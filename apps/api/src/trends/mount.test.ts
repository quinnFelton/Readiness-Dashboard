import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { signApiToken } from '../auth/token';
import { acquireDefaultsTestMutex } from '../test-utils/defaults-mutex';
import { closePool, getPool } from '../users/pool';

// Reads or changes the global default classifier/deriver flags: serialise with other such files.
let releaseDefaultsLock: () => Promise<void> = async () => {};

// Integration stage D: the phase-5b routers are mounted on the real app (apps/api/src/app.ts) after
// express.json(). Every route must reach its router and answer 401/403 — never 404, which would mean
// "not mounted". /comparison is master-only (PLAN §8.7). Needs migrated local Postgres.
describe('phase 5b routers are mounted on the real app', () => {
  let a: string; // plain user
  let b: string; // another plain user
  let m: string; // master
  const app = () => createApp();
  const nowSec = () => Math.floor(Date.now() / 1000);
  const bearer = (userId: string, role: 'user' | 'master' = 'user') =>
    `Bearer ${signApiToken({ userId, role }, { nowSec: nowSec() })}`;
  const EVENT = '44444444-4444-4444-8444-444444444444';

  beforeAll(async () => {
    releaseDefaultsLock = await acquireDefaultsTestMutex(getPool());
    vi.stubEnv('NEXTAUTH_SECRET', 'test-secret-test-secret-test-secret');
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    const tag = randomBytes(4).toString('hex');
    const ins = async (who: string, role: 'user' | 'master') =>
      (
        await getPool().query<{ id: string }>(
          `INSERT INTO users(email, role) VALUES ($1, $2) RETURNING id`,
          [`${who}-${tag}@stage-d.invalid`, role],
        )
      ).rows[0]!.id;
    a = await ins('a', 'user');
    b = await ins('b', 'user');
    m = await ins('m', 'master');
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await getPool().query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[a, b, m]]); // cascades
    await releaseDefaultsLock();
    await closePool();
  });

  type Method = 'get' | 'put' | 'post' | 'delete';
  const perUser = (): [string, Method, string, object?][] => [
    ['scores', 'get', `/api/v1/scores/${b}`],
    ['trends', 'get', `/api/v1/trends/${b}`],
    ['feedback read', 'get', `/api/v1/feedback/${b}`],
    [
      'feedback write',
      'put',
      `/api/v1/feedback/${b}`,
      { classifierId: 'ef_quadrant_v1', asOf: '2026-03-27', vote: 1 },
    ],
    ['events read', 'get', `/api/v1/athlete-events/${b}`],
    [
      'events write',
      'post',
      `/api/v1/athlete-events/${b}`,
      { date: '2026-03-20', eventType: 'race' },
    ],
    ['events delete', 'delete', `/api/v1/athlete-events/${b}/${EVENT}`],
  ];

  it('per-user routes: 401 without a token, 403 for a plain user on another user, never 404', async () => {
    for (const [name, method, path, body] of perUser()) {
      const anon = request(app())[method](path);
      const anonRes = await (body ? anon.send(body) : anon);
      expect(anonRes.status, `${name} anonymous`).toBe(401);

      const other = request(app())[method](path).set('authorization', bearer(a));
      const otherRes = await (body ? other.send(body) : other);
      expect(otherRes.status, `${name} cross-user`).toBe(403);
    }
  });

  const comparison: [Method, string][] = [
    ['get', '/api/v1/comparison/classifiers'],
    ['put', '/api/v1/comparison/classifiers/ef_quadrant_v1/default'],
    ['get', '/api/v1/comparison/derivers'],
  ];

  it('comparison routes: 401 without a token, 403 for any non-master (even with a forged master claim)', async () => {
    for (const [method, path] of comparison) {
      expect((await request(app())[method](path)).status, `${path} anonymous`).toBe(401);
      expect(
        (await request(app())[method](path).set('authorization', bearer(a))).status,
        `${path} user`,
      ).toBe(403);
      expect(
        (await request(app())[method](path).set('authorization', bearer(a, 'master'))).status,
        `${path} forged master claim`,
      ).toBe(403);
    }
  });

  it('a master reaches comparison and another user’s trends; a user reads their own', async () => {
    const der = await request(app())
      .get('/api/v1/comparison/derivers')
      .set('authorization', bearer(m, 'master'));
    expect(der.status).toBe(200);
    expect(der.body.derivers.some((d: { id: string }) => d.id === 'peak20_v1')).toBe(true);

    const masterRead = await request(app())
      .get(`/api/v1/trends/${b}`)
      .set('authorization', bearer(m, 'master'));
    expect(masterRead.status).toBe(200);
    expect(masterRead.body).toMatchObject({ userId: b, classifierId: 'ef_quadrant_v1' });

    const own = await request(app()).get(`/api/v1/scores/${a}`).set('authorization', bearer(a));
    expect(own.status).toBe(200);
    expect(own.body.scores).toEqual([]);
  });

  it('JSON bodies are parsed (mounted after express.json())', async () => {
    const res = await request(app())
      .post(`/api/v1/athlete-events/${a}`)
      .set('authorization', bearer(a))
      .send({ date: '2026-03-20', eventType: 'planned_rest' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ date: '2026-03-20', eventType: 'planned_rest', createdBy: a });
  });

  // 5b tester follow-up: athlete-event `notes` must never be logged (CLAUDE.md rule 6), mirroring
  // the feedback-comment check in comparison/authz.test.ts — here end to end through the real app.
  describe('athlete-event notes are never logged', () => {
    const SECRET = 'SECRET-ATHLETE-NOTE-7c21';
    let spies: ReturnType<typeof vi.spyOn>[];
    beforeEach(() => {
      spies = [
        ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k)),
        vi.spyOn(process.stdout, 'write'),
        vi.spyOn(process.stderr, 'write'),
      ];
    });
    afterEach(() => {
      for (const s of spies) s.mockRestore();
    });
    const logged = () =>
      spies
        .flatMap((s) => s.mock.calls)
        .map((c) => JSON.stringify(c))
        .join('\n');

    it('create, list and delete with notes: notes returned to the caller, absent from logs', async () => {
      const created = await request(app())
        .post(`/api/v1/athlete-events/${a}`)
        .set('authorization', bearer(a))
        .send({ date: '2026-03-21', eventType: 'illness', notes: SECRET });
      expect(created.status).toBe(201);
      expect(created.body.notes).toBe(SECRET);

      const list = await request(app())
        .get(`/api/v1/athlete-events/${a}?range=366d`)
        .set('authorization', bearer(a));
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).toContain(SECRET);

      const del = await request(app())
        .delete(`/api/v1/athlete-events/${a}/${created.body.id as string}`)
        .set('authorization', bearer(a));
      expect(del.status).toBe(204);

      expect(logged()).not.toContain(SECRET);
    });

    it('a rejected (too long) note is not echoed in the response or the logs', async () => {
      const long = SECRET.repeat(50); // > 1000 chars
      const res = await request(app())
        .post(`/api/v1/athlete-events/${a}`)
        .set('authorization', bearer(a))
        .send({ date: '2026-03-21', eventType: 'injury', notes: long });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
      expect(logged()).not.toContain(SECRET);
    });

    it('a cross-user write with notes is 403 and the notes are not logged', async () => {
      const res = await request(app())
        .post(`/api/v1/athlete-events/${b}`)
        .set('authorization', bearer(a))
        .send({ date: '2026-03-21', eventType: 'injury', notes: SECRET });
      expect(res.status).toBe(403);
      expect(logged()).not.toContain(SECRET);
    });
  });
});
