import { describe, expect, it } from 'vitest';
import type { BaselineResult } from './baseline';
import {
  DEFAULT_CLASSIFIER_CONFIG,
  classifyFatigueFitness,
  directionFromZ,
  formatZ,
  recoveryTrend,
  validateClassifierConfig,
  type ClassifierConfig,
} from './classifier';

const CFG = DEFAULT_CLASSIFIER_CONFIG;

/** A baseline with plenty of points and the given z. */
function b(z: number | null, shortCount = 7, longCount = 28): BaselineResult {
  return {
    asOf: '2026-10-04',
    shortMean: 1,
    shortCount,
    longMean: 1,
    longStdDev: z === null ? 0 : 1,
    longCount,
    z,
  };
}

/** Recovery trend whose combined z is exactly `z` (HRV z = z, resting-HR z = −z). */
function rec(z: number) {
  return recoveryTrend(b(z), b(-z));
}

describe('directionFromZ (dead zone)', () => {
  it('treats the boundary itself as flat and anything beyond it as a direction', () => {
    expect(directionFromZ(0.5, 0.5)).toBe('flat');
    expect(directionFromZ(-0.5, 0.5)).toBe('flat');
    expect(directionFromZ(0.5000001, 0.5)).toBe('up');
    expect(directionFromZ(-0.5000001, 0.5)).toBe('down');
    expect(directionFromZ(0, 0.5)).toBe('flat');
  });

  it('with a zero dead zone only an exact 0 is flat', () => {
    expect(directionFromZ(0, 0)).toBe('flat');
    expect(directionFromZ(1e-9, 0)).toBe('up');
    expect(directionFromZ(-1e-9, 0)).toBe('down');
  });
});

describe('recoveryTrend', () => {
  it('combines HRV and resting HR with one sign convention: mean(hrvZ, −rhrZ)', () => {
    const r = recoveryTrend(b(1.0), b(-0.6));
    expect(r.z).toBeCloseTo(0.8, 12);
    expect(r.direction).toBe('up');
    expect(r).toMatchObject({ hrvZ: 1.0, restingHrZ: -0.6, problems: [] });
  });

  it('reads falling HRV and rising resting HR as recovery down', () => {
    expect(recoveryTrend(b(-1.2), b(1.0)).direction).toBe('down');
  });

  it('lets opposing signals cancel to flat', () => {
    const r = recoveryTrend(b(1.0), b(1.0)); // HRV up (good) but RHR up (bad)
    expect(r.z).toBe(0);
    expect(r.direction).toBe('flat');
  });

  it('abstains when HRV is not connected (default requires both signals)', () => {
    const r = recoveryTrend(null, b(-2));
    expect(r.direction).toBeNull();
    expect(r.z).toBeNull();
    expect(r.restingHrZ).toBe(-2);
    expect(r.problems).toEqual(['no HRV data']);
  });

  it('uses a single signal only when the config allows it', () => {
    const cfg = { ...CFG, allowSingleRecoverySignal: true };
    const rhrOnly = recoveryTrend(null, b(1.0), cfg);
    expect(rhrOnly.z).toBe(-1.0);
    expect(rhrOnly.direction).toBe('down');
    const hrvOnly = recoveryTrend(b(0.7), null, cfg);
    expect(hrvOnly.direction).toBe('up');
    const neither = recoveryTrend(null, null, cfg);
    expect(neither.direction).toBeNull();
    expect(neither.problems).toEqual(['no HRV data', 'no resting HR data']);
  });

  it('abstains when a signal has too few points, saying how many it has', () => {
    const r = recoveryTrend(b(1, 3, 28), b(1, 7, 13));
    expect(r.direction).toBeNull();
    expect(r.problems).toEqual([
      'HRV: short window has 3 (needs 4), long window has 28 (needs 14)',
      'resting HR: short window has 7 (needs 4), long window has 13 (needs 14)',
    ]);
  });

  it('abstains when a baseline has no spread (z null)', () => {
    const r = recoveryTrend(b(null), b(0));
    expect(r.direction).toBeNull();
    expect(r.problems).toEqual(['HRV baseline has no spread to compare against']);
  });

  it('applies the recovery dead zone', () => {
    expect(rec(0.5).direction).toBe('flat');
    expect(rec(0.51).direction).toBe('up');
    expect(rec(-0.5).direction).toBe('flat');
    expect(rec(-0.51).direction).toBe('down');
  });
});

