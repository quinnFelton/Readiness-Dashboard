import { randomBytes } from 'node:crypto';
import type { StravaActivityPayload } from '@rd/provider-adapters/strava';
import {
  type ActivityEffortDeriver,
  PEAK20_V1,
  StrategyRegistry,
  createDeriverRegistry,
} from '@rd/scoring-engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../users/pool';
import { ActivityEffortService } from './activity-effort-service';

// PLAN §8.8: every registered deriver runs on the one stream; one row per (activity, deriver).
// Needs migrated local Postgres. No network.
const pool = () => getPool();
const ALT = `alt_test_${randomBytes(4).toString('hex')}`;

const payload = (
  id: number,
  seconds = 1800,
  watts = 200,
  streamSeconds = seconds,
): StravaActivityPayload =>
  ({
    activity: {
      id,
      type: 'Ride',
      sport_type: 'Ride',
      start_date_local: '2026-03-01T08:00:00Z',
      moving_time: seconds,
      has_heartrate: true,
      manual: false,
    },
    streams: {
      time: { data: Array.from({ length: streamSeconds }, (_, i) => i) },
      watts: { data: Array.from({ length: streamSeconds }, () => watts) },
      heartrate: { data: Array.from({ length: streamSeconds }, () => 140) },
    },
  }) as unknown as StravaActivityPayload;

/** A second deriver whose acceptance can be toggled, to exercise per-deriver rejection. */
let altAccepts = true;
const alt: ActivityEffortDeriver = {
  id: ALT,
  description: 'test variant',
  derive: (s, o) => {
    const e = PEAK20_V1.derive(s, o);
    return altAccepts || !e.qualifies ? e : { ...e, qualifies: false, reason: 'insufficient_hr' };
  },
};

describe('ActivityEffortService with several derivers (PLAN §8.8)', () => {
  let userId: string;
  const svc = new ActivityEffortService(pool(), {}, createDeriverRegistry().register(alt));
  const rows = async () =>
    (
      await pool().query(
        `SELECT deriver_id, external_activity_id, ef_peak20::float AS ef
           FROM activity_efforts WHERE user_id = $1 ORDER BY deriver_id`,
        [userId],
      )
    ).rows;

  beforeAll(async () => {
    await pool().query(`INSERT INTO derivers (id, description) VALUES ($1, 'test')`, [ALT]);
    const { rows: u } = await pool().query<{ id: string }>(
      'INSERT INTO users(email) VALUES ($1) RETURNING id',
      [`derivers-${randomBytes(4).toString('hex')}@efforts.invalid`],
    );
    userId = u[0]!.id;
  });
  beforeEach(async () => {
    altAccepts = true;
    await pool().query('DELETE FROM activity_efforts WHERE user_id = $1', [userId]);
  });
  afterAll(async () => {
    await pool().query('DELETE FROM users WHERE id = $1', [userId]);
    await pool().query('DELETE FROM derivers WHERE id = $1', [ALT]);
    await closePool();
  });

  it('writes one row per deriver, tagged with its id, and is idempotent on replay', async () => {
    const out = await svc.processActivity(userId, payload(1));
    expect(out).toEqual({
      status: 'upserted',
      externalActivityId: '1',
      derivers: ['peak20_v1', ALT],
    });
    await svc.processActivity(userId, payload(1, 1800, 210));
    const r = await rows();
    expect(r.map((x) => x.deriver_id).sort()).toEqual([ALT, 'peak20_v1'].sort());
    expect(r.every((x) => Math.abs(x.ef - 210 / 140) < 1e-9)).toBe(true);
  });

  it('a deriver that rejects the stream gets no row, and loses a stale one; others keep theirs', async () => {
    await svc.processActivity(userId, payload(2));
    altAccepts = false;
    const out = await svc.processActivity(userId, payload(2));
    expect(out).toEqual({ status: 'upserted', externalActivityId: '2', derivers: ['peak20_v1'] });
    expect((await rows()).map((x) => x.deriver_id)).toEqual(['peak20_v1']);
  });

  it('skipped when no deriver qualifies; the first deriver’s reason is reported', async () => {
    const out = await svc.processActivity(userId, payload(3, 1800, 200, 300));
    expect(out).toEqual({ status: 'skipped', reason: 'too_short' });
    expect(await rows()).toEqual([]);
  });

  it('deleteActivity removes every deriver’s row', async () => {
    await svc.processActivity(userId, payload(4));
    expect(await svc.deleteActivity(userId, '4')).toBe(2);
    expect(await rows()).toEqual([]);
  });

  it('a deriver without a `derivers` row is rejected by the DB (add a migration row with it)', async () => {
    const unseeded = new ActivityEffortService(
      pool(),
      {},
      new StrategyRegistry<ActivityEffortDeriver>('deriver', [{ ...alt, id: 'not_seeded_v1' }]),
    );
    await expect(unseeded.processActivity(userId, payload(5))).rejects.toThrow(/foreign key/);
  });
});
