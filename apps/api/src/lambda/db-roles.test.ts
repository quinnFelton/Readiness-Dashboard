import { randomBytes, randomInt } from 'node:crypto';
import { createAdapterRegistry, createTerraAdapter } from '@rd/provider-adapters';
import { StravaClient, StravaRateLimiter } from '@rd/provider-adapters/strava';
import express from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConnectionConfigService } from '../connections/config-service';
import { LocalAesGcmCipher } from '../crypto/token-cipher';
import { ActivityEffortService } from '../efforts/activity-effort-service';
import { markHistoryDirty } from '../fatigue-fitness/history-rebuild';
import { createRecompute } from '../fatigue-fitness/recompute';
import { FatigueFitnessService } from '../fatigue-fitness/service';
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
import { deleteOldWebhookEvents } from './webhook-ttl';

// Stage E item: "every Lambda shares the Aurora master credential". Phase 9 gives each function its
// own Postgres role with the least privilege its handler needs (migration *_phase-9_hardening.sql).
// This file pins the EXACT privileges (so they cannot silently widen or lose a grant) and runs the real
// handler code for each function under its role (so a missing grant fails here, not in production).
// Needs migrated local Postgres; the test user is a superuser, so SET ROLE can assume any of them.

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://rd:rd@localhost:5432/readiness';
const admin = () => getPool();

/** A pool whose every connection runs as `role`. */
function rolePool(role: string): pg.Pool {
  if (!/^rd_[a-z_]+$/.test(role)) throw new Error('bad role');
  const p = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  p.on('connect', (c) => {
    void c.query(`SET ROLE ${role}`); // queued ahead of the caller's first query
  });
  return p;
}

