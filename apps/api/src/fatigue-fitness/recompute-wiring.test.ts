import { randomBytes, randomInt } from 'node:crypto';
import { createAdapterRegistry, createTerraAdapter } from '@rd/provider-adapters';
import { StravaClient, StravaRateLimiter } from '@rd/provider-adapters/strava';
import express from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionConfigService } from '../connections/config-service';
import { ConnectionService } from '../connections/connection-service';
import { LocalAesGcmCipher } from '../crypto/token-cipher';
import { ActivityEffortService } from '../efforts/activity-effort-service';
import { OuraAdapter, ouraConfigFromEnv, ouraSignature } from '../providers/oura/register';
import { syncOuraUser } from '../providers/oura/sync-job';
import { acquireOuraTestMutex } from '../providers/oura/test-mutex';
import { createOuraWebhookRouter } from '../providers/oura/webhook';
import { StravaIngestService } from '../providers/strava/strava-ingest-service';
import { acquireDefaultsTestMutex } from '../test-utils/defaults-mutex';
import { addDays, todayUtc } from '../trends/http';
import { closePool, getPool } from '../users/pool';
import { replayStravaEvents, stravaWebhookRouter } from '../webhooks/strava/routes';
import { terraWebhookRouter } from '../webhooks/terra/router';
import { signTerraPayload } from '../webhooks/terra/signature';
import { type Recompute, createRecompute, sharedRecompute } from './recompute';

// Integration stage E: every ingest path calls FatigueFitnessService.onSyncComplete (PLAN §8.4:
// compute on sync, never on dashboard load). Each test seeds the same 28-day history for two users,
// ingests for ONE of them through a real path, and asserts trend rows appear for that user only.
// The paths use their production default (the process-wide sharedRecompute), not an injected hook.
//
// Needs migrated local Postgres (docker compose up -d db && pnpm db:migrate). All provider HTTP is
// an in-memory fake (CLAUDE.md rule 10). Dates are relative to the real today, because the
// production hook recomputes "today" plus the touched days.

const pool = getPool();
const cipher = new LocalAesGcmCipher(randomBytes(32).toString('base64'));
const tag = randomBytes(4).toString('hex');
const today = () => todayUtc(new Date());
const day = (d: number) => addDays(today(), -d);
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const created: string[] = [];
let n = 0;
async function mkUser(label: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users(email) VALUES ($1) RETURNING id`,
    [`wire-${label}-${tag}-${n++}@stage-e.invalid`],
  );
  created.push(rows[0]!.id);
  return rows[0]!.id;
}

/** EF up in the last week (rides every other day) + recovery down (daily), from `source`. */
async function seedHistory(userId: string, source: string, opts: { efforts?: boolean } = {}) {
  if (opts.efforts ?? true) {
    for (let d = 2; d < 28; d += 2) {
      await pool.query(
        `INSERT INTO activity_efforts (user_id, external_activity_id, source, date, duration_sec,
           avg_hr, ef_peak20, deriver_id) VALUES ($1, $2, 'strava', $3, 3600, 140, $4, 'peak20_v1')`,
        [userId, `hist-${d}`, day(d), (d < 7 ? 2.0 : 1.5) + (d % 3) * 0.02],
      );
    }
  }
  for (let d = 1; d < 28; d++) {
    await pool.query(
      `INSERT INTO daily_metrics (user_id, date, source, metric_type, value)
       VALUES ($1, $2, $3, 'hrv', $4), ($1, $2, $3, 'resting_hr', $5)`,
      [userId, day(d), source, (d < 7 ? 40 : 60) + (d % 3), (d < 7 ? 60 : 50) + (d % 2)],
    );
  }
}

const count = async (table: 'trends' | 'readiness_scores', userId: string) =>
  Number(
    (
      await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE user_id = $1`, [
        userId,
      ])
    ).rows[0]!.n,
  );
const trendDays = async (userId: string) =>
  (
    await pool.query<{ d: string }>(
      `SELECT DISTINCT to_char(as_of, 'YYYY-MM-DD') AS d FROM trends WHERE user_id = $1 ORDER BY d`,
      [userId],
    )
  ).rows.map((r) => r.d);
