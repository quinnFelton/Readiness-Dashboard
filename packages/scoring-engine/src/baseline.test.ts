import { describe, expect, it } from 'vitest';
import { addDays, dailySeries } from './__fixtures__/series';
import { DEFAULT_BASELINE_WINDOWS, dayNumber, rollingBaseline, type SeriesPoint } from './baseline';

const ASOF = '2026-10-04';
const W = DEFAULT_BASELINE_WINDOWS;

describe('dayNumber', () => {
  it('converts YYYY-MM-DD to days since the epoch', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dayNumber('1970-01-02')).toBe(1);
    expect(dayNumber('2024-03-01') - dayNumber('2024-02-28')).toBe(2); // leap year
  });

  it('rejects malformed or impossible dates', () => {
    for (const bad of ['2026-2-01', '2026-02-30', '2026-13-01', '2026-00-10', '0050-01-01', 'x']) {
      expect(() => dayNumber(bad)).toThrow(RangeError);
    }
  });
});

describe('rollingBaseline', () => {
  it('computes a hand-checkable z for a step change in the last 7 days', () => {
    // Ages 7…27 = 10, ages 0…6 = 12.
    // long: mean = (21·10 + 7·12)/28 = 10.5; sample var = (21·0.25 + 7·2.25)/27 = 7/9
    // z = (12 − 10.5) / √(7/9) = 4.5/√7 = 1.7008401285415224
    const series = dailySeries(ASOF, 28, (age) => (age < 7 ? 12 : 10));
    const b = rollingBaseline(series, W, ASOF);
    expect(b).toMatchObject({ asOf: ASOF, shortMean: 12, shortCount: 7, longMean: 10.5, longCount: 28 });
    expect(b.longStdDev).toBeCloseTo(Math.sqrt(7 / 9), 12);
    expect(b.z).toBeCloseTo(4.5 / Math.sqrt(7), 12);
  });

  it('counts every activity on a multi-ride day separately (PLAN §8.4)', () => {
    const series: SeriesPoint[] = [
      { date: ASOF, value: 1 },
      { date: ASOF, value: 1 },
      { date: addDays(ASOF, -1), value: 4 },
    ];
    const b = rollingBaseline(series, W, ASOF);
    expect(b.shortCount).toBe(3);
    // Per-activity mean (1+1+4)/3 = 2, not the per-day mean of means (1+4)/2 = 2.5.
    expect(b.shortMean).toBe(2);
  });

  it('uses inclusive calendar windows ending at asOf and ignores future points', () => {
    const series: SeriesPoint[] = [
      { date: addDays(ASOF, 1), value: 1000 }, // future: ignored
      { date: ASOF, value: 1 }, // age 0: short + long
      { date: addDays(ASOF, -6), value: 2 }, // age 6: short + long
      { date: addDays(ASOF, -7), value: 3 }, // age 7: long only
      { date: addDays(ASOF, -27), value: 4 }, // age 27: long only
      { date: addDays(ASOF, -28), value: 1000 }, // age 28: outside both
    ];
    const b = rollingBaseline(series, W, ASOF);
    expect(b.shortCount).toBe(2);
    expect(b.shortMean).toBe(1.5);
    expect(b.longCount).toBe(4);
    expect(b.longMean).toBe(2.5);
  });

  it('can compare against the long window immediately before the short one', () => {
    // Ages 7…34 alternate 9/11 (mean 10, sample sd √(28/27)); ages 0…6 = 12.
    const series = dailySeries(ASOF, 35, (age) => (age < 7 ? 12 : age % 2 === 0 ? 9 : 11));
    const b = rollingBaseline(series, { ...W, longExcludesShort: true }, ASOF);
    expect(b.shortCount).toBe(7);
    expect(b.longCount).toBe(28);
    expect(b.longMean).toBe(10);
    expect(b.z).toBeCloseTo(2 / Math.sqrt(28 / 27), 12);
  });

  it('skips non-finite values', () => {
    const series: SeriesPoint[] = [
      { date: ASOF, value: Number.NaN },
      { date: ASOF, value: 5 },
    ];
    expect(rollingBaseline(series, W, ASOF)).toMatchObject({ shortCount: 1, shortMean: 5 });
  });

  it('returns nulls rather than numbers when there is too little data', () => {
    expect(rollingBaseline([], W, ASOF)).toEqual({
      asOf: ASOF,
      shortMean: null,
      shortCount: 0,
      longMean: null,
      longStdDev: null,
      longCount: 0,
      z: null,
    });
    // One point: a mean but no std dev, so no z.
    const one = rollingBaseline([{ date: ASOF, value: 5 }], W, ASOF);
    expect(one).toMatchObject({ shortMean: 5, longMean: 5, longStdDev: null, z: null });
    // Long-window data but nothing in the short window: no z.
    const old = rollingBaseline(dailySeries(addDays(ASOF, -10), 10, () => 5), W, ASOF);
    expect(old).toMatchObject({ shortMean: null, longCount: 10, z: null });
    // Exclusive mode with only short-window points: no long baseline.
    const shortOnly = rollingBaseline(dailySeries(ASOF, 3, () => 5), { ...W, longExcludesShort: true }, ASOF);
    expect(shortOnly).toMatchObject({ shortCount: 3, longMean: null, longCount: 0, z: null });
  });

  it('treats a perfectly flat baseline matched by the short window as z = 0', () => {
    // 0.1 is inexact in binary, so the std dev is float noise rather than exactly 0.
    const b = rollingBaseline(dailySeries(ASOF, 28, () => 0.1), W, ASOF);
    expect(b.z).toBe(0);
  });

  it('refuses an infinite z when a flat baseline is followed by a change', () => {
    const series = dailySeries(ASOF, 35, (age) => (age < 7 ? 12 : 10));
    const b = rollingBaseline(series, { ...W, longExcludesShort: true }, ASOF);
    expect(b.longStdDev).toBe(0);
    expect(b.z).toBeNull();
  });

  it('validates window sizes and dates', () => {
    expect(() => rollingBaseline([], { shortDays: 0, longDays: 28 }, ASOF)).toThrow(RangeError);
    expect(() => rollingBaseline([], { shortDays: 1.5, longDays: 28 }, ASOF)).toThrow(RangeError);
    expect(() => rollingBaseline([], { shortDays: 1, longDays: 1 }, ASOF)).toThrow(RangeError);
    expect(() => rollingBaseline([], { shortDays: 7, longDays: 6.5 }, ASOF)).toThrow(RangeError);
    expect(() => rollingBaseline([], { shortDays: 7, longDays: 3 }, ASOF)).toThrow(RangeError);
    expect(() =>
      rollingBaseline([], { shortDays: 7, longDays: 3, longExcludesShort: true }, ASOF),
    ).not.toThrow();
    expect(() => rollingBaseline([], W, '2026-10-4')).toThrow(RangeError);
    expect(() => rollingBaseline([{ date: 'bad', value: 1 }], W, ASOF)).toThrow(RangeError);
  });

  it('has frozen 7 d / 28 d defaults', () => {
    expect(DEFAULT_BASELINE_WINDOWS).toEqual({ shortDays: 7, longDays: 28 });
    expect(Object.isFrozen(DEFAULT_BASELINE_WINDOWS)).toBe(true);
  });
});
