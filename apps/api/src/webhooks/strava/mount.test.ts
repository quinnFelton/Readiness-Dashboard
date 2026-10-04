import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app';
import { closePool, getPool } from '../../users/pool';

// Integration stage C: /api/v1/webhooks/strava must exist on the real app. Strava has no payload
// signature; authenticity is the GET verify_token handshake plus the pinned subscription_id on POSTs.
// Needs migrated local Postgres; no network (the owner below has no local connection, so nothing is
// fetched from Strava).
const VERIFY = `verify-${randomBytes(6).toString('hex')}`;
const SUB_ID = '424242';
const OWNER = 900_000_000 + Math.floor(Math.random() * 99_999_999);

describe('strava webhook is mounted on the real app', () => {
  beforeAll(() => {
    vi.stubEnv('STRAVA_WEBHOOK_VERIFY_TOKEN', VERIFY);
    vi.stubEnv('STRAVA_SUBSCRIPTION_ID', SUB_ID);
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await getPool().query(
      `DELETE FROM webhook_events WHERE provider = 'strava' AND payload_jsonb->>'owner_id' = $1`,
      [String(OWNER)],
    );
    await closePool();
  });

  const event = (subscriptionId: number) => ({
    object_type: 'activity',
    object_id: 1,
    aspect_type: 'create',
    owner_id: OWNER,
    subscription_id: subscriptionId,
    event_time: Math.floor(Date.now() / 1000),
  });

  it('GET validation with a wrong verify token reaches the handler and gets 403 (not 404)', async () => {
    const res = await request(createApp())
      .get('/api/v1/webhooks/strava')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'c1' });
    expect(res.status).toBe(403);
  });

  it('GET validation with the right verify token echoes the challenge', async () => {
    const res = await request(createApp())
      .get('/api/v1/webhooks/strava')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': 'c2' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'hub.challenge': 'c2' });
  });

  it('POST from a different subscription reaches the handler and gets 403 (not 404)', async () => {
    const res = await request(createApp()).post('/api/v1/webhooks/strava').send(event(1));
    expect(res.status).toBe(403);
  });

  it('POST from the pinned subscription is parsed and acknowledged', async () => {
    const res = await request(createApp())
      .post('/api/v1/webhooks/strava')
      .send(event(Number(SUB_ID)));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });
});
