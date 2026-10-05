import { randomBytes } from 'node:crypto';
import { StravaClient, StravaRateLimiter } from '@rd/provider-adapters/strava';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LocalAesGcmCipher } from '../../crypto/token-cipher';
import { ActivityEffortService } from '../../efforts/activity-effort-service';
import { StravaIngestService } from '../../providers/strava/strava-ingest-service';
import { closePool, getPool } from '../../users/pool';
import { replayStravaEvents, stravaWebhookRouter } from './routes';

// Needs migrated local Postgres (docker compose up -d db && pnpm db:migrate). All Strava HTTP is
// an in-memory fake (CLAUDE.md rule 10). Fixtures follow the shapes in
// https://developers.strava.com/docs/reference/ and /docs/webhooks/.

const ATHLETE = 4242;
const VERIFY = 'verify-me';
const cipher = new LocalAesGcmCipher(randomBytes(32).toString('base64'));
const pool = () => getPool();

const steady = (seconds: number, watts = 200, hr = 140) => ({
  time: { data: Array.from({ length: seconds }, (_, i) => i) },
  watts: { data: Array.from({ length: seconds }, () => watts) },
  heartrate: { data: Array.from({ length: seconds }, () => hr) },
});
const ride = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  type: 'Ride',
  sport_type: 'Ride',
  start_date_local: '2026-03-01T08:00:00Z',
  moving_time: 1800,
  has_heartrate: true,
  manual: false,
  ...over,
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

interface Call {
  method: string;
  path: string;
  auth?: string;
  body?: string;
}

function fakeStrava() {
  const calls: Call[] = [];
  const activities = new Map<number, unknown>();
  const streams = new Map<number, unknown>();
  let usageHeader: string | undefined;
  let athleteStatus = 200; // GET /athlete; 401 = the athlete deauthorized the app
  const f = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      auth,
      body: init?.body as string,
    });
    if (url.pathname === '/oauth/token') {
      return json({
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        expires_at: Math.floor(Date.now() / 1000) + 21600,
        expires_in: 21600,
      });
    }
    if (url.pathname === '/api/v3/athlete') return json({ id: 4242 }, athleteStatus);
    const m = /^\/api\/v3\/activities\/(\d+)(\/streams)?$/.exec(url.pathname);
    const headers: Record<string, string> = usageHeader
      ? { 'x-readratelimit-limit': '100,1000', 'x-readratelimit-usage': usageHeader }
      : {};
    if (!m) return json({}, 404, headers);
    const store = m[2] ? streams : activities;
    const v = store.get(Number(m[1]));
    return v ? json(v, 200, headers) : json({}, 404, headers);
  };
  return {
    f: f as unknown as typeof fetch,
    calls,
    activities,
    streams,
    setUsage: (u: string | undefined) => (usageHeader = u),
    setAthleteStatus: (s: number) => (athleteStatus = s),
    apiCalls: () => calls.filter((c) => c.path.startsWith('/api/v3')),
  };
}

