/**
 * End-to-end PLAN §8.5 scenarios through the public API only:
 * stream → deriveActivityEffort → rollingBaseline → recoveryTrend → classifyFatigueFitness.
 */
import { describe, expect, it } from 'vitest';
import { addDays, dailySeries } from './__fixtures__/series';
import {
  DEFAULT_BASELINE_WINDOWS,
  DEFAULT_CLASSIFIER_CONFIG,
  classifyFatigueFitness,
  deriveActivityEffort,
  recoveryTrend,
  rollingBaseline,
  type SeriesPoint,
  type StreamSample,
} from './index';

const ASOF = '2026-10-04';
const W = DEFAULT_BASELINE_WINDOWS;
const POWER = 250;
const RIDE_SEC = 1500;

/**
 * A 25-minute ride at a perfectly constant 250 W whose HR drifts linearly from `baseHr`
 * to `baseHr + driftBpm` (cardiac drift / decoupling).
 */
function driftRide(baseHr: number, driftBpm: number): StreamSample[] {
  const s: StreamSample[] = [];
  for (let t = 0; t < RIDE_SEC; t++) {
    s.push({ t, watts: POWER, hr: baseHr + (driftBpm * t) / RIDE_SEC });
  }
  return s;
}

/** Small deterministic day-to-day wobble so the 28-day baseline has spread. */
const wobble = (age: number) => [0, 2, -2][age % 3]!;

/**
 * 28 days of rides ending at ASOF. One ride a day, plus a second ride on even-age days in
 * the last two weeks (multi-ride days, PLAN §8.4). Returns per-activity EF points.
 */
function efHistory(driftForAge: (age: number) => number) {
  const peak20: SeriesPoint[] = [];
  const overall: SeriesPoint[] = [];
  for (let age = 27; age >= 0; age--) {
    const rides = age < 14 && age % 2 === 0 ? 2 : 1;
    for (let r = 0; r < rides; r++) {
      const e = deriveActivityEffort(driftRide(140 + wobble(age) + r, driftForAge(age)));
      if (!e.qualifies || e.efPeak20 === null || e.efOverall === null) {
        throw new Error('fixture ride should qualify');
      }
      const date = addDays(ASOF, -age);
      peak20.push({ date, value: e.efPeak20 });
      overall.push({ date, value: e.efOverall });
    }
  }
  return { peak20, overall };
}

// Decoupling worsens in the last week (drift 5 → 25 bpm): EF falls at constant power.
const decoupling = efHistory((age) => (age < 7 ? 25 : 5));
// Drift shrinks in the last week (25 → 5 bpm): more power per beat, EF rises.
const coupling = efHistory((age) => (age < 7 ? 5 : 25));

const hrvStable = dailySeries(ASOF, 28, (age) => 60 + (age % 2 === 0 ? -2 : 2));
const rhrStable = dailySeries(ASOF, 28, (age) => 50 + (age % 2 === 0 ? -1 : 1));
const hrvFalling = dailySeries(ASOF, 28, (age) => (age < 7 ? 48 : 60 + (age % 2 === 0 ? -2 : 2)));
const rhrRising = dailySeries(ASOF, 28, (age) => (age < 7 ? 56 : 50 + (age % 2 === 0 ? -1 : 1)));

const stableRecovery = recoveryTrend(
  rollingBaseline(hrvStable, W, ASOF),
  rollingBaseline(rhrStable, W, ASOF),
);
const fallingRecovery = recoveryTrend(
  rollingBaseline(hrvFalling, W, ASOF),
  rollingBaseline(rhrRising, W, ASOF),
);

describe('PLAN §8.5 fixture 3: multi-day HR drift at constant power', () => {
  it('keeps per-activity granularity on multi-ride days', () => {
    const b = rollingBaseline(decoupling.peak20, W, ASOF);
    // Short window, ages 0–6: 7 days + second rides at ages 0, 2, 4, 6 = 11 activities.
    expect(b.shortCount).toBe(11);
    // All 28 days + 7 second rides (ages 0, 2, …, 12) = 35 activities.
    expect(b.longCount).toBe(35);
  });

  it('sees EF falling when drift worsens and rising when it shrinks, in both EF series', () => {
    const dz = DEFAULT_CLASSIFIER_CONFIG.efDeadZone;
    for (const series of [decoupling.peak20, decoupling.overall]) {
      expect(rollingBaseline(series, W, ASOF).z!).toBeLessThan(-dz);
    }
    for (const series of [coupling.peak20, coupling.overall]) {
      expect(rollingBaseline(series, W, ASOF).z!).toBeGreaterThan(dz);
    }
  });

  it('sanity-checks the paired recovery fixtures', () => {
    expect(stableRecovery.direction).toBe('flat');
    expect(fallingRecovery.direction).toBe('down');
  });

  it('EF falling + recovery falling → acute_fatigue', () => {
    const c = classifyFatigueFitness(rollingBaseline(decoupling.peak20, W, ASOF), fallingRecovery);
    expect(c.state).toBe('acute_fatigue');
  });

  it('EF falling + recovery stable → ambiguous (not auto-labelled as fatigue)', () => {
    const c = classifyFatigueFitness(rollingBaseline(decoupling.peak20, W, ASOF), stableRecovery);
    expect(c.state).toBe('ambiguous');
  });

  it('EF rising + recovery falling → overreaching_risk', () => {
    const c = classifyFatigueFitness(rollingBaseline(coupling.peak20, W, ASOF), fallingRecovery);
    expect(c.state).toBe('overreaching_risk');
  });

  it('EF rising + recovery stable → fitness_gain', () => {
    const c = classifyFatigueFitness(rollingBaseline(coupling.peak20, W, ASOF), stableRecovery);
    expect(c.state).toBe('fitness_gain');
  });
});

describe('PLAN §8.5 fixture 4: missing data → abstain', () => {
  const strongEf = rollingBaseline(coupling.peak20, W, ASOF);

  it('no HRV connected yet: abstains despite a strong EF trend and resting-HR data', () => {
    const recovery = recoveryTrend(null, rollingBaseline(rhrRising, W, ASOF));
    const c = classifyFatigueFitness(strongEf, recovery);
    expect(c.state).toBe('insufficient_data');
    expect(c.efDirection).toBe('up');
    expect(c.insightText).toContain('no HRV data');
  });

  it('HRV connected only a few days ago: abstains on too few readings', () => {
    const recent = dailySeries(ASOF, 3, () => 55);
    const recovery = recoveryTrend(
      rollingBaseline(recent, W, ASOF),
      rollingBaseline(rhrStable, W, ASOF),
    );
    expect(classifyFatigueFitness(strongEf, recovery).state).toBe('insufficient_data');
  });

  it('a new rider with only a handful of rides: abstains on EF', () => {
    const fewRides = coupling.peak20.slice(-3);
    const c = classifyFatigueFitness(rollingBaseline(fewRides, W, ASOF), stableRecovery);
    expect(c.state).toBe('insufficient_data');
    expect(c.efZ).toBeNull();
  });

  it('a long break from riding (nothing in the last 7 days): abstains on EF', () => {
    const stale = coupling.peak20.filter((p) => p.date <= addDays(ASOF, -7));
    const c = classifyFatigueFitness(rollingBaseline(stale, W, ASOF), stableRecovery);
    expect(c.state).toBe('insufficient_data');
  });
});
