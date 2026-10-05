// Thin Terra REST client: widget session + one-time historical backfill. No polling (PLAN §5.3).
// Credentials stay server-side (docs: "Always call the /auth endpoints from your backend").

export interface TerraClientConfig {
  devId: string;
  apiKey: string;
  /** Widget session host. https://docs.tryterra.co/unified-api/user-authentication/implementation-terra-widget.md */
  widgetUrl?: string;
  /** REST data host. Base URL taken from the legacy-widget page (https://api.tryterra.co/v2/...). */
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface WidgetSessionRequest {
  referenceId: string;
  /** Comma-separated provider codes, e.g. "ZEPP". Omitted => widget shows all providers. */
  providers?: string;
  successRedirectUrl?: string;
  failureRedirectUrl?: string;
}

export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  resetAfterSec?: number;
}

/** 429 from Terra. https://docs.tryterra.co/reference/health-and-fitness-api/rate-limits.md */
export class TerraRateLimitError extends Error {
  constructor(
    /** r1 = single request too large (retrying identically never works); r2 = hourly budget. */
    readonly rule: 'r1' | 'r2' | 'unknown',
    readonly retryAfterSec?: number,
  ) {
    super(`terra rate limited (${rule})`);
    this.name = 'TerraRateLimitError';
  }
}

/** Never carries the response body: it may contain health data (CLAUDE.md rule 6). */
export class TerraHttpError extends Error {
  constructor(readonly status: number) {
    super(`terra http ${status}`);
    this.name = 'TerraHttpError';
  }
}

const num = (h: string | null): number | undefined => {
  if (h === null) return undefined;
  const n = Number(h);
  return Number.isFinite(n) ? n : undefined;
};

export function readRateLimit(h: Headers): RateLimitInfo {
  return {
    limit: num(h.get('x-terra-ratelimit-limit')),
    remaining: num(h.get('x-terra-ratelimit-remaining')),
    resetAfterSec: num(h.get('x-terra-ratelimit-reset-after')),
  };
}

export interface BackfillRequest {
  terraUserId: string;
  /** Inclusive start, YYYY-MM-DD. */
  startDate: string;
  /** Exclusive end, YYYY-MM-DD (Terra: "data returned up to but not including this date"). */
  endDate: string;
}

export interface TerraClient {
  generateWidgetSession(req: WidgetSessionRequest): Promise<{ url: string; sessionId?: string }>;
  requestSleepBackfill(req: BackfillRequest): Promise<RateLimitInfo>;
  /** Disconnects a Terra user (stops all pushes). See the UNVERIFIED note on the implementation. */
  deauthenticateUser(terraUserId: string): Promise<void>;
}

const dayCount = (a: string, b: string) =>
  Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000));

export function createTerraClient(cfg: TerraClientConfig): TerraClient {
  const f = cfg.fetch ?? fetch;
  const widgetUrl = cfg.widgetUrl ?? 'https://access.tryterra.co/api/widget/session';
  const apiBase = (cfg.apiBaseUrl ?? 'https://api.tryterra.co/v2').replace(/\/$/, '');
  const headers = {
    'dev-id': cfg.devId,
    'x-api-key': cfg.apiKey,
    'Content-Type': 'application/json',
  };

  const now = cfg.now ?? Date.now;
  const budgets = new Map<string, { remaining: number; resetAt: number }>();

  const check = (res: Response): void => {
    if (res.status === 429) {
      const rule = res.headers.get('x-terra-ratelimit-rule');
      throw new TerraRateLimitError(
        rule === 'r1' || rule === 'r2' ? rule : 'unknown',
        num(res.headers.get('retry-after')),
      );
    }
    if (!res.ok) throw new TerraHttpError(res.status);
  };

  return {
    async generateWidgetSession(req) {
      // Body fields: https://docs.tryterra.co/unified-api/user-authentication/implementation-terra-widget.md
      // (the older /v2/auth/generateWidgetSession is deprecated, sunset 2026-11-03).
      const res = await f(widgetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          reference_id: req.referenceId,
          ...(req.providers ? { providers: req.providers } : {}),
          ...(req.successRedirectUrl ? { auth_success_redirect_url: req.successRedirectUrl } : {}),
          ...(req.failureRedirectUrl ? { auth_failure_redirect_url: req.failureRedirectUrl } : {}),
        }),
      });
      check(res);
      const json = (await res.json()) as { url?: unknown; session_id?: unknown };
      if (typeof json.url !== 'string') throw new Error('terra widget session: missing url');
      return {
        url: json.url,
        sessionId: typeof json.session_id === 'string' ? json.session_id : undefined,
      };
    },

    async deauthenticateUser(terraUserId) {
      // Doc (verified 2026-10-04): "call /auth/deauthenticateUser with the user's user_id"; API-only,
      // not in the dashboard. https://docs.tryterra.co/help-center/help-topics/data-api-sdk/authentication-users-and-connection-state/deauthenticate-users.md
      // UNVERIFIED: the fetched pages never state the HTTP method or whether user_id is a query
      // parameter; DELETE + query is an assumption. Callers treat a failure as "not revoked" and
      // say so; confirm against the API reference before relying on it (docs/reports/9-hardening.md).
      const res = await f(
        `${apiBase}/auth/deauthenticateUser?${new URLSearchParams({ user_id: terraUserId })}`,
        {
          method: 'DELETE',
          headers,
        },
      );
      check(res);
    },

    async requestSleepBackfill({ terraUserId, startDate, endDate }) {
      // GET /sleep?user_id&start_date&end_date&to_webhook — delivered asynchronously to our webhook,
      // so no payload is handled here (and nothing is polled).
      // https://docs.tryterra.co/unified-api/managing-user-health-data/requesting-historical-data.md
      const q = new URLSearchParams({
        user_id: terraUserId,
        start_date: startDate,
        end_date: endDate,
        to_webhook: 'true',
        with_samples: 'false',
      });
      // Pre-emptive back-off: cost is (end - start) days against a per-user hourly budget; if the last
      // response said we can't afford this call yet, don't send it (avoids a guaranteed 429).
      const cost = dayCount(startDate, endDate);
      const known = budgets.get(terraUserId);
      if (known && known.remaining < cost && known.resetAt > now()) {
        throw new TerraRateLimitError('r2', Math.ceil((known.resetAt - now()) / 1000));
      }
      const res = await f(`${apiBase}/sleep?${q}`, { method: 'GET', headers });
      check(res);
      const rl = readRateLimit(res.headers);
      if (rl.remaining !== undefined && rl.resetAfterSec !== undefined) {
        budgets.set(terraUserId, {
          remaining: rl.remaining,
          resetAt: now() + rl.resetAfterSec * 1000,
        });
      }
      return rl;
    },
  };
}
