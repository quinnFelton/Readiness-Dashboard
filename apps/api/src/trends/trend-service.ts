import type { MetricSeries, SeriesPoint } from '@rd/shared-types';
import type pg from 'pg';
import type { ConnectionConfigService } from '../connections/config-service';
import { addDays } from './http';

// PLAN §6 TrendService: reads precomputed rows only. Nothing here computes (PLAN §8.4: compute on
// sync, not on page load). Every query is scoped by user_id.

export interface TrendRow {
  asOf: string;
  metricType: string;
  window: string;
  zScore: number | null;
  recoveryZ: number | null;
  /** For metric_type 'fatigue_fitness_state' this is the classified state. */
  direction: string | null;
  insightText: string | null;
  flaggedAt: string;
}

export interface ScoreRow {
  date: string;
  score: number;
  components: unknown;
  /** The chosen classifier's state for that date, if one was computed. */
  state: string | null;
  insightText: string | null;
}

export class TrendService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly configs?: Pick<ConnectionConfigService, 'getResolvedDailyMetrics'>,
  ) {}

  /**
   * The observations behind the trends, for the dashboard charts (PLAN §9). Same sources the
   * classifier uses (FatigueFitnessService.loadSeries): EF only from the `is_default` deriver
   * (PLAN §8.8, never mixed), daily metrics resolved by the user's per-metric source precedence
   * (PLAN §6, never averaged). EF stays sparse: no row on rest days, nothing interpolated.
   * Several rides on one day are each returned, in activity order.
   */
  async getSeries(userId: string, days: number, today: string): Promise<MetricSeries> {
    if (!this.configs) throw new Error('TrendService.getSeries needs a ConnectionConfigService');
    const from = addDays(today, -(days - 1));
    const { rows: d } = await this.pool.query<{ id: string }>(
      `SELECT id FROM derivers WHERE is_default`,
    );
    const deriverId = d[0]?.id;
    if (!deriverId) throw new Error('no deriver is flagged is_default in the derivers table');

    const { rows: ef } = await this.pool.query<{
      date: string;
      ef_peak20: number | null;
      ef_overall: number | null;
    }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date,
              ef_peak20::float8 AS ef_peak20, ef_overall::float8 AS ef_overall
         FROM activity_efforts
        WHERE user_id = $1 AND deriver_id = $2 AND date BETWEEN $3::date AND $4::date
        ORDER BY date, external_activity_id`,
      [userId, deriverId, from, today],
    );
    const efCol = (k: 'ef_peak20' | 'ef_overall'): SeriesPoint[] =>
      ef.flatMap((r) => (r[k] === null ? [] : [{ date: r.date, value: r[k] as number }]));

    const resolved = await this.configs.getResolvedDailyMetrics(userId, from, today);
    const daily = (t: string): SeriesPoint[] =>
      resolved
        .filter((r) => r.metricType === t)
        .map((r) => ({ date: r.date, value: r.value }))
        .sort((a, b) => a.date.localeCompare(b.date));

    return {
      efPeak20: efCol('ef_peak20'),
      efOverall: efCol('ef_overall'),
      hrv: daily('hrv'),
      restingHr: daily('resting_hr'),
    };
  }

  /** Rows with as_of in the `days` days ending `today` (inclusive). */
  async getTrends(
    userId: string,
    classifierId: string,
    days: number,
    today: string,
  ): Promise<TrendRow[]> {
    const { rows } = await this.pool.query(
      `SELECT to_char(as_of, 'YYYY-MM-DD') AS as_of, metric_type, trend_window,
              z_score::float8 AS z_score, recovery_z::float8 AS recovery_z,
              direction, insight_text, flagged_at
         FROM trends
        WHERE user_id = $1 AND classifier_id = $2 AND as_of BETWEEN $3::date AND $4::date
        ORDER BY as_of, metric_type, trend_window`,
      [userId, classifierId, addDays(today, -(days - 1)), today],
    );
    return rows.map((r) => ({
      asOf: r.as_of,
      metricType: r.metric_type,
      window: r.trend_window,
      zScore: r.z_score,
      recoveryZ: r.recovery_z,
      direction: r.direction,
      insightText: r.insight_text,
      flaggedAt: new Date(r.flagged_at).toISOString(),
    }));
  }

  /**
   * Readiness series with the chosen classifier's state alongside. readiness_scores itself isn't
   * classifier-specific (PLAN §7), so the classifier only decides which state is joined in.
   */
  async getScores(
    userId: string,
    classifierId: string,
    days: number,
    today: string,
  ): Promise<ScoreRow[]> {
    const { rows } = await this.pool.query(
      `SELECT to_char(s.date, 'YYYY-MM-DD') AS date, s.score::float8 AS score,
              s.components_jsonb, t.direction AS state, t.insight_text
         FROM readiness_scores s
         LEFT JOIN trends t
           ON t.user_id = s.user_id AND t.as_of = s.date AND t.classifier_id = $2
          AND t.metric_type = 'fatigue_fitness_state' AND t.trend_window = '7d'
        WHERE s.user_id = $1 AND s.date BETWEEN $3::date AND $4::date
        ORDER BY s.date`,
      [userId, classifierId, addDays(today, -(days - 1)), today],
    );
    return rows.map((r) => ({
      date: r.date,
      score: r.score,
      components: r.components_jsonb,
      state: r.state,
      insightText: r.insight_text,
    }));
  }
}
