/// <reference types="node" />
import type { NormalizedDailyMetric } from '@rd/shared-types';
import type {
  CallbackContext,
  ConnectionGrant,
  FetchContext,
  FetchResult,
  ProviderAdapter,
  StartContext,
  StartResult,
} from '../types';
import { type OuraConfig, SANDBOX_ACCESS_TOKEN, SANDBOX_CODE } from './config';
import { OURA_DERIVATION_VERSION, type OuraRawBundle, normalizeOura } from './mapping';

// Error classes carry status/codes only — never response bodies, which could hold health data (rule 6).
export class OuraAuthError extends Error {
  override name = 'OuraAuthError';
  /** Set when tokens were refreshed before the failure. Oura refresh tokens are single-use, so the
   *  caller MUST persist this even though the sync failed, or the connection is lost. */
  refreshedGrant?: ConnectionGrant;
}
export class OuraHttpError extends Error {
  override name = 'OuraHttpError';
  refreshedGrant?: ConnectionGrant;
  constructor(readonly status: number) {
    super(`oura http ${status}`);
  }
}
export class OuraRateLimitError extends Error {
  override name = 'OuraRateLimitError';
  refreshedGrant?: ConnectionGrant;
  constructor(readonly retryAfterSec: number) {
    super(`oura rate limited, retry after ${retryAfterSec}s`);
  }
}

const DAY_MS = 86_400_000;
const MAX_PAGES = 50;
const fmtDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Incremental window (PLAN §13). `since` = last successful sync; we back up `overlapDays` because Oura
 * finalizes a day late, and rely on idempotent upserts. end_date is tomorrow (UTC) so today's data is
 * included regardless of whether the API treats end_date as exclusive (UNVERIFIED semantics).
 */
