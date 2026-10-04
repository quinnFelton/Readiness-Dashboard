/**
 * Activity-effort derivers (PLAN §8.8): different ways of turning one raw stream into
 * `activity_efforts` scalars. Every registered deriver runs on every qualifying activity, on
 * the single already-fetched stream, so adding one costs no extra provider API calls.
 * Each deriver's rows are tagged with its `id` (`activity_efforts.deriver_id`); only the
 * `is_default` deriver feeds what users see.
 */
import { type ActivityEffort, type EffortOptions, deriveActivityEffort } from './effort';
import { type Strategy, StrategyRegistry } from './registry';
import type { StreamSample } from './stream';

export interface ActivityEffortDeriver extends Strategy {
  derive(stream: readonly StreamSample[], opts?: Partial<EffortOptions>): ActivityEffort;
}

/** Baseline method: best rolling 20-min power with HR from the same window (PLAN §8.1). */
export const PEAK20_V1: ActivityEffortDeriver = Object.freeze({
  id: 'peak20_v1',
  description: 'Best rolling 20-min power with matched-window HR (PLAN §8.1)',
  derive: (stream: readonly StreamSample[], opts?: Partial<EffortOptions>) =>
    deriveActivityEffort(stream, opts),
});

/** Matches the seeded `derivers.is_default` row; the DB flag is authoritative at runtime. */
export const DEFAULT_DERIVER_ID = PEAK20_V1.id;

/**
 * A fresh registry with the built-in derivers. Add variants (A1, A2, ...) here as they land,
 * AND add a `derivers` row in a migration: `activity_efforts.deriver_id` references it.
 */
export function createDeriverRegistry(): StrategyRegistry<ActivityEffortDeriver> {
  return new StrategyRegistry<ActivityEffortDeriver>('deriver', [PEAK20_V1]);
}
