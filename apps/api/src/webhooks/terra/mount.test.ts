import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { closePool } from '../../users/pool';
import { signTerraPayload } from './signature';

// PLAN §6: POST /api/v1/webhooks/terra must exist on the real app and receive the RAW body
// (i.e. must not sit behind the global express.json()).
const SECRET = 'whsec_mount_test';

describe('terra webhook is mounted on the real app', () => {
  const prev = process.env.TERRA_SIGNING_SECRET;
  beforeAll(() => {
    process.env.TERRA_SIGNING_SECRET = SECRET;
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.TERRA_SIGNING_SECRET;
    else process.env.TERRA_SIGNING_SECRET = prev;
    await closePool();
  });

  it('unsigned request reaches the handler and gets 401 (not 404)', async () => {
    const res = await request(createApp())
      .post('/api/v1/webhooks/terra')
      .set('content-type', 'application/json')
      .send('{"type":"sleep"}');
    expect(res.status).toBe(401);
  });

  it('a correctly signed request is not rejected as 401/404/500 by body-parser ordering', async () => {
    const raw = JSON.stringify({ type: 'sleep', status: 'success', data: [] });
    const res = await request(createApp())
      .post('/api/v1/webhooks/terra')
      .set('content-type', 'application/json')
      .set('terra-signature', signTerraPayload(raw, SECRET, Math.floor(Date.now() / 1000)))
      .send(raw);
    expect(res.status).toBe(200);
  });
});
