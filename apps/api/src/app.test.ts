import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';

describe('GET /api/v1/health', () => {
  it('returns ok', async () => {
    const res = await request(createApp()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('404s unknown routes', async () => {
    const res = await request(createApp()).get('/api/v1/nope');
    expect(res.status).toBe(404);
  });
});

// Integration stage E (phase 8 request): the REST and webhook Lambdas mount disjoint route groups.
describe('createApp({ mount })', () => {
  it("'api' serves the REST API but no webhook routers", async () => {
    const app = createApp({ mount: 'api' });
    expect((await request(app).get('/api/v1/health')).status).toBe(200);
    for (const p of ['terra', 'strava', 'oura']) {
      expect((await request(app).post(`/api/v1/webhooks/${p}`).send({})).status).toBe(404);
    }
  });

  it("'webhooks' serves only the chosen webhook routers, no REST API", async () => {
    const app = createApp({ mount: 'webhooks', webhookProviders: ['terra'] });
    expect((await request(app).get('/api/v1/health')).status).toBe(404);
    // Mounted: Terra answers (500 unconfigured / 401 unsigned) instead of 404.
    expect((await request(app).post('/api/v1/webhooks/terra').send('{}')).status).not.toBe(404);
    expect((await request(app).post('/api/v1/webhooks/strava').send({})).status).toBe(404);
  });

  it("default 'all' mounts both", async () => {
    const app = createApp();
    expect((await request(app).get('/api/v1/health')).status).toBe(200);
    expect((await request(app).get('/api/v1/webhooks/strava')).status).not.toBe(404);
  });
});
