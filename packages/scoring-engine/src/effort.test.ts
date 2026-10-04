import { describe, expect, it } from 'vitest';
import { junk, segments, steadyRide } from './__fixtures__/streams';
import {
  DEFAULT_EFFORT_OPTIONS,
  deriveActivityEffort,
  resolveEffortOptions,
  type QualifyingEffort,
} from './effort';
import { DERIVATION_VERSION } from './version';

function qualifying(e: ReturnType<typeof deriveActivityEffort>): QualifyingEffort {
  if (!e.qualifies) throw new Error(`expected a qualifying effort, got ${e.reason}`);
  return e;
}

describe('deriveActivityEffort', () => {
  it('derives every scalar for a clean steady-state ride (PLAN §8.5 fixture 1)', () => {
    // 60 min @ 200 W, HR 140. NP = avg = peak20 = 200, EF = 200/140 = 1.4285714…
    const e = qualifying(deriveActivityEffort(steadyRide(3600, 200, 140)));
    expect(e.durationSec).toBe(3600);
    expect(e.avgPower).toBe(200);
    expect(e.avgHr).toBe(140);
    expect(e.normalizedPower).toBeCloseTo(200, 9);
    expect(e.peak20Power).toBe(200);
    expect(e.peak20AvgHr).toBe(140);
    expect(e.peak20StartT).toBe(0);
    expect(e.peak20EndT).toBe(1200);
    expect(e.efOverall).toBeCloseTo(1.4285714285714286, 9);
    expect(e.efPeak20).toBeCloseTo(1.4285714285714286, 12);
    expect(e.powerCoverage).toBe(1);
    expect(e.hrCoverage).toBe(1);
    expect(e.derivationVersion).toBe(DERIVATION_VERSION);
  });

  it('isolates a threshold effort in junk miles and keeps peak20 HR on that window (fixture 2)', () => {
    const s = segments([...junk(900, 125), { sec: 1200, watts: 300, hr: 165 }, ...junk(1500, 130)]);
    const e = qualifying(deriveActivityEffort(s));
    expect(e.peak20Power).toBe(300);
    expect(e.peak20AvgHr).toBe(165);
    expect(e.peak20StartT).toBe(900);
    expect(e.peak20EndT).toBe(2100);
    expect(e.efPeak20).toBeCloseTo(300 / 165, 12);
    // Whole-ride HR = (900·125 + 1200·165 + 1500·130) / 3600 = 505 500 / 3600 = 140.41666…
    expect(e.avgHr).toBeCloseTo(140.41666666666666, 9);
    expect(e.efOverall).toBeCloseTo(e.normalizedPower! / e.avgHr, 12);
    // avg power: junk pattern mean is 138.75 W over full 80 s cycles.
    // 900 s = 11 cycles + 20 s (100,160); 1500 s = 18 cycles + 60 s (100,160,220,130,0,190).
    const junkWork = 11 * 80 * 138.75 + 10 * (100 + 160) + 18 * 80 * 138.75 + 10 * 800;
    expect(e.avgPower).toBeCloseTo((junkWork + 1200 * 300) / 3600, 9);
  });

  it('rejects an empty stream', () => {
    expect(deriveActivityEffort([])).toMatchObject({ qualifies: false, reason: 'empty_stream' });
  });

  it('applies the minimum duration at the boundary (≥ 20 min qualifies)', () => {
    expect(deriveActivityEffort(steadyRide(1199, 200, 140))).toMatchObject({
      qualifies: false,
      reason: 'too_short',
      durationSec: 1199,
    });
    expect(deriveActivityEffort(steadyRide(1200, 200, 140)).qualifies).toBe(true);
  });

  it('measures duration in active time, collapsing a café-stop recording gap', () => {
    const s = [...steadyRide(900, 200, 140), ...steadyRide(900, 200, 140, 900 + 1800)];
    const e = qualifying(deriveActivityEffort(s));
    expect(e.durationSec).toBe(1800);
    expect(e.peak20StartT).toBe(0);
    expect(e.peak20EndT).toBe(2700 + 300);
  });

  it('rejects rides with too little power coverage', () => {
    const s = segments([
      { sec: 1700, watts: 200, hr: 140 },
      { sec: 300, watts: null, hr: 140 }, // 85 % coverage < 90 %
    ]);
    expect(deriveActivityEffort(s)).toMatchObject({ qualifies: false, reason: 'insufficient_power' });
    expect(deriveActivityEffort(s, { minPowerCoverage: 0.8 }).qualifies).toBe(true);
  });

  it('rejects a ride with no power even when the minimum coverage is 0', () => {
    const s = steadyRide(1200, Number.NaN, 140);
    expect(deriveActivityEffort(s, { minPowerCoverage: 0 })).toMatchObject({
      reason: 'insufficient_power',
      powerCoverage: 0,
    });
  });

  it('rejects rides with too little HR coverage, including none at all', () => {
    const partial = segments([
      { sec: 1700, watts: 200, hr: 140 },
      { sec: 300, watts: 200, hr: null },
    ]);
    expect(deriveActivityEffort(partial)).toMatchObject({ reason: 'insufficient_hr' });
    const none = segments([{ sec: 1200, watts: 200, hr: null }]);
    expect(deriveActivityEffort(none, { minHrCoverage: 0 })).toMatchObject({
      reason: 'insufficient_hr',
      hrCoverage: 0,
    });
  });

  it('nulls peak20 HR/EF when the peak window itself lacks HR coverage', () => {
    // 6000 s ride; HR missing for the first 600 s of the 300 W effort.
    // Ride HR coverage = 5400/6000 = 0.9 (passes); window coverage = 0.5 (fails).
    const s = segments([
      ...junk(2400, 130),
      { sec: 600, watts: 300, hr: null },
      { sec: 600, watts: 300, hr: 165 },
      ...junk(2400, 130),
    ]);
    const e = qualifying(deriveActivityEffort(s));
    expect(e.peak20Power).toBe(300);
    expect(e.peak20StartT).toBe(2400);
    expect(e.peak20AvgHr).toBeNull();
    expect(e.efPeak20).toBeNull();
    expect(e.efOverall).not.toBeNull();
  });

  it('nulls peak20 HR/EF when the peak window has no HR at all', () => {
    const s = segments([
      ...junk(2400, 130),
      { sec: 1200, watts: 300, hr: null },
      ...junk(2400, 130),
    ]);
    const e = qualifying(deriveActivityEffort(s, { minHrCoverage: 0.6 }));
    expect(e.peak20AvgHr).toBeNull();
    expect(e.efPeak20).toBeNull();
  });

  it('returns null NP/peak20 when a lowered minimum admits a ride too short to compute them', () => {
    const tiny = qualifying(deriveActivityEffort(steadyRide(20, 200, 140), { minDurationSec: 10 }));
    expect(tiny.normalizedPower).toBeNull();
    expect(tiny.efOverall).toBeNull();
    expect(tiny.peak20Power).toBeNull();
    expect(tiny.peak20AvgHr).toBeNull();
    expect(tiny.peak20StartT).toBeNull();
    expect(tiny.peak20EndT).toBeNull();
    expect(tiny.efPeak20).toBeNull();

    const short = qualifying(deriveActivityEffort(steadyRide(600, 200, 140), { minDurationSec: 60 }));
    expect(short.normalizedPower).toBeCloseTo(200, 9);
    expect(short.efOverall).toBeCloseTo(200 / 140, 9);
    expect(short.peak20Power).toBeNull();
  });
});

