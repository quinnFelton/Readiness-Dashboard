import type { RequestHandler } from 'express';

// PLAN §12 "rate-limit the public API via API Gateway throttling". In AWS the HTTP API stage does it
// (infra/cdk config `throttle`: rate 20 rps, burst 40, same defaults here). This is the local-dev
// stand-in so the app behaves the same behind `pnpm dev`: a token bucket, 429 + Retry-After when empty.
// In-process and per-container, so it is NOT a control in Lambda: server.ts enables it, lambda/*.ts
// do not.

export interface RateLimitOptions {
  /** Sustained requests per second. */
  ratePerSec: number;
  /** Bucket size: how many requests may arrive at once. */
  burst: number;
  /**
   * Bucket key. Default: one stage-wide bucket, which is what API Gateway's default-route throttle
   * is. Pass e.g. `(req) => req.ip` for a per-client limit (used for the login route).
   */
  key?: (req: Parameters<RequestHandler>[0]) => string;
  now?: () => number;
  /** Cap on tracked keys; the oldest is dropped beyond it so a key flood cannot grow memory. */
  maxKeys?: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export function createRateLimiter(opts: RateLimitOptions): RequestHandler {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  const buckets = new Map<string, Bucket>();
  return (req, res, next) => {
    const k = opts.key ? opts.key(req) : 'stage';
    const t = now();
    let b = buckets.get(k);
    if (!b) {
      if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value as string);
      b = { tokens: opts.burst, at: t };
    } else {
      buckets.delete(k); // re-insert below: Map order doubles as least-recently-used
      b.tokens = Math.min(opts.burst, b.tokens + ((t - b.at) / 1000) * opts.ratePerSec);
      b.at = t;
    }
    buckets.set(k, b);
    if (b.tokens < 1) {
      res.setHeader(
        'Retry-After',
        String(Math.max(1, Math.ceil((1 - b.tokens) / opts.ratePerSec))),
      );
      res.status(429).json({ error: 'too_many_requests' });
      return;
    }
    b.tokens -= 1;
    next();
  };
}

/** THROTTLE_RATE / THROTTLE_BURST mirror the CDK context names; `RATE_LIMIT=off` disables. */
export function rateLimitFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitOptions | null {
  if (env.RATE_LIMIT === 'off') return null;
  const num = (raw: string | undefined, d: number) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? n : d;
  };
  return { ratePerSec: num(env.THROTTLE_RATE, 20), burst: num(env.THROTTLE_BURST, 40) };
}
