import { randomBytes } from 'node:crypto';
import { createAdapterRegistry } from '@rd/provider-adapters';
import type { NormalizedActivityEffort, NormalizedDailyMetric } from '@rd/shared-types';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signApiToken } from '../auth/token';
import { signOAuthState } from '../crypto/oauth-state';
import { LocalAesGcmCipher } from '../crypto/token-cipher';
import { FakeAdapter } from '../sync/fake-adapter';
import { SyncService } from '../sync/sync-service';
import { closePool, getPool } from '../users/pool';
import { ConnectionConfigService } from './config-service';
import { ConnectionService } from './connection-service';
import { connectionsRouter } from './routes';

// Needs migrated local Postgres: docker compose up -d db && pnpm db:migrate. No network: the
// only adapters are in-memory fakes. Provider keys must satisfy the PLAN §7 CHECK, so the fakes
// reuse 'oura' / 'terra' / 'strava' keys inside a test-local registry.
process.env.NEXTAUTH_SECRET = 'test-secret-test-secret-test-secret';

const pool = () => getPool();
const secret = randomBytes(32);
const cipher = new LocalAesGcmCipher(randomBytes(32).toString('base64'));
const nowSec = () => Math.floor(Date.now() / 1000);
const bearer = (id: string) =>
  `Bearer ${signApiToken({ userId: id, role: 'user' }, { nowSec: nowSec() })}`;

const metric = (date: string, metricType: NormalizedDailyMetric['metricType'], value: number) =>
  ({ date, metricType, value }) as unknown as NormalizedDailyMetric;
const effort = (id: string, avgHr: number) =>
  ({
    externalActivityId: id,
    date: '2026-03-01',
    durationSec: 3600,
    avgHr,
    avgPower: 200,
  }) as unknown as NormalizedActivityEffort;

