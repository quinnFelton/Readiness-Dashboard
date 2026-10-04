/// <reference types="node" />
// Oura adapter configuration. Everything environment-specific is config, not constants (CLAUDE.md rule 9).
// Spec: https://cloud.ouraring.com/v2/static/json/openapi-1.41.json (excerpt: ./docs/openapi-excerpt.json)

import type { OuraCollection } from './mapping';

export interface OuraConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /**
   * Sandbox/test-user mode (PLAN §5.1): no ring and no real OAuth needed. `start` bounces straight to
   * the callback with a placeholder code, and data calls use the `/v2/sandbox/usercollection/...` prefix
   * (spec: paths GET /v2/sandbox/usercollection/daily_readiness and .../daily_sleep are verified; the
   * sandbox `sleep` collection was not visible in the spec excerpt, so sandbox HRV/resting HR is best-effort).
   */
  sandbox: boolean;
  /** Spec securitySchemes.OAuth2.flows.authorizationCode.scopes: email, personal, daily, heartrate, workout,
   *  tag, session, spo2, heart_health. We need `daily` (readiness/sleep) and `personal` (personal_info id). */
  scopes: string[];
  apiBaseUrl: string;
  // Spec securitySchemes.OAuth2.flows.authorizationCode.authorizationUrl / tokenUrl.
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

  // ---- Webhooks (spec webhookDocs: https://cloud.ouraring.com/v2/docs, "Webhook Subscription Routes") ----
  /** Our secret `verification_token`, echoed back during subscription verification (GET challenge). */
  webhookVerificationToken: string;
  /** Public URL Oura posts to, e.g. https://api.example.com/api/v1/webhooks/oura. */
  webhookCallbackUrl: string;
  /** Reject deliveries whose x-oura-timestamp is further than this from now (replay protection). */
  webhookToleranceSec: number;
  /** On an event, re-fetch from this many days before event_time (the payload carries no date, only object_id). */
  webhookLookbackDays: number;
  /**
   * Webhook `data_type` -> collection to re-fetch. Data types not listed are acknowledged and ignored.
   * The spec excerpt references `ExtApiV2DataType` without listing its values (the docs example uses "sleep"),
   * so this mapping is config: override with OURA_WEBHOOK_DATA_TYPES="type:collection,type:collection".
   */
  webhookCollections: Record<string, OuraCollection>;
  /** Spec WebhookOperation enum: create | update | delete. */
  webhookEventTypes: string[];
  /** ensureSubscriptions renews a subscription when it expires within this many seconds. */
  subscriptionRenewWithinSec: number;

  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export const SANDBOX_CODE = 'sandbox';
export const SANDBOX_ACCESS_TOKEN = 'sandbox-access-token';

const COLLECTIONS: readonly string[] = ['daily_readiness', 'daily_sleep', 'sleep'];

export const DEFAULT_WEBHOOK_COLLECTIONS: Record<string, OuraCollection> = {
  daily_readiness: 'daily_readiness',
  daily_sleep: 'daily_sleep',
  sleep: 'sleep',
};

function parseCollections(v: string | undefined): Record<string, OuraCollection> {
  if (!v) return { ...DEFAULT_WEBHOOK_COLLECTIONS };
  const out: Record<string, OuraCollection> = {};
  for (const part of v.split(/[\s,]+/).filter(Boolean)) {
    const [type, coll = type] = part.split(':');
    if (type && coll && COLLECTIONS.includes(coll)) out[type] = coll as OuraCollection;
  }
  return out;
}

export function ouraConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OuraConfig {
  const num = (v: string | undefined, d: number) =>
    v && Number.isFinite(Number(v)) ? Number(v) : d;
  return {
    clientId: env.OURA_CLIENT_ID ?? '',
    clientSecret: env.OURA_CLIENT_SECRET ?? '',
    redirectUri: env.OURA_REDIRECT_URI ?? 'http://localhost:4000/api/v1/connections/oura/callback',
    sandbox: (env.OURA_USE_SANDBOX ?? 'false').toLowerCase() === 'true',
    scopes: (env.OURA_SCOPES ?? 'daily personal').split(/[\s,]+/).filter(Boolean),
    apiBaseUrl: env.OURA_API_BASE_URL ?? 'https://api.ouraring.com',
    authorizeUrl: env.OURA_AUTHORIZE_URL ?? 'https://cloud.ouraring.com/oauth/authorize',
    tokenUrl: env.OURA_TOKEN_URL ?? 'https://api.ouraring.com/oauth/token',
    lookbackDays: num(env.OURA_LOOKBACK_DAYS, 30),
    overlapDays: num(env.OURA_OVERLAP_DAYS, 2),
    refreshSkewSec: num(env.OURA_REFRESH_SKEW_SEC, 300),
    maxRetryAfterSec: num(env.OURA_MAX_RETRY_AFTER_SEC, 30),
    maxRateLimitRetries: num(env.OURA_MAX_RATE_LIMIT_RETRIES, 3),
    webhookVerificationToken: env.OURA_WEBHOOK_VERIFICATION_TOKEN ?? '',
    webhookCallbackUrl: env.OURA_WEBHOOK_CALLBACK_URL ?? '',
    webhookToleranceSec: num(env.OURA_WEBHOOK_TOLERANCE_SEC, 300),
    webhookLookbackDays: num(env.OURA_WEBHOOK_LOOKBACK_DAYS, 3),
    webhookCollections: parseCollections(env.OURA_WEBHOOK_DATA_TYPES),
    webhookEventTypes: (env.OURA_WEBHOOK_EVENT_TYPES ?? 'create,update,delete')
      .split(/[\s,]+/)
      .filter(Boolean),
    subscriptionRenewWithinSec: num(env.OURA_SUBSCRIPTION_RENEW_WITHIN_SEC, 7 * 86_400),
  };
}
