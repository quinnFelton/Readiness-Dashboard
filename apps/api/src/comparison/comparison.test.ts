import { randomBytes } from 'node:crypto';
import {
  EF_QUADRANT_V1,
  StrategyRegistry,
  type TrendClassifier,
  efQuadrantClassifier,
} from '@rd/scoring-engine';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signApiToken } from '../auth/token';
import { closePool, getPool } from '../users/pool';
import { comparisonRouter } from './routes';

// Needs migrated local Postgres. Numeric assertions use a classifier id private to this file and
// an event type no other test file writes (`injury`), so concurrent test files can't skew them.
process.env.NEXTAUTH_SECRET = 'test-secret-test-secret-test-secret';
const pool = () => getPool();
const tag = randomBytes(4).toString('hex');
const ALT = `cmp_alt_${tag}`;
const DB_ONLY = `cmp_dbonly_${tag}`; // has a classifiers row, but no code behind it
const CODE_ONLY = `cmp_codeonly_${tag}`; // registered in code, but no classifiers row
const TODAY = '2026-03-28';

const registry = new StrategyRegistry<TrendClassifier>('classifier', [
  EF_QUADRANT_V1,
  efQuadrantClassifier(ALT, 'alt', {}),
  efQuadrantClassifier(CODE_ONLY, 'code only', {}),
]);
const bearer = (id: string, role: 'user' | 'master') =>
  `Bearer ${signApiToken({ userId: id, role }, { nowSec: Math.floor(Date.now() / 1000) })}`;

const app = express();
app.use(express.json());
app.use(
  '/comparison',
  comparisonRouter({
    pool: pool(),
    classifiers: registry,
    now: () => new Date(`${TODAY}T12:00:00Z`),
    config: {
      leadDays: 3,
      flagStates: ['overreaching_risk', 'acute_fatigue'],
      eventTypes: ['injury'],
    },
  }),
);

