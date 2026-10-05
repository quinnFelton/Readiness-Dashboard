import { randomBytes } from 'node:crypto';
import { EF_QUADRANT_V1 } from '@rd/scoring-engine';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signApiToken } from '../auth/token';
import { scoresRouter } from '../scores/routes';
import { closePool, getPool } from '../users/pool';
import { trendsRouter } from './routes';

// Needs migrated local Postgres. Rows are seeded directly: these routes only read precomputed data.
process.env.NEXTAUTH_SECRET = 'test-secret-test-secret-test-secret';
const pool = () => getPool();
const tag = randomBytes(4).toString('hex');
const ALT = `routes_alt_${tag}`;
const TODAY = '2026-03-28';

const bearer = (id: string, role: 'user' | 'master') =>
  `Bearer ${signApiToken({ userId: id, role }, { nowSec: Math.floor(Date.now() / 1000) })}`;

const app = express();
app.use(express.json());
const deps = { pool: pool(), now: () => new Date(`${TODAY}T12:00:00Z`) };
app.use('/trends', trendsRouter(deps));
app.use('/scores', scoresRouter(deps));

describe('GET /trends and /scores (read precomputed rows only)', () => {
  let a: string;
  let b: string;
  let m: string;
  const mk = async (name: string, role: 'user' | 'master') =>
    (
      await pool().query<{ id: string }>(
        `INSERT INTO users(email, role) VALUES ($1, $2) RETURNING id`,
        [`${name}-${tag}@phase5b.invalid`, role],
      )
    ).rows[0]!.id;
  const seedTrend = (user: string, classifier: string, asOf: string, state: string) =>
    pool().query(
      `INSERT INTO trends (user_id, classifier_id, as_of, metric_type, trend_window, direction, insight_text)
       VALUES ($1,$2,$3::date,'fatigue_fitness_state','7d',$4,'text')`,
      [user, classifier, asOf, state],
    );

  beforeAll(async () => {
    await pool().query(`INSERT INTO classifiers (id, description) VALUES ($1,'test')`, [ALT]);
    [a, b, m] = [await mk('a', 'user'), await mk('b', 'user'), await mk('m', 'master')];
    await seedTrend(a, EF_QUADRANT_V1.id, TODAY, 'acute_fatigue');
    await seedTrend(a, ALT, TODAY, 'ambiguous');
    await seedTrend(a, EF_QUADRANT_V1.id, '2025-01-01', 'steady'); // outside a 28d range
    await seedTrend(b, EF_QUADRANT_V1.id, TODAY, 'fitness_gain');
    await pool().query(
      `INSERT INTO readiness_scores (user_id, date, score, components_jsonb) VALUES ($1,$2::date,72,'{}')`,
      [a, TODAY],
    );
  });
  afterAll(async () => {
    await pool().query('DELETE FROM users WHERE id = ANY($1)', [[a, b, m]]);
    await pool().query('DELETE FROM classifiers WHERE id = $1', [ALT]);
    await closePool();
  });

  it('returns only the default classifier’s rows to a plain user, within the range', async () => {
    const res = await request(app)
      .get(`/trends/${a}?range=28d`)
      .set('Authorization', bearer(a, 'user'));
    expect(res.status).toBe(200);
    expect(res.body.classifierId).toBe(EF_QUADRANT_V1.id);
    expect(res.body.trends.map((t: { direction: string }) => t.direction)).toEqual([
      'acute_fatigue',
    ]);
  });

  it('a user cannot read another user’s trends or scores', async () => {
    for (const p of ['trends', 'scores']) {
      const res = await request(app).get(`/${p}/${b}`).set('Authorization', bearer(a, 'user'));
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('fitness_gain');
    }
  });

  it('?classifier=<non-default>: 403 for a user, works for a master, 404 if unknown', async () => {
    const asUser = await request(app)
      .get(`/trends/${a}?classifier=${ALT}`)
      .set('Authorization', bearer(a, 'user'));
    expect(asUser.status).toBe(403);
    const asMaster = await request(app)
      .get(`/trends/${a}?classifier=${ALT}`)
      .set('Authorization', bearer(m, 'master'));
    expect(asMaster.status).toBe(200);
    expect(asMaster.body.trends.map((t: { direction: string }) => t.direction)).toEqual([
      'ambiguous',
    ]);
    const unknown = await request(app)
      .get(`/trends/${a}?classifier=nope`)
      .set('Authorization', bearer(m, 'master'));
    expect(unknown.status).toBe(404);
  });

  it('/scores joins the chosen classifier’s state onto the readiness series', async () => {
    const res = await request(app).get(`/scores/${a}`).set('Authorization', bearer(a, 'user'));
    expect(res.status).toBe(200);
    expect(res.body.scores).toEqual([
      expect.objectContaining({ date: TODAY, score: 72, state: 'acute_fatigue' }),
    ]);
    const alt = await request(app)
      .get(`/scores/${a}?classifier=${ALT}`)
      .set('Authorization', bearer(m, 'master'));
    expect(alt.body.scores[0].state).toBe('ambiguous');
  });
});
