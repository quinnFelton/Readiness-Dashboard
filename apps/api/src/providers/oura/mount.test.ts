import { randomBytes } from 'node:crypto';
import { ouraSignature } from '@rd/provider-adapters';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app';
import { closePool, getPool } from '../../users/pool';
import { acquireOuraTestMutex } from './test-mutex';

// Integration stage C: GET/POST /api/v1/webhooks/oura must exist on the real app and the POST must see
// the raw body (mounted before the global express.json()). Needs migrated local Postgres; no network.
const SECRET = `oura-secret-${randomBytes(6).toString('hex')}`;
const VERIFY = `verify-${randomBytes(6).toString('hex')}`;
const OURA_UID = `mount-${randomBytes(6).toString('hex')}`; // no local connection => 'unknown_user'

describe('oura webhook is mounted on the real app', () => {
  let releaseMutex: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    vi.stubEnv('OURA_CLIENT_SECRET', SECRET);
    vi.stubEnv('OURA_WEBHOOK_VERIFICATION_TOKEN', VERIFY);
    // The Oura router builds its token cipher on first request (deps() in webhook.ts).
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    releaseMutex = await acquireOuraTestMutex(getPool());
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await getPool().query(
      `DELETE FROM webhook_events WHERE provider = 'oura' AND payload_jsonb->>'oura_user_id' = $1`,
      [OURA_UID],
    );
    await releaseMutex?.();
    await closePool();
  });

  it('GET verification with a wrong token reaches the handler and gets 401 (not 404)', async () => {
    const res = await request(createApp())
      .get('/api/v1/webhooks/oura')
      .query({ verification_token: 'wrong', challenge: 'c1' });
    expect(res.status).toBe(401);
  });

  it('GET verification with the right token echoes the challenge', async () => {
    const res = await request(createApp())
      .get('/api/v1/webhooks/oura')
      .query({ verification_token: VERIFY, challenge: 'c2' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge: 'c2' });
  });

  it('unsigned POST reaches the handler and gets 401 (not 404)', async () => {
    const res = await request(createApp())
      .post('/api/v1/webhooks/oura')
      .set('content-type', 'application/json')
      .send('{"event_type":"create"}');
    expect(res.status).toBe(401);
  });

  it('a correctly signed POST is verified over the raw bytes and succeeds', async () => {
    // Deliberately non-canonical whitespace: if express.json() ran first, the re-serialised body
    // would differ from the signed bytes.
    const raw = `{ "event_type": "create",  "data_type": "daily_sleep", "object_id": "o1", "event_time": "${new Date().toISOString()}", "user_id": "${OURA_UID}" }`;
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await request(createApp())
      .post('/api/v1/webhooks/oura')
      .set('content-type', 'application/json')
      .set('x-oura-timestamp', ts)
      .set('x-oura-signature', ouraSignature(SECRET, ts, raw))
      .send(raw);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, outcome: 'unknown_user' });
  });
});
