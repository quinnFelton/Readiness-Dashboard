import { describe, expect, it } from 'vitest';
import { createAdapterRegistry } from './registry';
import type { ProviderAdapter } from './types';

const stub = (
  key: string,
  role: 'activity_source' | 'daily_metrics_source',
): ProviderAdapter<never> => ({
  key,
  role,
  normalize: () => [],
  start: async () => ({ redirectUrl: 'x' }),
  handleCallback: async () => ({}),
});

describe('adapter registry', () => {
  it('looks up by provider + role', () => {
    const r = createAdapterRegistry();
    const oura = stub('oura', 'daily_metrics_source');
    const strava = stub('strava', 'activity_source');
    r.register(oura);
    r.register(strava);
    expect(r.get('oura', 'daily_metrics_source')).toBe(oura);
    expect(r.get('strava', 'activity_source')).toBe(strava);
    expect(r.getByProvider('strava')).toBe(strava);
  });

  it('returns undefined for unknown provider or wrong role', () => {
    const r = createAdapterRegistry();
    r.register(stub('oura', 'daily_metrics_source'));
    expect(r.get('oura', 'activity_source')).toBeUndefined();
    expect(r.get('garmin', 'activity_source')).toBeUndefined();
    expect(r.getByProvider('garmin')).toBeUndefined();
  });

  it('lists by role and rejects duplicate provider keys', () => {
    const r = createAdapterRegistry();
    r.register(stub('oura', 'daily_metrics_source'));
    r.register(stub('terra', 'daily_metrics_source'));
    r.register(stub('strava', 'activity_source'));
    expect(r.listByRole('daily_metrics_source').map((a) => a.key)).toEqual(['oura', 'terra']);
    expect(() => r.register(stub('oura', 'activity_source'))).toThrow(/already registered/);
  });
});