const eventStatuses = async (userId: string, provider: string) =>
  (
    await pool.query<{ status: string }>(
      `SELECT status FROM webhook_events WHERE user_id = $1 AND provider = $2 ORDER BY received_at`,
      [userId, provider],
    )
  ).rows.map((r) => r.status);

/** A hook whose FatigueFitnessService always fails, with a log spy. */
function failingHook(): { hook: Recompute; log: ReturnType<typeof vi.fn> } {
  const log = vi.fn();
  const hook = createRecompute(
    {
      onSyncComplete: async () => {
        throw new TypeError('hrv=63 must never be logged');
      },
    },
    { log },
  );
  return { hook, log };
}

let releaseDefaults: () => Promise<void> = async () => {};
let a: string; // the user who ingests
let b: string; // same history, never ingests: must get no trend rows

beforeAll(async () => {
  // Trend rows need the default classifier; comparison.test.ts swaps it while it runs.
  releaseDefaults = await acquireDefaultsTestMutex(pool);
});
beforeEach(async () => {
  a = await mkUser('a');
  b = await mkUser('b');
});
afterAll(async () => {
  await pool.query(`DELETE FROM webhook_events WHERE user_id = ANY($1)`, [created]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [created]);
  await releaseDefaults();
  await closePool();
});

it('sharedRecompute is one hook per process', () => {
  expect(sharedRecompute()).toBe(sharedRecompute());
});

// ---------------------------------------------------------------- Strava (PLAN §5.2)