describe('strava webhook', () => {
  const fake = fakeStrava();
  let now = new Date();
  const limiter = new StravaRateLimiter({ now: () => now, maxWaitMs: 0 });
  const client = new StravaClient({
    clientId: '1',
    clientSecret: 'secret',
    redirectUri: 'http://x/cb',
    fetch: fake.f,
    limiter,
    now: () => now,
  });
  const efforts = new ActivityEffortService(pool());
  const ingest = new StravaIngestService({ pool: pool(), cipher, client, efforts, now: () => now });

  const app = express();
  app.use('/webhooks/strava', stravaWebhookRouter({ ingest, verifyToken: VERIFY, pool: pool() }));
  const pinned = express();
  pinned.use(
    '/w',
    stravaWebhookRouter({ ingest, verifyToken: VERIFY, subscriptionId: '777', pool: pool() }),
  );

  const created: string[] = [];
  let userId: string;
  const event = (aspect: string, id: number, over: Record<string, unknown> = {}) => ({
    object_type: 'activity',
    object_id: id,
    aspect_type: aspect,
    owner_id: ATHLETE,
    subscription_id: 777,
    event_time: 1_772_000_000,
    updates: {},
    ...over,
  });
  const post = (body: unknown) =>
    request(app)
      .post('/webhooks/strava')
      .send(body as object);
  const effortRows = async () =>
    (await pool().query('SELECT * FROM activity_efforts WHERE user_id = $1', [userId])).rows;
  const eventRows = async () =>
    (
      await pool().query(
        `SELECT user_id, status, payload_jsonb FROM webhook_events
          WHERE provider='strava' AND payload_jsonb->>'owner_id' = $1 ORDER BY received_at`,
        [String(ATHLETE)],
      )
    ).rows;
  const connect = async (expiresAt: Date, active = true) => {
    const ctx = `${userId}:strava`;
    await pool().query(`DELETE FROM provider_connections WHERE user_id=$1`, [userId]);
    await pool().query(
      `INSERT INTO provider_connections
         (user_id, provider, role, external_user_id, access_token_enc, refresh_token_enc, expires_at, is_active)
       VALUES ($1,'strava','activity_source',$2,$3,$4,$5,$6)`,
      [
        userId,
        String(ATHLETE),
        await cipher.encrypt('access-1', ctx),
        await cipher.encrypt('refresh-1', ctx),
        expiresAt,
        active,
      ],
    );
  };
  const farFuture = () => new Date(Date.now() + 5 * 3600_000);

  beforeAll(async () => {
    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO users(email) VALUES ($1) RETURNING id`,
      [`strava-${randomBytes(4).toString('hex')}@phase4.invalid`],
    );
    userId = rows[0]!.id;
    created.push(userId);
  });
  beforeEach(async () => {
    await pool().query('DELETE FROM activity_efforts WHERE user_id=$1', [userId]);
    await pool().query("DELETE FROM webhook_events WHERE payload_jsonb->>'owner_id' = $1", [
      String(ATHLETE),
    ]);
    await connect(farFuture());
    fake.calls.length = 0;
    fake.activities.clear();
    fake.streams.clear();
    fake.setUsage(undefined);
    fake.setAthleteStatus(200);
    now = new Date();
    limiter.update(
      new Headers({ 'x-readratelimit-limit': '100,1000', 'x-readratelimit-usage': '0,0' }),
    );
  });
  afterAll(async () => {
    await pool().query("DELETE FROM webhook_events WHERE payload_jsonb->>'owner_id' = $1", [
      String(ATHLETE),
    ]);
    await pool().query('DELETE FROM users WHERE id = ANY($1)', [created]);
    await closePool();
  });

  describe('subscription challenge', () => {
    const q = (o: Record<string, string>) =>
      request(app)
        .get('/webhooks/strava')
        .query({
          'hub.mode': 'subscribe',
          'hub.challenge': 'abc123',
          'hub.verify_token': VERIFY,
          ...o,
        });
    it('echoes hub.challenge as JSON with a valid verify token', async () => {
      const r = await q({});
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ 'hub.challenge': 'abc123' });
    });
    it('rejects a wrong verify token, wrong mode, or missing challenge', async () => {
      expect((await q({ 'hub.verify_token': 'nope' })).status).toBe(403);
      expect((await q({ 'hub.mode': 'unsubscribe' })).status).toBe(403);
      expect(
        (
          await request(app)
            .get('/webhooks/strava')
            .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY })
        ).status,
      ).toBe(403);
    });
    it('rejects everything when no verify token is configured', async () => {
      const open = express();
      open.use(stravaWebhookRouter({ ingest, verifyToken: '', pool: pool() }));
      const r = await request(open)
        .get('/')
        .query({ 'hub.mode': 'subscribe', 'hub.challenge': 'x', 'hub.verify_token': '' });
      expect(r.status).toBe(403);
    });
  });

  describe('events', () => {
    it('create: fetches only that activity + streams, derives via the engine, upserts, records receipt', async () => {
      fake.activities.set(9001, ride(9001));
      fake.streams.set(9001, steady(1800));
      const r = await post(event('create', 9001));
      expect(r.status).toBe(200);

      expect(fake.apiCalls().map((c) => c.path)).toEqual([
        '/api/v3/activities/9001',
        '/api/v3/activities/9001/streams',
      ]);
      const [row] = await effortRows();
      expect(row).toMatchObject({
        external_activity_id: '9001',
        source: 'strava',
        duration_sec: 1800,
        derivation_version: 1,
        training_load_method: 'trimp',
      });
      expect(row.date.toISOString().slice(0, 10)).toBe('2026-03-01');
      expect(Number(row.peak20_power)).toBeCloseTo(200, 6);
      expect(Number(row.peak20_avg_hr)).toBeCloseTo(140, 6);
      expect(Number(row.ef_peak20)).toBeCloseTo(200 / 140, 6);
      expect(Number(row.ef_overall)).toBeCloseTo(200 / 140, 6);
      expect(Number(row.training_load)).toBeGreaterThan(0);

      const [ev] = await eventRows();
      expect(ev).toMatchObject({ user_id: userId, status: 'processed' });
      // The receipt stores the notification only, never stream data.
      expect(JSON.stringify(ev.payload_jsonb)).not.toContain('watts');
    });

    it('update: re-fetches and overwrites the same row', async () => {
      fake.activities.set(9001, ride(9001));
      fake.streams.set(9001, steady(1800, 200));
      await post(event('create', 9001));
      fake.streams.set(9001, steady(1800, 250));
      await post(event('update', 9001, { updates: { title: 'renamed' } }));
      const rows = await effortRows();
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].peak20_power)).toBeCloseTo(250, 6);
    });

    it('retries / duplicate deliveries produce exactly one row', async () => {
      fake.activities.set(9001, ride(9001));
      fake.streams.set(9001, steady(1800));
      // Dedupe off here, to prove the upsert itself is idempotent (the dedupe has its own test).
      const raw = express();
      raw.use(
        stravaWebhookRouter({ ingest, verifyToken: VERIFY, pool: pool(), dedupeWindowSec: 0 }),
      );
      const send = () => request(raw).post('/').send(event('create', 9001));
      await Promise.all([send(), send()]);
      await send();
      expect(await effortRows()).toHaveLength(1);
      expect(await eventRows()).toHaveLength(3); // each delivery is recorded, one metric row
    });

    it('delete: confirmed with Strava first; removes the row only because Strava says it is gone', async () => {
      fake.activities.set(9001, ride(9001));
      fake.streams.set(9001, steady(1800));
      await post(event('create', 9001));
      fake.activities.delete(9001); // really deleted on Strava
      fake.calls.length = 0;
      const r = await post(event('delete', 9001));
      expect(r.status).toBe(200);
      expect(await effortRows()).toHaveLength(0);
      expect(fake.apiCalls().map((c) => c.path)).toEqual(['/api/v3/activities/9001']);
    });

    it('a forged delete for an activity that still exists on Strava removes nothing (H2)', async () => {
      fake.activities.set(9001, ride(9001));
      fake.streams.set(9001, steady(1800));
      await post(event('create', 9001));
      expect(await effortRows()).toHaveLength(1);
      await post(event('delete', 9001)); // Strava still has it
      expect(await effortRows()).toHaveLength(1);
    });

    it('collapses repeats of one (owner, object, aspect) inside the window, even when concurrent', async () => {
      fake.activities.set(9001, ride(9001));
      fake.streams.set(9001, steady(1800));
      await Promise.all([post(event('update', 9001)), post(event('update', 9001))]);
      await post(event('update', 9001));
      expect(await eventRows()).toHaveLength(1);
      expect(fake.apiCalls().filter((c) => c.path === '/api/v3/activities/9001')).toHaveLength(1);
      await post(event('delete', 9001)); // a different aspect is not a repeat
      expect(await eventRows()).toHaveLength(2);
    });

    it('flags a still-pending event so only then does the Lambda kick the replay (M4)', async () => {
      const slow = express();
      const slowIngest = {
        findUserByAthlete: ingest.findUserByAthlete.bind(ingest),
        ingestActivity: () => new Promise<never>(() => undefined), // never finishes in the budget
      } as unknown as StravaIngestService;
      slow.use(
        stravaWebhookRouter({
          ingest: slowIngest,
          verifyToken: VERIFY,
          pool: pool(),
          responseBudgetMs: 20,
        }),
      );
      const r = await request(slow).post('/').send(event('create', 9100));
      expect(r.status).toBe(200);
      expect(r.headers['x-rd-replay']).toBe('1');
      expect((await eventRows())[0]).toMatchObject({ status: 'pending' });
      const fast = await post(event('create', 9101));
      expect(fast.headers['x-rd-replay']).toBeUndefined();
    });

    it('delete only touches the owner’s own activity', async () => {
      const other = (
        await pool().query<{ id: string }>(`INSERT INTO users(email) VALUES ($1) RETURNING id`, [
          `o-${randomBytes(4).toString('hex')}@phase4.invalid`,
        ])
      ).rows[0]!.id;
      created.push(other);
      await pool().query(
        `INSERT INTO activity_efforts (user_id, external_activity_id, source, date, duration_sec, avg_hr) VALUES ($1,'9001','strava','2026-03-01',1800,140)`,
        [other],
      );
      await post(event('delete', 9001));
      expect(
        (await pool().query('SELECT 1 FROM activity_efforts WHERE user_id=$1', [other])).rowCount,
      ).toBe(1);
    });

    it('skips short rides without fetching streams', async () => {
      fake.activities.set(9002, ride(9002, { moving_time: 600 }));
      await post(event('create', 9002));
      expect(fake.apiCalls().map((c) => c.path)).toEqual(['/api/v3/activities/9002']);
      expect(await effortRows()).toHaveLength(0);
      expect((await eventRows())[0]).toMatchObject({ status: 'processed' });
    });

    it.each(['Run', 'Swim', 'EBikeRide'])('skips %s without fetching streams', async (t) => {
      fake.activities.set(9003, ride(9003, { sport_type: t, type: t }));
      await post(event('create', 9003));
      expect(fake.apiCalls().map((c) => c.path)).toEqual(['/api/v3/activities/9003']);
      expect(await effortRows()).toHaveLength(0);
    });

    it('skips (and removes) a ride whose streams fall below the minimum after gap collapsing', async () => {
      fake.activities.set(9004, ride(9004));
      fake.streams.set(9004, steady(300)); // summary says 30 min, stream only has 5
      await post(event('create', 9004));
      expect(await effortRows()).toHaveLength(0);
    });

    it('an update that makes a stored ride ineligible removes its row', async () => {
      fake.activities.set(9001, ride(9001));
      fake.streams.set(9001, steady(1800));
      await post(event('create', 9001));
      fake.activities.set(9001, ride(9001, { sport_type: 'Run', type: 'Run' }));
      await post(event('update', 9001, { updates: { type: 'Run' } }));
      expect(await effortRows()).toHaveLength(0);
    });

    it('activity deleted on Strava before we fetch: row removed, event processed', async () => {
      await pool().query(
        `INSERT INTO activity_efforts (user_id, external_activity_id, source, date, duration_sec, avg_hr) VALUES ($1,'9005','strava','2026-03-01',1800,140)`,
        [userId],
      );
      await post(event('update', 9005)); // fake returns 404
      expect(await effortRows()).toHaveLength(0);
    });

    it('events for unknown athletes are dropped: no Strava calls and no row stored (M4)', async () => {
      const r = await post(event('create', 9001, { owner_id: 999999 }));
      expect(r.status).toBe(200);
      expect(r.headers['x-rd-replay']).toBeUndefined();
      expect(fake.calls).toHaveLength(0);
      const { rowCount } = await pool().query(
        `SELECT 1 FROM webhook_events WHERE payload_jsonb->>'owner_id' = '999999'`,
      );
      expect(rowCount).toBe(0);
    });

    it('production fails closed without a pinned subscription id; a pinned one still works (H2)', async () => {
      const prod = express();
      prod.use(
        '/w',
        stravaWebhookRouter({
          ingest,
          verifyToken: VERIFY,
          pool: pool(),
          requireSubscriptionPin: true,
        }),
      );
      const open = await request(prod).post('/w').send(event('create', 1));
      expect(open.status).toBe(503);
      expect(fake.calls).toHaveLength(0);
      expect(await eventRows()).toHaveLength(0);

      const pinnedProd = express();
      pinnedProd.use(
        '/w',
        stravaWebhookRouter({
          ingest,
          verifyToken: VERIFY,
          subscriptionId: '777',
          requireSubscriptionPin: true,
          pool: pool(),
        }),
      );
      expect((await request(pinnedProd).post('/w').send(event('create', 1))).status).toBe(200);
    });

    it('receipts store ids only: a renamed-activity title in `updates` is not kept', async () => {
      fake.activities.set(9001, ride(9001));
      fake.streams.set(9001, steady(1800));
      await post(event('update', 9001, { updates: { title: 'Tempo with my doctor' } }));
      const [row] = await eventRows();
      expect(JSON.stringify(row.payload_jsonb)).not.toContain('doctor');
      expect(row.payload_jsonb).not.toHaveProperty('updates');
    });

    it('rejects malformed bodies and mismatched subscription ids', async () => {
      expect((await post({ hello: 'world' })).status).toBe(400);
      const bad = await request(pinned)
        .post('/w')
        .send(event('create', 1, { subscription_id: 1 }));
      expect(bad.status).toBe(403);
      expect(fake.calls).toHaveLength(0);
    });

    const deauthEvent = {
      object_type: 'athlete',
      object_id: ATHLETE,
      aspect_type: 'update',
      owner_id: ATHLETE,
      subscription_id: 777,
      updates: { authorized: 'false' },
    };

    it('a forged deauthorization event does not disconnect: Strava still accepts the token (H2)', async () => {
      await post(deauthEvent);
      const { rows } = await pool().query(
        `SELECT is_active, access_token_enc IS NOT NULL AS has_token FROM provider_connections WHERE user_id=$1`,
        [userId],
      );
      expect(rows[0]).toEqual({ is_active: true, has_token: true });
      expect(fake.apiCalls().map((c) => c.path)).toEqual(['/api/v3/athlete']);
      expect((await eventRows())[0]).toMatchObject({ status: 'processed' });
    });

    it('athlete deauthorization deactivates the connection and clears tokens once Strava rejects the token', async () => {
      fake.setAthleteStatus(401);
      await post({
        object_type: 'athlete',
        object_id: ATHLETE,
        aspect_type: 'update',
        owner_id: ATHLETE,
        subscription_id: 777,
        updates: { authorized: 'false' },
      });
      const { rows } = await pool().query(
        `SELECT is_active, access_token_enc, refresh_token_enc FROM provider_connections WHERE user_id=$1`,
        [userId],
      );
      expect(rows[0]).toEqual({
        is_active: false,
        access_token_enc: null,
        refresh_token_enc: null,
      });
    });
  });

  describe('token refresh', () => {
    it('refreshes BEFORE the API call when near expiry and stores rotated tokens encrypted', async () => {
      await connect(new Date(Date.now() + 60_000)); // 1 minute left
      fake.activities.set(9001, ride(9001));
      fake.streams.set(9001, steady(1800));
      await post(event('create', 9001));

      expect(fake.calls[0]).toMatchObject({ method: 'POST', path: '/oauth/token' });
      const form = new URLSearchParams(fake.calls[0]!.body);
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe('refresh-1');
      // API calls carry the NEW access token.
      expect(fake.apiCalls().every((c) => c.auth === 'Bearer access-2')).toBe(true);

      const { rows } = await pool().query(
        `SELECT access_token_enc, refresh_token_enc, expires_at FROM provider_connections WHERE user_id=$1`,
        [userId],
      );
      const ctx = `${userId}:strava`;
      expect(await cipher.decrypt(rows[0].access_token_enc, ctx)).toBe('access-2');
      expect(await cipher.decrypt(rows[0].refresh_token_enc, ctx)).toBe('refresh-2');
      expect(rows[0].access_token_enc.includes(Buffer.from('access-2'))).toBe(false);
      expect(rows[0].expires_at.getTime()).toBeGreaterThan(Date.now() + 5 * 3600_000);
    });

    it('does not refresh when the token has plenty of life left; concurrent events refresh once', async () => {
      fake.activities.set(9001, ride(9001));
      fake.streams.set(9001, steady(1800));
      await post(event('create', 9001));
      expect(fake.calls.some((c) => c.path === '/oauth/token')).toBe(false);

      fake.calls.length = 0;
      await connect(new Date(Date.now() - 1000)); // already expired
      await Promise.all([post(event('create', 9001)), post(event('update', 9001))]);
      expect(fake.calls.filter((c) => c.path === '/oauth/token')).toHaveLength(1);
    });

    it('a revoked refresh token deactivates the connection and fails the event', async () => {
      await connect(new Date(Date.now() - 1000));
      const revoking = new StravaClient({
        clientId: '1',
        clientSecret: 's',
        redirectUri: 'x',
        fetch: (async () => json({ message: 'Bad Request' }, 400)) as never,
        limiter,
      });
      const svc = new StravaIngestService({ pool: pool(), cipher, client: revoking, efforts });
      const a = express();
      a.use(stravaWebhookRouter({ ingest: svc, verifyToken: VERIFY, pool: pool() }));
      const r = await request(a).post('/').send(event('create', 9001));
      expect(r.status).toBe(200); // still ack: Strava must not hammer us
      // A revoked grant can never succeed until the user reconnects: terminal at once (phase 9).
      expect((await eventRows())[0].status).toBe('abandoned');
      const { rows } = await pool().query(
        'SELECT is_active FROM provider_connections WHERE user_id=$1',
        [userId],
      );
      expect(rows[0].is_active).toBe(false);
    });
  });

  describe('rate limits', () => {
    it('backs off before the ceiling: no request leaves, event stays failed, replay succeeds later', async () => {
      now = new Date('2026-03-01T10:07:00Z');
      fake.activities.set(9001, ride(9001));
      fake.streams.set(9001, steady(1800));
      fake.setUsage('91,300'); // app is past 90% of its 100-read/15min budget after the first response

      await post(event('create', 9001)); // first call goes out, headers report 91/100
      const before = fake.apiCalls().length;
      expect(before).toBeGreaterThanOrEqual(1);
      await pool().query('DELETE FROM activity_efforts WHERE user_id=$1', [userId]);

      fake.calls.length = 0;
      await post(event('update', 9001)); // (not a repeat of the create above, so not deduped)
      expect(fake.calls).toHaveLength(0); // limiter refused locally — never risked a 429
      expect((await eventRows()).at(-1)!.status).toBe('failed');
      expect(await effortRows()).toHaveLength(0);

      // Next 15-minute window: replay picks up the failed event and completes.
      now = new Date('2026-03-01T10:16:00Z');
      fake.setUsage('1,301');
      // The replay scan is global and this DB is shared with parallel test files: scope it to this
      // file's user so other files' failed/pending events are not replayed with this file's fake.
      const scan = `WHERE provider = 'strava' AND user_id IS NOT NULL`;
      const scoped = {
        query: (text: string, params?: unknown[]) =>
          pool().query(
            text.includes(scan) ? text.replace(scan, `${scan} AND user_id = '${userId}'`) : text,
            params,
          ),
        connect: () => pool().connect(),
      } as unknown as ReturnType<typeof pool>;
      const done = await replayStravaEvents(scoped, ingest);
      expect(done).toBeGreaterThanOrEqual(1);
      expect(await effortRows()).toHaveLength(1);
      expect((await eventRows()).every((e) => e.status === 'processed')).toBe(true);
    });
  });
});
