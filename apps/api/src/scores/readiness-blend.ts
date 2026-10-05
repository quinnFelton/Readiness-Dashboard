import type { ReadinessWeights } from '../fatigue-fitness/config';

// PLAN §8.6: a light, explicitly secondary blend of one day's recovery metrics. Kept as a small pure
// function here (it is not part of the EF-vs-recovery analytic); z-scores come from the engine's
// rollingBaseline, so no statistics are re-implemented.

/** Neutral 50 ± pointsPerZ per z-unit, clamped to 0-100. z = 0 (at baseline) → 50. */
export function zToScore(z: number, pointsPerZ: number): number {
  return Math.min(100, Math.max(0, 50 + pointsPerZ * z));
}

export interface ReadinessComponents {
  /** Each 0-100, or null/undefined when unavailable that day. */
  hrv?: number | null;
  restingHr?: number | null;
  sleep?: number | null;
}

export interface ReadinessBlend {
  score: number;
  /** Effective (renormalised) weights over the components that were present. */
  weights: Partial<Record<keyof ReadinessWeights, number>>;
  components: Partial<Record<keyof ReadinessWeights, number>>;
}

/**
 * Weighted mean over available components; weights are renormalised across what's present so a
 * missing sleep score doesn't drag the day down. null if nothing is available (no score that day).
 */
export function blendReadiness(
  components: ReadinessComponents,
  weights: ReadinessWeights,
): ReadinessBlend | null {
  const present: (keyof ReadinessWeights)[] = [];
  for (const k of ['hrv', 'restingHr', 'sleep'] as const) {
    const v = components[k];
    if (typeof v === 'number' && Number.isFinite(v) && weights[k] > 0) present.push(k);
  }
  if (present.length === 0) return null;
  const total = present.reduce((s, k) => s + weights[k], 0);
  let score = 0;
  const eff: ReadinessBlend['weights'] = {};
  const comps: ReadinessBlend['components'] = {};
  for (const k of present) {
    const w = weights[k] / total;
    eff[k] = Math.round(w * 1e6) / 1e6;
    comps[k] = components[k] as number;
    score += w * (components[k] as number);
  }
  return { score: Math.round(score * 100) / 100, weights: eff, components: comps };
}
