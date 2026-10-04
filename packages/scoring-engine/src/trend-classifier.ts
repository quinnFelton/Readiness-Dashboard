/**
 * Trend classifiers (PLAN §8.7, champion/challenger): every registered classifier runs on
 * every compute pass over the same baselines; output is tagged with its `id`
 * (`trends.classifier_id`) and only the `is_default` one drives what users see.
 *
 * Input is the raw baselines, not a pre-built RecoveryTrend, so a variant can change how
 * recovery is combined (dead zone, single-signal rules) as well as how EF is read.
 */
import type { BaselineResult } from './baseline';
import {
  type Classification,
  type ClassifierConfig,
  DEFAULT_CLASSIFIER_CONFIG,
  classifyFatigueFitness,
  recoveryTrend,
  validateClassifierConfig,
} from './classifier';
import { type Strategy, StrategyRegistry } from './registry';

export interface TrendInputs {
  /** ef_peak20 baseline from the default deriver's rows (PLAN §8.2). */
  ef: BaselineResult | null;
  hrv: BaselineResult | null;
  restingHr: BaselineResult | null;
}

export interface TrendClassifier extends Strategy {
  classify(inputs: TrendInputs): Classification;
}

/**
 * The §8.3 EF × recovery quadrant with a given config. A tuned variant is one line:
 * `efQuadrantClassifier('ef_quadrant_tight_v1', 'Dead zone 0.3', { efDeadZone: 0.3 })`.
 */
export function efQuadrantClassifier(
  id: string,
  description: string,
  overrides: Partial<ClassifierConfig> = {},
): TrendClassifier {
  const config: ClassifierConfig = Object.freeze({ ...DEFAULT_CLASSIFIER_CONFIG, ...overrides });
  validateClassifierConfig(config);
  return Object.freeze({
    id,
    description,
    classify: ({ ef, hrv, restingHr }: TrendInputs) =>
      classifyFatigueFitness(ef, recoveryTrend(hrv, restingHr, config), config),
  });
}

export const EF_QUADRANT_V1 = efQuadrantClassifier(
  'ef_quadrant_v1',
  'EF × recovery quadrant, default thresholds (PLAN §8.3)',
);

/** Matches the seeded `classifiers.is_default` row; the DB flag is authoritative at runtime. */
export const DEFAULT_CLASSIFIER_ID = EF_QUADRANT_V1.id;

/** A fresh registry with the built-in classifiers. Add challengers here. */
export function createClassifierRegistry(): StrategyRegistry<TrendClassifier> {
  return new StrategyRegistry<TrendClassifier>('classifier', [EF_QUADRANT_V1]);
}

/** Runs every classifier in the registry; one result per classifier id, in registration order. */
export function classifyAll(
  registry: StrategyRegistry<TrendClassifier>,
  inputs: TrendInputs,
): { classifierId: string; classification: Classification }[] {
  return registry.list().map((c) => ({ classifierId: c.id, classification: c.classify(inputs) }));
}
