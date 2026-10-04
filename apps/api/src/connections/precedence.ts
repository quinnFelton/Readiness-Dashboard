import type { DailyMetricType } from '@rd/shared-types';

// PLAN §6: explicit, auditable multi-source precedence per metric type. Thresholds/precedence are
// config, not constants (CLAUDE.md rule 9).

export const DAILY_METRIC_TYPES: readonly DailyMetricType[] = [
  'hrv',
  'resting_hr',
  'sleep_score',
  'readiness',
];

export interface PrecedenceConfig {
  /** Order used when the user has configured no daily-metrics sources. Oura preferred by default. */
  defaultOrder: string[];
  /** Optional per-metric default order (e.g. a different winner for sleep_score). */
  perMetric?: Partial<Record<DailyMetricType, string[]>>;
}

export function loadPrecedenceConfig(env: NodeJS.ProcessEnv = process.env): PrecedenceConfig {
  const csv = env.DAILY_METRICS_DEFAULT_SOURCE_ORDER;
  const order = csv
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { defaultOrder: order?.length ? order : ['oura', 'terra'] };
}

export type MetricPrecedence = Record<DailyMetricType, string[]>;

/**
 * Per metric type, the sources in preference order. A user's explicit ordering (connection_configs
 * priority) wins over config defaults and applies to every metric type.
 */
export function resolvePrecedence(
  userOrder: readonly string[],
  cfg: PrecedenceConfig,
): MetricPrecedence {
  const out = {} as MetricPrecedence;
  for (const m of DAILY_METRIC_TYPES) {
    out[m] = userOrder.length > 0 ? [...userOrder] : [...(cfg.perMetric?.[m] ?? cfg.defaultOrder)];
  }
  return out;
}

export interface SourcedValue {
  source: string;
  value: number;
}

/**
 * Pick the winning row for one (date, metric): the first source in `order` that has a value.
 * Sources not in `order` rank after all listed ones, alphabetically, so the result is deterministic.
 * Never averages and never depends on sync order.
 */
export function pickBySource<T extends SourcedValue>(
  candidates: readonly T[],
  order: readonly string[],
): T | undefined {
  const rank = (s: string) => {
    const i = order.indexOf(s);
    return i === -1 ? order.length : i;
  };
  return [...candidates].sort(
    (a, b) => rank(a.source) - rank(b.source) || a.source.localeCompare(b.source),
  )[0];
}