export function computeOuraRange(
  since: Date | null,
  now: Date,
  cfg: Pick<OuraConfig, 'lookbackDays' | 'overlapDays'>,
): { startDate: string; endDate: string } {
  const start = since
    ? new Date(since.getTime() - cfg.overlapDays * DAY_MS)
    : new Date(now.getTime() - cfg.lookbackDays * DAY_MS);
  return { startDate: fmtDay(start), endDate: fmtDay(new Date(now.getTime() + DAY_MS)) };
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

export class OuraAdapter implements ProviderAdapter<NormalizedDailyMetric> {
  readonly role = 'daily_metrics_source' as const;
  readonly key = 'oura';
  readonly derivationVersion = OURA_DERIVATION_VERSION;

  constructor(private readonly cfg: OuraConfig) {}

  private get now() {
    return this.cfg.now?.() ?? new Date();
  }
  private get http(): typeof fetch {
    return this.cfg.fetch ?? fetch;
  }
  private sleep(ms: number) {
    return this.cfg.sleep ? this.cfg.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  normalize(rawPayload: unknown): NormalizedDailyMetric[] {
    return normalizeOura(rawPayload);
  }

  // Authorize URL + params: https://cloud.ouraring.com/docs/authentication (verified)
  async start(ctx: StartContext): Promise<StartResult> {
    const base = this.cfg.sandbox ? this.cfg.redirectUri : this.cfg.authorizeUrl;
    const u = new URL(base);
    if (this.cfg.sandbox) {
      u.searchParams.set('code', SANDBOX_CODE);
    } else {
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', this.cfg.clientId);
      u.searchParams.set('redirect_uri', this.cfg.redirectUri);
      u.searchParams.set('scope', this.cfg.scopes.join(' '));
    }
    u.searchParams.set('state', ctx.state); // passed through unchanged; the API verifies it on callback
    return { redirectUrl: u.toString() };
  }

  async handleCallback(ctx: CallbackContext): Promise<ConnectionGrant> {
    if (ctx.query.error) throw new OuraAuthError('authorization denied');
    const code = ctx.query.code;
    if (!code) throw new OuraAuthError('missing authorization code');
    if (this.cfg.sandbox) {
      if (code !== SANDBOX_CODE) throw new OuraAuthError('invalid sandbox code');
      return { externalUserId: `sandbox-${ctx.userId}`, accessToken: SANDBOX_ACCESS_TOKEN };
    }
    const grant = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.redirectUri,
    });
    // Best-effort identity; needs the personal scope (UNVERIFIED path: /v2/usercollection/personal_info).
    try {
      const info = (await this.apiGet(grant.accessToken!, '/v2/usercollection/personal_info')) as {
        id?: unknown;
      };
      if (typeof info?.id === 'string') grant.externalUserId = info.id;
    } catch {
      /* identity is optional */
    }
    return grant;
  }

  async fetchRaw(ctx: FetchContext): Promise<FetchResult> {
    let accessToken = ctx.accessToken;
    let refreshedGrant: ConnectionGrant | undefined;
    const refresh = async () => {
      if (!ctx.refreshToken) throw new OuraAuthError('access token expired and no refresh token');
      refreshedGrant = await this.refreshTokens(ctx.refreshToken);
      accessToken = refreshedGrant.accessToken;
    };

    try {
      if (!this.cfg.sandbox) {
        const expired =
          !accessToken ||
          (ctx.expiresAt != null &&
            ctx.expiresAt.getTime() - this.cfg.refreshSkewSec * 1000 <= this.now.getTime());
        if (expired) await refresh();
      }
      const range = computeOuraRange(ctx.since, this.now, this.cfg);
      const collect = async () => ({
        dailyReadiness: await this.paged(accessToken!, 'daily_readiness', range),
        dailySleep: await this.paged(accessToken!, 'daily_sleep', range),
        sleep: await this.paged(accessToken!, 'sleep', range),
      });
      let raw: OuraRawBundle;
      try {
        raw = await collect();
      } catch (e) {
        // Token revoked/expired earlier than expires_at says: refresh once and retry.
        if (
          e instanceof OuraHttpError &&
          e.status === 401 &&
          !refreshedGrant &&
          !this.cfg.sandbox
        ) {
          await refresh();
          raw = await collect();
        } else throw e;
      }
      return { raw, refreshedGrant };
    } catch (e) {
      if (refreshedGrant && e instanceof Error)
        (e as { refreshedGrant?: ConnectionGrant }).refreshedGrant = refreshedGrant;
      throw e;
    }
  }

  // Refresh: POST token URL, form body grant_type=refresh_token (client creds in body are allowed).
  // https://cloud.ouraring.com/docs/authentication — verified. Refresh tokens are SINGLE-USE.
  private refreshTokens(refreshToken: string): Promise<ConnectionGrant> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  private async tokenRequest(params: Record<string, string>): Promise<ConnectionGrant> {
    const body = new URLSearchParams({
      ...params,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });
    const res = await this.http(this.cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (res.status === 400 || res.status === 401) throw new OuraAuthError('token request rejected');
    if (!res.ok) throw new OuraHttpError(res.status);
    const t = (await res.json()) as TokenResponse;
    // Response fields (verified): access_token, refresh_token, expires_in (seconds), token_type.
    if (typeof t.access_token !== 'string') throw new OuraAuthError('malformed token response');
    return {
      accessToken: t.access_token,
      refreshToken: typeof t.refresh_token === 'string' ? t.refresh_token : undefined,
      expiresAt:
        typeof t.expires_in === 'number'
          ? new Date(this.now.getTime() + t.expires_in * 1000)
          : undefined,
    };
  }

  /** Follows next_token pagination (UNVERIFIED param/response names: start_date, end_date, next_token, data). */
  private async paged(
    token: string,
    collection: string,
    range: { startDate: string; endDate: string },
  ): Promise<unknown[]> {
    const prefix = this.cfg.sandbox ? '/v2/sandbox/usercollection' : '/v2/usercollection';
    const items: unknown[] = [];
    let next: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ start_date: range.startDate, end_date: range.endDate });
      if (next) q.set('next_token', next);
      const body = (await this.apiGet(token, `${prefix}/${collection}?${q}`)) as {
        data?: unknown;
        next_token?: unknown;
      };
      if (Array.isArray(body?.data)) items.push(...body.data);
      if (typeof body?.next_token !== 'string' || !body.next_token) return items;
      next = body.next_token;
    }
    return items;
  }

  /**
   * GET with rate-limit handling. Oura's limits/headers could not be machine-verified; we honor the standard
   * `Retry-After` on 429 (wait if short, else fail fast so the next scheduled run retries). With three
   * requests per user per run we are far below any plausible limit, so no proactive throttle is added.
   */
  private async apiGet(token: string, path: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.http(`${this.cfg.apiBaseUrl}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      if (res.status === 429) {
        const parsed = Number(res.headers.get('retry-after'));
        const retryAfter = Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 2 ** attempt;
        if (retryAfter > this.cfg.maxRetryAfterSec || attempt >= this.cfg.maxRateLimitRetries) {
          throw new OuraRateLimitError(retryAfter);
        }
        await this.sleep(retryAfter * 1000);
        continue;
      }
      if (!res.ok) throw new OuraHttpError(res.status);
      return res.json();
    }
  }
}
