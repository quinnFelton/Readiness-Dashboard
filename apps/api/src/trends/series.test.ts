import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signApiToken } from '../auth/token';
import { closePool, getPool } from '../users/pool';
import { trendsRouter } from './routes';

// GET /trends/:userId returns `series` for the dashboard charts (PLAN §9): the same data the
// classifier reads. Needs migrated local Postgres; rows are seeded directly.
process.env.NEXTAUTH_SECRET = 'test-secret-test-secret-test-secret';
const pool = () => getPool();
const tag = randomBytes(4).toString('hex');
const ALT_DERIVER = `series_alt_${tag}`;
const TODAY = '2026-03-28';

const bearer = (id: string, role: 'user' | 'master') =>
  `Bearer ${signApiToken({ userId: id, role }, { nowSec: Math.floor(Date.now() / 1000) })}`;

const app = express();
app.use(express.json());
app.use('/trends', trendsRouter({ pool: pool(), now: () => new Date(`${TODAY}T12:00:00Z`) }));

describe('GET /trends/:userId series', () => {
  let a: string;
  let b: string;

  const mkUser = async (name: string) =>
    (
      await pool().query<{ id: string }>(`INSERT INTO users(email) VALUES ($1) RETURNING id`, [
        `${name}-${tag}@series.invalid`,
      ])
    ).rows[0]!.id;
  const effort = (
    user: string,
    id: string,
    date: string,
    ef20: number | null,
    efAll: number,
    deriver = 'peak20_v1',
  ) =>
    pool().query(
      `INSERT INTO activity_efforts
         (user_id, external_activity_id, source, date, duration_sec, avg_hr, ef_peak20, ef_overall, deriver_id)
       VALUES ($1,$2,'strava',$3::date,3600,140,$4,$5,$6)`,
      [user, id, date, ef20, efAll, deriver],
    );
  const metric = (user: string, date: string, source: string, type: string, value: number) =>
    pool().query(
      `INSERT INTO daily_metrics (user_id, date, source, metric_type, value) VALUES ($1,$2::date,$3,$4,$5)`,
      [user, date, source, type, value],
    );

  beforeAll(async () => {
    await pool().query(`INSERT INTO derivers (id, description) VALUES ($1,'test')`, [ALT_DERIVER]);
    [a, b] = [await mkUser('a'), await mkUser('b')];
    // Terra preferred over Oura for this user (priority 0 wins), overriding the Oura-first default.
    await pool().query(
      `INSERT INTO connection_configs (user_id, role, provider, priority)
       VALUES ($1,'daily_metrics_source','terra',0), ($1,'daily_metrics_source','oura',1)`,
      [a],
    );
    await effort(a, 'r1', '2026-03-20', 1.5, 1.4);
    await effort(a, 'r2', '2026-03-20', 1.6, 1.45); // two rides on one day: both kept
    await effort(a, 'r3', '2026-03-25', null, 1.3); // no peak-20 EF: only in efOverall
    await effort(a, 'r1', '2026-03-20', 9.9, 9.9, ALT_DERIVER); // non-default deriver: excluded
    await effort(a, 'old', '2026-01-01', 1.1, 1.1); // outside a 28d range
    await metric(a, '2026-03-27', 'oura', 'hrv', 60);
    await metric(a, '2026-03-27', 'terra', 'hrv', 55); // terra wins under this user's precedence
    await metric(a, '2026-03-26', 'oura', 'hrv', 58); // only source that day
    await metric(a, '2026-03-27', 'oura', 'resting_hr', 48);
    await metric(a, '2026-03-27', 'oura', 'sleep_score', 80); // not a charted series
    await effort(b, 'rb', '2026-03-20', 2, 2);
  });
  afterAll(async () => {
    await pool().query('DELETE FROM users WHERE id = ANY($1)', [[a, b]]);
    await pool().query('DELETE FROM derivers WHERE id = $1', [ALT_DERIVER]);
    await closePool();
  });

  it('returns default-deriver EF (sparse, never mixed) and precedence-resolved daily metrics', async () => {
    const res = await request(app)
      .get(`/trends/${a}?range=28d`)
      .set('Authorization', bearer(a, 'user'));
    expect(res.status).toBe(200);
    expect(res.body.series).toEqual({
      efPeak20: [
        { date: '2026-03-20', value: 1.5 },
        { date: '2026-03-20', value: 1.6 },
      ],
      efOverall: [
        { date: '2026-03-20', value: 1.4 },
        { date: '2026-03-20', value: 1.45 },
        { date: '2026-03-25', value: 1.3 },
      ],
      hrv: [
        { date: '2026-03-26', value: 58 },
        { date: '2026-03-27', value: 55 },
      ],
      restingHr: [{ date: '2026-03-27', value: 48 }],
    });
  });

  it('empty series (not missing) for a user with no data yet', async () => {
    const c = await mkUser('c');
    try {
      const res = await request(app).get(`/trends/${c}`).set('Authorization', bearer(c, 'user'));
      expect(res.status).toBe(200);
      expect(res.body.series).toEqual({ efPeak20: [], efOverall: [], hrv: [], restingHr: [] });
    } finally {
      await pool().query('DELETE FROM users WHERE id = $1', [c]);
    }
  });

  it('another user’s series is not readable', async () => {
    const res = await request(app).get(`/trends/${b}`).set('Authorization', bearer(a, 'user'));
    expect(res.status).toBe(403);
    expect(res.body.series).toBeUndefined();
  });
});
