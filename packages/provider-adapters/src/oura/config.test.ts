import { describe, expect, it } from 'vitest';
import { DEFAULT_WEBHOOK_COLLECTIONS, ouraConfigFromEnv } from './config';

// Thresholds and endpoints are config, not constants (CLAUDE.md rule 9).
describe('ouraConfigFromEnv', () => {
  it('uses spec defaults when env is empty', () => {
    const c = ouraConfigFromEnv({});
    expect(c).toMatchObject({
      clientId: '',
      clientSecret: '',
      sandbox: false,
      scopes: ['daily', 'personal'],
      apiBaseUrl: 'https://api.ouraring.com',
      authorizeUrl: 'https://cloud.ouraring.com/oauth/authorize',
      tokenUrl: 'https://api.ouraring.com/oauth/token',
      lookbackDays: 30,
      overlapDays: 2,
      refreshSkewSec: 300,
      maxRetryAfterSec: 30,
      maxRateLimitRetries: 3,
      webhookToleranceSec: 300,
      webhookLookbackDays: 3,
      webhookEventTypes: ['create', 'update', 'delete'],
      subscriptionRenewWithinSec: 7 * 86_400,
    });
    expect(c.webhookCollections).toEqual(DEFAULT_WEBHOOK_COLLECTIONS);
    expect(c.webhookCollections).not.toBe(DEFAULT_WEBHOOK_COLLECTIONS);
  });

  it('reads overrides; sandbox flag is case-insensitive; lists split on commas or spaces', () => {
    const c = ouraConfigFromEnv({
      OURA_CLIENT_ID: 'id',
      OURA_CLIENT_SECRET: 'secret',
      OURA_USE_SANDBOX: 'TRUE',
      OURA_SCOPES: 'daily, personal heartrate',
      OURA_LOOKBACK_DAYS: '10',
      OURA_WEBHOOK_TOLERANCE_SEC: '60',
      OURA_WEBHOOK_EVENT_TYPES: 'create update',
    });
    expect(c).toMatchObject({
      clientId: 'id',
      clientSecret: 'secret',
      sandbox: true,
      scopes: ['daily', 'personal', 'heartrate'],
      lookbackDays: 10,
      webhookToleranceSec: 60,
      webhookEventTypes: ['create', 'update'],
    });
  });

  it('falls back to defaults for non-numeric or empty numbers', () => {
    const c = ouraConfigFromEnv({ OURA_LOOKBACK_DAYS: 'abc', OURA_OVERLAP_DAYS: '' });
    expect(c.lookbackDays).toBe(30);
    expect(c.overlapDays).toBe(2);
  });

  it('parses webhook data types, with optional type:collection mapping, dropping unknown collections', () => {
    const c = ouraConfigFromEnv({
      OURA_WEBHOOK_DATA_TYPES: 'daily_sleep, readiness:daily_readiness bogus foo:workout',
    });
    expect(c.webhookCollections).toEqual({
      daily_sleep: 'daily_sleep',
      readiness: 'daily_readiness',
    });
  });
});
