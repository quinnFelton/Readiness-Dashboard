/// <reference types="node" />
import type { ConnectionGrant } from '../types';
import type { StravaActivitySummary, StravaStreamSet } from './mapping';
import { StravaRateLimitError, StravaRateLimiter, nextFifteenMinuteBoundary } from './rate-limit';

// Endpoints/params verified 2026-10-04:
//  OAuth: https://developers.strava.com/docs/authentication/
//    authorize  GET  https://www.strava.com/oauth/authorize (client_id, redirect_uri,
//               response_type=code, approval_prompt, scope, state)
//    token      POST https://www.strava.com/oauth/token (grant_type=authorization_code|refresh_token)
//               → { access_token, refresh_token, expires_at (unix s), expires_in, athlete?, scope? }
//    The refresh token can change on every refresh — always persist the one returned.
//  API: https://developers.strava.com/docs/reference/
//    GET /activities/{id}, GET /activities/{id}/streams, GET /athlete/activities (after, page, per_page)

export const STRAVA_AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
export const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
export const STRAVA_REVOKE_URL = 'https://www.strava.com/oauth/revoke';
export const STRAVA_API_BASE = 'https://www.strava.com/api/v3';
export const STRAVA_SCOPE = 'activity:read_all';

/** Credentials are unusable (revoked/denied); the user must reconnect. Carries no token material. */
export class StravaAuthError extends Error {
  constructor(message = 'strava authorization failed') {
    super(message);
    this.name = 'StravaAuthError';
  }
}
export class StravaHttpError extends Error {
  constructor(readonly status: number) {
    super(`strava http ${status}`); // status only — never echo bodies (may hold health data)
    this.name = 'StravaHttpError';
  }
}

export interface StravaClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
  limiter?: StravaRateLimiter;
  now?: () => Date;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete?: { id: number };
}

const isTokenResponse = (v: unknown): v is TokenResponse => {
  const t = v as Partial<TokenResponse> | null;
  return (
    !!t &&
    typeof t.access_token === 'string' &&
    typeof t.refresh_token === 'string' &&
    typeof t.expires_at === 'number'
  );
};

export class StravaClient {
  readonly limiter: StravaRateLimiter;
  private readonly doFetch: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly cfg: StravaClientConfig) {
    this.doFetch = cfg.fetch ?? fetch;
    this.limiter = cfg.limiter ?? new StravaRateLimiter();
    this.now = cfg.now ?? (() => new Date());
  }

  authorizeUrl(state: string): string {
    const p = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      approval_prompt: 'auto',
      scope: STRAVA_SCOPE,
      state,
    });
    return `${STRAVA_AUTHORIZE_URL}?${p.toString()}`;
  }

  exchangeCode(code: string): Promise<ConnectionGrant> {
    return this.token({ grant_type: 'authorization_code', code });
  }

  /** Mandatory before any call when the access token is near expiry (PLAN §5.2). */
  refresh(refreshToken: string): Promise<ConnectionGrant> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  private async token(params: Record<string, string>): Promise<ConnectionGrant> {
    const res = await this.doFetch(STRAVA_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        ...params,
      }).toString(),
    });
    // 400/401 on the token endpoint = bad/revoked code or refresh token.
    if (res.status === 400 || res.status === 401) throw new StravaAuthError();
    if (!res.ok) throw new StravaHttpError(res.status);
    const body: unknown = await res.json();
    if (!isTokenResponse(body)) throw new StravaHttpError(502);
    return {
      externalUserId: body.athlete ? String(body.athlete.id) : undefined,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: new Date(body.expires_at * 1000),
    };
  }

  /**
   * Ends the grant at Strava. https://developers.strava.com/docs/authentication/ (verified 2026-10-04):
   * POST https://www.strava.com/oauth/revoke, HTTP Basic auth (client_id:client_secret), form field
   * `token` (access or refresh token). 200 with an empty body whether or not the token was found.
   */
  async revoke(token: string): Promise<void> {
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const res = await this.doFetch(STRAVA_REVOKE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({ token }).toString(),
    });
    if (!res.ok) throw new StravaHttpError(res.status);
  }

  /**
   * GET /athlete (https://developers.strava.com/docs/reference/): cheapest authenticated call, used
   * only to confirm that a token still works. 401 -> StravaAuthError (the grant is gone).
   */
  async getAthlete(accessToken: string): Promise<{ id?: number } | null> {
    return this.get<{ id?: number }>(accessToken, '/athlete');
  }

  getActivity(accessToken: string, id: string | number): Promise<StravaActivitySummary | null> {
    return this.get<StravaActivitySummary>(
      accessToken,
      `/activities/${encodeURIComponent(String(id))}`,
    );
  }

  /** null when Strava has no streams (404: manual activity, deleted, or no sensors). */
  getStreams(accessToken: string, id: string | number): Promise<StravaStreamSet | null> {
    return this.get<StravaStreamSet>(
      accessToken,
      `/activities/${encodeURIComponent(String(id))}/streams`,
      { keys: 'time,watts,heartrate', key_by_type: 'true' },
    );
  }

  async listActivities(
    accessToken: string,
    afterEpochSec: number,
    page: number,
    perPage = 50,
  ): Promise<StravaActivitySummary[]> {
    const r = await this.get<StravaActivitySummary[]>(accessToken, '/athlete/activities', {
      after: String(afterEpochSec),
      page: String(page),
      per_page: String(perPage),
    });
    return r ?? [];
  }

  private async get<T>(
    accessToken: string,
    path: string,
    query: Record<string, string> = {},
  ): Promise<T | null> {
    await this.limiter.beforeRequest(); // back off before the ceiling, not after a 429
    const qs = Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
    const res = await this.doFetch(`${STRAVA_API_BASE}${path}${qs}`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
    this.limiter.update(res.headers);
    if (res.status === 429) {
      this.limiter.markExhausted();
      throw new StravaRateLimitError(nextFifteenMinuteBoundary(this.now()), '15min');
    }
    if (res.status === 404) return null;
    if (res.status === 401) throw new StravaAuthError();
    if (!res.ok) throw new StravaHttpError(res.status);
    return (await res.json()) as T;
  }
}

/** True when the access token expires within `skewSec` (or expiry is unknown). */
export function tokenNeedsRefresh(
  expiresAt: Date | null | undefined,
  now: Date,
  skewSec = 900,
): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() - now.getTime() <= skewSec * 1000;
}
