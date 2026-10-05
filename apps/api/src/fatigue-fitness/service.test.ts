import { randomBytes } from 'node:crypto';
import type { AdapterRegistry } from '@rd/provider-adapters';
import {
  EF_QUADRANT_V1,
  StrategyRegistry,
  type TrendClassifier,
  efQuadrantClassifier,
} from '@rd/scoring-engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionConfigService } from '../connections/config-service';
import { addDays } from '../trends/http';
import { acquireDefaultsTestMutex } from '../test-utils/defaults-mutex';
import { closePool, getPool } from '../users/pool';

// Reads or changes the global default classifier/deriver flags: serialise with other such files.
let releaseDefaultsLock: () => Promise<void> = async () => {};
import { FatigueFitnessService } from './service';

// Needs migrated local Postgres (docker compose up -d db && pnpm db:migrate). No network.
const pool = () => getPool();
const tag = randomBytes(4).toString('hex');
const ASOF = '2026-03-28';
const ALT_CLASSIFIER = `tight_test_${tag}`;
const ALT_DERIVER = `alt_deriver_${tag}`;

// A deliberately huge dead zone: this variant calls everything "steady", unlike the default.
const tight = efQuadrantClassifier(ALT_CLASSIFIER, 'test variant', { efDeadZone: 50 });
const both = () => new StrategyRegistry<TrendClassifier>('classifier', [EF_QUADRANT_V1, tight]);