describe('strava ingest → trends', () => {
  const activities = new Map<string, unknown>();
  const streams = new Map<string, unknown>();
  const stravaFetch = async (input: string | URL | Request) => {
    const m = /^\/api\/v3\/activities\/(\d+)(\/streams)?$/.exec(new URL(String(input)).pathname);
    const v = m ? (m[2] ? streams : activities).get(m[1]!) : undefined;
    return v ? json(v) : json({}, 404);
  };
  const client = new StravaClient({
    clientId: '1',
    clientSecret: 's',
    redirectUri: 'http://x/cb',
    fetch: stravaFetch as unknown as typeof fetch,
    limiter: new StravaRateLimiter({ maxWaitMs: 0 }),
  });
  const efforts = new ActivityEffortService(pool);
  const ingestWith = (recompute?: Recompute) =>
    new StravaIngestService({ pool, cipher, client, efforts, recompute });
  const appFor = (ingest: StravaIngestService) =>
    express().use(
      '/w',
      stravaWebhookRouter({ ingest, verifyToken: 'v', pool, responseBudgetMs: 20_000 }),
    );

  let athlete: number;
  let activityId: number;
  const event = (aspect: string) => ({
    object_type: 'activity',
    object_id: activityId,
    aspect_type: aspect,
    owner_id: athlete,
    updates: {},
  });

  beforeEach(async () => {
    athlete = randomInt(1_000_000_000, 2_000_000_000);
    activityId = randomInt(1_000_000_000, 2_000_000_000);
    const ctx = `${a}:strava`;
    await pool.query(
      `INSERT INTO provider_connections
         (user_id, provider, role, external_user_id, access_token_enc, refresh_token_enc, expires_at)
       VALUES ($1, 'strava', 'activity_source', $2, $3, $4, now() + interval '6 hours')`,
      [
        a,
        String(athlete),
        await cipher.encrypt('access', ctx),
        await cipher.encrypt('refresh', ctx),
      ],
    );
    // Shapes per https://developers.strava.com/docs/reference/ (as in strava-webhook.test.ts).
    activities.set(String(activityId), {
      id: activityId,
      type: 'Ride',
      sport_type: 'Ride',
      start_date_local: `${today()}T08:00:00Z`,
      moving_time: 1800,
      has_heartrate: true,
      manual: false,
    });
    streams.set(String(activityId), {
      time: { data: Array.from({ length: 1800 }, (_, i) => i) },
      watts: { data: Array.from({ length: 1800 }, () => 200) },
      heartrate: { data: Array.from({ length: 1800 }, () => 140) },
    });
    await seedHistory(a, 'oura');
    await seedHistory(b, 'oura');
  });

  it('webhook create: trend rows for the athlete, none for anyone else', async () => {
    expect(await count('trends', a)).toBe(0);
    const res = await request(appFor(ingestWith())).post('/w').send(event('create'));
    expect(res.status).toBe(200);
    expect(await eventStatuses(a, 'strava')).toEqual(['processed']);
    expect(await trendDays(a)).toContain(today());
    expect(await count('trends', b)).toBe(0);
  });

  it('webhook delete recomputes from the remaining rides', async () => {
    const app = appFor(ingestWith());
    await request(app).post('/w').send(event('create')).expect(200);
    await pool.query(`DELETE FROM trends WHERE user_id = $1`, [a]); // observe the delete's pass
    await request(app).post('/w').send(event('delete')).expect(200);
    expect(await eventStatuses(a, 'strava')).toEqual(['processed', 'processed']);
    expect(
      Number(
        (
          await pool.query(
            `SELECT count(*) AS n FROM activity_efforts WHERE user_id = $1 AND external_activity_id = $2`,
            [a, String(activityId)],
          )
        ).rows[0].n,
      ),
    ).toBe(0);
    expect(await trendDays(a)).toContain(today());
    expect(await count('trends', b)).toBe(0);
  });

  it('replayStravaEvents: a replayed event produces trend rows', async () => {
    await pool.query(
      `INSERT INTO webhook_events (user_id, provider, payload_jsonb, status)
       VALUES ($1, 'strava', $2, 'failed')`,
      [a, JSON.stringify(event('create'))],
    );
    // Scope the global replay scan to this test's user so concurrent test files' rows are untouched.
    const scan = `WHERE provider = 'strava' AND user_id IS NOT NULL`;
    const scoped = {
      query: (text: string, params?: unknown[]) => {
        if (text.includes(scan)) text = text.replace(scan, `${scan} AND user_id = '${a}'`);
        else if (/FROM webhook_events/.test(text)) throw new Error('replay scan not scoped');
        return pool.query(text, params);
      },
    } as unknown as pg.Pool;
    expect(await replayStravaEvents(scoped, ingestWith())).toBe(1);
    expect(await eventStatuses(a, 'strava')).toEqual(['processed']);
    expect(await trendDays(a)).toContain(today());
    expect(await count('trends', b)).toBe(0);
  });

  it('a failing recompute does not fail the ingest: event stays processed, name-only log', async () => {
    const { hook, log } = failingHook();
    const res = await request(appFor(ingestWith(hook)))
      .post('/w')
      .send(event('create'));
    expect(res.status).toBe(200);
    expect(await eventStatuses(a, 'strava')).toEqual(['processed']);
    expect(log).toHaveBeenCalledWith('fatigue-fitness recompute failed: TypeError');
    expect(JSON.stringify(log.mock.calls)).not.toContain('hrv');
    expect(await count('trends', a)).toBe(0);
  });
});

// ---------------------------------------------------------------- Terra (PLAN §5.3)