describe('connection framework', () => {
  const oura = new FakeAdapter<NormalizedDailyMetric>('oura', 'daily_metrics_source');
  const terra = new FakeAdapter<NormalizedDailyMetric>('terra', 'daily_metrics_source');
  const strava = new FakeAdapter<NormalizedActivityEffort>('strava', 'activity_source');
  const registry = createAdapterRegistry();
  registry.register(oura);
  registry.register(terra);
  registry.register(strava);

  const configs = new ConnectionConfigService(pool(), registry);
  const conns = new ConnectionService(pool(), registry, cipher, configs);
  const sync = new SyncService(pool(), registry, cipher);

  const app = express();
  app.use(express.json());
  app.use(
    '/connections',
    connectionsRouter({ pool: pool(), registry, cipher, stateSecret: secret }),
  );

  let a: string;
  let b: string;
  const created: string[] = [];

  const mkUser = async (tag: string) => {
    const { rows } = await pool().query<{ id: string }>(
      `INSERT INTO users(email) VALUES ($1) RETURNING id`,
      [`${tag}-${randomBytes(4).toString('hex')}@phase2.invalid`],
    );
    created.push(rows[0]!.id);
    return rows[0]!.id;
  };
  const count = async (table: string, userId: string, extra = '') =>
    (
      await pool().query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1 ${extra}`, [
        userId,
      ])
    ).rows[0].n as number;

  beforeAll(async () => {
    a = await mkUser('a');
    b = await mkUser('b');
  });
  beforeEach(async () => {
    await pool().query('DELETE FROM daily_metrics WHERE user_id = ANY($1)', [[a, b]]);
    await pool().query('DELETE FROM activity_efforts WHERE user_id = ANY($1)', [[a, b]]);
    await pool().query('DELETE FROM connection_configs WHERE user_id = ANY($1)', [[a, b]]);
    await pool().query('DELETE FROM provider_connections WHERE user_id = ANY($1)', [[a, b]]);
    oura.fetchCalls = [];
  });
  afterAll(async () => {
    await pool().query('DELETE FROM users WHERE id = ANY($1)', [created]); // cascades
    await closePool();
  });

  describe('ConnectionConfigService', () => {
    it('only one activity source: setting a second replaces the first', async () => {
      await configs.setActivitySource(a, 'strava');
      await configs.setActivitySource(a, 'strava');
      expect((await configs.getConfig(a)).activitySource).toBe('strava');
      expect(await count('connection_configs', a, `AND role='activity_source'`)).toBe(1);
    });

    it('the DB itself rejects a second activity source row', async () => {
      await pool().query(
        `INSERT INTO connection_configs(user_id, role, provider) VALUES ($1,'activity_source','strava')`,
        [a],
      );
      await expect(
        pool().query(
          `INSERT INTO connection_configs(user_id, role, provider) VALUES ($1,'activity_source','garmin')`,
          [a],
        ),
      ).rejects.toThrow(/uq_connection_configs_one_activity_source/);
    });

    it('rejects providers registered for the other role or not registered', async () => {
      await expect(configs.setActivitySource(a, 'oura')).rejects.toThrow(/not an activity source/);
      await expect(configs.setActivitySource(a, 'garmin')).rejects.toThrow();
      await expect(configs.setDailyMetricsSources(a, ['strava'])).rejects.toThrow(
        /not a daily-metrics/,
      );
      await expect(configs.setDailyMetricsSources(a, ['oura', 'oura'])).rejects.toThrow(
        /duplicate/,
      );
      expect(await count('connection_configs', a)).toBe(0);
    });

    it('stores ordered daily sources as priority and can clear the activity source', async () => {
      await configs.setDailyMetricsSources(a, ['terra', 'oura']);
      expect((await configs.getConfig(a)).dailyMetricsSources).toEqual(['terra', 'oura']);
      await configs.setDailyMetricsSources(a, ['oura']);
      expect((await configs.getConfig(a)).dailyMetricsSources).toEqual(['oura']);
      await configs.setActivitySource(a, 'strava');
      await configs.setActivitySource(a, null);
      expect((await configs.getConfig(a)).activitySource).toBeNull();
    });

    it('precedence defaults to Oura-first and is overridable; resolved metrics follow it', async () => {
      await pool().query(
        `INSERT INTO daily_metrics(user_id,date,source,metric_type,value) VALUES
           ($1,'2026-03-01','oura','hrv',60), ($1,'2026-03-01','terra','hrv',50),
           ($1,'2026-03-02','terra','hrv',55)`,
        [a],
      );
      expect((await configs.getPrecedence(a)).hrv).toEqual(['oura', 'terra']);
      let res = await configs.getResolvedDailyMetrics(a, '2026-03-01', '2026-03-31');
      expect(res).toEqual([
        { date: '2026-03-01', metricType: 'hrv', source: 'oura', value: 60 },
        { date: '2026-03-02', metricType: 'hrv', source: 'terra', value: 55 }, // fallback
      ]);
      await configs.setDailyMetricsSources(a, ['terra', 'oura']);
      expect((await configs.getPrecedence(a)).hrv).toEqual(['terra', 'oura']);
      res = await configs.getResolvedDailyMetrics(a, '2026-03-01', '2026-03-31');
      expect(res[0]).toMatchObject({ source: 'terra', value: 50 });
    });
  });

  describe('SyncService', () => {
    const connect = async (userId: string) => {
      await conns.saveGrant(userId, 'oura', 'daily_metrics_source', { accessToken: 'tok' });
      await conns.saveGrant(userId, 'strava', 'activity_source', { accessToken: 'tok2' });
    };

    it('upsert run twice = one row, value updated, identity forced to adapter/user', async () => {
      await connect(a);
      const mk = () => [metric('2026-03-01', 'hrv', 60), metric('2026-03-01', 'hrv', 61)]; // in-batch dup too
      oura.enqueue(mk());
      await sync.syncUser(a);
      oura.enqueue([metric('2026-03-01', 'hrv', 65)]);
      const r = (await sync.syncUser(a)).find((x) => x.provider === 'oura');
      expect(r).toMatchObject({ ok: true, provider: 'oura', dailyMetrics: 1 });
      const { rows } = await pool().query(
        `SELECT source, value::float AS value FROM daily_metrics WHERE user_id=$1`,
        [a],
      );
      expect(rows).toEqual([{ source: 'oura', value: 65 }]);
    });

    it('activity efforts are idempotent on external_activity_id and reset ef columns', async () => {
      await connect(a);
      strava.enqueue([effort('x1', 140)]);
      await sync.syncUser(a);
      await pool().query(`UPDATE activity_efforts SET ef_overall = 1.5 WHERE user_id=$1`, [a]);
      strava.enqueue([effort('x1', 150)]);
      await sync.syncUser(a);
      const { rows } = await pool().query(
        `SELECT avg_hr::float AS avg_hr, ef_overall, source FROM activity_efforts WHERE user_id=$1`,
        [a],
      );
      expect(rows).toEqual([{ avg_hr: 150, ef_overall: null, source: 'strava' }]);
    });

    it('only syncs configured, active connections and records last_synced_at + since', async () => {
      await pool().query(
        `INSERT INTO provider_connections(user_id,provider,role,access_token_enc)
         VALUES ($1,'terra','daily_metrics_source',NULL)`,
        [a],
      ); // connected but not in connection_configs => not synced
      await connect(a);
      oura.enqueue([metric('2026-03-01', 'hrv', 60)]);
      const first = await sync.syncUser(a);
      expect(first.map((r) => r.provider).sort()).toEqual(['oura', 'strava']);
      expect(oura.fetchCalls[0]).toMatchObject({ accessToken: 'tok', since: null });
      await sync.syncUser(a);
      expect(oura.fetchCalls[1]?.since).toBeInstanceOf(Date);
      await pool().query(`UPDATE provider_connections SET is_active=false WHERE user_id=$1`, [a]);
      expect(await sync.syncUser(a)).toEqual([]);
    });

    it('isolates a failing provider and returns no payload details', async () => {
      await connect(a);
      oura.enqueue([{ date: 'not-a-date', metricType: 'hrv', value: 1 }]);
      const res = await sync.syncUser(a);
      expect(res.find((r) => r.provider === 'oura')).toMatchObject({ ok: false });
      expect(JSON.stringify(res)).not.toMatch(/not-a-date/);
      expect(res.find((r) => r.provider === 'strava')?.ok).toBe(true);
      expect(await count('daily_metrics', a)).toBe(0);
    });

    it('syncAll covers every user with config', async () => {
      await connect(a);
      await connect(b);
      oura.enqueue([metric('2026-03-01', 'hrv', 1)]).enqueue([metric('2026-03-01', 'hrv', 2)]);
      const all = await sync.syncAll();
      expect(all.has(a) && all.has(b)).toBe(true);
      expect(await count('daily_metrics', a)).toBe(1);
      expect(await count('daily_metrics', b)).toBe(1);
    });
  });

  describe('disconnect', () => {
    it("deletes tokens, config and ONLY that provider's derived rows, only for that user", async () => {
      for (const u of [a, b]) {
        await conns.saveGrant(u, 'oura', 'daily_metrics_source', { accessToken: 't' });
        await conns.saveGrant(u, 'terra', 'daily_metrics_source', { accessToken: 't' });
        await pool().query(
          `INSERT INTO daily_metrics(user_id,date,source,metric_type,value) VALUES
             ($1,'2026-03-01','oura','hrv',60), ($1,'2026-03-01','terra','hrv',50)`,
          [u],
        );
      }
      await conns.saveGrant(a, 'strava', 'activity_source', { accessToken: 't' });
      await pool().query(
        `INSERT INTO activity_efforts(user_id,external_activity_id,source,date,duration_sec,avg_hr)
         VALUES ($1,'e1','strava','2026-03-01',3600,140)`,
        [a],
      );

      await conns.disconnect(a, 'oura');
      expect(await count('provider_connections', a, `AND provider='oura'`)).toBe(0);
      expect(await count('connection_configs', a, `AND provider='oura'`)).toBe(0);
      expect(await count('daily_metrics', a, `AND source='oura'`)).toBe(0);
      expect(await count('daily_metrics', a, `AND source='terra'`)).toBe(1);
      expect(await count('provider_connections', b, `AND provider='oura'`)).toBe(1);
      expect(await count('daily_metrics', b, `AND source='oura'`)).toBe(1);

      await conns.disconnect(a, 'strava');
      expect(await count('activity_efforts', a)).toBe(0);
      await conns.disconnect(a, 'strava'); // idempotent
    });
  });

  describe('routes + authorization', () => {
    it('401 without a token on every route', async () => {
      await request(app).get('/connections/config').expect(401);
      await request(app).put('/connections/config').send({}).expect(401);
      await request(app).post('/connections/oura/start').expect(401);
      await request(app).get('/connections/oura/callback').expect(401);
      await request(app).delete('/connections/oura').expect(401);
    });

    it('start dispatches to the adapter with a signed state; unknown provider is 404', async () => {
      const res = await request(app)
        .post('/connections/oura/start')
        .set('Authorization', bearer(a))
        .expect(200);
      expect(res.body.redirectUrl).toMatch(/^https:\/\/fake\.invalid\/oura\/authorize\?state=/);
      await request(app)
        .post('/connections/garmin/start')
        .set('Authorization', bearer(a))
        .expect(404);
      await request(app)
        .post('/connections/config/start')
        .set('Authorization', bearer(a))
        .expect(404);
    });

    it('callback rejects missing/foreign/expired state, then stores encrypted tokens + config', async () => {
      const auth = { Authorization: bearer(a) };
      await request(app).get('/connections/oura/callback?code=c').set(auth).expect(400);
      const foreign = signOAuthState({ userId: b, provider: 'oura', nowSec: nowSec() }, secret);
      await request(app)
        .get(`/connections/oura/callback?code=c&state=${foreign}`)
        .set(auth)
        .expect(400);
      const wrongProvider = signOAuthState(
        { userId: a, provider: 'terra', nowSec: nowSec() },
        secret,
      );
      await request(app)
        .get(`/connections/oura/callback?code=c&state=${wrongProvider}`)
        .set(auth)
        .expect(400);
      const expired = signOAuthState(
        { userId: a, provider: 'oura', nowSec: nowSec() - 3600 },
        secret,
      );
      await request(app)
        .get(`/connections/oura/callback?code=c&state=${expired}`)
        .set(auth)
        .expect(400);

      const start = await request(app).post('/connections/oura/start').set(auth);
      const state = new URL(start.body.redirectUrl).searchParams.get('state')!;
      const ok = await request(app)
        .get(`/connections/oura/callback?code=c1&state=${state}`)
        .set(auth)
        .expect(200);
      expect(ok.body.connection).toMatchObject({
        provider: 'oura',
        role: 'daily_metrics_source',
        externalUserId: 'ext-c1',
      });
      expect(JSON.stringify(ok.body)).not.toMatch(/fake-access|token/i);

      const { rows } = await pool().query(
        `SELECT access_token_enc FROM provider_connections WHERE user_id=$1 AND provider='oura'`,
        [a],
      );
      const enc = rows[0].access_token_enc as Buffer;
      expect(enc.includes(Buffer.from('fake-access-oura'))).toBe(false);
      expect(await cipher.decrypt(enc, `${a}:oura`)).toBe('fake-access-oura');
      expect((await configs.getConfig(a)).dailyMetricsSources).toEqual(['oura']);

      // reconnecting is idempotent: still one connection row
      await request(app)
        .get(`/connections/oura/callback?code=c2&state=${state}`)
        .set(auth)
        .expect(200);
      expect(await count('provider_connections', a)).toBe(1);
    });

    it('a user cannot read or change another user’s connections, config or data', async () => {
      await conns.saveGrant(a, 'oura', 'daily_metrics_source', { accessToken: 't' });
      await configs.setActivitySource(a, 'strava');
      await pool().query(
        `INSERT INTO daily_metrics(user_id,date,source,metric_type,value) VALUES ($1,'2026-03-01','oura','hrv',60)`,
        [a],
      );

      const asB = await request(app)
        .get('/connections/config')
        .set('Authorization', bearer(b))
        .expect(200);
      expect(asB.body.connections).toEqual([]);
      expect(asB.body.config).toEqual({ activitySource: null, dailyMetricsSources: [] });
      const asA = await request(app)
        .get('/connections/config')
        .set('Authorization', bearer(a))
        .expect(200);
      expect(asA.body.connections).toHaveLength(1);
      expect(asA.body.connections[0].userId).toBe(a);
      expect(JSON.stringify(asA.body)).not.toMatch(/_enc/);

      // B "disconnecting oura" and "changing config" only ever touches B's own rows.
      await request(app).delete('/connections/oura').set('Authorization', bearer(b)).expect(204);
      await request(app)
        .put('/connections/config')
        .set('Authorization', bearer(b))
        .send({ activitySource: null })
        .expect(200);
      expect(await count('provider_connections', a)).toBe(1);
      expect(await count('daily_metrics', a)).toBe(1);
      expect((await configs.getConfig(a)).activitySource).toBe('strava');

      // client-supplied user ids are ignored
      await request(app)
        .put('/connections/config')
        .set('Authorization', bearer(b))
        .send({ userId: a, dailyMetricsSources: ['terra'] })
        .expect(200);
      // A's config is untouched (still just the auto-added 'oura' from connecting), B's changed.
      expect((await configs.getConfig(a)).dailyMetricsSources).toEqual(['oura']);
      expect((await configs.getConfig(b)).dailyMetricsSources).toEqual(['terra']);
    });

    it('PUT/GET /config validates input and round-trips', async () => {
      const auth = { Authorization: bearer(a) };
      await request(app).put('/connections/config').set(auth).send({}).expect(400);
      await request(app)
        .put('/connections/config')
        .set(auth)
        .send({ activitySource: 5 })
        .expect(400);
      await request(app)
        .put('/connections/config')
        .set(auth)
        .send({ dailyMetricsSources: ['strava'] })
        .expect(400);
      const put = await request(app)
        .put('/connections/config')
        .set(auth)
        .send({ activitySource: 'strava', dailyMetricsSources: ['terra', 'oura'] })
        .expect(200);
      expect(put.body.config).toEqual({
        activitySource: 'strava',
        dailyMetricsSources: ['terra', 'oura'],
      });
      expect(put.body.precedence.hrv).toEqual(['terra', 'oura']);
      const get = await request(app).get('/connections/config').set(auth).expect(200);
      expect(get.body.config).toEqual(put.body.config);
    });

    it('DELETE removes the connection and derived rows via the route', async () => {
      await conns.saveGrant(a, 'oura', 'daily_metrics_source', { accessToken: 't' });
      await pool().query(
        `INSERT INTO daily_metrics(user_id,date,source,metric_type,value) VALUES ($1,'2026-03-01','oura','hrv',60)`,
        [a],
      );
      await request(app).delete('/connections/oura').set('Authorization', bearer(a)).expect(204);
      expect(await count('provider_connections', a)).toBe(0);
      expect(await count('daily_metrics', a)).toBe(0);
    });
  });
});
