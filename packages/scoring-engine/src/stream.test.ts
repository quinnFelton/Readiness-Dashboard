import { describe, expect, it } from 'vitest';
import { isValidHr, isValidWatts, resampleTo1Hz, type StreamSample } from './stream';

describe('resampleTo1Hz', () => {
  it('passes a clean 1 Hz stream through unchanged', () => {
    const s: StreamSample[] = [
      { t: 0, watts: 100, hr: 120 },
      { t: 1, watts: 110, hr: 121 },
      { t: 2, watts: 120, hr: 122 },
    ];
    expect(resampleTo1Hz(s)).toEqual({
      watts: [100, 110, 120],
      hr: [120, 121, 122],
      t: [0, 1, 2],
      powerCoverage: 1,
      hrCoverage: 1,
      durationSec: 3,
    });
  });

  it('returns an empty grid for an empty stream or one with only non-finite t', () => {
    const empty = { watts: [], hr: [], t: [], powerCoverage: 0, hrCoverage: 0, durationSec: 0 };
    expect(resampleTo1Hz([])).toEqual(empty);
    expect(resampleTo1Hz([{ t: Number.NaN, watts: 100 }])).toEqual(empty);
  });

  it('sorts out-of-order samples without mutating the input', () => {
    const s: StreamSample[] = [
      { t: 2, watts: 300 },
      { t: 0, watts: 100 },
      { t: Number.POSITIVE_INFINITY, watts: 999 },
      { t: 1, watts: 200 },
    ];
    const before = JSON.stringify(s);
    expect(resampleTo1Hz(s).watts).toEqual([100, 200, 300]);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('time-weights faster-than-1 Hz samples into 1 s buckets (2 Hz)', () => {
    const s: StreamSample[] = [
      { t: 0, watts: 100, hr: 120 },
      { t: 0.5, watts: 200, hr: 130 },
      { t: 1, watts: 300, hr: 140 },
      { t: 1.5, watts: 300, hr: 140 },
    ];
    // last sample holds a nominal 1 s → total 2.5 s → 3 buckets; bucket 2 is half-covered.
    const g = resampleTo1Hz(s);
    expect(g.watts).toEqual([150, 300, 300]);
    expect(g.hr).toEqual([125, 140, 140]);
    expect(g.t).toEqual([0, 1, 2]);
    expect(g.durationSec).toBe(2.5);
  });

  it('holds sub-1 Hz samples forward (smart recording, 1 sample / 5 s)', () => {
    const s: StreamSample[] = [
      { t: 0, watts: 100, hr: 120 },
      { t: 5, watts: 200, hr: 130 },
      { t: 10, watts: 300, hr: 140 },
    ];
    const g = resampleTo1Hz(s);
    expect(g.watts).toEqual([100, 100, 100, 100, 100, 200, 200, 200, 200, 200, 300]);
    expect(g.t).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(g.durationSec).toBe(11);
  });

  it('splits holds that straddle bucket edges at fractional timestamps', () => {
    const s: StreamSample[] = [
      { t: 0, watts: 100 },
      { t: 1.5, watts: 200 },
      { t: 3, watts: 300 },
    ];
    // holds: [0,1.5)@100, [1.5,3)@200, [3,4)@300
    const g = resampleTo1Hz(s);
    expect(g.watts).toEqual([100, 150, 200, 300]);
    expect(g.t).toEqual([0, 1, 2, 3]);
  });

  it('collapses gaps longer than maxGapSec and keeps original t per active second', () => {
    const s: StreamSample[] = [];
    for (let t = 0; t < 5; t++) s.push({ t, watts: 100, hr: 120 });
    for (let t = 100; t < 105; t++) s.push({ t, watts: 200, hr: 150 });
    const g = resampleTo1Hz(s); // default maxGapSec = 10
    expect(g.durationSec).toBe(10);
    expect(g.watts).toEqual([100, 100, 100, 100, 100, 200, 200, 200, 200, 200]);
    expect(g.t).toEqual([0, 1, 2, 3, 4, 100, 101, 102, 103, 104]);
  });

  it('holds across a gap when the gap is within maxGapSec', () => {
    const s: StreamSample[] = [
      { t: 0, watts: 100 },
      { t: 10, watts: 200 },
    ];
    expect(resampleTo1Hz(s, 10).durationSec).toBe(11); // dt = 10 is not > 10: held
    expect(resampleTo1Hz(s, 9).durationSec).toBe(2); // dt = 10 > 9: collapsed
  });

  it('treats missing/invalid watts as 0 W and excludes them from power coverage', () => {
    const s: StreamSample[] = [
      { t: 0, watts: 200, hr: 120 },
      { t: 1, watts: null, hr: 120 },
      { t: 2, hr: 120 },
      { t: 3, watts: -5, hr: 120 },
      { t: 4, watts: Number.NaN, hr: 120 },
      { t: 5, watts: 0, hr: 120 }, // a recorded 0 is valid (coasting)
    ];
    const g = resampleTo1Hz(s);
    expect(g.watts).toEqual([200, 0, 0, 0, 0, 0]);
    expect(g.powerCoverage).toBeCloseTo(2 / 6, 12);
    expect(g.hrCoverage).toBe(1);
  });

  it('marks missing/invalid HR as null and excludes it from HR coverage', () => {
    const s: StreamSample[] = [
      { t: 0, watts: 100, hr: 140 },
      { t: 1, watts: 100, hr: null },
      { t: 2, watts: 100 },
      { t: 3, watts: 100, hr: 0 },
      { t: 4, watts: 100, hr: Number.POSITIVE_INFINITY },
    ];
    const g = resampleTo1Hz(s);
    expect(g.hr).toEqual([140, null, null, null, null]);
    expect(g.hrCoverage).toBeCloseTo(0.2, 12);
  });

  it('averages a partially-missing bucket over its valid part only', () => {
    const s: StreamSample[] = [
      { t: 0, watts: 240, hr: 150 },
      { t: 0.5, watts: null, hr: null },
      { t: 1, watts: 100, hr: 100 },
    ];
    const g = resampleTo1Hz(s);
    expect(g.watts).toEqual([240, 100]);
    expect(g.hr).toEqual([150, 100]);
    expect(g.powerCoverage).toBeCloseTo(1.5 / 2, 12);
  });

  it('lets the later of two duplicate timestamps win', () => {
    const integer: StreamSample[] = [
      { t: 0, watts: 100 },
      { t: 0, watts: 300 },
      { t: 1, watts: 200 },
    ];
    expect(resampleTo1Hz(integer).watts).toEqual([300, 200]);

    // A fractional duplicate exercises the zero-overlap path inside a bucket.
    const fractional: StreamSample[] = [
      { t: 0, watts: 100 },
      { t: 0.5, watts: 999 },
      { t: 0.5, watts: 300 },
      { t: 1, watts: 200 },
    ];
    expect(resampleTo1Hz(fractional).watts).toEqual([200, 200]);
  });

  it('is robust to float drift from fractional sampling (10 Hz for an hour)', () => {
    const s: StreamSample[] = [];
    for (let i = 0; i < 36_000; i++) s.push({ t: i / 10, watts: 200, hr: 140 });
    const g = resampleTo1Hz(s);
    // 35 999 × 0.1 s + 1 s nominal hold on the last sample = 3600.9 s → 3601 buckets.
    expect(g.watts).toHaveLength(3601);
    expect(g.durationSec).toBeCloseTo(3600.9, 6);
    for (const w of g.watts) expect(w).toBeCloseTo(200, 9);
  });

  it('folds a float overshoot past the last bucket back into it', () => {
    // Total = 1.0000001 + 1 = 2.0000001 s, within EPS of 2, so the grid has 2 buckets and the
    // last hold's 1e-7 s tail (which would be bucket 2) is folded into bucket 1.
    const s: StreamSample[] = [
      { t: 0, watts: 100 },
      { t: 1.0000001, watts: 300 },
    ];
    const g = resampleTo1Hz(s);
    expect(g.watts).toHaveLength(2);
    expect(g.watts[0]).toBe(100);
    expect(g.watts[1]).toBeCloseTo(300, 4);
  });

  it('rejects an invalid maxGapSec', () => {
    expect(() => resampleTo1Hz([], 0.5)).toThrow(RangeError);
    expect(() => resampleTo1Hz([], Number.NaN)).toThrow(RangeError);
  });
});

describe('sample validity', () => {
  it('accepts finite non-negative watts and finite positive HR', () => {
    expect(isValidWatts(0)).toBe(true);
    expect(isValidWatts(250)).toBe(true);
    expect(isValidWatts(-1)).toBe(false);
    expect(isValidWatts(null)).toBe(false);
    expect(isValidWatts(undefined)).toBe(false);
    expect(isValidHr(60)).toBe(true);
    expect(isValidHr(0)).toBe(false);
    expect(isValidHr(Number.NaN)).toBe(false);
  });
});
