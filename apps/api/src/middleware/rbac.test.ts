import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signApiToken } from '../auth/token';

// DB-free RBAC tests: UserService is mocked so these run without Postgres.
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

import { requireMaster, requireSelfOrMaster, requireUser } from './rbac';

const SECRET = 'test-secret-test-secret-test-secret';
process.env.NEXTAUTH_SECRET = SECRET;
const now = () => Math.floor(Date.now() / 1000);
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';
const bearer = (id: string, role: 'user' | 'master' = 'user') =>
  `Bearer ${signApiToken({ userId: id, role }, { nowSec: now() })}`;

const app = express();
app.get('/me', requireUser, (req, res) => res.json({ id: req.user?.id }));
app.get('/admin', requireUser, requireMaster, (_req, res) => res.json({ ok: true }));
app.get('/things/:userId', requireUser, requireSelfOrMaster('userId'), (_req, res) =>
  res.json({ ok: true }),
);
app.get('/noparam', requireUser, requireSelfOrMaster('userId'), (_req, res) =>
  res.json({ ok: true }),
);
app.get('/nouser', requireMaster, (_req, res) => res.json({ ok: true }));

beforeEach(() => {
  users.clear();
  users.set(A, { id: A, email: 'a@x.test', name: null, role: 'user', createdAt: '' });
  users.set(B, { id: B, email: 'b@x.test', name: null, role: 'user', createdAt: '' });
  users.set(M, { id: M, email: 'm@x.test', name: null, role: 'master', createdAt: '' });
});

describe('requireUser', () => {
  it('401 with no header', async () => {
    expect((await request(app).get('/me')).status).toBe(401);
  });
  it.each(['Basic abc', 'Bearer', 'Bearer a b', 'bearer'])(
    '401 for malformed header %s',
    async (h) => {
      expect((await request(app).get('/me').set('Authorization', h)).status).toBe(401);
    },
  );
  it('accepts lowercase scheme', async () => {
    const t = bearer(A).replace('Bearer', 'bearer');
    expect((await request(app).get('/me').set('Authorization', t)).status).toBe(200);
  });
  it('401 when the user was deleted after token issue', async () => {
    const h = bearer(A);
    users.delete(A);
    expect((await request(app).get('/me').set('Authorization', h)).status).toBe(401);
  });
  it('200 and sets req.user', async () => {
    const res = await request(app).get('/me').set('Authorization', bearer(A));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(A);
  });
  it('401 for a token with a different audience/issuer', async () => {
    const forgedBody = Buffer.from(
      JSON.stringify({ sub: A, iss: 'evil', aud: 'rd-api', iat: now(), exp: now() + 100 }),
    ).toString('base64url');
    const good = signApiToken({ userId: A, role: 'user' }, { nowSec: now() });
    const [h, , s] = good.split('.');
    const res = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${h}.${forgedBody}.${s}`);
    expect(res.status).toBe(401);
  });
});

describe('requireMaster', () => {
  it('401 unauthenticated, 403 user, 200 master', async () => {
    expect((await request(app).get('/admin')).status).toBe(401);
    expect((await request(app).get('/admin').set('Authorization', bearer(A))).status).toBe(403);
    expect(
      (await request(app).get('/admin').set('Authorization', bearer(M, 'master'))).status,
    ).toBe(200);
  });
  it('role comes from DB: master claim in token for a plain user is 403', async () => {
    expect(
      (await request(app).get('/admin').set('Authorization', bearer(A, 'master'))).status,
    ).toBe(403);
  });
  it('role comes from DB: demoted master loses access', async () => {
    const h = bearer(M, 'master');
    users.set(M, { ...users.get(M)!, role: 'user' });
    expect((await request(app).get('/admin').set('Authorization', h)).status).toBe(403);
  });
  it('fails closed (401) if used without requireUser', async () => {
    expect((await request(app).get('/nouser')).status).toBe(401);
  });
});

describe('requireSelfOrMaster', () => {
  it('401 unauthenticated', async () => {
    expect((await request(app).get(`/things/${A}`)).status).toBe(401);
  });
  it('self 200, other 403, master 200', async () => {
    expect((await request(app).get(`/things/${A}`).set('Authorization', bearer(A))).status).toBe(
      200,
    );
    expect((await request(app).get(`/things/${B}`).set('Authorization', bearer(A))).status).toBe(
      403,
    );
    expect(
      (await request(app).get(`/things/${B}`).set('Authorization', bearer(M, 'master'))).status,
    ).toBe(200);
  });
  it('is case-sensitive on id (no uppercase bypass of another id)', async () => {
    expect(
      (await request(app).get(`/things/${B.toUpperCase()}`).set('Authorization', bearer(A))).status,
    ).toBe(403);
  });
  it('denies a plain user when the param is missing (fail closed)', async () => {
    expect((await request(app).get('/noparam').set('Authorization', bearer(A))).status).toBe(403);
  });
});