describe('effort options', () => {
  it('has frozen PLAN §8.1 defaults', () => {
    expect(DEFAULT_EFFORT_OPTIONS).toEqual({
      minDurationSec: 1200,
      maxGapSec: 10,
      minPowerCoverage: 0.9,
      minHrCoverage: 0.9,
    });
    expect(Object.isFrozen(DEFAULT_EFFORT_OPTIONS)).toBe(true);
  });

  it('merges partial overrides over the defaults', () => {
    expect(resolveEffortOptions({ minHrCoverage: 0.5 })).toEqual({
      ...DEFAULT_EFFORT_OPTIONS,
      minHrCoverage: 0.5,
    });
    expect(resolveEffortOptions()).toEqual(DEFAULT_EFFORT_OPTIONS);
  });

  it('rejects invalid thresholds', () => {
    expect(() => resolveEffortOptions({ minDurationSec: -1 })).toThrow(RangeError);
    expect(() => resolveEffortOptions({ minDurationSec: Number.NaN })).toThrow(RangeError);
    expect(() => resolveEffortOptions({ minDurationSec: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
    expect(() => resolveEffortOptions({ minPowerCoverage: 1.5 })).toThrow(RangeError);
    expect(() => resolveEffortOptions({ minHrCoverage: -0.1 })).toThrow(RangeError);
    expect(() => deriveActivityEffort([], { maxGapSec: 0 })).toThrow(RangeError);
  });
});
