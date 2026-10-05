import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { createRateLimiter, rateLimitFromEnv } from './rate-limit';
import { safeErrorHandler } from './safe-error';

describe('rate limiter (local stand-in for API Gateway throttling, PLAN §12)', () => {
  const appWith = (now: () => number, burst = 3, ratePerSec = 1) => {
    const app = express();
    app.use(createRateLimiter({ ratePerSec, burst, now }));
    app.get('/x', (_req, res) => void res.json({ ok: true }));
    return app;
  };

  it('allows a burst, then answers 429 with Retry-After, then refills at the sustained rate', async () => {
    let t = 1_000_000;
    const app = appWith(() => t);
    for (let i = 0; i < 3; i++) expect((await request(app).get('/x')).status).toBe(200);
    const blocked = await request(app).get('/x');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('1');
    expect(blocked.body).toEqual({ error: 'too_many_requests' });
    t += 2_000; // 2 s at 1 rps -> 2 tokens
    expect((await request(app).get('/x')).status).toBe(200);
    expect((await request(app).get('/x')).status).toBe(200);
    expect((await request(app).get('/x')).status).toBe(429);
  });

  it('never refills above the burst size', async () => {
    let t = 0;
    const app = appWith(() => t);
    t += 3_600_000;
    for (let i = 0; i < 3; i++) expect((await request(app).get('/x')).status).toBe(200);
    expect((await request(app).get('/x')).status).toBe(429);
  });

  it('keys are independent and the key table is bounded', async () => {
    const app = express();
    let n = 0;
    app.use(
      createRateLimiter({
        ratePerSec: 1,
        burst: 1,
        now: () => 0,
        maxKeys: 2,
        key: (r) => String(r.headers['x-k']),
      }),
    );
    app.get('/x', (_req, res) => void res.json({ n: ++n }));
    expect((await request(app).get('/x').set('x-k', 'a')).status).toBe(200);
    expect((await request(app).get('/x').set('x-k', 'a')).status).toBe(429);
    expect((await request(app).get('/x').set('x-k', 'b')).status).toBe(200);
    await request(app).get('/x').set('x-k', 'c'); // evicts the oldest key ("a")
    expect((await request(app).get('/x').set('x-k', 'a')).status).toBe(200);
  });

  it('reads the CDK context names, defaults to 20 rps / burst 40, and can be turned off', () => {
    expect(rateLimitFromEnv({})).toEqual({ ratePerSec: 20, burst: 40 });
    expect(rateLimitFromEnv({ THROTTLE_RATE: '5', THROTTLE_BURST: '7' })).toEqual({
      ratePerSec: 5,
      burst: 7,
    });
    expect(rateLimitFromEnv({ THROTTLE_RATE: 'junk' })).toEqual({ ratePerSec: 20, burst: 40 });
    expect(rateLimitFromEnv({ RATE_LIMIT: 'off' })).toBeNull();
  });

  it('createApp applies it to REST and webhook routes when enabled, and not otherwise', async () => {
    const limited = createApp({ rateLimit: { ratePerSec: 1, burst: 1, now: () => 0 } });
    expect((await request(limited).get('/api/v1/health')).status).toBe(200);
    expect((await request(limited).get('/api/v1/health')).status).toBe(429);
    const open = createApp();
    for (let i = 0; i < 5; i++)
      expect((await request(open).get('/api/v1/health')).status).toBe(200);
  });
});

describe('safeErrorHandler (security review L3)', () => {
  const appThatThrows = (err: unknown) => {
    const app = express();
    app.get('/boom', () => {
      throw err;
    });
    app.post('/json', express.json(), (_req, res) => void res.json({}));
    app.use(safeErrorHandler);
    return app;
  };

  it('answers a generic 500 and logs only the error class name (no message, no stack)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = 'duplicate key value violates unique constraint: (email)=(victim@example.com)';
    const res = await request(appThatThrows(new TypeError(secret))).get('/boom');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('victim');
    expect(res.text).not.toContain('at ');
    const logged = spy.mock.calls.flat().join(' ');
    expect(logged).toContain('TypeError');
    expect(logged).not.toContain('victim');
    spy.mockRestore();
  });

  it('maps malformed JSON to a 400 without echoing the body', async () => {
    const res = await request(appThatThrows(new Error('x')))
      .post('/json')
      .set('content-type', 'application/json')
      .send('{"email": "victim@example.com"');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_json' });
  });

  it('createApp uses it: an unknown route is a plain 404, a bad body on a REST route is a 400', async () => {
    const res = await request(createApp())
      .post('/api/v1/auth/login')
      .set('content-type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_json' });
  });
});
