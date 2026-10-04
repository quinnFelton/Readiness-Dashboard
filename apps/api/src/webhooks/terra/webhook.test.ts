import { randomBytes, randomUUID } from 'node:crypto';
import { createAdapterRegistry, createTerraAdapter } from '@rd/provider-adapters';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAesGcmCipher } from '../../crypto/token-cipher';
import { runTerraBackfillOnce } from '../../providers/terra/backfill';
import { closePool, getPool } from '../../users/pool';
import { terraWebhookRouter } from './router';
import { signTerraPayload } from './signature';

// Needs migrated local Postgres (docker compose up -d db && pnpm db:migrate). Terra HTTP is mocked;
// payload shapes mirror https://docs.tryterra.co/reference/health-and-fitness-api/data-models.md.

const SECRET = 'whsec_phase3b_test';
const NOW = 1_800_000_000;
const cipher = new LocalAesGcmCipher(randomBytes(32).toString('base64'));
const pool = () => getPool();

const TERRA_UID = 'terra-user-0001';
const sleepFor = (referenceId: string, terraUserId = TERRA_UID) => ({
  status: 'success',
  type: 'sleep',
  user: { user_id: terraUserId, provider: 'ZEPP', reference_id: referenceId },
  data: [
    {
      metadata: { start_time: '2026-03-01T23:00:00+00:00', end_time: '2026-03-02T07:00:00+00:00' },
      scores: { sleep: 80 },
      heart_rate_data: { summary: { resting_hr_bpm: 50, avg_hrv_rmssd: 65 } },
    },
  ],
});

