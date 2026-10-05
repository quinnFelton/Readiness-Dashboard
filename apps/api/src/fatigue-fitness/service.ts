import {
  type BaselineResult,
  type SeriesPoint,
  type StrategyRegistry,
  type TrendClassifier,
  classifyAll,
  createClassifierRegistry,
  rollingBaseline,
} from '@rd/scoring-engine';
import type { ConnectionRole } from '@rd/shared-types';
import type pg from 'pg';
import type { ConnectionConfigService } from '../connections/config-service';
import { blendReadiness, zToScore } from '../scores/readiness-blend';
import { getDefaultClassifierId } from '../trends/default-classifier';
import { addDays, todayUtc } from '../trends/http';
import { type FatigueFitnessConfig, loadFatigueFitnessConfig } from './config';

export type SyncKind = 'daily_metrics' | 'activity';

/** Maps a provider role (SyncService / webhook handlers know it) to the trigger kind. */
export const syncKindForRole = (role: ConnectionRole): SyncKind =>
  role === 'activity_source' ? 'activity' : 'daily_metrics';

export interface ComputeOutcome {
  asOf: string;
  /** Classifier rows were (re)computed. False when an EF or a recovery trend is still missing. */
  ran: boolean;
  skipReason?: 'no_ef_trend' | 'no_recovery_trend';
  /** Classifier ids upserted this pass (empty when !ran). */
  classifiers: string[];
  readinessUpdated: boolean;
}

/**
 * PLAN §6 FatigueFitnessService / §8.4 / §8.7. Orchestration and persistence only; every number
 * comes from @rd/scoring-engine (baselines, classifiers).
 *
 * Trigger (§8.4): call {@link onSyncComplete} after a daily-metrics sync OR an activity sync. It
 * recomputes the classifiers only when both an EF trend and a recovery trend can be computed for
 * the window; otherwise it does nothing to `trends`. Everything is keyed on natural keys, so
 * re-running with the same data is a no-op in effect.
 */
export class FatigueFitnessService {
  private readonly cfg: FatigueFitnessConfig;

  constructor(
    private readonly pool: pg.Pool,
    private readonly configs: Pick<ConnectionConfigService, 'getResolvedDailyMetrics'>,
    opts: {
      registry?: StrategyRegistry<TrendClassifier>;
      config?: FatigueFitnessConfig;
      now?: () => Date;
    } = {},
  ) {
    this.registry = opts.registry ?? createClassifierRegistry();
    this.cfg = opts.config ?? loadFatigueFitnessConfig();
    this.now = opts.now ?? (() => new Date());
  }

  private readonly registry: StrategyRegistry<TrendClassifier>;
  private readonly now: () => Date;

  /**
   * @param asOf window end, `YYYY-MM-DD` (default today, UTC). Callers that know the affected
   *   date (e.g. a backfilled ride) can pass it; the window is the 7d/28d ending there.
   */
  async onSyncComplete(userId: string, kind: SyncKind, asOf?: string): Promise<ComputeOutcome> {
    const date = asOf ?? todayUtc(this.now());
    // The readiness blend only depends on daily metrics, so an activity sync can't change it.
    const readinessUpdated =
      kind === 'daily_metrics' ? await this.computeReadiness(userId, date) : false;
    const trend = await this.computeTrends(userId, date);
    return { ...trend, readinessUpdated };
  }