describe('terra webhook → trends', () => {
  const SECRET = `whsec_stage_e_${tag}`;
  const registry = createAdapterRegistry();
  registry.register(
    createTerraAdapter({
      devId: 'd',
      apiKey: 'k',
      successRedirectUrl: 'https://app.example/s',
      fetch: (async () => new Response('{}')) as unknown as typeof fetch,
    }),
  );
  const nowSec = () => Math.floor(Date.now() / 1000);
  const appFor = (recompute?: Recompute) =>
    express().use(
      '/t',
      terraWebhookRouter({ pool, registry, cipher, signingSecret: SECRET, nowSec, recompute }),
    );
  let terraUid: string;
  // Shape per https://docs.tryterra.co/reference/health-and-fitness-api/data-models.md (as in
  // webhooks/terra/webhook.test.ts).
  const sleep = () => ({
    status: 'success',
    type: 'sleep',
    user: { user_id: terraUid, provider: 'ZEPP', reference_id: a },
    data: [
      {
        metadata: { start_time: `${day(1)}T23:00:00+00:00`, end_time: `${today()}T07:00:00+00:00` },
        scores: { sleep: 80 },
        heart_rate_data: { summary: { resting_hr_bpm: 50, avg_hrv_rmssd: 65 } },
      },
    ],
  });
  const post = (app: express.Express, payload: unknown) => {
    const raw = JSON.stringify(payload);
    return request(app)
      .post('/t')
      .set('content-type', 'application/json')
      .set('terra-signature', signTerraPayload(raw, SECRET, nowSec()))
      .send(raw);
  };

  beforeEach(async () => {
    terraUid = `terra-${tag}-${n++}`;
    await pool.query(
      `INSERT INTO provider_connections (user_id, provider, role, external_user_id)
       VALUES ($1, 'terra', 'daily_metrics_source', $2)`,
      [a, terraUid],
    );
    await seedHistory(a, 'terra');
    await seedHistory(b, 'terra');
  });

  it('stored sleep metrics: trend + readiness rows for that user only', async () => {
    expect(await count('trends', a)).toBe(0);
    const res = await post(appFor(), sleep());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'processed' });
    expect(await eventStatuses(a, 'terra')).toEqual(['processed']);
    expect(await trendDays(a)).toContain(today());
    expect(await count('readiness_scores', a)).toBeGreaterThan(0);
    expect(await count('trends', b)).toBe(0);
    expect(await count('readiness_scores', b)).toBe(0);
  });

  it('a failing recompute still answers 200 and leaves the event processed', async () => {
    const { hook, log } = failingHook();
    const res = await post(appFor(hook), sleep());
    expect(res.status).toBe(200);
    expect(await eventStatuses(a, 'terra')).toEqual(['processed']);
    expect(log).toHaveBeenCalledWith('fatigue-fitness recompute failed: TypeError');
    expect(await count('trends', a)).toBe(0);
  });
});

// ---------------------------------------------------------------- Oura (PLAN §5.1)