describe('POST /webhooks/terra', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  const registry = createAdapterRegistry();
  registry.register(
    createTerraAdapter({
      devId: 'd',
      apiKey: 'k',
      successRedirectUrl: 'https://app.example/s',
      fetch: fetchMock as unknown as typeof fetch,
    }),
  );

  const app = express();
  // Deliberately mounted WITHOUT a global json parser (see router docs).
  app.use(
    '/api/v1/webhooks/terra',
    terraWebhookRouter({
      pool: pool(),
      registry,
      cipher,
      signingSecret: SECRET,
      nowSec: () => NOW,
      toleranceSec: 300,
      backfillConfig: { days: 30 },
    }),
  );

  let userId: string;
  let otherUser: string;
  const created: string[] = [];
  const mkUser = async (tag: string) => {
    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO users(email) VALUES ($1) RETURNING id`,
      [`${tag}-${randomBytes(4).toString('hex')}@phase3b.invalid`],
    );
    created.push(rows[0]!.id);
    return rows[0]!.id;
  };

  const post = (payload: unknown, opts: { secret?: string; t?: number; raw?: string } = {}) => {
    const raw = opts.raw ?? JSON.stringify(payload);
    return request(app)
      .post('/api/v1/webhooks/terra')
      .set('content-type', 'application/json')
      .set('terra-signature', signTerraPayload(raw, opts.secret ?? SECRET, opts.t ?? NOW))
      .send(raw);
  };

  const metrics = async (u: string) =>
    (
      await pool().query(
        `SELECT date::text AS date, metric_type, value::float AS value, source
           FROM daily_metrics WHERE user_id = $1 ORDER BY metric_type`,
        [u],
      )
    ).rows;
  const events = async (u: string | null) =>
    (
      await pool().query(
        u
          ? `SELECT status, payload_jsonb FROM webhook_events WHERE user_id = $1`
          : `SELECT status, payload_jsonb FROM webhook_events WHERE user_id IS NULL AND payload_jsonb->>'terra_user_id' = $1`,
        [u ?? TERRA_UID],
      )
    ).rows;
  const connect = (u: string, ext = TERRA_UID, lastSynced: Date | null = null) =>
    pool().query(
      `INSERT INTO provider_connections (user_id, provider, role, external_user_id, last_synced_at)
       VALUES ($1,'terra','daily_metrics_source',$2,$3)
       ON CONFLICT (user_id, provider) DO UPDATE SET external_user_id=$2, is_active=true, last_synced_at=$3`,
      [u, ext, lastSynced],
    );

  beforeAll(async () => {
    userId = await mkUser('a');
    otherUser = await mkUser('b');
  });
  beforeEach(async () => {
    const ids = [userId, otherUser];
    await pool().query('DELETE FROM daily_metrics WHERE user_id = ANY($1)', [ids]);
    await pool().query('DELETE FROM connection_configs WHERE user_id = ANY($1)', [ids]);
    await pool().query('DELETE FROM provider_connections WHERE user_id = ANY($1)', [ids]);
    await pool().query(
      `DELETE FROM webhook_events WHERE user_id = ANY($1) OR payload_jsonb->>'terra_user_id' = $2`,
      [ids, TERRA_UID],
    );
    fetchMock.mockClear();
  });
  afterAll(async () => {
    await pool().query('DELETE FROM users WHERE id = ANY($1)', [created]);
    await closePool();
  });

  it('accepts a valid signature, records receipt, normalizes and upserts', async () => {
    await connect(userId);
    const res = await post(sleepFor(userId));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'processed' });
    expect(await metrics(userId)).toEqual([
      { date: '2026-03-02', metric_type: 'hrv', value: 65, source: 'terra' },
      { date: '2026-03-02', metric_type: 'resting_hr', value: 50, source: 'terra' },
      { date: '2026-03-02', metric_type: 'sleep_score', value: 80, source: 'terra' },
    ]);
    const ev = await events(userId);
    expect(ev).toHaveLength(1);
    expect(ev[0].status).toBe('processed');
  });

  it('does not retain the raw payload in webhook_events (metadata only)', async () => {
    await connect(userId);
    await post(sleepFor(userId));
    const [ev] = await events(userId);
    const text = JSON.stringify(ev.payload_jsonb);
    expect(text).not.toContain('avg_hrv_rmssd');
    expect(text).not.toContain('65');
    expect(ev.payload_jsonb).toMatchObject({ type: 'sleep', items: 1, result: 'sleep' });
  });

  it('is idempotent: redelivery does not duplicate rows', async () => {
    await connect(userId);
    await post(sleepFor(userId));
    await post(sleepFor(userId));
    expect(await metrics(userId)).toHaveLength(3);
  });

  it('rejects a tampered body (401), writes nothing, records nothing', async () => {
    await connect(userId);
    const good = JSON.stringify(sleepFor(userId));
    const tampered = good.replace('"sleep":80', '"sleep":99');
    const sig = signTerraPayload(good, SECRET, NOW);
    const res = await request(app)
      .post('/api/v1/webhooks/terra')
      .set('content-type', 'application/json')
      .set('terra-signature', sig)
      .send(tampered);
    expect(res.status).toBe(401);
    expect(await metrics(userId)).toEqual([]);
    expect(await events(userId)).toEqual([]);
  });

  it('rejects the wrong secret', async () => {
    await connect(userId);
    const res = await post(sleepFor(userId), { secret: 'not-the-secret' });
    expect(res.status).toBe(401);
    expect(await metrics(userId)).toEqual([]);
  });

  it('rejects a stale timestamp even with a valid MAC', async () => {
    await connect(userId);
    const res = await post(sleepFor(userId), { t: NOW - 3600 });
    expect(res.status).toBe(401);
    expect(await metrics(userId)).toEqual([]);
  });

  it('rejects a missing signature header', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/terra')
      .set('content-type', 'application/json')
      .send(JSON.stringify(sleepFor(userId)));
    expect(res.status).toBe(401);
  });

  it('verifies before parsing: a signed-but-unparseable body is 400, an unsigned one is 401', async () => {
    const raw = 'not json{';
    expect((await post(null, { raw })).status).toBe(400);
    const unsigned = await request(app)
      .post('/api/v1/webhooks/terra')
      .set('content-type', 'application/json')
      .send(raw);
    expect(unsigned.status).toBe(401);
  });

  it('fails closed when no signing secret is configured', async () => {
    const prev = process.env.TERRA_SIGNING_SECRET;
    delete process.env.TERRA_SIGNING_SECRET;
    const bare = express();
    bare.use('/w', terraWebhookRouter({ pool: pool(), registry, cipher, nowSec: () => NOW }));
    const res = await request(bare).post('/w').send('{}');
    expect(res.status).toBe(500);
    if (prev !== undefined) process.env.TERRA_SIGNING_SECRET = prev;
  });

  it('refuses (500) rather than mis-verify when a json parser consumed the body first', async () => {
    const bad = express();
    bad.use(express.json());
    bad.use(
      '/w',
      terraWebhookRouter({
        pool: pool(),
        registry,
        cipher,
        signingSecret: SECRET,
        nowSec: () => NOW,
      }),
    );
    const raw = JSON.stringify(sleepFor(userId));
    const res = await request(bad)
      .post('/w')
      .set('content-type', 'application/json')
      .set('terra-signature', signTerraPayload(raw, SECRET, NOW))
      .send(raw);
    expect(res.status).toBe(500);
  });

  it('ignores an unknown reference_id safely (200, no writes, event recorded unmatched)', async () => {
    const res = await post(sleepFor(randomUUID()));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ignored' });
    const ev = await events(null);
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(ev[0].payload_jsonb.result).toBe('unknown_or_inactive_connection');
  });

  it('ignores a non-uuid / missing reference_id without hitting the DB with it', async () => {
    expect((await post(sleepFor('not-a-uuid'))).body).toEqual({ status: 'ignored' });
    const noRef = { ...sleepFor(userId), user: { user_id: TERRA_UID } };
    expect((await post(noRef)).body).toEqual({ status: 'ignored' });
  });

  it("ignores a signed payload whose Terra user_id doesn't match the stored connection", async () => {
    await connect(userId, 'the-real-terra-user');
    const res = await post(sleepFor(userId, 'someone-else'));
    expect(res.body).toEqual({ status: 'ignored' });
    expect(await metrics(userId)).toEqual([]);
  });

  it('ignores data for an inactive (deauthed) connection', async () => {
    await connect(userId);
    await pool().query(`UPDATE provider_connections SET is_active=false WHERE user_id=$1`, [
      userId,
    ]);
    expect((await post(sleepFor(userId))).body).toEqual({ status: 'ignored' });
    expect(await metrics(userId)).toEqual([]);
  });

  it('auth event records the Terra user_id and triggers the one-time backfill', async () => {
    const res = await post({
      status: 'success',
      type: 'auth',
      user: { user_id: TERRA_UID, provider: 'ZEPP', reference_id: userId },
      reference_id: userId,
    });
    expect(res.status).toBe(200);
    const { rows } = await pool().query(
      `SELECT external_user_id, role, is_active, last_synced_at FROM provider_connections WHERE user_id=$1 AND provider='terra'`,
      [userId],
    );
    expect(rows[0]).toMatchObject({
      external_user_id: TERRA_UID,
      role: 'daily_metrics_source',
      is_active: true,
    });
    expect(rows[0].last_synced_at).not.toBeNull();
    // configured as a source too
    const cfg = await pool().query(
      `SELECT 1 FROM connection_configs WHERE user_id=$1 AND provider='terra'`,
      [userId],
    );
    expect(cfg.rowCount).toBe(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.pathname).toBe('/v2/sleep');
    expect(u.searchParams.get('user_id')).toBe(TERRA_UID);
    expect(u.searchParams.get('to_webhook')).toBe('true');
    expect(init.headers).toMatchObject({ 'dev-id': 'd', 'x-api-key': 'k' });

    // redelivered auth event must not re-request history
    await post({
      status: 'success',
      type: 'auth',
      user: { user_id: TERRA_UID, provider: 'ZEPP', reference_id: userId },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('auth event for an unknown user creates nothing', async () => {
    const ghost = randomUUID();
    const res = await post({
      status: 'success',
      type: 'auth',
      user: { user_id: TERRA_UID, reference_id: ghost },
    });
    expect(res.body).toEqual({ status: 'ignored' });
    expect(
      (await pool().query(`SELECT 1 FROM provider_connections WHERE user_id=$1`, [ghost])).rowCount,
    ).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failed backfill returns 5xx (so Terra retries) and leaves last_synced_at NULL', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('x', {
        status: 429,
        headers: { 'x-terra-ratelimit-rule': 'r2', 'retry-after': '60' },
      }),
    );
    const res = await post({
      status: 'success',
      type: 'auth',
      user: { user_id: TERRA_UID, reference_id: userId },
    });
    expect(res.status).toBe(500);
    const { rows } = await pool().query(
      `SELECT last_synced_at FROM provider_connections WHERE user_id=$1`,
      [userId],
    );
    expect(rows[0].last_synced_at).toBeNull();
    const [ev] = await events(userId);
    expect(ev.status).toBe('failed');
    // retry succeeds
    expect(
      (
        await post({
          status: 'success',
          type: 'auth',
          user: { user_id: TERRA_UID, reference_id: userId },
        })
      ).status,
    ).toBe(200);
  });

  it('deauth deactivates the connection', async () => {
    await connect(userId);
    const res = await post({
      status: 'success',
      type: 'deauth',
      user: { user_id: TERRA_UID, reference_id: userId },
    });
    expect(res.status).toBe(200);
    const { rows } = await pool().query(
      `SELECT is_active FROM provider_connections WHERE user_id=$1`,
      [userId],
    );
    expect(rows[0].is_active).toBe(false);
  });

  it('daily/body payloads are accepted but write no metrics (not mapped)', async () => {
    await connect(userId);
    const res = await post({ ...sleepFor(userId), type: 'daily' });
    expect(res.status).toBe(200);
    expect(await metrics(userId)).toEqual([]);
  });
});

describe('runTerraBackfillOnce', () => {
  it('skips when there is no connection row', async () => {
    const calls: unknown[] = [];
    const out = await runTerraBackfillOnce(
      getPool(),
      {
        generateWidgetSession: async () => ({ url: '' }),
        requestSleepBackfill: async (r) => (calls.push(r), {}),
      },
      randomUUID(),
      'tu',
      { days: 10 },
    );
    expect(out).toBe('skipped');
    expect(calls).toEqual([]);
  });
});