  /** Classifier pass for one window. Does nothing unless both trends exist. */
  async computeTrends(
    userId: string,
    asOf: string,
  ): Promise<Omit<ComputeOutcome, 'readinessUpdated'>> {
    const from = addDays(asOf, -(this.cfg.longDays - 1));
    const [efSeries, hrvSeries, rhrSeries] = await this.loadSeries(userId, from, asOf);
    const windows = { shortDays: this.cfg.shortDays, longDays: this.cfg.longDays };
    const ef = efSeries.length ? rollingBaseline(efSeries, windows, asOf) : null;
    const hrv = hrvSeries.length ? rollingBaseline(hrvSeries, windows, asOf) : null;
    const restingHr = rhrSeries.length ? rollingBaseline(rhrSeries, windows, asOf) : null;

    // "Exists" = a z-score can be computed (>= 1 short-window point, >= 2 long-window points, spread).
    const hasEf = ef?.z != null;
    const hasRecovery = hrv?.z != null || restingHr?.z != null;
    if (!hasEf || !hasRecovery) {
      return {
        asOf,
        ran: false,
        skipReason: hasEf ? 'no_recovery_trend' : 'no_ef_trend',
        classifiers: [],
      };
    }

    // Fail loudly on a default flag with no code behind it, before writing anything.
    await getDefaultClassifierId(this.pool, this.registry);

    const results = classifyAll(this.registry, { ef, hrv, restingHr });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const { classifierId, classification: c } of results) {
        await client.query(
          `INSERT INTO trends
             (user_id, classifier_id, as_of, metric_type, trend_window, z_score, recovery_z,
              direction, insight_text)
           VALUES ($1, $2, $3::date, 'fatigue_fitness_state', '7d', $4, $5, $6, $7)
           ON CONFLICT (user_id, classifier_id, metric_type, trend_window, as_of) DO UPDATE SET
             z_score = EXCLUDED.z_score, recovery_z = EXCLUDED.recovery_z,
             direction = EXCLUDED.direction, insight_text = EXCLUDED.insight_text,
             flagged_at = CASE WHEN trends.direction IS DISTINCT FROM EXCLUDED.direction
                               THEN now() ELSE trends.flagged_at END`,
          [userId, classifierId, asOf, c.efZ, c.recoveryZ, c.state, c.insightText],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return { asOf, ran: true, classifiers: results.map((r) => r.classifierId) };
  }

  /**
   * Secondary readiness score for one day (PLAN §8.6). Upserts on (user_id, date). Returns false
   * (and writes nothing) if that day has no usable recovery metric.
   */
  async computeReadiness(userId: string, date: string): Promise<boolean> {
    const from = addDays(date, -(this.cfg.longDays - 1));
    // ConnectionConfigService applies per-metric source precedence; sources are never averaged.
    const resolved = await this.configs.getResolvedDailyMetrics(userId, from, date);
    const series = (t: string): SeriesPoint[] =>
      resolved.filter((r) => r.metricType === t).map((r) => ({ date: r.date, value: r.value }));

    // One-day short window against the long baseline: z of *that day's* value.
    const windows = { shortDays: 1, longDays: this.cfg.longDays };
    const component = (t: 'hrv' | 'resting_hr', sign: 1 | -1): number | null => {
      const s = series(t);
      const b: BaselineResult | null = s.some((p) => p.date === date)
        ? rollingBaseline(s, windows, date)
        : null;
      return b?.z == null ? null : zToScore(sign * b.z, this.cfg.readinessPointsPerZ);
    };
    // Higher HRV is better; higher resting HR is worse.
    const sleepToday = series('sleep_score').find((p) => p.date === date)?.value;
    const blend = blendReadiness(
      {
        hrv: component('hrv', 1),
        restingHr: component('resting_hr', -1),
        sleep: sleepToday === undefined ? null : Math.min(100, Math.max(0, sleepToday)),
      },
      this.cfg.readinessWeights,
    );
    if (!blend) return false;
    await this.pool.query(
      `INSERT INTO readiness_scores (user_id, date, score, components_jsonb)
       VALUES ($1, $2::date, $3, $4::jsonb)
       ON CONFLICT (user_id, date) DO UPDATE SET
         score = EXCLUDED.score, components_jsonb = EXCLUDED.components_jsonb, computed_at = now()`,
      [
        userId,
        date,
        blend.score,
        JSON.stringify({ components: blend.components, weights: blend.weights }),
      ],
    );
    return true;
  }

  /** [ef_peak20 from the default deriver only, hrv, resting_hr] as engine series. */
  private async loadSeries(
    userId: string,
    from: string,
    to: string,
  ): Promise<[SeriesPoint[], SeriesPoint[], SeriesPoint[]]> {
    // PLAN §8.8: never mix derivers in one EF series. The flag is read from the DB; no default = deploy error.
    const { rows: d } = await this.pool.query<{ id: string }>(
      `SELECT id FROM derivers WHERE is_default`,
    );
    const deriverId = d[0]?.id;
    if (!deriverId) throw new Error('no deriver is flagged is_default in the derivers table');

    const { rows: efRows } = await this.pool.query<{ date: string; value: number }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, ef_peak20::float8 AS value
         FROM activity_efforts
        WHERE user_id = $1 AND deriver_id = $2 AND ef_peak20 IS NOT NULL
          AND date BETWEEN $3::date AND $4::date
        ORDER BY date, external_activity_id`,
      [userId, deriverId, from, to],
    );
    // Precedence lives in ConnectionConfigService (PLAN §6): read from it, never average sources.
    const resolved = await this.configs.getResolvedDailyMetrics(userId, from, to);
    const pick = (t: string): SeriesPoint[] =>
      resolved.filter((r) => r.metricType === t).map((r) => ({ date: r.date, value: r.value }));
    return [efRows, pick('hrv'), pick('resting_hr')];
  }
}

/**
 * Adapter for the sync layer's completion hook. Errors are swallowed (a failed classifier pass must
 * not fail the ingest that triggered it) and reported by class name only: messages may quote data.
 */
export function createSyncCompletionHook(
  svc: Pick<FatigueFitnessService, 'onSyncComplete'>,
  onError: (errorName: string) => void = () => {},
): (userId: string, role: ConnectionRole, asOf?: string) => Promise<void> {
  return async (userId, role, asOf) => {
    try {
      await svc.onSyncComplete(userId, syncKindForRole(role), asOf);
    } catch (err) {
      onError(err instanceof Error ? err.name : 'Error');
    }
  };
}
