import { randomBytes } from 'node:crypto';
import { createAdapterRegistry } from '@rd/provider-adapters';
import { EF_QUADRANT_V1 } from '@rd/scoring-engine';
import type { NormalizedActivityEffort, NormalizedDailyMetric } from '@rd/shared-types';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signApiToken } from '../auth/token';
import { LocalAesGcmCipher } from '../crypto/token-cipher';
import { acquireDefaultsTestMutex } from '../test-utils/defaults-mutex';
import { FakeAdapter } from '../sync/fake-adapter';
import { closePool, getPool } from '../users/pool';
import { LastMasterError, deleteUserCompletely } from './delete-service';
import { exportUserData } from './export-service';
import { privacyRouter } from './routes';

// PLAN §12 per-user export/delete. Needs migrated local Postgres; provider HTTP is faked.
process.env.NEXTAUTH_SECRET = 'test-secret-test-secret-test-secret';

const tag = randomBytes(4).toString('hex');
const cipher = new LocalAesGcmCipher(randomBytes(32).toString('base64'));
const bearer = (id: string, role: 'user' | 'master') =>
  `Bearer ${signApiToken({ userId: id, role }, { nowSec: Math.floor(Date.now() / 1000) })}`;

const strava = new FakeAdapter<NormalizedActivityEffort>('strava', 'activity_source');
const oura = new FakeAdapter<NormalizedDailyMetric>('oura', 'daily_metrics_source');
const terra = new FakeAdapter<NormalizedDailyMetric>('terra', 'daily_metrics_source');
const revokeSpy = vi.fn(async (_ctx: unknown) => undefined);
Object.assign(strava, { revoke: revokeSpy });
Object.assign(oura, {
  revoke: async () => {
    throw new Error('provider down: access_token=SHOULD-NOT-LEAK');
  },
});
const registry = createAdapterRegistry();
registry.register(strava);
registry.register(oura);
registry.register(terra); // no revoke(): reported as skipped

const app = express();
app.use(express.json());
app.use('/users', privacyRouter({ pool: getPool(), registry, cipher }));

const pool = () => getPool();
const mk = async (name: string, role: 'user' | 'master' = 'user') =>
  (
    await pool().query<{ id: string }>(
      `INSERT INTO users(email, name, role) VALUES ($1,$2,$3) RETURNING id`,
      [`${name}-${tag}@phase9.invalid`, name, role],
    )
  ).rows[0]!.id;

const ACCESS = 'plain-access-token-aaaa';
const REFRESH = 'plain-refresh-token-bbbb';

/** One row in every per-user table. */
async function seed(userId: string, voter: string) {
  const ctx = (p: string) => `${userId}:${p}`;
  await pool().query(
    `INSERT INTO provider_connections (user_id, provider, role, external_user_id, access_token_enc, refresh_token_enc)
     VALUES ($1,'strava','activity_source',$2,$3,$4), ($1,'oura','daily_metrics_source',$5,$6,NULL)`,
    [
      userId,
      `ath-${userId}`,
      await cipher.encrypt(ACCESS, ctx('strava')),
      await cipher.encrypt(REFRESH, ctx('strava')),
      `oura-${userId}`,
      await cipher.encrypt('oura-access', ctx('oura')),
    ],
  );
  await pool().query(
    `INSERT INTO connection_configs (user_id, role, provider) VALUES ($1,'activity_source','strava')`,
    [userId],
  );
  await pool().query(
    `INSERT INTO daily_metrics (user_id, date, source, metric_type, value)
     VALUES ($1,'2026-03-01','oura','hrv',55), ($1,'2026-03-01','garmin-kept','resting_hr',48)`,
    [userId],
  );
  await pool().query(
    `INSERT INTO activity_efforts (user_id, external_activity_id, source, date, duration_sec, avg_hr)
     VALUES ($1,$2,'strava','2026-03-02',3600,140)`,
    [userId, `act-${userId}`],
  );
  await pool().query(
    `INSERT INTO readiness_scores (user_id, date, score, components_jsonb) VALUES ($1,'2026-03-01',70,'{}')`,
    [userId],
  );
  await pool().query(
    `INSERT INTO trends (user_id, classifier_id, as_of, metric_type, trend_window, direction)
     VALUES ($1,$2,'2026-03-01','fatigue_fitness_state','7d','steady')`,
    [userId, EF_QUADRANT_V1.id],
  );
  await pool().query(
    `INSERT INTO insight_feedback (user_id, classifier_id, as_of, state, vote, voted_by)
     VALUES ($1,$2,'2026-03-01','steady',1,$3), ($4,$2,'2026-03-01','steady',-1,$1)`,
    [userId, EF_QUADRANT_V1.id, voter, voter],
  );
  await pool().query(
    `INSERT INTO athlete_events (user_id, date, event_type, notes, created_by)
     VALUES ($1,'2026-03-03','illness','flu',$2)`,
    [userId, voter],
  );
  await pool().query(
    `INSERT INTO history_rebuild_requests (user_id, earliest_date) VALUES ($1,'2026-01-01')`,
    [userId],
  );
  await pool().query(
    `INSERT INTO webhook_events (user_id, provider, payload_jsonb, status)
     VALUES ($1,'strava','{"object_id":1}','processed')`,
    [userId],
  );
}

