import { randomBytes } from 'node:crypto';
import { EF_QUADRANT_V1 } from '@rd/scoring-engine';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { athleteEventsRouter } from '../athlete-events/routes';
import { signApiToken } from '../auth/token';
import { closePool, getPool } from '../users/pool';
import { feedbackRouter } from './routes';

// Needs migrated local Postgres.
process.env.NEXTAUTH_SECRET = 'test-secret-test-secret-test-secret';
const pool = () => getPool();
const tag = randomBytes(4).toString('hex');
const TODAY = '2026-03-28';
const bearer = (id: string, role: 'user' | 'master') =>
  `Bearer ${signApiToken({ userId: id, role }, { nowSec: Math.floor(Date.now() / 1000) })}`;

const app = express();
app.use(express.json());
const deps = { pool: pool(), now: () => new Date(`${TODAY}T12:00:00Z`) };
app.use('/feedback', feedbackRouter(deps));
app.use('/athlete-events', athleteEventsRouter(deps));

describe('feedback and athlete events (DB)', () => {
  let a: string;
  let b: string;
  let m: string;
  const mk = async (name: string, role: 'user' | 'master') =>
    (
      await pool().query<{ id: string }>(
        `INSERT INTO users(email, role) VALUES ($1,$2) RETURNING id`,
        [`${name}-${tag}@phase5b.invalid`, role],
      )
    ).rows[0]!.id;
  const count = async (table: string, user: string) =>
    (await pool().query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [user]))
      .rows[0].n;

  beforeAll(async () => {
    [a, b, m] = [await mk('a', 'user'), await mk('b', 'user'), await mk('m', 'master')];
    await pool().query(
      `INSERT INTO trends (user_id, classifier_id, as_of, metric_type, trend_window, direction)
       VALUES ($1,$2,$3::date,'fatigue_fitness_state','7d','overreaching_risk')`,
      [a, EF_QUADRANT_V1.id, TODAY],
    );
  });
  afterAll(async () => {
    await pool().query('DELETE FROM users WHERE id = ANY($1)', [[a, b, m]]);
    await closePool();
  });

  const vote = (v: number, extra: object = {}) => ({
    classifierId: EF_QUADRANT_V1.id,
    asOf: TODAY,
    vote: v,
    ...extra,
  });

  it('re-voting updates in place (idempotent on user, classifier, date, voter); records state', async () => {
    const put = (body: object) =>
      request(app).put(`/feedback/${a}`).set('Authorization', bearer(a, 'user')).send(body);
    expect((await put(vote(1))).body).toMatchObject({
      vote: 1,
      state: 'overreaching_risk',
      votedBy: a,
    });
    await put(vote(1));
    const flipped = await put(vote(-1, { comment: 'felt fine' }));
    expect(flipped.body).toMatchObject({ vote: -1, comment: 'felt fine' });
    expect(await count('insight_feedback', a)).toBe(1);
  });

  it('a master vote for the same athlete is a separate row (voted_by is in the key)', async () => {
    const res = await request(app)
      .put(`/feedback/${a}`)
      .set('Authorization', bearer(m, 'master'))
      .send(vote(1));
    expect(res.status).toBe(200);
    expect(await count('insight_feedback', a)).toBe(2);
  });

  it('rejects a vote for a trend that does not exist, and writes nothing', async () => {
    const res = await request(app)
      .put(`/feedback/${a}`)
      .set('Authorization', bearer(a, 'user'))
      .send(vote(1, { asOf: '2026-03-01' }));
    expect(res.status).toBe(404);
    expect(await count('insight_feedback', a)).toBe(2);
  });

  it('GET returns the athlete’s votes; another user gets 403 and nothing else leaks', async () => {
    const mine = await request(app).get(`/feedback/${a}`).set('Authorization', bearer(a, 'user'));
    expect(mine.status).toBe(200);
    expect(mine.body.votes).toHaveLength(2);
    const theirs = await request(app).get(`/feedback/${a}`).set('Authorization', bearer(b, 'user'));
    expect(theirs.status).toBe(403);
  });

  describe('athlete events', () => {
    const post = (as: string, role: 'user' | 'master', target: string, body: object) =>
      request(app)
        .post(`/athlete-events/${target}`)
        .set('Authorization', bearer(as, role))
        .send(body);

    it('create / list / delete, isolated per user', async () => {
      const created = await post(a, 'user', a, {
        date: '2026-03-20',
        eventType: 'illness',
        notes: 'flu',
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ eventType: 'illness', notes: 'flu', createdBy: a });
      const id = created.body.id as string;

      const listA = await request(app)
        .get(`/athlete-events/${a}`)
        .set('Authorization', bearer(a, 'user'));
      expect(listA.body.events.map((e: { id: string }) => e.id)).toEqual([id]);
      const listB = await request(app)
        .get(`/athlete-events/${b}`)
        .set('Authorization', bearer(b, 'user'));
      expect(listB.body.events).toEqual([]);

      // b can't delete a's event, by either route shape.
      expect(
        (
          await request(app)
            .delete(`/athlete-events/${a}/${id}`)
            .set('Authorization', bearer(b, 'user'))
        ).status,
      ).toBe(403);
      // ...nor via their own path with a's event id: scoped by user_id, matches nothing.
      expect(
        (
          await request(app)
            .delete(`/athlete-events/${b}/${id}`)
            .set('Authorization', bearer(b, 'user'))
        ).status,
      ).toBe(404);
      expect(await count('athlete_events', a)).toBe(1);

      expect(
        (
          await request(app)
            .delete(`/athlete-events/${a}/${id}`)
            .set('Authorization', bearer(a, 'user'))
        ).status,
      ).toBe(204);
      expect(await count('athlete_events', a)).toBe(0);
    });

    it('a master can log an event for an athlete; created_by is the master', async () => {
      const res = await post(m, 'master', b, { date: '2026-03-21', eventType: 'race' });
      expect(res.status).toBe(201);
      expect(res.body.createdBy).toBe(m);
    });

    it('per-user delete (§12) removes feedback and events via cascade', async () => {
      await pool().query('DELETE FROM users WHERE id = $1', [a]);
      expect(await count('insight_feedback', a)).toBe(0);
      expect(await count('athlete_events', a)).toBe(0);
    });
  });
});
