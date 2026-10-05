import { DEFAULT_BASELINE_WINDOWS } from '@rd/scoring-engine';

// Thresholds are config, not constants (CLAUDE.md rule 9). Env vars, with defaults from the engine.
// Classifier thresholds themselves (dead zones, minimum points) live with each registered classifier
// variant in @rd/scoring-engine: an id must always mean the same method (PLAN §8.7), so a tuned
// threshold set is a new classifier id + `classifiers` row, not an env override of an existing id.

export interface ReadinessWeights {
  hrv: number;
  restingHr: number;
  sleep: number;
}

export interface FatigueFitnessConfig {
  /** Short / long baseline windows in days (PLAN §8.2). */
  shortDays: number;
  longDays: number;
  /** Secondary readiness blend (PLAN §8.6). Weights are relative; missing components are dropped. */
  readinessWeights: ReadinessWeights;
  /** Score points per z-unit around a neutral 50, for the HRV / resting-HR components. */
  readinessPointsPerZ: number;
}

export const DEFAULT_FATIGUE_FITNESS_CONFIG: Readonly<FatigueFitnessConfig> = Object.freeze({
  shortDays: DEFAULT_BASELINE_WINDOWS.shortDays,
  longDays: DEFAULT_BASELINE_WINDOWS.longDays,
  readinessWeights: Object.freeze({ hrv: 0.4, restingHr: 0.3, sleep: 0.3 }),
  readinessPointsPerZ: 20,
});

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return n;
}

export function loadFatigueFitnessConfig(
  env: NodeJS.ProcessEnv = process.env,
): FatigueFitnessConfig {
  const d = DEFAULT_FATIGUE_FITNESS_CONFIG;
  const cfg: FatigueFitnessConfig = {
    shortDays: num(env, 'BASELINE_SHORT_DAYS', d.shortDays),
    longDays: num(env, 'BASELINE_LONG_DAYS', d.longDays),
    readinessWeights: {
      hrv: num(env, 'READINESS_WEIGHT_HRV', d.readinessWeights.hrv),
      restingHr: num(env, 'READINESS_WEIGHT_RESTING_HR', d.readinessWeights.restingHr),
      sleep: num(env, 'READINESS_WEIGHT_SLEEP', d.readinessWeights.sleep),
    },
    readinessPointsPerZ: num(env, 'READINESS_POINTS_PER_Z', d.readinessPointsPerZ),
  };
  validateFatigueFitnessConfig(cfg);
  return cfg;
}

export function validateFatigueFitnessConfig(c: FatigueFitnessConfig): void {
  if (!Number.isInteger(c.shortDays) || c.shortDays < 1)
    throw new RangeError('shortDays must be an integer >= 1');
  if (!Number.isInteger(c.longDays) || c.longDays < c.shortDays || c.longDays < 2) {
    throw new RangeError('longDays must be an integer >= max(2, shortDays)');
  }
  const w = Object.values(c.readinessWeights);
  if (w.some((x) => !Number.isFinite(x) || x < 0) || w.every((x) => x === 0)) {
    throw new RangeError('readiness weights must be >= 0 and not all zero');
  }
  if (!Number.isFinite(c.readinessPointsPerZ) || c.readinessPointsPerZ <= 0) {
    throw new RangeError('readinessPointsPerZ must be > 0');
  }
}
