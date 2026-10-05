import { describe, expect, it } from 'vitest';
import { loadFatigueFitnessConfig } from '../fatigue-fitness/config';
import { blendReadiness, zToScore } from './readiness-blend';

const w = { hrv: 0.4, restingHr: 0.3, sleep: 0.3 };

describe('zToScore', () => {
  it('is 50 at baseline, ±pointsPerZ per z, and clamped to 0-100', () => {
    expect(zToScore(0, 20)).toBe(50);
    expect(zToScore(1, 20)).toBe(70);
    expect(zToScore(-1.5, 20)).toBe(20);
    expect(zToScore(10, 20)).toBe(100);
    expect(zToScore(-10, 20)).toBe(0);
  });
});

describe('blendReadiness', () => {
  it('weighted mean of all components: 0.4*80 + 0.3*60 + 0.3*50 = 65', () => {
    const r = blendReadiness({ hrv: 80, restingHr: 60, sleep: 50 }, w);
    expect(r?.score).toBe(65);
  });
  it('renormalises over present components: hrv 80 (0.4) + sleep 50 (0.3) → (32+15)/0.7 = 67.14', () => {
    const r = blendReadiness({ hrv: 80, restingHr: null, sleep: 50 }, w);
    expect(r?.score).toBe(67.14);
    expect(r?.components).toEqual({ hrv: 80, sleep: 50 });
  });
  it('null when nothing is available, or the only components have weight 0', () => {
    expect(blendReadiness({}, w)).toBeNull();
    expect(blendReadiness({ sleep: 70 }, { hrv: 1, restingHr: 1, sleep: 0 })).toBeNull();
  });
});

describe('loadFatigueFitnessConfig', () => {
  it('has defaults and reads env overrides', () => {
    expect(loadFatigueFitnessConfig({}).longDays).toBe(28);
    const c = loadFatigueFitnessConfig({ READINESS_WEIGHT_SLEEP: '1', BASELINE_LONG_DAYS: '42' });
    expect(c.readinessWeights.sleep).toBe(1);
    expect(c.longDays).toBe(42);
  });
  it('rejects nonsense', () => {
    expect(() => loadFatigueFitnessConfig({ BASELINE_LONG_DAYS: 'abc' })).toThrow();
    expect(() => loadFatigueFitnessConfig({ BASELINE_SHORT_DAYS: '30' })).toThrow(RangeError);
    expect(() =>
      loadFatigueFitnessConfig({
        READINESS_WEIGHT_HRV: '0',
        READINESS_WEIGHT_RESTING_HR: '0',
        READINESS_WEIGHT_SLEEP: '0',
      }),
    ).toThrow(RangeError);
  });
});
