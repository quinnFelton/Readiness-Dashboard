/// <reference types="node" />
// Strava rate limiting. Docs: https://developers.strava.com/docs/rate-limits/
//  - Limits are per *application* (shared by all users): default 200/15min + 2,000/day overall,
//    100/15min + 1,000/day for read (non-upload) endpoints.
//  - Every response carries X-RateLimit-Limit / X-RateLimit-Usage (overall) and
//    X-ReadRateLimit-Limit / X-ReadRateLimit-Usage (reads), each "<15min>,<daily>".
//  - 15-minute windows reset at :00/:15/:30/:45; the daily window resets at midnight UTC.
//  - Exceeding a limit yields 429.
// Strategy (PLAN §13): back off BEFORE the ceiling. Once usage reaches `ceilingFraction` of a limit
// we stop sending. A short 15-min wait is slept out; anything longer than `maxWaitMs` (and any
// daily exhaustion) throws StravaRateLimitError carrying `retryAt` so the caller can leave the
// work pending for replay instead of holding a webhook request open.

export const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class StravaRateLimitError extends Error {
  constructor(
    readonly retryAt: Date,
    readonly scope: '15min' | 'daily',
  ) {
    super(`strava rate limit (${scope}) reached; retry at ${retryAt.toISOString()}`);
    this.name = 'StravaRateLimitError';
  }
}

export interface RateLimiterOptions {
  /** Stop sending at this fraction of the limit (default 0.9 → 90/100 read requests). */
  ceilingFraction?: number;
  /** Longest 15-minute wait we will sleep through; beyond that, throw. Default 60s. */
  maxWaitMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface Pair {
  fifteen: number;
  daily: number;
}

/** Parses "100,1000" → {fifteen:100,daily:1000}; null if absent/malformed. */
export function parsePair(value: string | null | undefined): Pair | null {
  if (!value) return null;
  const parts = value.split(',').map((s) => Number(s.trim()));
  const [fifteen, daily] = parts;
  if (parts.length !== 2 || !Number.isFinite(fifteen) || !Number.isFinite(daily)) return null;
  return { fifteen: fifteen as number, daily: daily as number };
}

export const nextFifteenMinuteBoundary = (d: Date): Date =>
  new Date((Math.floor(d.getTime() / FIFTEEN_MIN_MS) + 1) * FIFTEEN_MIN_MS);
export const nextUtcMidnight = (d: Date): Date =>
  new Date((Math.floor(d.getTime() / DAY_MS) + 1) * DAY_MS);

interface Snapshot {
  limit: Pair;
  usage: Pair;
  at: Date;
}

export class StravaRateLimiter {
  private snap: Snapshot | null = null;
  private readonly ceiling: number;
  private readonly maxWaitMs: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: RateLimiterOptions = {}) {
    this.ceiling = opts.ceilingFraction ?? 0.9;
    this.maxWaitMs = opts.maxWaitMs ?? 60_000;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Record headers from any Strava response. Read headers win for GETs (they are stricter). */
  update(headers: Headers): void {
    const limit = parsePair(
      headers.get('x-readratelimit-limit') ?? headers.get('x-ratelimit-limit'),
    );
    const usage = parsePair(
      headers.get('x-readratelimit-usage') ?? headers.get('x-ratelimit-usage'),
    );
    if (limit && usage) this.snap = { limit, usage, at: this.now() };
  }

  /** Marks the app as saturated after a 429 whose headers were missing/unparseable. */
  markExhausted(): void {
    const at = this.now();
    this.snap = {
      limit: { fifteen: 1, daily: Number.MAX_SAFE_INTEGER },
      usage: { fifteen: 1, daily: 0 },
      at,
    };
  }

  /** Resolves when it is safe to send; throws StravaRateLimitError when waiting is not reasonable. */
  async beforeRequest(): Promise<void> {
    const s = this.snap;
    if (!s) return;
    const now = this.now();
    // Usage observed in an earlier window no longer counts against the current one.
    const sameQuarter =
      Math.floor(s.at.getTime() / FIFTEEN_MIN_MS) === Math.floor(now.getTime() / FIFTEEN_MIN_MS);
    const sameDay = Math.floor(s.at.getTime() / DAY_MS) === Math.floor(now.getTime() / DAY_MS);
    const usage15 = sameQuarter ? s.usage.fifteen : 0;
    const usageDay = sameDay ? s.usage.daily : 0;

    if (usageDay >= s.limit.daily * this.ceiling) {
      throw new StravaRateLimitError(nextUtcMidnight(now), 'daily');
    }
    if (usage15 >= s.limit.fifteen * this.ceiling) {
      const retryAt = nextFifteenMinuteBoundary(now);
      const wait = retryAt.getTime() - now.getTime() + 1000; // +1s clock-skew margin
      if (wait > this.maxWaitMs) throw new StravaRateLimitError(retryAt, '15min');
      await this.sleep(wait);
      // Window rolled over; our recorded usage is now stale.
      this.snap = null;
    }
  }
}
