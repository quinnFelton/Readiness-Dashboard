import { createAdapterRegistry } from '@rd/provider-adapters';
import { describe, expect, it } from 'vitest';
import { registerDefaultAdapters } from './register-all';

// Integration stage C: real adapters are registered from env, tolerant of missing credentials and
// idempotent (createApp() runs many times per test process). Pure registry test: no DB, no network.
describe('registerDefaultAdapters', () => {
  it('registers nothing when no provider is configured', () => {
    const registry = createAdapterRegistry();
    expect(registerDefaultAdapters(registry, {})).toEqual([]);
    expect(registry.listByRole('daily_metrics_source')).toEqual([]);
    expect(registry.listByRole('activity_source')).toEqual([]);
  });

  it('registers Oura, Terra and Strava under their roles when configured, and is idempotent', () => {
    const registry = createAdapterRegistry();
    const env = {
      OURA_CLIENT_ID: 'oura-id',
      TERRA_DEV_ID: 'dev',
      TERRA_API_KEY: 'key',
      TERRA_SUCCESS_REDIRECT_URL: 'http://localhost:3000/settings',
      STRAVA_CLIENT_ID: 'strava-id',
    };
    expect(registerDefaultAdapters(registry, env).sort()).toEqual(['oura', 'strava', 'terra']);
    expect(registry.get('oura', 'daily_metrics_source')).toBeDefined();
    expect(registry.get('terra', 'daily_metrics_source')).toBeDefined();
    expect(registry.get('strava', 'activity_source')).toBeDefined();
    expect(registerDefaultAdapters(registry, env)).toEqual([]); // second call: no throw, no-op
  });

  it('registers Oura in sandbox mode without a client id', () => {
    const registry = createAdapterRegistry();
    expect(registerDefaultAdapters(registry, { OURA_USE_SANDBOX: 'true' })).toEqual(['oura']);
  });
});
