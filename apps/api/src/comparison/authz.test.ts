import express from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signApiToken } from '../auth/token';

// DB-free: users are mocked (as in rbac.test.ts) and the pool is a stub that records every query.
// These tests prove the authorization boundary: a request that fails requireSelfOrMaster /
// requireMaster must be rejected BEFORE any SQL runs, and notes/comments must never be logged.
const users = new Map<
  string,
  { id: string; email: string; name: null; role: 'user' | 'master'; createdAt: string }
>();
vi.mock('../users/pool', () => ({ getPool: () => ({}) }));
vi.mock('../users/service', () => ({
  UserService: class {
    async getById(id: string) {
      return users.get(id) ?? null;
    }
  },
}));

import { athleteEventsRouter } from '../athlete-events/routes';
import { feedbackRouter } from '../feedback/routes';
import { scoresRouter } from '../scores/routes';
import { trendsRouter } from '../trends/routes';
import { comparisonRouter } from './routes';

process.env.NEXTAUTH_SECRET = 'test-secret-test-secret-test-secret';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';
const EVENT = '44444444-4444-4444-8444-444444444444';
const nowSec = () => Math.floor(Date.now() / 1000);
const bearer = (id: string, role: 'user' | 'master' = 'user') =>
  `Bearer ${signApiToken({ userId: id, role }, { nowSec: nowSec() })}`;

const query = vi.fn();
const pool = { query, connect: vi.fn() } as unknown as pg.Pool;
const now = () => new Date('2026-03-28T12:00:00Z');

const app = express();
app.use(express.json());
app.use('/trends', trendsRouter({ pool, now }));
app.use('/scores', scoresRouter({ pool, now }));
app.use('/feedback', feedbackRouter({ pool, now }));
app.use('/athlete-events', athleteEventsRouter({ pool, now }));
app.use('/comparison', comparisonRouter({ pool, now }));

beforeEach(() => {
  users.clear();
  users.set(A, { id: A, email: 'a@x.test', name: null, role: 'user', createdAt: '' });
  users.set(B, { id: B, email: 'b@x.test', name: null, role: 'user', createdAt: '' });
  users.set(M, { id: M, email: 'm@x.test', name: null, role: 'master', createdAt: '' });
  query.mockReset();
  // The default classifier lookup is the only query a rejected-early request may reach.
  query.mockImplementation(async (sql: string) =>
    /is_default/.test(sql) ? { rows: [{ id: 'ef_quadrant_v1' }] } : { rows: [], rowCount: 0 },
  );
});

const vote = { classifierId: 'ef_quadrant_v1', asOf: '2026-03-27', vote: 1, comment: 'x' };
const evt = { date: '2026-03-20', eventType: 'illness', notes: 'x' };