describe('comparison routes (DB)', () => {
  let u: string;
  let v: string;
  let m: string;
  const mk = async (name: string, role: 'user' | 'master') =>
    (
      await pool().query<{ id: string }>(
        `INSERT INTO users(email, role) VALUES ($1,$2) RETURNING id`,
        [`${name}-${tag}@phase5b.invalid`, role],
      )
    ).rows[0]!.id;
  const defaults = async () =>
    (await pool().query<{ id: string }>(`SELECT id FROM classifiers WHERE is_default`)).rows.map(
      (r) => r.id,
    );
  const get = (path: string, as: string, role: 'user' | 'master' = 'master') =>
    request(app).get(path).set('Authorization', bearer(as, role));

  beforeAll(async () => {
    for (const id of [ALT, DB_ONLY]) {
      await pool().query(`INSERT INTO classifiers (id, description) VALUES ($1,'test')`, [id]);
    }
    [u, v, m] = [await mk('u', 'user'), await mk('v', 'user'), await mk('m', 'master')];
    const flag = (date: string, state: string) =>
      pool().query(
        `INSERT INTO trends (user_id, classifier_id, as_of, metric_type, trend_window, direction)
         VALUES ($1,$2,$3::date,'fatigue_fitness_state','7d',$4)`,
        [u, ALT, date, state],
      );
    // Hand-checked fixture, lead = 3 days (see backtest.test.ts for the same reasoning):
    //  events: u injury 03-04, u injury 03-15, v injury 03-12 (v has no flags at all)
    //   03-04 preceded by 03-01 (gap 3) / 03-02 (gap 2); 03-15 not (03-10 is gap 5); 03-12 not
    //   ⇒ considered 3, preceded 1
    //  flags: 03-01 hit, 03-02 hit, 03-10 false alarm, 03-20 false alarm, 03-27 pending
    //   ('ambiguous' 03-25 isn't a counted state) ⇒ judged 4, falseAlarms 2, pending 1
    await flag('2026-03-01', 'overreaching_risk');
    await flag('2026-03-02', 'acute_fatigue');
    await flag('2026-03-10', 'overreaching_risk');
    await flag('2026-03-20', 'acute_fatigue');
    await flag('2026-03-25', 'ambiguous');
    await flag('2026-03-27', 'overreaching_risk');
    for (const [user, date] of [
      [u, '2026-03-04'],
      [u, '2026-03-15'],
      [v, '2026-03-12'],
    ] as const) {
      await pool().query(
        `INSERT INTO athlete_events (user_id, date, event_type) VALUES ($1,$2::date,'injury')`,
        [user, date],
      );
    }
    // Agreement: 2 up, 1 down on ALT.
    for (const [date, vote] of [
      ['2026-03-01', 1],
      ['2026-03-02', 1],
      ['2026-03-10', -1],
    ] as const) {
      await pool().query(
        `INSERT INTO insight_feedback (user_id, classifier_id, as_of, state, vote, voted_by)
         VALUES ($1,$2,$3::date,'x',$4,$1)`,
        [u, ALT, date, vote],
      );
    }
  });
  afterAll(async () => {
    await pool().query('DELETE FROM users WHERE id = ANY($1)', [[u, v, m]]); // cascades events/feedback
    await pool().query('DELETE FROM trends WHERE classifier_id = ANY($1)', [[ALT, DB_ONLY]]);
    await pool().query('DELETE FROM classifiers WHERE id = ANY($1)', [[ALT, DB_ONLY]]);
    await closePool();
  });

  it('403 for a plain user on every comparison route', async () => {
    expect((await get('/comparison/classifiers', u, 'user')).status).toBe(403);
    expect((await get('/comparison/derivers', u, 'user')).status).toBe(403);
    const put = await request(app)
      .put(`/comparison/classifiers/${ALT}/default`)
      .set('Authorization', bearer(u, 'user'));
    expect(put.status).toBe(403);
  });

  it('reports agreement and backtest numbers matching the hand-checked fixture', async () => {
    const res = await get('/comparison/classifiers?range=90d', m);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ leadDays: 3, range: '90d' });
    const alt = res.body.classifiers.find((c: { id: string }) => c.id === ALT);
    expect(alt.agreement).toEqual({ up: 2, down: 1, rate: 2 / 3 });
    expect(alt.backtest).toMatchObject({
      eventsConsidered: 3,
      eventsPreceded: 1,
      flagsJudged: 4,
      falseAlarms: 2,
      flagsPending: 1,
      recall: 1 / 3,
      falseAlarmRate: 0.5,
    });
    expect(alt.registered).toBe(true);
    expect(alt.isDefault).toBe(false);
    const flagged = res.body.classifiers.filter((c: { isDefault: boolean }) => c.isDefault);
    expect(flagged).toHaveLength(1);
  });

  it('lists derivers with their default flag', async () => {
    const res = await get('/comparison/derivers', m);
    expect(res.status).toBe(200);
    const def = res.body.derivers.filter((d: { isDefault: boolean }) => d.isDefault);
    expect(def).toHaveLength(1);
  });

  it('promotion leaves exactly one default, and is reversible and repeatable', async () => {
    const original = (await defaults())[0]!;
    const put = (id: string) =>
      request(app)
        .put(`/comparison/classifiers/${id}/default`)
        .set('Authorization', bearer(m, 'master'));
    try {
      expect((await put(ALT)).body).toEqual({ defaultClassifierId: ALT });
      expect(await defaults()).toEqual([ALT]);
      expect((await put(ALT)).status).toBe(200); // idempotent
      expect(await defaults()).toEqual([ALT]);
    } finally {
      await put(original);
    }
    expect(await defaults()).toEqual([original]);
  });

  it('refuses ids that are not in the code registry, or have no classifiers row', async () => {
    const before = await defaults();
    const put = (id: string) =>
      request(app)
        .put(`/comparison/classifiers/${id}/default`)
        .set('Authorization', bearer(m, 'master'));
    expect((await put(DB_ONLY)).status).toBe(400); // DB row, no code
    expect((await put(CODE_ONLY)).status).toBe(404); // code, no DB row
    expect(await defaults()).toEqual(before); // nothing changed
  });
});
