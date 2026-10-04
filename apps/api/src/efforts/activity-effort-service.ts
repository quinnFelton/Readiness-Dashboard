import {
  type ActivityEffortDeriver,
  DERIVATION_VERSION,
  type StrategyRegistry,
  createDeriverRegistry,
} from '@rd/scoring-engine';
import {
  DEFAULT_STRAVA_FILTER,
  DEFAULT_TRAINING_LOAD_CONFIG,
  STRAVA_PROVIDER_KEY,
  type SkipReason,
  type StravaActivityFilter,
  type StravaActivityPayload,
  type TrainingLoadConfig,
  activityDate,
  skipReason,
  streamsToSamples,
  trainingLoad,
} from '@rd/provider-adapters/strava';
import type pg from 'pg';

export type EffortOutcome =
  /** `derivers`: ids that produced a row. Derivers that rejected the stream have no row. */
  | { status: 'upserted'; externalActivityId: string; derivers: string[] }
  | {
      status: 'skipped';
      reason:
        | SkipReason
        | 'no_date'
        | 'empty_stream'
        | 'too_short'
        | 'insufficient_power'
        | 'insufficient_hr';
    };

export interface ActivityEffortConfig {
  filter: StravaActivityFilter;
  trainingLoad: TrainingLoadConfig;
}

/** Thresholds are config (CLAUDE.md rule 9): MIN_ACTIVITY_DURATION_SEC, STRAVA_FTP, HR_MAX, HR_REST. */
export function loadActivityEffortConfig(
  env: NodeJS.ProcessEnv = process.env,
): ActivityEffortConfig {
  const num = (v: string | undefined): number | undefined => {
    const n = v === undefined || v === '' ? NaN : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    filter: {
      ...DEFAULT_STRAVA_FILTER,
      minDurationSec: num(env.MIN_ACTIVITY_DURATION_SEC) ?? DEFAULT_STRAVA_FILTER.minDurationSec,
    },
    trainingLoad: {
      ftp: num(env.STRAVA_FTP) ?? DEFAULT_TRAINING_LOAD_CONFIG.ftp,
      hrMax: num(env.HR_MAX) ?? DEFAULT_TRAINING_LOAD_CONFIG.hrMax,
      hrRest: num(env.HR_REST) ?? DEFAULT_TRAINING_LOAD_CONFIG.hrRest,
    },
  };
}

/**
 * PLAN §8.1 / §8.8 / §13: stream → scalars → one activity_efforts row per registered deriver.
 * Every deriver runs on the one already-fetched stream (no extra API calls). All maths lives in
 * @rd/scoring-engine; this class only wires it to the DB. The stream is held in memory for the
 * duration of the call and never persisted (CLAUDE.md rule 5).
 */
export class ActivityEffortService {
  private readonly cfg: ActivityEffortConfig;

  constructor(
    private readonly pool: pg.Pool,
    cfg: Partial<ActivityEffortConfig> = {},
    private readonly derivers: StrategyRegistry<ActivityEffortDeriver> = createDeriverRegistry(),
  ) {
    const d = loadActivityEffortConfig();
    this.cfg = { ...d, ...cfg };
  }

  /** Pre-fetch gate so callers can skip the (costly) streams call. */
  skipReasonFor(a: StravaActivityPayload['activity']): SkipReason | null {
    return skipReason(a, this.cfg.filter);
  }

  /**
   * Idempotent: keyed on (user_id, external_activity_id, deriver_id), so webhook retries / duplicate
   * events / re-derivations converge on one row per deriver. If an updated activity no longer
   * qualifies (type changed, trimmed below the minimum, ...) previously stored rows are removed
   * rather than left stale: all of them for a pre-fetch skip, or just that deriver's row when
   * only one deriver rejects the stream. `skipped` means no deriver produced a row; its reason
   * is the first deriver's (registration order, so the default deriver's when it is first).
   */
  async processActivity(userId: string, p: StravaActivityPayload): Promise<EffortOutcome> {
    const externalActivityId = String(p.activity.id);
    const skipped = (reason: Extract<EffortOutcome, { status: 'skipped' }>['reason']) =>
      this.removeAndSkip(userId, externalActivityId, reason);

    const pre = skipReason(p.activity, this.cfg.filter);
    if (pre) return skipped(pre);
    const date = activityDate(p.activity);
    if (!date) return skipped('no_date');

    const samples = streamsToSamples(p.streams);
    const produced: string[] = [];
    let firstReason: Extract<EffortOutcome, { status: 'skipped' }>['reason'] | null = null;
    for (const deriver of this.derivers.list()) {
      const e = deriver.derive(samples, { minDurationSec: this.cfg.filter.minDurationSec });
      if (!e.qualifies) {
        firstReason ??= e.reason;
        await this.deleteActivity(userId, externalActivityId, deriver.id);
        continue;
      }
      const load = trainingLoad(e, this.cfg.trainingLoad);
      await this.pool.query(
        `INSERT INTO activity_efforts
         (user_id, external_activity_id, source, date, duration_sec, avg_power, normalized_power,
          avg_hr, peak20_power, peak20_avg_hr, ef_overall, ef_peak20,
          training_load, training_load_method, derivation_version, deriver_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (user_id, external_activity_id, deriver_id) DO UPDATE SET
         source = EXCLUDED.source, date = EXCLUDED.date, duration_sec = EXCLUDED.duration_sec,
         avg_power = EXCLUDED.avg_power, normalized_power = EXCLUDED.normalized_power,
         avg_hr = EXCLUDED.avg_hr, peak20_power = EXCLUDED.peak20_power,
         peak20_avg_hr = EXCLUDED.peak20_avg_hr, ef_overall = EXCLUDED.ef_overall,
         ef_peak20 = EXCLUDED.ef_peak20, training_load = EXCLUDED.training_load,
         training_load_method = EXCLUDED.training_load_method,
         derivation_version = EXCLUDED.derivation_version`,
        [
          userId,
          externalActivityId,
          STRAVA_PROVIDER_KEY,
          date,
          e.durationSec,
          e.avgPower,
          e.normalizedPower,
          e.avgHr,
          e.peak20Power,
          e.peak20AvgHr,
          e.efOverall,
          e.efPeak20,
          load?.value ?? null,
          load?.method ?? null,
          DERIVATION_VERSION,
          deriver.id,
        ],
      );
      produced.push(deriver.id);
    }
    if (produced.length === 0) return skipped(firstReason ?? 'empty_stream');
    return { status: 'upserted', externalActivityId, derivers: produced };
  }

  /**
   * Webhook `delete` events, and updates that make an activity ineligible. Removes every
   * deriver's row, or only `deriverId`'s when given. Returns rows removed.
   */
  async deleteActivity(
    userId: string,
    externalActivityId: string,
    deriverId?: string,
  ): Promise<number> {
    const r = await this.pool.query(
      `DELETE FROM activity_efforts
        WHERE user_id = $1 AND external_activity_id = $2 AND source = $3
          AND ($4::text IS NULL OR deriver_id = $4)`,
      [userId, externalActivityId, STRAVA_PROVIDER_KEY, deriverId ?? null],
    );
    return r.rowCount ?? 0;
  }

  private async removeAndSkip(
    userId: string,
    externalActivityId: string,
    reason: Extract<EffortOutcome, { status: 'skipped' }>['reason'],
  ): Promise<EffortOutcome> {
    await this.deleteActivity(userId, externalActivityId);
    return { status: 'skipped', reason };
  }
}
