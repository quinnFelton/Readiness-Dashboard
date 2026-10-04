import { describe, expect, it } from 'vitest';
import { rollingBaseline } from './baseline';
import { recoveryTrend } from './classifier';
import type { BaselineResult } from './baseline';

const W = { shortDays: 7, longDays: 28 };

describe('rollingBaseline window edges', () => {
  it('7-day window is asOf-6..asOf; asOf-7 is outside short but inside long', () => {
    const r = rollingBaseline(
      [
        { date: '2026-03-10', value: 10 }, // age 0
        { date: '2026-03-04', value: 20 }, // age 6 -> short
        { date: '2026-03-03', value: 30 }, // age 7 -> long only
        { date: '2026-02-10', value: 40 }, // age 28 -> outside
        { date: '2026-03-11', value: 99 }, // future -> ignored
      ],
      W,
      '2026-03-10',
    );
    expect(r.shortCount).toBe(2);
    expect(r.shortMean).toBe(15);
    expect(r.longCount).toBe(3);
    expect(r.longMean).toBe(20);
    // sample sd of 10,20,30 = 10; z = (15-20)/10
    expect(r.longStdDev).toBeCloseTo(10, 10);
    expect(r.z).toBeCloseTo(-0.5, 10);
  });

  it('empty series yields nulls', () => {
    const r = rollingBaseline([], W, '2026-03-10');
    expect(r.z).toBeNull();
    expect(r.shortMean).toBeNull();
  });

  it('rejects impossible dates', () => {
    expect(() => rollingBaseline([], W, '2026-02-30')).toThrow();
  });
});

describe('recoveryTrend sign convention', () => {
  const mk = (z: number): BaselineResult => ({
    asOf: '2026-03-10',
    shortMean: 0,
    shortCount: 10,
    longMean: 0,
    longStdDev: 1,
    longCount: 30,
    z,
  });
  it('HRV up + RHR down is positive recovery', () => {
    const r = recoveryTrend(mk(1), mk(-1));
    expect(r.z).toBe(1);
    expect(r.direction).toBe('up');
  });
  it('HRV down + RHR up is negative recovery', () => {
    const r = recoveryTrend(mk(-2), mk(0));
    expect(r.z).toBe(-1);
    expect(r.direction).toBe('down');
  });
  it('abstains when one signal is missing by default', () => {
    expect(recoveryTrend(null, mk(1)).direction).toBeNull();
  });
});
