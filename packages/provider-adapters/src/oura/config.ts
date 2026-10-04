/// <reference types="node" />
// Oura adapter configuration. Everything environment-specific is config, not constants (CLAUDE.md rule 9).

export interface OuraConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /**
   * Sandbox/test-user mode (PLAN §5.1): no ring and no real OAuth needed. `start` bounces straight to
   * the callback with a placeholder code, and data calls use the `/v2/sandbox/...` path prefix.
   */
  sandbox: boolean;
  scopes: string[];
  apiBaseUrl: string;
  // Verified: https://cloud.ouraring.com/docs/authentication
  authorizeUrl: string;
  tokenUrl: string;
  /** First sync (since === null) fetches this many days back. */
  lookbackDays: number;
  /** Re-fetch this many days before last_synced_at: Oura finalizes a day's scores late (upserts are idempotent). */
  overlapDays: number;
  /** Refresh proactively when the access token expires within this many seconds. */
  refreshSkewSec: number;
  /** 429 with Retry-After at or below this is waited out; above it the sync fails fast (next run retries). */
  maxRetryAfterSec: number;
  maxRateLimitRetries: number;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export const SANDBOX_CODE = 'sandbox';
export const SANDBOX_ACCESS_TOKEN = 'sandbox-access-token';

export function ouraConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OuraConfig {
  const num = (v: string | undefined, d: number) =>
    v && Number.isFinite(Number(v)) ? Number(v) : d;
  return {
    clientId: env.OURA_CLIENT_ID ?? '',
    clientSecret: env.OURA_CLIENT_SECRET ?? '',
    redirectUri: env.OURA_REDIRECT_URI ?? 'http://localhost:4000/api/v1/connections/oura/callback',
    sandbox: (env.OURA_USE_SANDBOX ?? 'false').toLowerCase() === 'true',
    // UNVERIFIED scope identifiers (the auth doc lists 8 scopes, e.g. "personal info" and "daily summaries",
    // but exact strings weren't machine-readable). Override with OURA_SCOPES.
    scopes: (env.OURA_SCOPES ?? 'daily personal').split(/[\s,]+/).filter(Boolean),
    apiBaseUrl: env.OURA_API_BASE_URL ?? 'https://api.ouraring.com',
    authorizeUrl: env.OURA_AUTHORIZE_URL ?? 'https://cloud.ouraring.com/oauth/authorize',
    tokenUrl: env.OURA_TOKEN_URL ?? 'https://api.ouraring.com/oauth/token',
    lookbackDays: num(env.OURA_LOOKBACK_DAYS, 30),
    overlapDays: num(env.OURA_OVERLAP_DAYS, 2),
    refreshSkewSec: num(env.OURA_REFRESH_SKEW_SEC, 300),
    maxRetryAfterSec: num(env.OURA_MAX_RETRY_AFTER_SEC, 30),
    maxRateLimitRetries: num(env.OURA_MAX_RATE_LIMIT_RETRIES, 3),
  };
}
