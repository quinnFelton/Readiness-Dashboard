import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { signApiToken } from '../auth/token';
import { closePool, getPool } from '../users/pool';

// Integration stage C: /api/v1/connections (phase 2) must be mounted on the real app, behind
// requireUser, and after express.json() (PUT /config reads a JSON body). Needs migrated local Postgres.
describe('connections router is mounted on the real app', () => {
  let userId: string;
  const bearer = () =>
    `Bearer ${signApiToken({ userId, role: 'user' }, { nowSec: Math.floor(Date.now() / 1000) })}`;

  beforeAll(async () => {
    vi.stubEnv('NEXTAUTH_SECRET', 'test-secret-test-secret-test-secret');
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO users(email) VALUES ($1) RETURNING id`,
      [`mount-${randomBytes(4).toString('hex')}@stage-c.invalid`],
    );
    userId = rows[0]!.id;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await getPool().query('DELETE FROM users WHERE id = $1', [userId]); // cascades
    await closePool();
  });

  it('unauthenticated request reaches the router and gets 401 (not 404)', async () => {
    const res = await request(createApp()).get('/api/v1/connections/config');
    expect(res.status).toBe(401);
  });

  it('an authenticated request succeeds', async () => {
    const res = await request(createApp())
      .get('/api/v1/connections/config')
      .set('authorization', bearer());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('connections');
  });

  it('JSON bodies are parsed for connections routes (global express.json() still applies)', async () => {
    const res = await request(createApp())
      .put('/api/v1/connections/config')
      .set('authorization', bearer())
      .send({}); // parsed but empty => the handler's own 400, not a parser failure
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/activitySource/);
  });
});
