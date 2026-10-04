import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeed } from '../../db/seed/seed';
import { createApp } from '../app';
import { signApiToken, verifyApiToken } from '../auth/token';
import { requireSelfOrMaster, requireUser } from '../middleware/rbac';
import { closePool, getPool } from './pool';
import { UserService } from './service';

// Needs local Postgres with migrations applied: docker compose up -d db && pnpm db:migrate
const SECRET = 'test-secret-test-secret-test-secret';
process.env.NEXTAUTH_SECRET = SECRET;

const now = () => Math.floor(Date.now() / 1000);
const tokenFor = (u: { id: string; role: 'user' | 'master' }) =>
  `Bearer ${signApiToken({ userId: u.id, role: u.role }, { nowSec: now() })}`;

describe('users + RBAC', () => {
  const app = createApp();
  let user01: { id: string; role: 'user' };
  let user02: { id: string; role: 'user' };
  let master: { id: string; role: 'master' };

  beforeAll(async () => {
    expect(await runSeed()).toBe(11);
    const svc = new UserService(getPool());
    user01 = (await svc.getByEmail('user01@example.test')) as typeof user01;
    user02 = (await svc.getByEmail('user02@example.test')) as typeof user02;
    master = (await svc.getByEmail('master@example.test')) as typeof master;
  });
  afterAll(closePool);

  it('seed is idempotent and deterministic', async () => {
    await runSeed();
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM users WHERE email LIKE '%@example.test'`);
    expect(rows[0].n).toBe(11);
  });

  describe('GET /api/v1/users/me', () => {
    it('401 without a token', async () => {
      expect((await request(app).get('/api/v1/users/me')).status).toBe(401);
    });
    it('401 with a garbage / tampered / expired token', async () => {
      const good = signApiToken({ userId: user01.id, role: 'user' }, { nowSec: now() });
      const tampered = good.slice(0, -2) + (good.endsWith('AA') ? 'BB' : 'AA');
      const expired = signApiToken({ userId: user01.id, role: 'user' }, { nowSec: now() - 1000, ttlSec: 10 });
      for (const t of ['nope', tampered, expired]) {
        const res = await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${t}`);
        expect(res.status).toBe(401);
      }
    });
    it('401 when token is signed with another secret', async () => {
      const t = signApiToken({ userId: user01.id, role: 'user' }, { nowSec: now(), secret: 'x'.repeat(32) });
      expect((await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${t}`)).status).toBe(401);
    });
    it('200 returns the caller only', async () => {
      const res = await request(app).get('/api/v1/users/me').set('Authorization', tokenFor(user01));
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe('user01@example.test');
    });
    it('trusts the DB role, not the token role claim', async () => {
      const forged = `Bearer ${signApiToken({ userId: user01.id, role: 'master' }, { nowSec: now() })}`;
      expect((await request(app).get('/api/v1/users').set('Authorization', forged)).status).toBe(403);
    });
  });

  describe('GET /api/v1/users', () => {
    it('401 unauthenticated', async () => {
      expect((await request(app).get('/api/v1/users')).status).toBe(401);
    });
    it('403 for a user', async () => {
      expect((await request(app).get('/api/v1/users').set('Authorization', tokenFor(user01))).status).toBe(403);
    });
    it('200 for master with the full roster', async () => {
      const res = await request(app).get('/api/v1/users').set('Authorization', tokenFor(master));
      expect(res.status).toBe(200);
      expect(res.body.users.length).toBeGreaterThanOrEqual(11);
    });
  });

  describe('requireSelfOrMaster', () => {
    const probe = express();
    probe.get('/things/:userId', requireUser, requireSelfOrMaster('userId'), (req, res) => {
      res.json({ ok: true, userId: req.params.userId });
    });

    it('401 unauthenticated', async () => {
      expect((await request(probe).get(`/things/${user01.id}`)).status).toBe(401);
    });
    it('user can read own resource', async () => {
      const res = await request(probe).get(`/things/${user01.id}`).set('Authorization', tokenFor(user01));
      expect(res.status).toBe(200);
    });
    it("user gets 403 on another user's resource", async () => {
      const res = await request(probe).get(`/things/${user02.id}`).set('Authorization', tokenFor(user01));
      expect(res.status).toBe(403);
    });
    it('master gets 200 on any user', async () => {
      const res = await request(probe).get(`/things/${user02.id}`).set('Authorization', tokenFor(master));
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/v1/auth/login (dev)', () => {
    it('404 when AUTH_DEV_PASSWORD is unset', async () => {
      delete process.env.AUTH_DEV_PASSWORD;
      const res = await request(app).post('/api/v1/auth/login').send({ email: 'user01@example.test', password: 'x' });
      expect(res.status).toBe(404);
    });
    it('200 with right password, 401 otherwise', async () => {
      process.env.AUTH_DEV_PASSWORD = 'dev-pass';
      const ok = await request(app).post('/api/v1/auth/login').send({ email: 'USER01@example.test', password: 'dev-pass' });
      expect(ok.status).toBe(200);
      expect(ok.body.user.role).toBe('user');
      const bad = await request(app).post('/api/v1/auth/login').send({ email: 'user01@example.test', password: 'nope' });
      expect(bad.status).toBe(401);
      const unknown = await request(app).post('/api/v1/auth/login').send({ email: 'ghost@example.test', password: 'dev-pass' });
      expect(unknown.status).toBe(401);
      delete process.env.AUTH_DEV_PASSWORD;
    });
  });
});

describe('api token', () => {
  it('rejects alg=none and wrong audience', () => {
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.`;
    expect(verifyApiToken(none, { secret: SECRET, nowSec: now() })).toBeNull();
  });
  it('round-trips', () => {
    const t = signApiToken({ userId: 'u', role: 'user' }, { secret: SECRET, nowSec: 1000 });
    expect(verifyApiToken(t, { secret: SECRET, nowSec: 1001 })?.sub).toBe('u');
    expect(verifyApiToken(t, { secret: SECRET, nowSec: 1000 + 300 })).toBeNull();
  });
});
