import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePool, getPool } from '../users/pool';
import { IDENTITY_TOLERANCE_SEC, signIdentityRequest } from './identity';
import { authRouter } from './routes';

// Security review H3. Needs migrated local Postgres.
const SECRET = 'test-secret-test-secret-test-secret';
process.env.NEXTAUTH_SECRET = SECRET;

const app = express();
app.use(express.json());
app.use('/auth', authRouter());

const tag = randomBytes(4).toString('hex');
const email = `ident-${tag}@phase9.invalid`;
let userId: string;

const nowSec = () => Math.floor(Date.now() / 1000);
const ask = (body: unknown, h: { ts?: number; sig?: string; email?: string } = {}) => {
  const ts = h.ts ?? nowSec();
  return request(app)
    .post('/auth/oauth-identity')
    .set('x-rd-ts', String(ts))
    .set('x-rd-sig', h.sig ?? signIdentityRequest(h.email ?? email, ts, SECRET))
    .send(body as object);
};

beforeAll(async () => {
  userId = (
    await getPool().query<{ id: string }>(
      `INSERT INTO users(email, name, role) VALUES ($1,'Ident','master') RETURNING id`,
      [email],
    )
  ).rows[0]!.id;
});
afterAll(async () => {
  await getPool().query('DELETE FROM users WHERE id = $1', [userId]);
  await closePool();
});

describe('POST /auth/oauth-identity', () => {
  it('returns the existing user for a correctly signed request (email match is case-insensitive)', async () => {
    const res = await ask({ email });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: userId, role: 'master', email });
    const upper = await ask({ email: email.toUpperCase() }, { email: email.toUpperCase() });
    expect(upper.body.user.id).toBe(userId);
  });

  it('404 for an email with no users row: sign-in is invite-only, nothing is auto-provisioned', async () => {
    const stranger = `nobody-${tag}@phase9.invalid`;
    const res = await ask({ email: stranger }, { email: stranger });
    expect(res.status).toBe(404);
    const n = await getPool().query(`SELECT 1 FROM users WHERE email = $1`, [stranger]);
    expect(n.rowCount).toBe(0);
  });

  it('401 without a valid signature: unsigned, wrong signature, signed for another email, stale', async () => {
    expect((await request(app).post('/auth/oauth-identity').send({ email })).status).toBe(401);
    expect((await ask({ email }, { sig: 'AAAA' })).status).toBe(401);
    // A signature for a different email cannot be reused to ask about this one.
    expect((await ask({ email }, { email: `other-${tag}@phase9.invalid` })).status).toBe(401);
    const old = nowSec() - IDENTITY_TOLERANCE_SEC - 5;
    expect((await ask({ email }, { ts: old })).status).toBe(401);
    // And nothing about the user leaks in any of those responses.
    expect(JSON.stringify((await ask({ email }, { sig: 'AAAA' })).body)).not.toContain(userId);
  });

  it('400 for malformed bodies', async () => {
    expect((await ask({})).status).toBe(400);
    expect((await ask({ email: 5 })).status).toBe(400);
    expect((await ask({ email: 'x'.repeat(400) })).status).toBe(400);
  });
});

describe('POST /auth/login (dev only)', () => {
  it('is 404 in production even with the dev password configured', async () => {
    vi.stubEnv('AUTH_DEV_PASSWORD', 'pw');
    vi.stubEnv('NODE_ENV', 'production');
    const res = await request(app).post('/auth/login').send({ email, password: 'pw' });
    expect(res.status).toBe(404);
    vi.unstubAllEnvs();
  });

  it('is 404 when AUTH_DEV_PASSWORD is unset', async () => {
    vi.stubEnv('AUTH_DEV_PASSWORD', '');
    const res = await request(app).post('/auth/login').send({ email, password: 'pw' });
    expect(res.status).toBe(404);
    vi.unstubAllEnvs();
  });

  it('is throttled per client: a guessing run gets 429 after the burst', async () => {
    vi.stubEnv('AUTH_DEV_PASSWORD', 'right');
    vi.stubEnv('NODE_ENV', 'test');
    const throttled = express();
    throttled.use(express.json());
    throttled.use('/auth', authRouter()); // fresh router = fresh bucket
    let first429 = -1;
    for (let i = 0; i < 15; i++) {
      const { status } = await request(throttled)
        .post('/auth/login')
        .send({ email, password: `guess${i}` });
      if (status === 429 && first429 < 0) first429 = i;
    }
    expect(first429).toBe(10); // burst of 10 attempts, then 429
    vi.unstubAllEnvs();
  });
});