describe('a plain user cannot read or write another user’s data (403 before any SQL)', () => {
  const cases: [string, 'get' | 'put' | 'post' | 'delete', string, object?][] = [
    ['trends', 'get', `/trends/${B}`],
    ['scores', 'get', `/scores/${B}`],
    ['feedback read', 'get', `/feedback/${B}`],
    ['feedback write', 'put', `/feedback/${B}`, vote],
    ['events read', 'get', `/athlete-events/${B}`],
    ['events write', 'post', `/athlete-events/${B}`, evt],
    ['events delete', 'delete', `/athlete-events/${B}/${EVENT}`],
  ];
  it.each(cases)('%s', async (_n, method, path, body) => {
    const req = request(app)[method](path).set('Authorization', bearer(A));
    const res = await (body ? req.send(body) : req);
    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(cases)('%s: 401 without a token', async (_n, method, path, body) => {
    const req = request(app)[method](path);
    const res = await (body ? req.send(body) : req);
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('comparison routes are master-only', () => {
  const routes: ['get' | 'put', string][] = [
    ['get', '/comparison/classifiers'],
    ['put', '/comparison/classifiers/ef_quadrant_v1/default'],
    ['get', '/comparison/derivers'],
  ];
  it.each(routes)('%s %s → 403 for a plain user, 401 anonymous', async (method, path) => {
    expect((await request(app)[method](path).set('Authorization', bearer(A))).status).toBe(403);
    expect((await request(app)[method](path)).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('a master token claim for a plain user is still 403 (role comes from the DB)', async () => {
    const res = await request(app)
      .get('/comparison/derivers')
      .set('Authorization', bearer(A, 'master'));
    expect(res.status).toBe(403);
  });

  it('refuses to promote an id that is not in the code registry (400, no SQL)', async () => {
    const res = await request(app)
      .put('/comparison/classifiers/not_registered_v9/default')
      .set('Authorization', bearer(M, 'master'));
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('classifier selection', () => {
  it('a plain user asking for a non-default classifier gets 403', async () => {
    for (const p of ['trends', 'scores']) {
      const res = await request(app)
        .get(`/${p}/${A}?classifier=other_variant_v1`)
        .set('Authorization', bearer(A));
      expect(res.status).toBe(403);
    }
  });

  it('a plain user may name the default classifier explicitly', async () => {
    const res = await request(app)
      .get(`/trends/${A}?classifier=ef_quadrant_v1`)
      .set('Authorization', bearer(A));
    expect(res.status).toBe(200);
    expect(res.body.classifierId).toBe('ef_quadrant_v1');
  });

  it('a plain user cannot vote on a non-default classifier', async () => {
    const res = await request(app)
      .put(`/feedback/${A}`)
      .set('Authorization', bearer(A))
      .send({ ...vote, classifierId: 'other_variant_v1' });
    expect(res.status).toBe(403);
  });

  it('a default flag with no registered code fails loudly (500), no silent fallback', async () => {
    query.mockImplementation(async (sql: string) =>
      /is_default/.test(sql) ? { rows: [{ id: 'unregistered_v7' }] } : { rows: [] },
    );
    const res = await request(app).get(`/trends/${A}`).set('Authorization', bearer(A));
    expect(res.status).toBe(500);
  });
});

describe('input validation', () => {
  const own = (m: 'put' | 'post', path: string, body: object) =>
    request(app)[m](path).set('Authorization', bearer(A)).send(body);

  it.each([
    [{ ...vote, vote: 0 }],
    [{ ...vote, vote: 2 }],
    [{ ...vote, vote: '1' }],
    [{ ...vote, asOf: '2026-02-30' }],
    [{ ...vote, classifierId: '' }],
    [{ ...vote, comment: 'x'.repeat(501) }],
  ])('feedback rejects bad body %#', async (body) => {
    expect((await own('put', `/feedback/${A}`, body)).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('feedback for a trend that does not exist is 404 and writes nothing', async () => {
    const res = await own('put', `/feedback/${A}`, vote);
    expect(res.status).toBe(404);
    expect(query.mock.calls.some(([sql]) => /INSERT/.test(String(sql)))).toBe(false);
  });

  it.each([
    [{ ...evt, eventType: 'cold' }],
    [{ ...evt, date: 'yesterday' }],
    [{ ...evt, notes: 'x'.repeat(1001) }],
  ])('athlete event rejects bad body %#', async (body) => {
    expect((await own('post', `/athlete-events/${A}`, body)).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['28', '0d', '999d', 'abc'])('range=%s is a 400', async (range) => {
    const res = await request(app)
      .get(`/trends/${A}?range=${range}`)
      .set('Authorization', bearer(A));
    expect(res.status).toBe(400);
  });
});

describe('notes and comments are never logged (CLAUDE.md rule 6)', () => {
  const SECRET = 'SECRET-HEALTH-TEXT-9f3a';
  const spies = () =>
    (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
  let all: ReturnType<typeof spies>;
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    all = spies();
    stdout = vi.spyOn(process.stdout, 'write');
    stderr = vi.spyOn(process.stderr, 'write');
  });
  afterEach(() => vi.restoreAllMocks());

  const logged = () =>
    [...all.flatMap((s) => s.mock.calls), ...stdout.mock.calls, ...stderr.mock.calls]
      .map((c) => JSON.stringify(c))
      .join('\n');

  it('a database error that quotes the row does not reach the logs or the response', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/INSERT INTO athlete_events/.test(sql)) {
        throw new Error(`Failing row contains (${SECRET})`);
      }
      return { rows: [], rowCount: 0 };
    });
    const res = await request(app)
      .post(`/athlete-events/${A}`)
      .set('Authorization', bearer(A))
      .send({ date: '2026-03-20', eventType: 'illness', notes: SECRET });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(logged()).not.toContain(SECRET);
  });

  it('same for a feedback comment', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/FROM trends/.test(sql)) return { rows: [{ direction: 'acute_fatigue' }] };
      if (/is_default/.test(sql)) return { rows: [{ id: 'ef_quadrant_v1' }] };
      if (/INSERT INTO insight_feedback/.test(sql)) throw new Error(`bad row (${SECRET})`);
      return { rows: [] };
    });
    const res = await request(app)
      .put(`/feedback/${A}`)
      .set('Authorization', bearer(A))
      .send({ ...vote, comment: SECRET });
    expect(res.status).toBe(500);
    expect(logged()).not.toContain(SECRET);
  });
});
