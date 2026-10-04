import { describe, expect, it } from 'vitest';
import * as api from './index';

const ride = (n: number, watts: (i: number) => number, hr = 150) =>
  Array.from({ length: n }, (_, i) => ({ t: i, watts: watts(i), hr }));

describe('public API (phase 5a prompt)', () => {
  it('exports every required symbol', () => {
    for (const name of [
      'deriveActivityEffort',
      'normalizedPower',
      'peakWindow',
      'rollingBaseline',
      'classifyFatigueFitness',
      'recoveryTrend',
      'DERIVATION_VERSION',
      'DEFAULT_CLASSIFIER_CONFIG',
    ]) {
      expect(api, name).toHaveProperty(name);
    }
    expect(typeof api.DERIVATION_VERSION).toBe('number');
  });

  it('does not mutate its inputs and is deterministic', () => {
    const stream = ride(1500, (i) => 200 + (i % 7));
    const copy = JSON.stringify(stream);
    const a = api.deriveActivityEffort(stream, {});
    const b = api.deriveActivityEffort(stream, {});
    expect(JSON.stringify(stream)).toBe(copy);
    expect(a).toEqual(b);
  });

  it('hand-checked: constant 200 W / 150 bpm for 25 min gives EF 4/3 everywhere', () => {
    const r = api.deriveActivityEffort(
      ride(1500, () => 200),
      {},
    );
    if (!r.qualifies) throw new Error('should qualify');
    expect(r.efOverall).toBeCloseTo(200 / 150, 9);
    expect(r.efPeak20).toBeCloseTo(200 / 150, 9);
    expect(r.derivationVersion).toBe(api.DERIVATION_VERSION);
  });

  it('peakWindow handles a 3 h ride quickly (O(n), not O(n*window))', () => {
    const stream = ride(10800, (i) => 150 + (i % 50));
    const t0 = Date.now();
    api.peakWindow(stream, 1200);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
