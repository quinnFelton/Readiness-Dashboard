import { randomBytes } from 'node:crypto';
import { type AnyAdapter, createAdapterRegistry } from '@rd/provider-adapters';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signApiToken } from '../auth/token';
import { LocalAesGcmCipher } from '../crypto/token-cipher';
import { FakeAdapter } from '../sync/fake-adapter';
import { closePool, getPool } from '../users/pool';
import { connectionsRouter } from './routes';

// GET /connections/providers lists the registry for the connections screen (PLAN §6), so the UI
// never hardcodes providers. Needs migrated local Postgres: requireUser checks the user exists.
process.env.NEXTAUTH_SECRET = 'test-secret-test-secret-test-secret';

const widget = Object.assign(new FakeAdapter('terra', 'daily_metrics_source'), {
  displayName: 'Zepp (via Terra)',
  connectFlow: 'widget' as const,
});
const registry = createAdapterRegistry();
for (const a of [
  new FakeAdapter('oura', 'daily_metrics_source'),
  widget,
  new FakeAdapter('strava', 'activity_source'),
] as AnyAdapter[]) {
  registry.register(a);
}

const app = express();
app.use(
  '/connections',
  connectionsRouter({
    registry,
    cipher: new LocalAesGcmCipher(randomBytes(32).toString('base64')),
    stateSecret: randomBytes(32),
  }),
);
let bearer = '';

describe('GET /connections/providers', () => {
  let userId: string;
  beforeAll(async () => {
    const { rows } = await getPool().query<{ id: string }>(
      'INSERT INTO users(email) VALUES ($1) RETURNING id',
      [`providers-${randomBytes(4).toString('hex')}@phase2.invalid`],
    );
    userId = rows[0]!.id;
    bearer = `Bearer ${signApiToken({ userId, role: 'user' }, { nowSec: Math.floor(Date.now() / 1000) })}`;
  });
  afterAll(async () => {
    await getPool().query('DELETE FROM users WHERE id = $1', [userId]);
    await closePool();
  });

  it('401 without a token', async () => {
    expect((await request(app).get('/connections/providers')).status).toBe(401);
  });

  it('lists every registered adapter, activity source first, with display name and flow', async () => {
    const res = await request(app).get('/connections/providers').set('Authorization', bearer);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      providers: [
        { key: 'strava', role: 'activity_source', displayName: 'strava', flow: 'oauth' },
        { key: 'oura', role: 'daily_metrics_source', displayName: 'oura', flow: 'oauth' },
        {
          key: 'terra',
          role: 'daily_metrics_source',
          displayName: 'Zepp (via Terra)',
          flow: 'widget',
        },
      ],
    });
  });

  it('"providers" is reserved, so it is never treated as a provider key', async () => {
    const res = await request(app).delete('/connections/providers').set('Authorization', bearer);
    expect(res.status).toBe(404);
  });
});
