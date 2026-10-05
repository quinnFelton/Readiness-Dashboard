import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { signApiToken } from '../auth/token';
import { acquireDefaultsTestMutex } from '../test-utils/defaults-mutex';
import { addDays, todayUtc } from '../trends/http';
import { closePool, getPool } from './pool';

// Smaller item: the admin roster called /trends/:id once per athlete. GET /users now carries the
// latest state per athlete (one DISTINCT ON query). Needs migrated local Postgres.
process.env.NEXTAUTH_SECRET = 'test-secret-test-secret-test-secret';
const bearer = (id: string, role: 'user' | 'master') =>
  `Bearer ${signApiToken({ userId: id, role }, { nowSec: Math.floor(Date.now() / 1000) })}`;

describe('GET /users latest state', () => {
  const app = createApp();
  const tag = randomBytes(4).toString('hex');
  const created: string[] = [];
  let release: () => Promise<void> = async () => {};
  let master: string;
  let a: string; // newer state wins
  let b: string; // state older than 28 days: not shown
  let c: string; // no trends at all
  let defaultId: string;
  const today = todayUtc(new Date());

  const mk = async (name: string, role: 'user' | 'master' = 'user') => {
    const id = (
      await getPool().query<{ id: string }>(
        `INSERT INTO users(email, role) VALUES ($1,$2) RETURNING id`,
        [`${name}-${tag}@phase9.invalid`, role],
      )
    ).rows[0]!.id;
    created.push(id);
    return id;
  };
  const state = (
    user: string,
    asOf: string,
    direction: string,
    classifier = defaultId,
    metric = 'fatigue_fitness_state',
  ) =>
    getPool().query(
      `INSERT INTO trends (user_id, classifier_id, as_of, metric_type, trend_window, direction)
       VALUES ($1,$2,$3::date,$4,'7d',$5)`,
      [user, classifier, asOf, metric, direction],
    );

  beforeAll(async () => {
    release = await acquireDefaultsTestMutex(getPool());
    defaultId = (
      await getPool().query<{ id: string }>(`SELECT id FROM classifiers WHERE is_default`)
    ).rows[0]!.id;
    [master, a, b, c] = [await mk('m', 'master'), await mk('a'), await mk('b'), await mk('c')];
    await state(a, addDays(today, -6), 'acute_fatigue');
    await state(a, addDays(today, -1), 'overreaching_risk'); // the latest
    await state(a, today, 'up', defaultId, 'hrv'); // not a state row: ignored
    await state(b, addDays(today, -40), 'fitness_gain'); // too old
  });
  afterAll(async () => {
    await getPool().query('DELETE FROM users WHERE id = ANY($1)', [created]);
    await release();
    await closePool();
  });

  const roster = async () => {
    const res = await request(app)
      .get('/api/v1/users')
      .set('Authorization', bearer(master, 'master'));
    expect(res.status).toBe(200);
    return Object.fromEntries(
      (
        res.body.users as {
          id: string;
          latestState: string | null;
          latestStateAsOf: string | null;
        }[]
      ).map((u) => [u.id, u]),
    );
  };

  it('serves the newest default-classifier state per athlete, in the same request as the roster', async () => {
    const r = await roster();
    expect(r[a]).toMatchObject({
      latestState: 'overreaching_risk',
      latestStateAsOf: addDays(today, -1),
    });
  });

  it('null (present, not absent) for athletes with no state in the last 28 days', async () => {
    const r = await roster();
    expect(r[b]).toMatchObject({ latestState: null, latestStateAsOf: null });
    expect(r[c]).toMatchObject({ latestState: null, latestStateAsOf: null });
    expect('latestState' in r[c]!).toBe(true); // the web roster only falls back to /trends/:id when it is undefined
  });

  it("ignores another classifier's rows", async () => {
    const other = `zz-other-${tag}`;
    await getPool().query(
      `INSERT INTO classifiers (id, description, is_default) VALUES ($1,'x',false)`,
      [other],
    );
    try {
      await state(c, today, 'fitness_gain', other);
      expect((await roster())[c]).toMatchObject({ latestState: null });
    } finally {
      await getPool().query('DELETE FROM trends WHERE classifier_id = $1', [other]);
      await getPool().query('DELETE FROM classifiers WHERE id = $1', [other]);
    }
  });

  it('is still master only: a plain user gets 403 and no state', async () => {
    const res = await request(app).get('/api/v1/users').set('Authorization', bearer(a, 'user'));
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('overreaching_risk');
  });
});
