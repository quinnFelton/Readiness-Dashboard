/**
 * EF-trend × recovery-trend quadrant classifier (PLAN §8.3, §8.4).
 *
 * Inputs are {@link BaselineResult}s from rollingBaseline(). A trend's direction comes from
 * its 7d-vs-28d z-score and a configurable dead zone (PLAN §17):
 *   z > deadZone → up,  z < −deadZone → down,  otherwise (boundary included) → flat.
 *
 * Abstention: if either side lacks enough points, or its z can't be computed, the result
 * is `insufficient_data`, never a guess (PLAN §8.4, §8.5).
 */
import type { BaselineResult } from './baseline';

export type TrendDirection = 'up' | 'down' | 'flat';

export type FatigueFitnessState =
  | 'fitness_gain'
  | 'overreaching_risk'
  | 'acute_fatigue'
  | 'ambiguous'
  | 'insufficient_data';

/** Thresholds are config, not constants (CLAUDE.md rule 9). Calibrate on real data (PLAN §17). */
export interface ClassifierConfig {
  /** |EF z| at or below this counts as flat. */
  efDeadZone: number;
  /** |combined recovery z| at or below this counts as flat. */
  recoveryDeadZone: number;
  /** Minimum qualifying activities in the short (7 d) window. */
  efMinShortPoints: number;
  /** Minimum qualifying activities in the long (28 d) window. Must be ≥ 2. */
  efMinLongPoints: number;
  /** Minimum daily readings per recovery signal in the short window. */
  recoveryMinShortPoints: number;
  /** Minimum daily readings per recovery signal in the long window. Must be ≥ 2. */
  recoveryMinLongPoints: number;
  /**
   * If false (default), recovery needs BOTH HRV and resting HR, and abstains when either
   * is missing (e.g. "no HRV connected yet", PLAN §8.5). If true, one signal is enough.
   */
  allowSingleRecoverySignal: boolean;
}

export const DEFAULT_CLASSIFIER_CONFIG: Readonly<ClassifierConfig> = Object.freeze({
  efDeadZone: 0.5,
  recoveryDeadZone: 0.5,
  efMinShortPoints: 2,
  efMinLongPoints: 6,
  recoveryMinShortPoints: 4,
  recoveryMinLongPoints: 14,
  allowSingleRecoverySignal: false,
});

export function validateClassifierConfig(c: ClassifierConfig): void {
  for (const key of ['efDeadZone', 'recoveryDeadZone'] as const) {
    if (!Number.isFinite(c[key]) || c[key] < 0) {
      throw new RangeError(`${key} must be a finite number >= 0`);
    }
  }
  for (const key of ['efMinShortPoints', 'recoveryMinShortPoints'] as const) {
    if (!Number.isInteger(c[key]) || c[key] < 1) {
      throw new RangeError(`${key} must be an integer >= 1`);
    }
  }
  // A std dev needs at least two points.
  for (const key of ['efMinLongPoints', 'recoveryMinLongPoints'] as const) {
    if (!Number.isInteger(c[key]) || c[key] < 2) {
      throw new RangeError(`${key} must be an integer >= 2`);
    }
  }
}

export function directionFromZ(z: number, deadZone: number): TrendDirection {
  if (z > deadZone) return 'up';
  if (z < -deadZone) return 'down';
  return 'flat';
}

type Assessed = { z: number; problem: null } | { z: null; problem: string };

function assess(
  label: string,
  b: BaselineResult | null,
  minShort: number,
  minLong: number,
): Assessed {
  if (b === null) return { z: null, problem: `no ${label} data` };
  if (b.shortCount < minShort || b.longCount < minLong) {
    return {
      z: null,
      problem:
        `${label} has ${b.shortCount} points in the short window (needs ${minShort}) ` +
        `and ${b.longCount} in the long window (needs ${minLong})`,
    };
  }
  if (b.z === null) return { z: null, problem: `${label} baseline has no spread to compare against` };
  return { z: b.z, problem: null };
}

export interface RecoveryTrend {
  /** null = not enough data (abstain). */
  direction: TrendDirection | null;
  /** Combined recovery z. Positive = better recovered (HRV up and/or resting HR down). */
  z: number | null;
  /** HRV z as computed (positive = HRV up = better), when usable. */
  hrvZ: number | null;
  /** Resting-HR z as computed (positive = RHR up = worse), when usable. */
  restingHrZ: number | null;
  /** Why a signal couldn't be used. Empty when both were usable. */
  problems: string[];
}

/**
 * Combine HRV and resting HR into one recovery trend (PLAN §8.3). Uses one sign convention
 * (recovery up = HRV up and/or RHR down), so the combined z is the mean of the usable
 * components: mean(hrvZ, −restingHrZ). Pass null for a signal with no data source.
 */