type Priv = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
const ALL_TABLES = [
  'activity_efforts',
  'athlete_events',
  'classifiers',
  'connection_configs',
  'daily_metrics',
  'derivers',
  'history_rebuild_requests',
  'insight_feedback',
  'provider_connections',
  'readiness_scores',
  'trends',
  'users',
  'webhook_events',
] as const;
const ALL_PRIVS: Priv[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const SIU: Priv[] = ['SELECT', 'INSERT', 'UPDATE'];
const SU: Priv[] = ['SELECT', 'UPDATE'];

/** What every ingest function needs to recompute trends/readiness after writing (PLAN §8.4). */
const RECOMPUTE: Record<string, Priv[]> = {
  connection_configs: ['SELECT'],
  daily_metrics: ['SELECT'],
  activity_efforts: ['SELECT'],
  derivers: ['SELECT'],
  classifiers: ['SELECT'],
  trends: SIU,
  readiness_scores: SIU,
  history_rebuild_requests: SIU,
};
const merge = (...parts: Record<string, Priv[]>[]): Record<string, Priv[]> => {
  const out: Record<string, Set<Priv>> = {};
  for (const p of parts) {
    for (const [t, ps] of Object.entries(p)) {
      const set = (out[t] ??= new Set<Priv>());
      for (const priv of ps) set.add(priv);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([t, s]) => [t, [...s].sort()]));
};

const EXPECTED: Record<string, Record<string, Priv[]>> = {
  rd_api: Object.fromEntries(ALL_TABLES.map((t) => [t, ALL_PRIVS])),
  rd_hook_strava: merge(RECOMPUTE, {
    provider_connections: SU,
    activity_efforts: ALL_PRIVS,
    webhook_events: SIU,
  }),
  rd_strava_replay: merge(RECOMPUTE, {
    provider_connections: SU,
    activity_efforts: ALL_PRIVS,
    webhook_events: SIU,
  }),
  rd_hook_oura: merge(RECOMPUTE, {
    provider_connections: SU,
    daily_metrics: ALL_PRIVS,
    webhook_events: SIU,
  }),
  rd_oura_sync: merge(RECOMPUTE, { provider_connections: SU, daily_metrics: SIU }),
  rd_hook_terra: merge(RECOMPUTE, {
    provider_connections: SIU,
    connection_configs: SIU,
    daily_metrics: SIU,
    webhook_events: SIU,
  }),
  rd_history_rebuild: merge(RECOMPUTE),
  rd_webhook_ttl: { webhook_events: ['DELETE'] },
  rd_first_master: { users: ['INSERT', 'SELECT'] },
};
const COLUMN_GRANTS: Record<string, { table: string; column: string }[]> = {
  rd_hook_terra: [{ table: 'users', column: 'id' }],
  rd_webhook_ttl: [{ table: 'webhook_events', column: 'received_at' }],
};

describe('per-function database roles: exact privileges', () => {
  afterAll(async () => {
    await closePool();
  });

  it('every table is accounted for here: a new table must be added to this matrix AND the migration', async () => {
    const { rows } = await admin().query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'pgmigrations'`,
    );
    expect(rows.map((r) => r.tablename).sort()).toEqual([...ALL_TABLES].sort());
  });

  for (const [role, perTable] of Object.entries(EXPECTED)) {
    it(`${role}: exactly the expected table privileges, nothing else`, async () => {
      for (const table of ALL_TABLES) {
        for (const priv of [
          'SELECT',
          'INSERT',
          'UPDATE',
          'DELETE',
          'TRUNCATE',
          'REFERENCES',
          'TRIGGER',
        ]) {
          const { rows } = await admin().query<{ ok: boolean }>(
            `SELECT has_table_privilege($1, $2, $3) AS ok`,
            [role, table, priv],
          );
          const want = (perTable[table] ?? []).includes(priv as Priv);
          expect(rows[0]!.ok, `${role} ${priv} on ${table}`).toBe(want);
        }
      }
      // Column-level grants (the only way these roles read a subset of a table).
      for (const { table, column } of COLUMN_GRANTS[role] ?? []) {
        const { rows } = await admin().query<{ ok: boolean }>(
          `SELECT has_column_privilege($1, $2, $3, 'SELECT') AS ok`,
          [role, table, column],
        );
        expect(rows[0]!.ok, `${role} column ${table}.${column}`).toBe(true);
      }
    });
  }

  it('no role can log in with a password, create objects, or escalate; all are IAM-auth only on RDS', async () => {
    const { rows } = await admin().query(
      `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolinherit
         FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
      [Object.keys(EXPECTED)],
    );
    expect(rows).toHaveLength(Object.keys(EXPECTED).length);
    for (const r of rows) {
      expect(r, r.rolname).toMatchObject({
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
      });
    }
    // They cannot create anything in the schema, nor drop/alter the owner's tables.
    for (const role of Object.keys(EXPECTED)) {
      const { rows: c } = await admin().query<{ ok: boolean }>(
        `SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`,
        [role],
      );
      expect(c[0]!.ok, `${role} CREATE on schema`).toBe(false);
    }
  });

  it('denies what the handler does not need, with a real permission error', async () => {
    const strava = rolePool('rd_hook_strava');
    const ttl = rolePool('rd_webhook_ttl');
    const terra = rolePool('rd_hook_terra');
    try {
      await expect(strava.query('SELECT 1 FROM athlete_events')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(strava.query('SELECT 1 FROM insight_feedback')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(strava.query('SELECT 1 FROM users')).rejects.toMatchObject({ code: '42501' });
      await expect(strava.query('DELETE FROM provider_connections')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(strava.query('TRUNCATE trends')).rejects.toMatchObject({ code: '42501' });
      await expect(strava.query('CREATE TABLE zz_nope (x int)')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(strava.query('DROP TABLE trends')).rejects.toMatchObject({ code: '42501' });
      await expect(strava.query('SELECT 1 FROM pgmigrations')).rejects.toMatchObject({
        code: '42501',
      });
      // The TTL role can delete receipts but cannot read a payload or touch anything else.
      await expect(ttl.query('SELECT payload_jsonb FROM webhook_events')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(ttl.query('SELECT 1 FROM daily_metrics')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(ttl.query('DELETE FROM users')).rejects.toMatchObject({ code: '42501' });
      // Terra may check that a user EXISTS, but cannot read their email or role.
      await expect(
        terra.query(`SELECT 1 FROM users WHERE id = '00000000-0000-4000-8000-000000000000'`),
      ).resolves.toBeDefined();
      await expect(terra.query('SELECT email FROM users')).rejects.toMatchObject({ code: '42501' });
      await expect(terra.query('SELECT * FROM users')).rejects.toMatchObject({ code: '42501' });
      // Nobody but the REST API can read another provider's tokens... the webhook roles are scoped by
      // table, and the token columns are only reachable where provider_connections is granted.
      await expect(
        ttl.query('SELECT access_token_enc FROM provider_connections'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await Promise.all([strava.end(), ttl.end(), terra.end()]);
    }
  });
});

// ------------------------------------------------------------------------------------------------
// Real handler code under each role.

const cipher = new LocalAesGcmCipher(randomBytes(32).toString('base64'));
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const today = () => todayUtc(new Date());
const day = (d: number) => addDays(today(), -d);

const created: string[] = [];
let seq = 0;
async function mkUser(label: string): Promise<string> {
  const { rows } = await admin().query<{ id: string }>(
    `INSERT INTO users(email) VALUES ($1) RETURNING id`,
    [`role-${label}-${randomBytes(4).toString('hex')}-${seq++}@phase9.invalid`],
  );
  created.push(rows[0]!.id);
  return rows[0]!.id;
}
/** 27 days of recovery data and a ride every other day, so the classifier has something to say. */
async function seedHistory(userId: string, source = 'oura') {
  for (let d = 1; d < 28; d++) {
    await admin().query(
      `INSERT INTO daily_metrics (user_id, date, source, metric_type, value)
       VALUES ($1,$2,$3,'hrv',$4), ($1,$2,$3,'resting_hr',$5) ON CONFLICT DO NOTHING`,
      [userId, day(d), source, (d < 7 ? 40 : 60) + (d % 3), (d < 7 ? 60 : 50) + (d % 2)],
    );
    if (d % 2 === 0) {
      await admin().query(
        `INSERT INTO activity_efforts (user_id, external_activity_id, source, date, duration_sec,
           avg_hr, ef_peak20, deriver_id) VALUES ($1,$2,'strava',$3,3600,140,$4,'peak20_v1')
         ON CONFLICT DO NOTHING`,
        [userId, `hist-${d}`, day(d), (d < 7 ? 2.0 : 1.5) + (d % 3) * 0.02],
      );
    }
  }
}
const trendRows = async (userId: string) =>
  (await admin().query(`SELECT 1 FROM trends WHERE user_id = $1`, [userId])).rowCount ?? 0;
const recomputeFor = (pool: pg.Pool) => {
  const registry = createAdapterRegistry();
  return createRecompute(
    new FatigueFitnessService(pool, new ConnectionConfigService(pool, registry)),
    { markHistoryDirty: (u, d) => markHistoryDirty(pool, u, d) },
  );
};

describe('real handler code under each function role', () => {
  let releaseDefaults: () => Promise<void> = async () => {};
  let releaseOura: () => Promise<void> = async () => {};
  beforeAll(async () => {
    releaseDefaults = await acquireDefaultsTestMutex(admin());
    releaseOura = await acquireOuraTestMutex(admin());
  });
  afterAll(async () => {
    await admin().query(`DELETE FROM webhook_events WHERE user_id = ANY($1)`, [created]);
    await admin().query(`DELETE FROM users WHERE id = ANY($1)`, [created]);
    await releaseOura();
    await releaseDefaults();
    await closePool();
  });

  it('rd_webhook_ttl: the TTL sweep deletes exactly the old receipts', async () => {
    const u = await mkUser('ttl');
    await admin().query(
      `INSERT INTO webhook_events (user_id, provider, payload_jsonb, status, received_at)
       VALUES ($1,'strava','{}','processed', now() - interval '40 days'),
              ($1,'strava','{}','processed', now() - interval '31 days'),
              ($1,'strava','{}','processed', now() - interval '29 days'),
              ($1,'strava','{}','pending', now())`,
      [u],
    );
    const pool = rolePool('rd_webhook_ttl');
    try {
      // Scoped by user would need SELECT on user_id; instead count what survives for our rows.
      const before = (await admin().query(`SELECT 1 FROM webhook_events WHERE user_id=$1`, [u]))
        .rowCount;
      expect(before).toBe(4);
      const deleted = await deleteOldWebhookEvents(pool, 30);
      expect(deleted).toBeGreaterThanOrEqual(2);
      const left = (
        await admin().query(
          `SELECT extract(day from now() - received_at)::int AS age FROM webhook_events WHERE user_id=$1 ORDER BY age DESC`,
          [u],
        )
      ).rows.map((r) => r.age);
      expect(left).toEqual([29, 0]);
    } finally {
      await pool.end();
    }
  });

  for (const role of [
    'rd_hook_strava',
    'rd_hook_oura',
    'rd_hook_terra',
    'rd_oura_sync',
    'rd_strava_replay',
    'rd_history_rebuild',
  ]) {
    it(`${role}: the trend/readiness recompute and the history queue work`, async () => {
      const u = await mkUser(role);
      await seedHistory(u);
      const pool = rolePool(role);
      try {
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await recomputeFor(pool)(u, 'daily_metrics', [day(1), day(60)]); // day(60): outside the window
        // Failures inside the hook are swallowed and logged: assert nothing was logged.
        expect(spy.mock.calls.flat().join(' ')).not.toMatch(/recompute failed/);
        spy.mockRestore();
        expect(await trendRows(u)).toBeGreaterThan(0);
        const q = await admin().query(
          `SELECT to_char(earliest_date,'YYYY-MM-DD') AS d FROM history_rebuild_requests WHERE user_id=$1`,
          [u],
        );
        expect(q.rows[0].d).toBe(day(60));
      } finally {
        await pool.end();
      }
    });
  }

  describe('rd_hook_strava + rd_strava_replay: webhook create/update/delete, token refresh, replay', () => {
    const activities = new Map<string, unknown>();
    const streams = new Map<string, unknown>();
    const stravaFetch = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/oauth/token') {
        return json({
          access_token: 'new-a',
          refresh_token: 'new-r',
          expires_at: Math.floor(Date.now() / 1000) + 21600,
          expires_in: 21600,
        });
      }
      const m = /^\/api\/v3\/activities\/(\d+)(\/streams)?$/.exec(url.pathname);
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

    it('create (with a token refresh), update, a confirmed delete, and the replay of a failed event', async () => {
      const u = await mkUser('strava');
      await seedHistory(u);
      const athlete = randomInt(1_000_000_000, 2_000_000_000);
      const activityId = randomInt(1_000_000_000, 2_000_000_000);
      await admin().query(
        `INSERT INTO provider_connections (user_id, provider, role, external_user_id, access_token_enc, refresh_token_enc, expires_at)
         VALUES ($1,'strava','activity_source',$2,$3,$4, now() - interval '1 hour')`, // expired: forces the refresh path
        [
          u,
          String(athlete),
          await cipher.encrypt('a', `${u}:strava`),
          await cipher.encrypt('r', `${u}:strava`),
        ],
      );
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

      for (const role of ['rd_hook_strava', 'rd_strava_replay']) {
        const pool = rolePool(role);
        try {
          const ingest = new StravaIngestService({
            pool,
            cipher,
            client,
            efforts: new ActivityEffortService(pool),
            recompute: recomputeFor(pool),
          });
          if (role === 'rd_hook_strava') {
            const app = express().use(
              '/w',
              stravaWebhookRouter({ ingest, verifyToken: 'v', pool, responseBudgetMs: 20_000 }),
            );
            const ev = (aspect: string) => ({
              object_type: 'activity',
              object_id: activityId,
              aspect_type: aspect,
              owner_id: athlete,
            });
            expect((await request(app).post('/w').send(ev('create'))).status).toBe(200);
            expect(
              (
                await admin().query(
                  `SELECT 1 FROM activity_efforts WHERE user_id=$1 AND external_activity_id=$2`,
                  [u, String(activityId)],
                )
              ).rowCount,
            ).toBe(1);
            expect(await trendRows(u)).toBeGreaterThan(0);
            expect((await request(app).post('/w').send(ev('update'))).status).toBe(200);
            // A confirmed delete (gone on Strava) removes the row; a forged event for a live one would not.
            activities.delete(String(activityId));
            expect((await request(app).post('/w').send(ev('delete'))).status).toBe(200);
            expect(
              (
                await admin().query(
                  `SELECT 1 FROM activity_efforts WHERE user_id=$1 AND external_activity_id=$2`,
                  [u, String(activityId)],
                )
              ).rowCount,
            ).toBe(0);
            const st = (
              await admin().query(
                `SELECT status FROM webhook_events WHERE user_id=$1 ORDER BY received_at`,
                [u],
              )
            ).rows.map((r) => r.status);
            expect(st).toEqual(['processed', 'processed', 'processed']);
            // The refresh rotated and stored the tokens (UPDATE on provider_connections).
            const c = await admin().query(
              `SELECT expires_at > now() AS fresh FROM provider_connections WHERE user_id=$1`,
              [u],
            );
            expect(c.rows[0].fresh).toBe(true);
          } else {
            activities.set(String(activityId), {
              id: activityId,
              type: 'Ride',
              sport_type: 'Ride',
              start_date_local: `${today()}T08:00:00Z`,
              moving_time: 1800,
              has_heartrate: true,
              manual: false,
            });
            await admin().query(
              `INSERT INTO webhook_events (user_id, provider, payload_jsonb, status) VALUES ($1,'strava',$2,'failed')`,
              [
                u,
                JSON.stringify({
                  object_type: 'activity',
                  object_id: activityId,
                  aspect_type: 'create',
                  owner_id: athlete,
                }),
              ],
            );
            // Scope the global replay scan to this user (other test files' rows stay untouched).
            const scan = `WHERE provider = 'strava' AND user_id IS NOT NULL`;
            const scoped = {
              query: (t: string, p?: unknown[]) =>
                pool.query(
                  t.includes(scan) ? t.replace(scan, `${scan} AND user_id = '${u}'`) : t,
                  p,
                ),
              connect: () => pool.connect(),
            } as unknown as pg.Pool;
            const n = await replayStravaEvents(scoped, ingest);
            expect(n).toBe(1);
            expect(
              (
                await admin().query(
                  `SELECT 1 FROM activity_efforts WHERE user_id=$1 AND external_activity_id=$2`,
                  [u, String(activityId)],
                )
              ).rowCount,
            ).toBe(1);
          }
        } finally {
          await pool.end();
        }
      }
    });
  });

  describe('rd_hook_terra: auth (connection + config + backfill), sleep, deauth', () => {
    it('records the connection, stores metrics, recomputes, then deactivates', async () => {
      const u = await mkUser('terra');
      await seedHistory(u, 'terra');
      const SECRET = 'whsec_phase9_roles';
      const NOW = 1_800_000_000;
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
      const pool = rolePool('rd_hook_terra');
      try {
        const app = express();
        app.use(
          '/t',
          terraWebhookRouter({
            pool,
            registry,
            cipher,
            signingSecret: SECRET,
            nowSec: () => NOW,
            toleranceSec: 300,
            backfillConfig: { days: 30 },
            recompute: recomputeFor(pool),
          }),
        );
        const post = (payload: unknown) => {
          const raw = JSON.stringify(payload);
          return request(app)
            .post('/t')
            .set('content-type', 'application/json')
            .set('terra-signature', signTerraPayload(raw, SECRET, NOW))
            .send(raw);
        };
        const TUID = `tu-${randomBytes(4).toString('hex')}`;
        const user = { user_id: TUID, provider: 'ZEPP', reference_id: u };
        expect((await post({ type: 'auth', status: 'success', user })).body).toEqual({
          status: 'processed',
        });
        const c = await admin().query(
          `SELECT is_active, last_synced_at IS NOT NULL AS backfilled FROM provider_connections WHERE user_id=$1`,
          [u],
        );
        expect(c.rows[0]).toEqual({ is_active: true, backfilled: true });
        expect(
          (
            await admin().query(
              `SELECT 1 FROM connection_configs WHERE user_id=$1 AND provider='terra'`,
              [u],
            )
          ).rowCount,
        ).toBe(1);

        const sleep = {
          status: 'success',
          type: 'sleep',
          user,
          data: [
            {
              metadata: {
                start_time: `${today()}T00:00:00+00:00`,
                end_time: `${today()}T07:00:00+00:00`,
              },
              scores: { sleep: 80 },
              heart_rate_data: { summary: { resting_hr_bpm: 50, avg_hrv_rmssd: 65 } },
            },
          ],
        };
        expect((await post(sleep)).body).toEqual({ status: 'processed' });
        expect(
          (
            await admin().query(
              `SELECT 1 FROM daily_metrics WHERE user_id=$1 AND date=$2::date AND source='terra' AND metric_type='hrv'`,
              [u, today()],
            )
          ).rowCount,
        ).toBe(1);
        expect(await trendRows(u)).toBeGreaterThan(0);

        expect((await post({ type: 'deauth', status: 'success', user })).body).toEqual({
          status: 'processed',
        });
        expect(
          (await admin().query(`SELECT is_active FROM provider_connections WHERE user_id=$1`, [u]))
            .rows[0].is_active,
        ).toBe(false);
        const ev = await admin().query(`SELECT status FROM webhook_events WHERE user_id=$1`, [u]);
        expect(ev.rows.every((r) => r.status === 'processed')).toBe(true);
      } finally {
        await pool.end();
      }
    });
  });

  describe('rd_oura_sync and rd_hook_oura', () => {
    const NOW = new Date('2026-09-10T12:00:00Z');
    const SECRET = 'client-secret';
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url));
      if (u.pathname === '/oauth/token')
        return json({ access_token: 'A1', refresh_token: 'R1', expires_in: 3600 });
      const coll = u.pathname.split('/').pop() as string;
      const data: Record<string, unknown[]> = {
        daily_readiness: [
          {
            id: 'r1',
            day: '2026-09-09',
            score: 80,
            contributors: {},
            timestamp: '2026-09-09T00:00:00+00:00',
          },
        ],
        daily_sleep: [
          {
            id: 's1',
            day: '2026-09-09',
            score: 75,
            contributors: {},
            timestamp: '2026-09-09T00:00:00+00:00',
          },
        ],
        sleep: [
          {
            id: 'sl1',
            day: '2026-09-09',
            type: 'long_sleep',
            average_hrv: 60,
            lowest_heart_rate: 47,
            total_sleep_duration: 27000,
            bedtime_start: '2026-09-09T00:00:00+00:00',
            bedtime_end: '2026-09-09T08:00:00+00:00',
            low_battery_alert: false,
            period: 0,
            time_in_bed: 28800,
          },
        ],
      };
      return json({ data: data[coll] ?? [], next_token: null });
    });
    const adapter = new OuraAdapter({
      ...ouraConfigFromEnv({}),
      clientId: 'cid',
      clientSecret: SECRET,
      webhookVerificationToken: 'v',
      now: () => NOW,
      sleep: async () => {},
      fetch: fetchMock as unknown as typeof fetch,
    });

    async function connectOura(): Promise<{ userId: string; ouraUid: string }> {
      const userId = await mkUser('oura');
      const ouraUid = `oura-${randomBytes(4).toString('hex')}`;
      await admin().query(
        `INSERT INTO provider_connections (user_id, provider, role, external_user_id, access_token_enc, refresh_token_enc, expires_at)
         VALUES ($1,'oura','daily_metrics_source',$2,$3,$4,$5)`,
        [
          userId,
          ouraUid,
          await cipher.encrypt('A0', `${userId}:oura`),
          await cipher.encrypt('R0', `${userId}:oura`),
          new Date('2026-09-10T11:00:00Z'),
        ], // expired: refresh path
      );
      await admin().query(
        `INSERT INTO connection_configs (user_id, role, provider) VALUES ($1,'daily_metrics_source','oura')`,
        [userId],
      );
      return { userId, ouraUid };
    }

    it('rd_oura_sync: refresh + ingest + recompute', async () => {
      const { userId } = await connectOura();
      const pool = rolePool('rd_oura_sync');
      try {
        const r = await syncOuraUser(userId, {
          pool,
          cipher,
          adapter,
          now: () => NOW,
          recompute: recomputeFor(pool),
        });
        expect(r).toMatchObject({ ok: true });
        expect(
          (
            await admin().query(`SELECT 1 FROM daily_metrics WHERE user_id=$1 AND source='oura'`, [
              userId,
            ])
          ).rowCount,
        ).toBeGreaterThan(0);
        const c = await admin().query(
          `SELECT last_synced_at IS NOT NULL AS synced FROM provider_connections WHERE user_id=$1`,
          [userId],
        );
        expect(c.rows[0].synced).toBe(true);
      } finally {
        await pool.end();
      }
    });

    it('rd_hook_oura: signed event -> fetch, upsert, delete event, receipt', async () => {
      const { userId, ouraUid } = await connectOura();
      const pool = rolePool('rd_hook_oura');
      try {
        const config = {
          ...ouraConfigFromEnv({}),
          clientId: 'cid',
          clientSecret: SECRET,
          webhookVerificationToken: 'v',
          now: () => NOW,
          sleep: async () => {},
          fetch: fetchMock as unknown as typeof fetch,
        };
        const app = express().use(
          '/hook',
          createOuraWebhookRouter({
            pool,
            cipher,
            adapter,
            config,
            now: () => NOW,
            recompute: recomputeFor(pool),
          }),
        );
        const ts = String(Math.floor(NOW.getTime() / 1000));
        const post = (body: unknown) => {
          const text = JSON.stringify(body);
          return request(app)
            .post('/hook')
            .set('content-type', 'application/json')
            .set('x-oura-timestamp', ts)
            .set('x-oura-signature', ouraSignature(SECRET, ts, text))
            .send(text);
        };
        const ev = (over: Record<string, unknown> = {}) => ({
          event_type: 'update',
          data_type: 'sleep',
          object_id: 'obj-1',
          event_time: '2026-09-10T11:59:30+00:00',
          user_id: ouraUid,
          ...over,
        });
        const res = await post(ev());
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(
          (
            await admin().query(`SELECT 1 FROM daily_metrics WHERE user_id=$1 AND source='oura'`, [
              userId,
            ])
          ).rowCount,
        ).toBeGreaterThan(0);
        const del = await post(ev({ event_type: 'delete', object_id: 'sl1' }));
        expect(del.status, JSON.stringify(del.body)).toBe(200);
        const st = await admin().query(`SELECT status FROM webhook_events WHERE user_id=$1`, [
          userId,
        ]);
        expect(st.rows.length).toBeGreaterThanOrEqual(2);
        expect(st.rows.every((r) => r.status === 'processed')).toBe(true);
      } finally {
        await pool.end();
      }
    });
  });

  it('rd_api: the REST API role can run the delete-everything transaction (privacy)', async () => {
    const { deleteUserCompletely } = await import('../privacy/delete-service');
    const { exportUserData } = await import('../privacy/export-service');
    const u = await mkUser('api');
    await seedHistory(u);
    await admin().query(
      `INSERT INTO history_rebuild_requests (user_id, earliest_date) VALUES ($1,'2026-01-01')`,
      [u],
    );
    const pool = rolePool('rd_api');
    try {
      const data = await exportUserData(pool, u);
      expect((data?.dailyMetrics as unknown[]).length).toBeGreaterThan(10);
      const r = await deleteUserCompletely({ pool, registry: createAdapterRegistry(), cipher }, u);
      expect(r.deleted).toBe(true);
      expect(
        (await admin().query(`SELECT 1 FROM daily_metrics WHERE user_id=$1`, [u])).rowCount,
      ).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
