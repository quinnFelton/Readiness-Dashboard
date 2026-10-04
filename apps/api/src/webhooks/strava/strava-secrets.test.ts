import { randomBytes } from 'node:crypto';
import { StravaClient, StravaRateLimiter } from '@rd/provider-adapters/strava';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalAesGcmCipher } from '../../crypto/token-cipher';
import { ActivityEffortService } from '../../efforts/activity-effort-service';
import { StravaIngestService } from '../../providers/strava/strava-ingest-service';
import { closePool, getPool } from '../../users/pool';
import { stravaWebhookRouter } from './routes';

// Extra checks: tokens never logged / never stored in plaintext; derived numbers hand-checked.
const ATHLETE = 5151;
const cipher = new LocalAesGcmCipher(randomBytes(32).toString('base64'));
const pool = () => getPool();
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
const N = 1800;
const arr = (v: number) => ({ data: Array.from({ length: N }, () => v) });

describe('strava secrets & numerics', () => {
  let userId: string;
  const fetchFn = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    if (u.pathname === '/oauth/token')
      return json({
        access_token: 'NEWACCESS-SECRET',
        refresh_token: 'NEWREFRESH-SECRET',
        expires_at: Math.floor(Date.now() / 1000) + 21600,
        expires_in: 21600,
      });
    if (u.pathname.endsWith('/streams'))
      return json({
        time: { data: Array.from({ length: N }, (_, i) => i) },
        watts: arr(200),
        heartrate: arr(140),
      });
    return json({
      id: 9100,
      type: 'Ride',
      sport_type: 'Ride',
      start_date_local: '2026-03-01T08:00:00Z',
      moving_time: N,
      has_heartrate: true,
      manual: false,
    });
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO users(email) VALUES ($1) RETURNING id`,
      [`secrets-${randomBytes(4).toString('hex')}@phase4.invalid`],
    );
    userId = rows[0]!.id;
    await pool().query(
      `INSERT INTO provider_connections
       (user_id, provider, role, external_user_id, access_token_enc, refresh_token_enc, expires_at, is_active)
       VALUES ($1,'strava','activity_source',$2,$3,$4,now() - interval '1 hour',true)`,
      [
        userId,
        String(ATHLETE),
        await cipher.encrypt('OLDACCESS-SECRET', `${userId}:strava`),
        await cipher.encrypt('OLDREFRESH-SECRET', `${userId}:strava`),
      ],
    );
  });
  afterAll(async () => {
    await pool().query("DELETE FROM webhook_events WHERE payload_jsonb->>'owner_id' = $1", [
      String(ATHLETE),
    ]);
    await pool().query('DELETE FROM users WHERE id = $1', [userId]);
    await closePool();
  });

  it('refresh+ingest logs no tokens, stores ciphertext only, and derives hand-checked values', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const client = new StravaClient({
      clientId: '1',
      clientSecret: 'CLIENTSECRET-X',
      redirectUri: 'http://x/cb',
      fetch: fetchFn,
      limiter: new StravaRateLimiter({ maxWaitMs: 0 }),
    });
    const ingest = new StravaIngestService({
      pool: pool(),
      cipher,
      client,
      efforts: new ActivityEffortService(pool()),
    });
    const app = express();
    app.use('/w', stravaWebhookRouter({ ingest, verifyToken: 'v', pool: pool() }));
    const r = await request(app).post('/w').send({
      object_type: 'activity',
      object_id: 9100,
      aspect_type: 'create',
      owner_id: ATHLETE,
      subscription_id: 1,
    });
    expect(r.status).toBe(200);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    spies.forEach((s) => s.mockRestore());
    expect(logged).not.toMatch(/SECRET/);
    expect(JSON.stringify(r.body)).not.toMatch(/SECRET/);

    const c = await pool().query(
      `SELECT access_token_enc, refresh_token_enc FROM provider_connections WHERE user_id=$1`,
      [userId],
    );
    for (const col of ['access_token_enc', 'refresh_token_enc']) {
      expect(Buffer.from(c.rows[0][col]).toString('latin1')).not.toMatch(/SECRET/);
    }
    expect(await cipher.decrypt(c.rows[0].access_token_enc, `${userId}:strava`)).toBe(
      'NEWACCESS-SECRET',
    );

    const e = (await pool().query('SELECT * FROM activity_efforts WHERE user_id=$1', [userId]))
      .rows[0];
    expect(Number(e.normalized_power)).toBeCloseTo(200, 6);
    expect(Number(e.peak20_power)).toBeCloseTo(200, 6);
    expect(Number(e.peak20_avg_hr)).toBeCloseTo(140, 6);
    expect(Number(e.ef_peak20)).toBeCloseTo(200 / 140, 4);
    expect(Number(e.ef_overall)).toBeCloseTo(200 / 140, 4);
    const ev = await pool().query(
      `SELECT payload_jsonb FROM webhook_events WHERE payload_jsonb->>'owner_id'=$1`,
      [String(ATHLETE)],
    );
    expect(JSON.stringify(ev.rows)).not.toMatch(/SECRET/);
  });
});