export function recoveryTrend(
  hrvBaseline: BaselineResult | null,
  restingHrBaseline: BaselineResult | null,
  config: ClassifierConfig = DEFAULT_CLASSIFIER_CONFIG,
): RecoveryTrend {
  validateClassifierConfig(config);
  const minS = config.recoveryMinShortPoints;
  const minL = config.recoveryMinLongPoints;
  const hrv = assess('HRV', hrvBaseline, minS, minL);
  const rhr = assess('resting HR', restingHrBaseline, minS, minL);

  const components: number[] = [];
  const problems: string[] = [];
  if (hrv.problem === null) components.push(hrv.z);
  else problems.push(hrv.problem);
  if (rhr.problem === null) components.push(-rhr.z);
  else problems.push(rhr.problem);

  const enough = components.length === 2 || (components.length === 1 && config.allowSingleRecoverySignal);
  let z: number | null = null;
  if (enough) {
    z = components.reduce((s, c) => s + c, 0) / components.length;
  }
  return {
    direction: z === null ? null : directionFromZ(z, config.recoveryDeadZone),
    z,
    hrvZ: hrv.z,
    restingHrZ: rhr.z,
    problems,
  };
}

export interface Classification {
  state: FatigueFitnessState;
  /** Plain-language flag for `trends.insight_text`. */
  insightText: string;
  efDirection: TrendDirection | null;
  recoveryDirection: TrendDirection | null;
  efZ: number | null;
  recoveryZ: number | null;
}

/** Signed, 1-decimal z for insight text. Rounding first avoids printing "-0.0". */
export function formatZ(z: number): string {
  const r = Math.round(z * 10) / 10;
  return `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}`;
}

const RECOVERY_WORD: Record<TrendDirection, string> = {
  up: 'improving',
  flat: 'stable',
  down: 'falling',
};

/**
 * Cross EF direction with recovery direction (PLAN §8.3 table):
 *
 * | EF   | recovery  | state              |
 * |------|-----------|--------------------|
 * | up   | flat / up | fitness_gain       |
 * | up   | down      | overreaching_risk  |
 * | down | down      | acute_fatigue      |
 * | down | flat / up | ambiguous          |
 * | flat | any       | ambiguous (*)      |
 *
 * (*) PLAN §8.3 doesn't define a flat-EF row. We don't invent a label: it's `ambiguous`,
 * and `efDirection: 'flat'` plus the insight text tell it apart from the EF-down case.
 * This is listed for Quinn to confirm.
 *
 * `efTrend` should be the ef_peak20 baseline, the primary signal per PLAN §8.2.
 */
export function classifyFatigueFitness(
  efTrend: BaselineResult | null,
  recovery: RecoveryTrend,
  config: ClassifierConfig = DEFAULT_CLASSIFIER_CONFIG,
): Classification {
  validateClassifierConfig(config);
  const ef = assess('EF', efTrend, config.efMinShortPoints, config.efMinLongPoints);

  if (ef.problem !== null || recovery.z === null) {
    const reasons = [...(ef.problem === null ? [] : [ef.problem]), ...recovery.problems];
    return {
      state: 'insufficient_data',
      insightText: `Not enough data to classify yet: ${reasons.join('; ')}.`,
      efDirection: ef.z === null ? null : directionFromZ(ef.z, config.efDeadZone),
      recoveryDirection: recovery.direction,
      efZ: ef.z,
      recoveryZ: recovery.z,
    };
  }

  const efDir = directionFromZ(ef.z, config.efDeadZone);
  // Re-derive from z so the dead zone in *this* config always applies.
  const recDir = directionFromZ(recovery.z, config.recoveryDeadZone);
  const efPart = `(EF z ${formatZ(ef.z)})`;
  const recPart = `recovery ${RECOVERY_WORD[recDir]} (z ${formatZ(recovery.z)})`;

  let state: FatigueFitnessState;
  let insightText: string;
  if (efDir === 'up' && recDir !== 'down') {
    state = 'fitness_gain';
    insightText =
      `Efficiency rising ${efPart} with ${recPart}: fitness gain. ` +
      `Aerobic efficiency is improving while you're well recovered.`;
  } else if (efDir === 'up') {
    state = 'overreaching_risk';
    insightText =
      `Efficiency rising ${efPart} while ${recPart}: overreaching risk. ` +
      `Output is still improving, but at a rising physiological cost. Consider extra recovery.`;
  } else if (efDir === 'down' && recDir === 'down') {
    state = 'acute_fatigue';
    insightText =
      `Efficiency falling ${efPart} with ${recPart}: acute fatigue. ` +
      `This is the expected response to hard training; recovery time should help.`;
  } else if (efDir === 'down') {
    state = 'ambiguous';
    insightText =
      `Efficiency falling ${efPart} without a matching recovery drop; ${recPart}. ` +
      `Could be heat, altitude, pacing, nutrition, or illness not yet showing in HRV. Worth a review.`;
  } else {
    state = 'ambiguous';
    insightText =
      `Efficiency steady ${efPart}; ${recPart}. No clear fitness or fatigue signal.` +
      (recDir === 'down' ? ' Recovery is falling before efficiency has moved, so watch the next few rides.' : '');
  }

  return {
    state,
    insightText,
    efDirection: efDir,
    recoveryDirection: recDir,
    efZ: ef.z,
    recoveryZ: recovery.z,
  };
}