describe('data export and full delete (DB)', () => {
  let releaseDefaultsLock: () => Promise<void> = async () => {};
  let a: string;
  let b: string;
  let m: string;
  const created: string[] = [];

  beforeAll(async () => {
    releaseDefaultsLock = await acquireDefaultsTestMutex(pool());
  });
  afterAll(async () => {
    await pool().query('DELETE FROM users WHERE id = ANY($1)', [created]);
    await releaseDefaultsLock();
    await closePool();
  });
  afterEach(async () => {
    // Fresh users per test (the emails are reused).
    await pool().query('DELETE FROM users WHERE id = ANY($1)', [created.splice(0)]);
  });
  beforeEach(async () => {
    revokeSpy.mockClear();
    a = await mk('a');
    b = await mk('b');
    m = await mk('m', 'master');
    created.push(a, b, m);
    await seed(a, m);
    await seed(b, m);
  });

  describe('authorization', () => {
    it('a user cannot export or delete another user (403), and nothing changes', async () => {
      const ex = await request(app)
        .get(`/users/${b}/export`)
        .set('Authorization', bearer(a, 'user'));
      expect(ex.status).toBe(403);
      expect(JSON.stringify(ex.body)).not.toContain(`b-${tag}`);
      const del = await request(app)
        .delete(`/users/${b}?confirm=true`)
        .set('Authorization', bearer(a, 'user'));
      expect(del.status).toBe(403);
      expect(revokeSpy).not.toHaveBeenCalled();
      const still = await pool().query(`SELECT 1 FROM users WHERE id = $1`, [b]);
      expect(still.rowCount).toBe(1);
    });

    it('rejects unauthenticated and forged-role callers', async () => {
      expect((await request(app).get(`/users/${a}/export`)).status).toBe(401);
      expect((await request(app).delete(`/users/${a}?confirm=true`)).status).toBe(401);
      // A token that claims master for a plain user is ignored: the role is re-read from the DB.
      const forged = await request(app)
        .get(`/users/${b}/export`)
        .set('Authorization', bearer(a, 'master'));
      expect(forged.status).toBe(403);
    });

    it('a master may act on any user; unknown or malformed ids are 404, not 500', async () => {
      const ok = await request(app)
        .get(`/users/${a}/export`)
        .set('Authorization', bearer(m, 'master'));
      expect(ok.status).toBe(200);
      const none = await request(app)
        .get(`/users/00000000-0000-4000-8000-000000000000/export`)
        .set('Authorization', bearer(m, 'master'));
      expect(none.status).toBe(404);
      const bad = await request(app)
        .get(`/users/not-a-uuid/export`)
        .set('Authorization', bearer(m, 'master'));
      expect(bad.status).toBe(404);
    });
  });

  describe('export', () => {
    it('returns everything stored about the user, including kept data from a disconnected source', async () => {
      // 'garmin-kept' has no provider_connections row: history kept after disconnect (owner decision).
      const res = await request(app)
        .get(`/users/${a}/export`)
        .set('Authorization', bearer(a, 'user'));
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.user).toMatchObject({ id: a, email: `a-${tag}@phase9.invalid` });
      expect(res.body.dailyMetrics.map((r: { source: string }) => r.source).sort()).toEqual([
        'garmin-kept',
        'oura',
      ]);
      expect(res.body.dailyMetrics[0].date).toBe('2026-03-01');
      expect(res.body.activityEfforts).toHaveLength(1);
      expect(res.body.providerConnections).toHaveLength(2);
      expect(res.body.readinessScores).toHaveLength(1);
      expect(res.body.trends).toHaveLength(1);
      expect(res.body.athleteEvents[0]).toMatchObject({ notes: 'flu' });
      expect(res.body.webhookEvents).toHaveLength(1);
      expect(res.body.insightFeedbackAbout).toHaveLength(1);
      expect(res.body.insightFeedbackGiven).toHaveLength(1); // `a` voted once, on the master's insight
    });

    it('never contains token columns or token plaintext, and never another user', async () => {
      const res = await request(app)
        .get(`/users/${a}/export`)
        .set('Authorization', bearer(a, 'user'));
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/token_enc/);
      expect(text).not.toContain(ACCESS);
      expect(text).not.toContain(REFRESH);
      expect(text).not.toContain(b);
      expect(text).not.toContain(`b-${tag}`);
    });

    it("includes the votes a master cast on others' insights (their own authored data)", async () => {
      const data = await exportUserData(pool(), m);
      expect(data?.insightFeedbackGiven).toHaveLength(2);
    });

    it('covers every column of every per-user table except tokens (new columns fail here)', async () => {
      const data = (await exportUserData(pool(), a))!;
      const sections: Record<string, string> = {
        provider_connections: 'providerConnections',
        connection_configs: 'connectionConfigs',
        daily_metrics: 'dailyMetrics',
        activity_efforts: 'activityEfforts',
        readiness_scores: 'readinessScores',
        trends: 'trends',
        insight_feedback: 'insightFeedbackAbout',
        athlete_events: 'athleteEvents',
        webhook_events: 'webhookEvents',
        history_rebuild_requests: 'historyRebuildRequests',
      };
      const { rows: tables } = await pool().query<{ table_name: string }>(
        `SELECT DISTINCT c.table_name FROM information_schema.columns c
           JOIN information_schema.tables t USING (table_schema, table_name)
          WHERE c.table_schema = 'public' AND c.column_name = 'user_id' AND t.table_type = 'BASE TABLE'`,
      );
      // A per-user table nobody exported fails here with its name.
      expect(tables.map((t) => t.table_name).sort()).toEqual(Object.keys(sections).sort());
      for (const [table, section] of Object.entries(sections)) {
        const { rows: cols } = await pool().query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema='public' AND table_name=$1`,
          [table],
        );
        const want = cols
          .map((c) => c.column_name)
          .filter((c) => c !== 'user_id' && !c.endsWith('_token_enc'));
        const row = (data[section] as Record<string, unknown>[])[0]!;
        expect(Object.keys(row).sort(), `${table} -> ${section}`).toEqual(want.sort());
      }
    });
  });

  describe('delete', () => {
    it('requires explicit confirmation', async () => {
      const res = await request(app).delete(`/users/${a}`).set('Authorization', bearer(a, 'user'));
      expect(res.status).toBe(400);
      expect((await pool().query(`SELECT 1 FROM users WHERE id=$1`, [a])).rowCount).toBe(1);
    });

    it('self-delete revokes grants with the decrypted tokens, then removes every row', async () => {
      const res = await request(app)
        .delete(`/users/${a}?confirm=true`)
        .set('Authorization', bearer(a, 'user'));
      expect(res.status).toBe(200);
      // strava: revoked with plaintext tokens; oura: provider down -> failed; terra: not connected.
      expect(res.body.revoked).toEqual({ strava: 'revoked', oura: 'failed' });
      expect(revokeSpy).toHaveBeenCalledWith({
        externalUserId: `ath-${a}`,
        accessToken: ACCESS,
        refreshToken: REFRESH,
      });
      expect(JSON.stringify(res.body)).not.toContain('SHOULD-NOT-LEAK');

      // Every table that has a user_id column, discovered from the schema (new tables can't be missed).
      const { rows: tables } = await pool().query<{ table_name: string }>(
        `SELECT DISTINCT c.table_name FROM information_schema.columns c
           JOIN information_schema.tables t USING (table_schema, table_name)
          WHERE c.table_schema = 'public' AND c.column_name = 'user_id' AND t.table_type = 'BASE TABLE'`,
      );
      expect(tables.length).toBeGreaterThanOrEqual(9);
      for (const { table_name } of tables) {
        const n = await pool().query(`SELECT 1 FROM ${table_name} WHERE user_id = $1`, [a]);
        expect(n.rowCount, table_name).toBe(0);
      }
      expect((await pool().query(`SELECT 1 FROM users WHERE id=$1`, [a])).rowCount).toBe(0);
      expect(
        (await pool().query(`SELECT 1 FROM insight_feedback WHERE voted_by=$1`, [a])).rowCount,
      ).toBe(0);
    });

    it("leaves the other user's data untouched", async () => {
      await request(app).delete(`/users/${a}?confirm=true`).set('Authorization', bearer(a, 'user'));
      for (const t of ['daily_metrics', 'activity_efforts', 'trends', 'provider_connections']) {
        const n = await pool().query(`SELECT 1 FROM ${t} WHERE user_id = $1`, [b]);
        expect(n.rowCount, t).toBeGreaterThan(0);
      }
    });

    it('master can delete a user; the deleted user token stops working', async () => {
      const res = await request(app)
        .delete(`/users/${a}?confirm=true`)
        .set('Authorization', bearer(m, 'master'));
      expect(res.status).toBe(200);
      const after = await request(app)
        .get(`/users/${a}/export`)
        .set('Authorization', bearer(a, 'user'));
      expect(after.status).toBe(401);
    });

    it('a failing provider revoke does not block the delete', async () => {
      const res = await request(app)
        .delete(`/users/${b}?confirm=true`)
        .set('Authorization', bearer(b, 'user'));
      expect(res.status).toBe(200);
      expect(res.body.revoked.oura).toBe('failed');
    });

    it('is idempotent: deleting again is a 404 / 401, never a 500', async () => {
      await request(app)
        .delete(`/users/${a}?confirm=true`)
        .set('Authorization', bearer(m, 'master'));
      const again = await request(app)
        .delete(`/users/${a}?confirm=true`)
        .set('Authorization', bearer(m, 'master'));
      expect(again.status).toBe(404);
    });
  });
});

describe('last master guard', () => {
  it('refuses to delete the only master, before revoking anything', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('is_master'))
        return { rowCount: 1, rows: [{ is_master: true, masters: 1 }] };
      return { rowCount: 1, rows: [{}] }; // the existence check
    });
    const revoke = vi.fn();
    const reg = createAdapterRegistry();
    await expect(
      deleteUserCompletely({ pool: { query } as never, registry: reg, cipher }, 'u1'),
    ).rejects.toBeInstanceOf(LastMasterError);
    expect(revoke).not.toHaveBeenCalled();
    // Only the existence check and the guard ran: no DELETE.
    expect(query.mock.calls.every(([sql]) => !/DELETE/.test(sql as string))).toBe(true);
  });
});