describe('classifyFatigueFitness: quadrants (PLAN §8.3)', () => {
  it('EF up + recovery up → fitness_gain', () => {
    const c = classifyFatigueFitness(b(1.2), rec(0.8));
    expect(c).toMatchObject({
      state: 'fitness_gain',
      efDirection: 'up',
      recoveryDirection: 'up',
      efZ: 1.2,
    });
    expect(c.recoveryZ).toBeCloseTo(0.8, 12);
    expect(c.insightText).toBe(
      'Efficiency rising (EF z +1.2) with recovery improving (z +0.8): fitness gain. ' +
        "Aerobic efficiency is improving while you're well recovered.",
    );
  });

  it('EF up + recovery stable → fitness_gain', () => {
    const c = classifyFatigueFitness(b(1.2), rec(0.1));
    expect(c.state).toBe('fitness_gain');
    expect(c.insightText).toContain('recovery stable (z +0.1)');
  });

  it('EF up + recovery down → overreaching_risk', () => {
    const c = classifyFatigueFitness(b(1.2), rec(-1.4));
    expect(c.state).toBe('overreaching_risk');
    expect(c.insightText).toBe(
      'Efficiency rising (EF z +1.2) while recovery falling (z −1.4): overreaching risk. ' +
        'Output is still improving, but at a rising physiological cost. Consider extra recovery.',
    );
  });

  it('EF down + recovery down → acute_fatigue', () => {
    const c = classifyFatigueFitness(b(-1.1), rec(-1.3));
    expect(c.state).toBe('acute_fatigue');
    expect(c.insightText).toContain('acute fatigue');
  });

  it('EF down + recovery stable or up → ambiguous (flag for review)', () => {
    for (const z of [0, 1.5]) {
      const c = classifyFatigueFitness(b(-1.1), rec(z));
      expect(c.state).toBe('ambiguous');
      expect(c.efDirection).toBe('down');
      expect(c.insightText).toContain('Worth a review');
    }
  });

  it('EF flat → steady (owner decision; PLAN §8.3 has no flat-EF row)', () => {
    const steady = classifyFatigueFitness(b(0.2), rec(0));
    expect(steady).toMatchObject({
      state: 'steady',
      efDirection: 'flat',
      recoveryDirection: 'flat',
    });
    expect(steady.insightText).toBe(
      'Efficiency steady (EF z +0.2); recovery stable (z +0.0): steady fitness and fatigue.',
    );
    expect(classifyFatigueFitness(b(-0.3), rec(1)).state).toBe('steady');
    const early = classifyFatigueFitness(b(0.2), rec(-1));
    expect(early.state).toBe('steady');
    expect(early.insightText).toContain('Recovery is falling before efficiency has moved');
  });
});

describe('classifyFatigueFitness: dead-zone boundaries', () => {
  it('EF exactly at the dead zone is flat; just beyond it is up/down', () => {
    expect(classifyFatigueFitness(b(0.5), rec(0)).efDirection).toBe('flat');
    expect(classifyFatigueFitness(b(0.5000001), rec(0)).state).toBe('fitness_gain');
    expect(classifyFatigueFitness(b(-0.5), rec(-1)).efDirection).toBe('flat');
    expect(classifyFatigueFitness(b(-0.5000001), rec(-1)).state).toBe('acute_fatigue');
  });

  it('recovery exactly at −deadZone is stable, so EF up stays fitness_gain', () => {
    expect(classifyFatigueFitness(b(1), rec(-0.5)).state).toBe('fitness_gain');
    expect(classifyFatigueFitness(b(1), rec(-0.5000001)).state).toBe('overreaching_risk');
  });

  it('uses the dead zones from the config passed to the classifier', () => {
    const wide: ClassifierConfig = { ...CFG, efDeadZone: 1.0, recoveryDeadZone: 1.0 };
    expect(classifyFatigueFitness(b(0.8), rec(0), wide).efDirection).toBe('flat');
    // Recovery z −0.7 is "down" by default but "flat" under a 1.0 dead zone.
    const r = rec(-0.7);
    expect(r.direction).toBe('down');
    expect(classifyFatigueFitness(b(1.2), r, wide).state).toBe('fitness_gain');
    expect(classifyFatigueFitness(b(1.2), r).state).toBe('overreaching_risk');
  });
});