describe('FatigueFitnessService (PLAN §8.4, §8.7, §8.8)', () => {
  let userId: string;
  const configs = new ConnectionConfigService(pool(), {} as AdapterRegistry);
  const svc = new FatigueFitnessService(pool(), configs, {
    registry: both(),
    now: () => new Date(`${ASOF}T12:00:00Z`),
  });
  const day = (d: number) => addDays(ASOF, -d);

  const addMetric = (date: string, source: string, metric: string, value: number) =>
    pool().query(
      `INSERT INTO daily_metrics (user_id, date, source, metric_type, value) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, date, source, metric_type) DO UPDATE SET value = EXCLUDED.value`,
      [userId, date, source, metric, value],
    );
  const addEffort = (n: number, date: string, ef: number, deriver = 'peak20_v1') =>
    pool().query(
      `INSERT INTO activity_efforts (user_id, external_activity_id, source, date, duration_sec, avg_hr,
         ef_peak20, deriver_id) VALUES ($1,$2,'strava',$3,3600,140,$4,$5)`,
      [userId, `a${n}`, date, ef, deriver],
    );
  /** EF up in the last week (14 rides, every other day). */
  const seedEf = async (deriver = 'peak20_v1') => {
    for (let d = 0; d < 28; d += 2)
      await addEffort(d, day(d), (d < 7 ? 2.0 : 1.5) + (d % 3) * 0.02, deriver);
  };
  /** HRV down + resting HR up in the last week, daily, from `source`. */
  const seedRecovery = async (source = 'oura') => {
    for (let d = 0; d < 28; d++) {
      await addMetric(day(d), source, 'hrv', (d < 7 ? 40 : 60) + (d % 3));
      await addMetric(day(d), source, 'resting_hr', (d < 7 ? 60 : 50) + (d % 2));
    }
  };
  const trendRows = async (classifier?: string) =>
    (
      await pool().query(
        `SELECT classifier_id, direction, flagged_at FROM trends
          WHERE user_id = $1 AND as_of = $2::date AND ($3::text IS NULL OR classifier_id = $3)
          ORDER BY classifier_id`,
        [userId, ASOF, classifier ?? null],
      )
    ).rows;

  beforeAll(async () => {
    releaseDefaultsLock = await acquireDefaultsTestMutex(getPool());
    await pool().query(`INSERT INTO classifiers (id, description) VALUES ($1, 'test')`, [
      ALT_CLASSIFIER,
    ]);
    await pool().query(`INSERT INTO derivers (id, description) VALUES ($1, 'test')`, [ALT_DERIVER]);
    const { rows } = await pool().query<{ id: string }>(
      'INSERT INTO users(email) VALUES ($1) RETURNING id',
      [`ff-${tag}@phase5b.invalid`],
    );
    userId = rows[0]!.id;
  });
  beforeEach(async () => {
    for (const t of [
      'trends',
      'readiness_scores',
      'daily_metrics',
      'activity_efforts',
      'connection_configs',
    ]) {
      await pool().query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
    }
  });
  afterAll(async () => {
    await pool().query('DELETE FROM users WHERE id = $1', [userId]); // cascades every per-user table
    await pool().query('DELETE FROM trends WHERE classifier_id = $1', [ALT_CLASSIFIER]);
    await pool().query('DELETE FROM classifiers WHERE id = $1', [ALT_CLASSIFIER]);
    await pool().query('DELETE FROM derivers WHERE id = $1', [ALT_DERIVER]);
    await releaseDefaultsLock();
    await closePool();
  });

  it('does nothing when only the recovery trend exists (activity side missing)', async () => {
    await seedRecovery();
    const out = await svc.onSyncComplete(userId, 'daily_metrics');
    expect(out).toMatchObject({ ran: false, skipReason: 'no_ef_trend', classifiers: [] });
    expect(await trendRows()).toHaveLength(0);
  });

  it('does nothing when only the EF trend exists (daily metrics missing)', async () => {
    await seedEf();
    const out = await svc.onSyncComplete(userId, 'activity');
    expect(out).toMatchObject({ ran: false, skipReason: 'no_recovery_trend' });
    expect(await trendRows()).toHaveLength(0);
  });

  it('fires from either sync once both exist, and classifies overreaching_risk', async () => {
    await seedEf();
    await seedRecovery();
    const out = await svc.onSyncComplete(userId, 'activity');
    expect(out.ran).toBe(true);
    const rows = await trendRows(EF_QUADRANT_V1.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('overreaching_risk');
  });

  it('two classifiers produce two rows per window, with their own states', async () => {
    await seedEf();
    await seedRecovery();
    const out = await svc.onSyncComplete(userId, 'daily_metrics');
    expect(out.classifiers.sort()).toEqual([EF_QUADRANT_V1.id, ALT_CLASSIFIER].sort());
    const rows = await trendRows();
    expect(rows.map((r) => r.classifier_id).sort()).toEqual(
      [ALT_CLASSIFIER, EF_QUADRANT_V1.id].sort(),
    );
    const state = Object.fromEntries(rows.map((r) => [r.classifier_id, r.direction]));
    expect(state[EF_QUADRANT_V1.id]).toBe('overreaching_risk');
    expect(state[ALT_CLASSIFIER]).not.toBe('overreaching_risk'); // EF is "flat" under a 50σ dead zone
  });

  it('recompute is idempotent for every classifier: same rows, unchanged flagged_at', async () => {
    await seedEf();
    await seedRecovery();
    await svc.onSyncComplete(userId, 'daily_metrics');
    const first = await trendRows();
    await svc.onSyncComplete(userId, 'activity');
    await svc.onSyncComplete(userId, 'daily_metrics');
    const second = await trendRows();
    expect(second).toHaveLength(first.length);
    expect(second).toEqual(first); // direction and flagged_at both stable
    const { rows } = await pool().query(
      `SELECT count(*)::int AS n FROM trends WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0].n).toBe(first.length);
  });

  it('only the default deriver’s efforts feed the EF series', async () => {
    // Only a non-default deriver has rows: the default's EF series is empty, so no trend exists.
    await seedEf(ALT_DERIVER);
    await seedRecovery();
    expect(await svc.onSyncComplete(userId, 'activity')).toMatchObject({
      ran: false,
      skipReason: 'no_ef_trend',
    });
    // Add the default deriver's rows: now it runs, and the alt rows (huge EF) don't disturb the result.
    await seedEf('peak20_v1');
    await pool().query(
      `UPDATE activity_efforts SET ef_peak20 = 99 WHERE user_id = $1 AND deriver_id = $2`,
      [userId, ALT_DERIVER],
    );
    const out = await svc.onSyncComplete(userId, 'activity');
    expect(out.ran).toBe(true);
    expect((await trendRows(EF_QUADRANT_V1.id))[0].direction).toBe('overreaching_risk');
  });

  it('fails loudly if the DB default classifier is not registered in code', async () => {
    await seedEf();
    await seedRecovery();
    const noDefault = new FatigueFitnessService(pool(), configs, {
      registry: new StrategyRegistry<TrendClassifier>('classifier', [tight]),
      now: () => new Date(`${ASOF}T12:00:00Z`),
    });
    await expect(noDefault.onSyncComplete(userId, 'activity')).rejects.toThrow(
      /unknown classifier/,
    );
    expect(await trendRows()).toHaveLength(0);
  });

  describe('daily-metric precedence (ConnectionConfigService, never averaged)', () => {
    // sleep_score alone makes the readiness score equal the winning source's value.
    const setOrder = async (order: string[]) => {
      await pool().query(`DELETE FROM connection_configs WHERE user_id = $1`, [userId]);
      for (const [i, p] of order.entries()) {
        await pool().query(
          `INSERT INTO connection_configs (user_id, role, provider, priority)
           VALUES ($1,'daily_metrics_source',$2,$3)`,
          [userId, p, i],
        );
      }
    };
    const score = async () =>
      Number(
        (
          await pool().query(
            `SELECT score FROM readiness_scores WHERE user_id = $1 AND date = $2::date`,
            [userId, ASOF],
          )
        ).rows[0].score,
      );

    it('uses the user’s preferred source, flips with the order, and never averages', async () => {
      await addMetric(ASOF, 'oura', 'sleep_score', 90);
      await addMetric(ASOF, 'terra', 'sleep_score', 50);

      await setOrder(['oura', 'terra']);
      expect(await svc.computeReadiness(userId, ASOF)).toBe(true);
      expect(await score()).toBe(90);

      await setOrder(['terra', 'oura']);
      await svc.computeReadiness(userId, ASOF);
      expect(await score()).toBe(50); // same row, updated; 70 (an average) never appears
    });

    it('readiness is idempotent on (user_id, date) and skips days without recovery data', async () => {
      await addMetric(ASOF, 'oura', 'sleep_score', 80);
      await svc.computeReadiness(userId, ASOF);
      await svc.computeReadiness(userId, ASOF);
      const { rows } = await pool().query(
        `SELECT count(*)::int AS n FROM readiness_scores WHERE user_id = $1`,
        [userId],
      );
      expect(rows[0].n).toBe(1);
      expect(await svc.computeReadiness(userId, day(3))).toBe(false);
    });
  });
});