describe('oura sync and webhook → trends', () => {
  const SECRET = 'oura-client-secret';
  // Shapes per Oura OpenAPI 1.41 (packages/provider-adapters/src/oura/docs), as in webhook.test.ts.
  const sleepDoc = (d: string) => ({
    id: `sl-${d}`,
    day: d,
    type: 'long_sleep',
    average_hrv: 70,
    lowest_heart_rate: 48,
    total_sleep_duration: 27000,
    bedtime_start: `${d}T00:00:00+00:00`,
    bedtime_end: `${d}T08:00:00+00:00`,
    low_battery_alert: false,
    period: 0,
    time_in_bed: 28800,
  });
  const ouraFetch = async (url: string | URL | Request) => {
    const coll = new URL(String(url)).pathname.split('/').pop();
    const data: Record<string, unknown[]> = {
      sleep: [sleepDoc(today())],
      daily_readiness: [{ id: 'r', day: today(), score: 80, contributors: {} }],
      daily_sleep: [{ id: 's', day: today(), score: 75, contributors: {} }],
    };
    return json({ data: data[coll ?? ''] ?? [], next_token: null });
  };
  const config = {
    ...ouraConfigFromEnv({}),
    clientId: 'cid',
    clientSecret: SECRET,
    webhookVerificationToken: 'vt',
    sleep: async () => {},
    fetch: ouraFetch as unknown as typeof fetch,
  };
  const adapter = new OuraAdapter(config);
  let ouraUid: string;
  let releaseOura: () => Promise<void> = async () => {};

  beforeAll(async () => {
    // Other Oura test files run syncOuraAll over every active Oura connection.
    releaseOura = await acquireOuraTestMutex(pool);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM provider_connections WHERE user_id = ANY($1)`, [created]);
    await releaseOura();
  });
  beforeEach(async () => {
    ouraUid = `oura-${tag}-${n++}`;
    const registry = createAdapterRegistry();
    registry.register(adapter);
    await new ConnectionService(
      pool,
      registry,
      cipher,
      new ConnectionConfigService(pool, registry),
    ).saveGrant(a, 'oura', 'daily_metrics_source', {
      accessToken: 'A0',
      refreshToken: 'R0',
      expiresAt: new Date(Date.now() + 3_600_000),
      externalUserId: ouraUid,
    });
    await seedHistory(a, 'oura');
    await seedHistory(b, 'oura');
  });

  it('scheduled sync: trend + readiness rows for that user only', async () => {
    expect(await count('trends', a)).toBe(0);
    const res = await syncOuraUser(a, { pool, cipher, adapter });
    expect(res.ok).toBe(true);
    expect(await trendDays(a)).toContain(today());
    expect(await count('readiness_scores', a)).toBeGreaterThan(0);
    expect(await count('trends', b)).toBe(0);
    expect(await count('readiness_scores', b)).toBe(0);
  });

  it('webhook event: trend rows for that user only, event processed', async () => {
    const app = express().use('/o', createOuraWebhookRouter({ pool, cipher, adapter, config }));
    const text = JSON.stringify({
      event_type: 'update',
      data_type: 'sleep',
      object_id: 'obj-1',
      event_time: new Date().toISOString(),
      user_id: ouraUid,
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await request(app)
      .post('/o')
      .set('content-type', 'application/json')
      .set('x-oura-timestamp', ts)
      .set('x-oura-signature', ouraSignature(SECRET, ts, text))
      .send(text);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, outcome: 'processed' });
    expect(await eventStatuses(a, 'oura')).toEqual(['processed']);
    expect(await trendDays(a)).toContain(today());
    expect(await count('trends', b)).toBe(0);
  });

  it('a failing recompute does not fail the sync', async () => {
    const { hook, log } = failingHook();
    const res = await syncOuraUser(a, { pool, cipher, adapter, recompute: hook });
    expect(res.ok).toBe(true);
    expect(log).toHaveBeenCalledWith('fatigue-fitness recompute failed: TypeError');
  });
});

// ---------------------------------------------------------------- Disconnect (PLAN §10 flow 8)

describe('disconnect → trends rebuilt from what remains', () => {
  it('drops the provider, rebuilds the window from the other source, touches no one else', async () => {
    await seedHistory(a, 'oura');
    await seedHistory(a, 'terra', { efforts: false });
    await seedHistory(b, 'oura');
    // Inactive rows: the disconnect deletes them either way, and syncOuraAll in other files skips them.
    await pool.query(
      `INSERT INTO provider_connections (user_id, provider, role, is_active)
       VALUES ($1, 'oura', 'daily_metrics_source', false), ($1, 'terra', 'daily_metrics_source', false)`,
      [a],
    );
    const registry = createAdapterRegistry();
    const conns = new ConnectionService(
      pool,
      registry,
      cipher,
      new ConnectionConfigService(pool, registry),
    );
    expect(await count('trends', a)).toBe(0);

    await conns.disconnect(a, 'oura');

    const { rows } = await pool.query(
      `SELECT DISTINCT source FROM daily_metrics WHERE user_id = $1`,
      [a],
    );
    expect(rows.map((r) => r.source)).toEqual(['terra']);
    const days = await trendDays(a);
    expect(days).toContain(today());
    expect(days.length).toBeGreaterThan(1); // the dashboard window, not just today
    expect(await count('trends', b)).toBe(0);
  });

  it('with nothing left to compute from, the dashboard has no trend or readiness rows', async () => {
    await seedHistory(a, 'oura');
    await pool.query(
      `INSERT INTO provider_connections (user_id, provider, role, is_active)
       VALUES ($1, 'oura', 'daily_metrics_source', false)`,
      [a],
    );
    await pool.query(
      `INSERT INTO readiness_scores (user_id, date, score, components_jsonb) VALUES ($1, $2, 70, '{}')`,
      [a, today()],
    );
    const registry = createAdapterRegistry();
    await new ConnectionService(
      pool,
      registry,
      cipher,
      new ConnectionConfigService(pool, registry),
    ).disconnect(a, 'oura');
    expect(await count('trends', a)).toBe(0);
    expect(await count('readiness_scores', a)).toBe(0);
  });
});
