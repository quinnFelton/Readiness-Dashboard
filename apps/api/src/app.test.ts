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
