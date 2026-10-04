import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAesGcmCipher } from '../../crypto/token-cipher';
import { closePool, getPool } from '../../users/pool';
import { withOuraUserLock } from './lock';
import { OuraAdapter, ouraConfigFromEnv, ouraSignature } from './register';
import { acquireOuraTestMutex } from './test-mutex';
import { createOuraWebhookRouter } from './webhook';

// Needs migrated local Postgres (docker compose up -d db && pnpm db:migrate). All Oura HTTP is mocked.
// Event/body shapes: Oura OpenAPI spec 1.41 webhookDocs (packages/provider-adapters/src/oura/docs).

const pool = getPool();
const cipher = new LocalAesGcmCipher(randomBytes(32).toString('base64'));
const NOW = new Date('2026-09-10T12:00:00Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const SECRET = 'client-secret';
const VTOKEN = 'verify-me';
const OURA_UID = `oura-${randomBytes(4).toString('hex')}`;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

const sleepDoc = (day: string, hrv: number, rhr: number) => ({
  id: `sl-${day}`,
  day,
  type: 'long_sleep',
  average_hrv: hrv,
  lowest_heart_rate: rhr,
  total_sleep_duration: 27000,
  bedtime_start: `${day}T00:00:00+00:00`,
  bedtime_end: `${day}T08:00:00+00:00`,
  low_battery_alert: false,
  period: 0,
  time_in_bed: 28800,
});
const readinessDoc = (day: string, score: number) => ({
  id: `rd-${day}`,
  contributors: {},
  day,
  score,
  timestamp: `${day}T00:00:00+00:00`,
});

let data: Record<string, unknown[]>;
let urls: string[];
let dataStatus: number;
let tokenCalls: number;

const fetchMock = vi.fn(async (url: string | URL | Request) => {
  const u = new URL(String(url));
  urls.push(String(url));
  if (u.pathname === '/oauth/token') {
    tokenCalls++;
    return json({ access_token: 'A1', refresh_token: 'R1', expires_in: 3600 });
  }
  if (dataStatus !== 200) return json({}, dataStatus);
  return json({ data: data[u.pathname.split('/').pop() as string] ?? [], next_token: null });
});

const config = {
  ...ouraConfigFromEnv({}),
  clientId: 'cid',
  clientSecret: SECRET,
  webhookVerificationToken: VTOKEN,
  now: () => NOW,
  sleep: async () => {},
  fetch: fetchMock as unknown as typeof fetch,
};
const adapter = new OuraAdapter(config);
const deps = { pool, cipher, adapter, config };

function appWith(prefixJson = false) {
  const app = express();
  if (prefixJson) app.use(express.json()); // simulates the global parser having consumed the body
  app.use('/hook', createOuraWebhookRouter(deps));
  return app;
}

const event = (over: Record<string, unknown> = {}) => ({
  event_type: 'update',
  data_type: 'sleep',
  object_id: 'obj-1',
  event_time: '2026-09-10T11:59:30+00:00',
  user_id: OURA_UID,
  ...over,
});
function post(app: express.Express, body: unknown, over: { sig?: string; ts?: string } = {}) {
  const text = JSON.stringify(body);
  const ts = over.ts ?? TS;
  return request(app)
    .post('/hook')
    .set('content-type', 'application/json')
    .set('x-oura-timestamp', ts)
    .set('x-oura-signature', over.sig ?? ouraSignature(SECRET, ts, text))
    .send(text);
}

let userId: string;
const metrics = async () =>
  (
    await pool.query<{ date: string; metric_type: string; value: string }>(
      `SELECT to_char(date,'YYYY-MM-DD') AS date, metric_type, value FROM daily_metrics
        WHERE user_id = $1 AND source = 'oura' ORDER BY date, metric_type`,
      [userId],
    )
  ).rows.map((r) => `${r.date} ${r.metric_type}=${Number(r.value)}`);
const receipts = async () =>
  (
    await pool.query(
      `SELECT user_id, status, payload_jsonb FROM webhook_events
        WHERE provider = 'oura' AND payload_jsonb->>'oura_user_id' = $1 ORDER BY received_at`,
      [OURA_UID],
    )
  ).rows;

async function connect(expiresAt: Date) {
  await pool.query(`DELETE FROM provider_connections WHERE user_id = $1`, [userId]);
  await pool.query(
    `INSERT INTO provider_connections
       (user_id, provider, role, external_user_id, access_token_enc, refresh_token_enc, expires_at)
     VALUES ($1,'oura','daily_metrics_source',$2,$3,$4,$5)`,
    [
      userId,
      OURA_UID,
      await cipher.encrypt('A0', `${userId}:oura`),
      await cipher.encrypt('R0', `${userId}:oura`),
      expiresAt,
    ],
  );
}

describe('oura webhook router', () => {
  let releaseMutex: () => Promise<void>;
  beforeAll(async () => {
    releaseMutex = await acquireOuraTestMutex(pool);
    const { rows } = await pool.query(`INSERT INTO users(email) VALUES ($1) RETURNING id`, [
      `oura-wh-${randomBytes(4).toString('hex')}@test.invalid`,
    ]);
    userId = rows[0].id;
  });
  beforeEach(async () => {
    data = {};
    urls = [];
    dataStatus = 200;
    tokenCalls = 0;
    await connect(new Date('2026-09-11T00:00:00Z'));
    await pool.query(`DELETE FROM daily_metrics WHERE user_id = $1`, [userId]);
    await pool.query(
      `DELETE FROM webhook_events WHERE provider='oura' AND (user_id = $1 OR user_id IS NULL)`,
      [userId],
    );
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM webhook_events WHERE provider='oura' AND user_id IS NULL`);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await releaseMutex();
    await closePool();
  });

  describe('GET verification challenge', () => {
    it('echoes the challenge for the right token and records a receipt', async () => {
      const res = await request(appWith()).get('/hook').query({
        verification_token: VTOKEN,
        challenge: 'rand-123',
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ challenge: 'rand-123' });
      const { rows } = await pool.query(
        `SELECT payload_jsonb, status FROM webhook_events
          WHERE provider='oura' AND user_id IS NULL AND payload_jsonb->>'kind'='verification'`,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain(VTOKEN);
    });
    it('rejects a wrong or missing token with 401 and no challenge', async () => {
      const bad = await request(appWith())
        .get('/hook')
        .query({ verification_token: 'nope', challenge: 'c' });
      expect(bad.status).toBe(401);
      expect(JSON.stringify(bad.body)).not.toContain('"c"');
      expect((await request(appWith()).get('/hook').query({ challenge: 'c' })).status).toBe(401);
    });
  });

  describe('POST events: authenticity first', () => {
    it('rejects a bad signature before doing anything (no fetch, no receipt, no rows)', async () => {
      const res = await post(appWith(), event(), { sig: 'A'.repeat(64) });
      expect(res.status).toBe(401);
      expect(urls).toEqual([]);
      expect(await receipts()).toEqual([]);
      expect(await metrics()).toEqual([]);
    });
    it('rejects a validly signed but stale delivery (replay)', async () => {
      const old = String(Number(TS) - 3600);
      const res = await post(appWith(), event(), {
        ts: old,
        sig: ouraSignature(SECRET, old, JSON.stringify(event())),
      });
      expect(res.status).toBe(401);
      expect(urls).toEqual([]);
      expect(await receipts()).toEqual([]);
    });
    it('rejects missing signature headers and empty bodies', async () => {
      const res = await request(appWith())
        .post('/hook')
        .set('content-type', 'application/json')
        .send(JSON.stringify(event()));
      expect(res.status).toBe(401);
      expect((await request(appWith()).post('/hook')).status).toBe(401);
    });
    it('returns 400 for a correctly signed but malformed event', async () => {
      const res = await post(appWith(), { hello: 'world' });
      expect(res.status).toBe(400);
      expect(await receipts()).toEqual([]);
    });
  });

  describe('POST events: processing', () => {
    it('re-fetches only the affected collection over the lookback window and upserts', async () => {
      data.sleep = [sleepDoc('2026-09-10', 61, 47)];
      data.daily_readiness = [readinessDoc('2026-09-10', 99)]; // must NOT be fetched for a sleep event
      const res = await post(appWith(), event());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, outcome: 'processed' });
      expect(urls).toHaveLength(1);
      // event_time 2026-09-10 minus webhookLookbackDays (3) -> 2026-09-07; end = tomorrow
      expect(urls[0]).toContain(
        '/v2/usercollection/sleep?start_date=2026-09-07&end_date=2026-09-11',
      );
      expect(await metrics()).toEqual(['2026-09-10 hrv=61', '2026-09-10 resting_hr=47']);
    });

    it('widens the window back to last_synced_at when the ring was offline', async () => {
      await pool.query(`UPDATE provider_connections SET last_synced_at = $2 WHERE user_id = $1`, [
        userId,
        new Date('2026-09-01T00:00:00Z'),
      ]);
      await post(appWith(), event());
      expect(urls[0]).toContain('start_date=2026-08-29');
    });

    it('records a metadata-only receipt linked to the user', async () => {
      data.sleep = [sleepDoc('2026-09-10', 61, 47)];
      await post(appWith(), event());
      const rs = await receipts();
      expect(rs).toHaveLength(1);
      expect(rs[0].user_id).toBe(userId);
      expect(rs[0].status).toBe('processed');
      expect(rs[0].payload_jsonb).toMatchObject({
        event_type: 'update',
        data_type: 'sleep',
        object_id: 'obj-1',
        outcome: 'processed',
      });
      const blob = JSON.stringify(rs[0].payload_jsonb);
      expect(blob).not.toMatch(/average_hrv|A0|R0|61/);
    });

    it('is idempotent: replaying the same event leaves identical rows', async () => {
      data.sleep = [sleepDoc('2026-09-10', 61, 47)];
      await post(appWith(), event());
      const first = await metrics();
      expect((await post(appWith(), event())).status).toBe(200);
      expect(await metrics()).toEqual(first);
      expect(await receipts()).toHaveLength(2); // each delivery is audited
    });

    it('acknowledges events for an unknown Oura user without fetching (receipt user_id NULL)', async () => {
      const res = await post(appWith(), event({ user_id: 'someone-else' }));
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('unknown_user');
      expect(urls).toEqual([]);
      const { rows } = await pool.query(
        `SELECT user_id, status FROM webhook_events
          WHERE provider='oura' AND payload_jsonb->>'oura_user_id' = 'someone-else'`,
      );
      expect(rows).toEqual([{ user_id: null, status: 'processed' }]);
      await pool.query(
        `DELETE FROM webhook_events WHERE payload_jsonb->>'oura_user_id'='someone-else'`,
      );
    });

    it('acknowledges and ignores data types we do not map', async () => {
      const res = await post(appWith(), event({ data_type: 'workout' }));
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('ignored_data_type');
      expect(urls).toEqual([]);
    });

    it('delete event removes rows the re-fetch no longer returns, only for that collection', async () => {
      data.daily_readiness = [readinessDoc('2026-09-09', 80), readinessDoc('2026-09-10', 70)];
      data.sleep = [sleepDoc('2026-09-10', 61, 47)];
      await post(appWith(), event({ data_type: 'daily_readiness' }));
      await post(appWith(), event());
      expect(await metrics()).toEqual([
        '2026-09-09 readiness=80',
        '2026-09-10 hrv=61',
        '2026-09-10 readiness=70',
        '2026-09-10 resting_hr=47',
      ]);
      data.daily_readiness = [readinessDoc('2026-09-09', 80)]; // 09-10 document was deleted upstream
      const res = await post(
        appWith(),
        event({ event_type: 'delete', data_type: 'daily_readiness' }),
      );
      expect(res.status).toBe(200);
      expect(await metrics()).toEqual([
        '2026-09-09 readiness=80',
        '2026-09-10 hrv=61',
        '2026-09-10 resting_hr=47',
      ]);
      // replay is a no-op
      await post(appWith(), event({ event_type: 'delete', data_type: 'daily_readiness' }));
      expect(await metrics()).toHaveLength(3);
    });

    it('refreshes an expired token, persists it encrypted, and uses it for the fetch', async () => {
      await connect(new Date('2026-09-10T11:00:00Z')); // expired relative to NOW
      data.sleep = [sleepDoc('2026-09-10', 61, 47)];
      const res = await post(appWith(), event());
      expect(res.status).toBe(200);
      expect(tokenCalls).toBe(1);
      const { rows } = await pool.query(
        `SELECT refresh_token_enc, access_token_enc FROM provider_connections WHERE user_id=$1`,
        [userId],
      );
      expect(await cipher.decrypt(rows[0].refresh_token_enc, `${userId}:oura`)).toBe('R1');
      expect(rows[0].access_token_enc.toString('utf8')).not.toContain('A1');
    });

    it('answers 500 (so Oura retries) and marks the receipt failed when the fetch fails; no leaks', async () => {
      dataStatus = 500;
      const res = await post(appWith(), event());
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).toBe('{"error":"OuraHttpError"}');
      const rs = await receipts();
      expect(rs[0].status).toBe('failed');
      expect(rs[0].payload_jsonb.outcome).toBe('OuraHttpError');
    });

    it('answers 503 while a polling sync holds the per-user lock', async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      let ready!: () => void;
      const started = new Promise<void>((r) => {
        ready = r;
      });
      const holder = withOuraUserLock(pool, userId, async () => {
        ready();
        await held;
      });
      await started;
      const res = await post(appWith(), event());
      release();
      await holder;
      expect(res.status).toBe(503);
      expect(urls).toEqual([]);
      expect((await receipts())[0].status).toBe('failed');
    });

    it('verifies against JSON.stringify(body) when a global JSON parser already consumed the body', async () => {
      data.sleep = [sleepDoc('2026-09-10', 61, 47)];
      const res = await post(appWith(true), event());
      expect(res.status).toBe(200);
      expect(await metrics()).toHaveLength(2);
      expect((await post(appWith(true), event(), { sig: 'B'.repeat(64) })).status).toBe(401);
    });
  });
});
