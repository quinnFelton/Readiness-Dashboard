import type { FatigueFitnessStateId } from '@rd/shared-types';

// PLAN §8.3 quadrant states. Colors are mid-tone so bands/badges read in light and dark mode.
export interface StateMeta {
  label: string;
  /** Hex used for chart bands and badge accents. */
  color: string;
  /** One-line plain-language meaning (PLAN §8.3 table). */
  summary: string;
}

export const STATE_META: Record<FatigueFitnessStateId, StateMeta> = {
  fitness_gain: {
    label: 'Fitness gain',
    color: '#16a34a',
    summary: 'Efficiency is improving while you are well recovered.',
  },
  overreaching_risk: {
    label: 'Overreaching risk',
    color: '#dc2626',
    summary: 'Output is improving, but at a rising physiological cost.',
  },
  acute_fatigue: {
    label: 'Acute fatigue',
    color: '#d97706',
    summary: 'Efficiency and recovery are both down: expected after hard training.',
  },
  ambiguous: {
    label: 'Needs review',
    color: '#7c3aed',
    summary: 'Efficiency dropped without a matching recovery signal.',
  },
  steady: {
    label: 'Steady',
    color: '#64748b',
    summary: 'Fitness and fatigue are holding steady.',
  },
  insufficient_data: {
    label: 'Not enough data',
    color: '#94a3b8',
    summary: 'We need more rides and recovery readings to classify.',
  },
};

export function isStateId(s: string | null): s is FatigueFitnessStateId {
  return s !== null && Object.prototype.hasOwnProperty.call(STATE_META, s);
}

/** A "flagged" state is one worth rating: anything that isn't steady or abstaining. */
export function isFlagged(state: string): boolean {
  return isStateId(state) && state !== 'steady' && state !== 'insufficient_data';
}
