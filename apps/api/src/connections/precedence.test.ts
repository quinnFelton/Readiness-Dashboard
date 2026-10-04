import { describe, expect, it } from 'vitest';
import { loadPrecedenceConfig, pickBySource, resolvePrecedence } from './precedence';

describe('precedence resolution (PLAN §6)', () => {
  const cfg = loadPrecedenceConfig({} as NodeJS.ProcessEnv);

  it('defaults to Oura-preferred for every metric when the user set nothing', () => {
    const p = resolvePrecedence([], cfg);
    for (const m of ['hrv', 'resting_hr', 'sleep_score', 'readiness'] as const) {
      expect(p[m]).toEqual(['oura', 'terra']);
    }
  });

  it('is overridable by the user ordering', () => {
    expect(resolvePrecedence(['terra', 'oura'], cfg).hrv).toEqual(['terra', 'oura']);
  });

  it('is overridable by config (env default order and per-metric)', () => {
    const env = { DAILY_METRICS_DEFAULT_SOURCE_ORDER: 'terra, oura' } as NodeJS.ProcessEnv;
    expect(resolvePrecedence([], loadPrecedenceConfig(env)).hrv).toEqual(['terra', 'oura']);
    const perMetric = resolvePrecedence([], { ...cfg, perMetric: { sleep_score: ['terra'] } });
    expect(perMetric.sleep_score).toEqual(['terra']);
    expect(perMetric.hrv).toEqual(['oura', 'terra']);
  });

  it('pickBySource picks first listed source present, independent of input order', () => {
    const rows = [
      { source: 'terra', value: 50 },
      { source: 'oura', value: 60 },
    ];
    expect(pickBySource(rows, ['oura', 'terra'])?.value).toBe(60);
    expect(pickBySource([...rows].reverse(), ['oura', 'terra'])?.value).toBe(60);
    expect(pickBySource(rows, ['terra', 'oura'])?.value).toBe(50);
    expect(pickBySource([rows[0]!], ['oura', 'terra'])?.value).toBe(50); // falls back when preferred absent
    expect(pickBySource([], ['oura'])).toBeUndefined();
  });

  it('ranks unlisted sources after listed ones, alphabetically', () => {
    const rows = [
      { source: 'zzz', value: 1 },
      { source: 'aaa', value: 2 },
    ];
    expect(pickBySource(rows, ['oura'])?.source).toBe('aaa');
  });
});