describe('classifyFatigueFitness: abstains instead of guessing', () => {
  it('no EF trend at all', () => {
    const c = classifyFatigueFitness(null, rec(1));
    expect(c).toMatchObject({ state: 'insufficient_data', efDirection: null, efZ: null });
    expect(c.recoveryDirection).toBe('up');
    expect(c.insightText).toBe('Not enough data to classify yet: no EF data.');
  });

  it('too few qualifying rides in either window', () => {
    const fewShort = classifyFatigueFitness(b(2, 1, 28), rec(0));
    expect(fewShort.state).toBe('insufficient_data');
    expect(fewShort.insightText).toContain('EF: short window has 1 (needs 2)');
    expect(classifyFatigueFitness(b(2, 7, 5), rec(0)).state).toBe('insufficient_data');
    expect(classifyFatigueFitness(b(2, 2, 6), rec(0)).state).toBe('fitness_gain'); // at minimum
  });

  it('EF baseline without spread', () => {
    const c = classifyFatigueFitness(b(null), rec(0));
    expect(c.state).toBe('insufficient_data');
    expect(c.insightText).toContain('EF baseline has no spread');
  });

  it('recovery missing, even with a strong EF signal', () => {
    const c = classifyFatigueFitness(b(3), recoveryTrend(null, b(1)));
    expect(c).toMatchObject({
      state: 'insufficient_data',
      efDirection: 'up',
      efZ: 3,
      recoveryDirection: null,
      recoveryZ: null,
    });
    expect(c.insightText).toBe('Not enough data to classify yet: no HRV data.');
  });

  it('both sides missing lists every reason', () => {
    const c = classifyFatigueFitness(null, recoveryTrend(null, null));
    expect(c.insightText).toBe(
      'Not enough data to classify yet: no EF data; no HRV data; no resting HR data.',
    );
  });
});

describe('classifier config', () => {
  it('has frozen defaults', () => {
    expect(CFG).toEqual({
      efDeadZone: 0.5,
      recoveryDeadZone: 0.5,
      efMinShortPoints: 2,
      efMinLongPoints: 6,
      recoveryMinShortPoints: 4,
      recoveryMinLongPoints: 14,
      allowSingleRecoverySignal: false,
    });
    expect(Object.isFrozen(CFG)).toBe(true);
    expect(() => validateClassifierConfig(CFG)).not.toThrow();
  });

  it('rejects invalid values', () => {
    const bad: Partial<ClassifierConfig>[] = [
      { efDeadZone: -0.1 },
      { recoveryDeadZone: Number.NaN },
      { efMinShortPoints: 0 },
      { recoveryMinShortPoints: 1.5 },
      { efMinLongPoints: 1 },
      { recoveryMinLongPoints: 2.5 },
    ];
    for (const patch of bad) {
      const cfg = { ...CFG, ...patch };
      expect(() => validateClassifierConfig(cfg)).toThrow(RangeError);
      expect(() => classifyFatigueFitness(b(1), rec(0), cfg)).toThrow(RangeError);
      expect(() => recoveryTrend(b(1), b(1), cfg)).toThrow(RangeError);
    }
  });
});

describe('formatZ', () => {
  it('prints a signed one-decimal z without a negative zero', () => {
    expect(formatZ(1.234)).toBe('+1.2');
    expect(formatZ(-1.26)).toBe('−1.3');
    expect(formatZ(-0.04)).toBe('+0.0');
    expect(formatZ(0)).toBe('+0.0');
  });
});
