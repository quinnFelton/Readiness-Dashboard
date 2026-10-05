import { randomBytes } from 'node:crypto';
import { createAdapterRegistry, defaultRegistry } from '@rd/provider-adapters';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionConfigService } from '../connections/config-service';
import { ConnectionService } from '../connections/connection-service';
import { LocalAesGcmCipher } from '../crypto/token-cipher';
import { handler } from '../lambda/history-rebuild';
import { acquireDefaultsTestMutex } from '../test-utils/defaults-mutex';
import { addDays, todayUtc } from '../trends/http';
import { closePool, getPool } from '../users/pool';
import {
  FULL_HISTORY_FROM,
  loadHistoryRebuildConfig,
  markHistoryDirty,
  oldestOutsideWindow,
  runHistoryRebuild,
} from './history-rebuild';
import { createRecompute } from './recompute';
import { FatigueFitnessService } from './service';

// Owner decision 2026-10-04: history is kept, so trends/readiness must exist for every date with data.
// Needs migrated local Postgres.

const pool = () => getPool();
const today = () => todayUtc(new Date());
const day = (d: number) => addDays(today(), -d);
const DAYS = 100; // deeper than the 28-day recompute window

describe('history rebuild (DB)', () => {
  const svc = new FatigueFitnessService(
    pool(),
    new ConnectionConfigService(pool(), defaultRegistry),
  );
  const created: string[] = [];
  let userId: string;

  const mkUser = async () => {
    const id = (
      await pool().query<{ id: string }>(`INSERT INTO users(email) VALUES ($1) RETURNING id`, [
        `rebuild-${randomBytes(4).toString('hex')}@phase9.invalid`,
      ])
    ).rows[0]!.id;
    created.push(id);
    return id;
  };
  /** `DAYS` days of recovery data (source `oura`) and a ride every other day, EF improving recently. */
  const seed = async (id: string, source = 'oura') => {
    for (let d = 1; d <= DAYS; d++) {
      await pool().query(
        `INSERT INTO daily_metrics (user_id, date, source, metric_type, value)
         VALUES ($1,$2,$3,'hrv',$4), ($1,$2,$3,'resting_hr',$5) ON CONFLICT DO NOTHING`,
        [id, day(d), source, 55 + (d % 5) + (d < 10 ? -8 : 0), 52 + (d % 3)],
      );
      if (d % 2 === 0) {
        await pool().query(
          `INSERT INTO activity_efforts (user_id, external_activity_id, source, date, duration_sec,
             avg_hr, ef_peak20, deriver_id) VALUES ($1,$2,'strava',$3,3600,140,$4,'peak20_v1')
           ON CONFLICT DO NOTHING`,
          [id, `r-${source}-${d}`, day(d), 1.5 + (d % 4) * 0.02 + (d < 10 ? 0.4 : 0)],
        );
      }
    }
  };
  const trendDays = async (id: string) =>
    (
      await pool().query<{ d: string }>(
        `SELECT DISTINCT to_char(as_of,'YYYY-MM-DD') AS d FROM trends WHERE user_id=$1 ORDER BY d`,
        [id],
      )
    ).rows.map((r) => r.d);
  const request = async (id: string) =>
    (
      await pool().query(
        `SELECT to_char(earliest_date,'YYYY-MM-DD') AS earliest, to_char(cursor_date,'YYYY-MM-DD') AS cursor,
                completed_at IS NOT NULL AS done FROM history_rebuild_requests WHERE user_id=$1`,
        [id],
      )
    ).rows[0];

  let releaseDefaults: () => Promise<void> = async () => {};
  beforeAll(async () => {
    // Trend rows need the default classifier, which other test files swap while they run.
    releaseDefaults = await acquireDefaultsTestMutex(pool());
    userId = await mkUser();
    await seed(userId);
  });
  beforeEach(async () => {
    await pool().query('DELETE FROM trends WHERE user_id = $1', [userId]);
    await pool().query('DELETE FROM readiness_scores WHERE user_id = $1', [userId]);
    await pool().query('DELETE FROM history_rebuild_requests WHERE user_id = $1', [userId]);
  });
  afterAll(async () => {
    await pool().query('DELETE FROM users WHERE id = ANY($1)', [created]);
    await releaseDefaults();
    await closePool();
  });

  describe('markHistoryDirty', () => {
    it('is idempotent; a pending request only moves earlier; a finished one restarts from the new date', async () => {
      await markHistoryDirty(pool(), userId, '2026-02-10');
      await markHistoryDirty(pool(), userId, '2026-02-20'); // later: ignored
      expect(await request(userId)).toMatchObject({ earliest: '2026-02-10', done: false });
      await markHistoryDirty(pool(), userId, '2026-01-05'); // earlier: wins
      expect(await request(userId)).toMatchObject({ earliest: '2026-01-05', done: false });

      await pool().query(
        `UPDATE history_rebuild_requests SET completed_at = now() WHERE user_id=$1`,
        [userId],
      );
      await markHistoryDirty(pool(), userId, '2026-03-01');
      expect(await request(userId)).toMatchObject({ earliest: '2026-03-01', done: false });
      expect(
        (await pool().query(`SELECT 1 FROM history_rebuild_requests WHERE user_id=$1`, [userId]))
          .rowCount,
      ).toBe(1);
    });
  });

  describe('runHistoryRebuild', () => {
    it('fills in trend rows for dates older than the 28-day recompute window, and finishes the request', async () => {
      expect(await trendDays(userId)).toEqual([]);
      await markHistoryDirty(pool(), userId, FULL_HISTORY_FROM);
      const r = await runHistoryRebuild(pool(), svc, {
        userId, // scoped: other test files leave pending requests in the shared DB
        config: { maxDatesPerUser: 500, maxUsers: 10 },
      });
      expect(r.failures).toBe(0);
      expect(r.dates).toBe(DAYS);
      const days = await trendDays(userId);
      expect(days).toContain(day(90)); // far outside the window the ingest hook covers
      expect(days).toContain(day(40));
      expect(days).toContain(day(1));
      expect(
        (await pool().query(`SELECT 1 FROM readiness_scores WHERE user_id=$1`, [userId])).rowCount,
      ).toBeGreaterThan(50);
      expect(await request(userId)).toMatchObject({ done: true, cursor: null });
      expect(r.pending).toBe(0);
    });

    it('is bounded per invocation and resumes from its cursor until done', async () => {
      await markHistoryDirty(pool(), userId, FULL_HISTORY_FROM);
      const cfg = { maxDatesPerUser: 30, maxUsers: 10 };
      const first = await runHistoryRebuild(pool(), svc, { userId, config: cfg });
      expect(first.dates).toBe(30); // never more than the bound
      expect(first.pending).toBeGreaterThanOrEqual(1);
      const mid = await request(userId);
      expect(mid).toMatchObject({ done: false });
      expect(mid.cursor).toBe(addDays(day(DAYS), 30)); // resumes after the 30th date (oldest first)

      let guard = 0;
      let total = first.dates;
      for (;;) {
        const r = await runHistoryRebuild(pool(), svc, { userId, config: cfg });
        total += r.dates;
        if (r.pending === 0 || ++guard > 10) break;
      }
      expect(total).toBe(DAYS);
      expect(await request(userId)).toMatchObject({ done: true });
    });

    it('is idempotent: a second full rebuild changes no rows', async () => {
      const cfg = { maxDatesPerUser: 500, maxUsers: 10 };
      await runHistoryRebuild(pool(), svc, { userId, full: true, config: cfg });
      const snapshot = async () =>
        (
          await pool().query(
            `SELECT classifier_id, as_of::text, metric_type, trend_window, z_score::text, direction
               FROM trends WHERE user_id=$1 ORDER BY 1,2,3,4`,
            [userId],
          )
        ).rows;
      const before = await snapshot();
      expect(before.length).toBeGreaterThan(50);
      const scores = (
        await pool().query(`SELECT count(*)::int AS n FROM readiness_scores WHERE user_id=$1`, [
          userId,
        ])
      ).rows[0].n;
      await runHistoryRebuild(pool(), svc, { userId, full: true, config: cfg });
      expect(await snapshot()).toEqual(before);
      expect(
        (
          await pool().query(`SELECT count(*)::int AS n FROM readiness_scores WHERE user_id=$1`, [
            userId,
          ])
        ).rows[0].n,
      ).toBe(scores);
    });

    it("`userId` without `full` only works that user's pending request, and does nothing without one", async () => {
      const cfg = { maxDatesPerUser: 500, maxUsers: 10 };
      const idle = await runHistoryRebuild(pool(), svc, { userId, config: cfg });
      expect(idle).toMatchObject({ users: 0, dates: 0 });
      expect(await trendDays(userId)).toEqual([]);
      await markHistoryDirty(pool(), userId, day(60));
      const r = await runHistoryRebuild(pool(), svc, { userId, config: cfg });
      expect(r.dates).toBe(60); // from day(60) to day(1): only dates from the request on
      expect(await trendDays(userId)).not.toContain(day(90));
    });

    it('only handles users with a pending request, max users per invocation', async () => {
      const other = await mkUser();
      await seed(other);
      await markHistoryDirty(pool(), userId, day(5));
      await markHistoryDirty(pool(), other, day(5));
      // Unscoped (what the schedule does): at most `maxUsers` users per invocation, however many are
      // pending (the shared test DB may hold other files' requests too, so only the bound is exact).
      const r = await runHistoryRebuild(pool(), svc, {
        config: { maxDatesPerUser: 50, maxUsers: 1 },
      });
      expect(r.users).toBeLessThanOrEqual(1);
      expect(r.dates).toBeLessThanOrEqual(50);
      const left = await pool().query(
        `SELECT 1 FROM history_rebuild_requests WHERE completed_at IS NULL AND user_id = ANY($1)`,
        [[userId, other]],
      );
      expect(left.rowCount).toBeGreaterThanOrEqual(1); // two were queued, one run did at most one
      await pool().query('DELETE FROM history_rebuild_requests WHERE user_id = ANY($1)', [
        [userId, other],
      ]);
    });

    it('skips a user another invocation is rebuilding (advisory lock)', async () => {
      await markHistoryDirty(pool(), userId, day(5));
      const holder = await pool().connect();
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [
        `history-rebuild:${userId}`,
      ]);
      try {
        const r = await runHistoryRebuild(pool(), svc, {
          userId,
          config: { maxDatesPerUser: 50, maxUsers: 5 },
        });
        expect(r.users).toBe(0);
        expect(await trendDays(userId)).toEqual([]);
      } finally {
        await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [
          `history-rebuild:${userId}`,
        ]);
        holder.release();
      }
    });

    it('a date that throws is counted and logged by class name only; the rest still run', async () => {
      await markHistoryDirty(pool(), userId, day(10));
      const log = vi.fn();
      let n = 0;
      const flaky = {
        onSyncComplete: async (u: string, k: 'daily_metrics' | 'activity', d: string) => {
          if (++n === 3) throw new TypeError('hrv=63 must never be logged');
          return svc.onSyncComplete(u, k, d);
        },
      };
      const r = await runHistoryRebuild(pool(), flaky, {
        userId,
        log,
        config: { maxDatesPerUser: 50, maxUsers: 5 },
      });
      expect(r.failures).toBe(1);
      expect(r.dates).toBe(10);
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]![0])).toContain('TypeError');
      expect(String(log.mock.calls[0]![0])).not.toContain('63');
    });
  });

  describe('wiring', () => {
    it('the ingest hook queues dates older than its window, and only those', async () => {
      const seen: [string, string][] = [];
      const recompute = createRecompute(
        {
          onSyncComplete: async () => ({
            asOf: '',
            ran: false,
            classifiers: [],
            readinessUpdated: false,
          }),
        },
        { markHistoryDirty: async (u, d) => void seen.push([u, d]) },
      );
      await recompute(userId, 'daily_metrics', [day(2), day(60), day(90), day(5)]);
      expect(seen).toEqual([[userId, day(90)]]); // the oldest date outside the window
      seen.length = 0;
      await recompute(userId, 'daily_metrics', [day(2), day(20)]);
      expect(seen).toEqual([]); // all inside the window: nothing to queue
    });

    it('a failing queue write never fails the hook', async () => {
      const log = vi.fn();
      const recompute = createRecompute(
        {
          onSyncComplete: async () => ({
            asOf: '',
            ran: false,
            classifiers: [],
            readinessUpdated: false,
          }),
        },
        {
          log,
          markHistoryDirty: async () => {
            throw new Error('db down: hrv=63');
          },
        },
      );
      await expect(recompute(userId, 'daily_metrics', [day(90)])).resolves.toBeUndefined();
      expect(String(log.mock.calls[0]![0])).toContain('Error');
      expect(String(log.mock.calls[0]![0])).not.toContain('63');
    });

    it("disconnect WITH erase queues a full rebuild; the rebuild then restores the other source's whole history", async () => {
      const u = await mkUser();
      await seed(u, 'oura'); // recovery from oura, rides from strava (see seed)
      await pool().query(
        `INSERT INTO daily_metrics (user_id, date, source, metric_type, value)
         SELECT $1, (now() at time zone 'utc')::date - n, 'terra', 'hrv', 50 + (n % 4)
           FROM generate_series(1, 100) AS n ON CONFLICT DO NOTHING`,
        [u],
      );
      const registry = createAdapterRegistry();
      const conns = new ConnectionService(
        pool(),
        registry,
        new LocalAesGcmCipher(randomBytes(32).toString('base64')),
        new ConnectionConfigService(pool(), registry),
        async () => undefined, // recompute hook: the 28-day pass is covered elsewhere
      );
      await pool().query(
        `INSERT INTO provider_connections (user_id, provider, role) VALUES ($1,'oura','daily_metrics_source')`,
        [u],
      );
      await conns.disconnect(u, 'oura', { deleteData: true });
      expect(await request(u)).toMatchObject({ earliest: FULL_HISTORY_FROM, done: false });
      expect(await trendDays(u)).toEqual([]); // erased, rebuild not yet run
      await runHistoryRebuild(pool(), svc, {
        userId: u,
        config: { maxDatesPerUser: 500, maxUsers: 5 },
      });
      // Rides (strava, kept) + terra hrv remain: history comes back for old dates too.
      const days = await trendDays(u);
      expect(days).toContain(day(80));
      // The erased source's values are gone from the inputs, so nothing derived from them returns.
      expect(
        (await pool().query(`SELECT 1 FROM daily_metrics WHERE user_id=$1 AND source='oura'`, [u]))
          .rowCount,
      ).toBe(0);
    });

    it('disconnect that KEEPS history queues nothing', async () => {
      const u = await mkUser();
      const registry = createAdapterRegistry();
      const conns = new ConnectionService(
        pool(),
        registry,
        new LocalAesGcmCipher(randomBytes(32).toString('base64')),
        new ConnectionConfigService(pool(), registry),
        async () => undefined,
      );
      await pool().query(
        `INSERT INTO provider_connections (user_id, provider, role) VALUES ($1,'oura','daily_metrics_source')`,
        [u],
      );
      await conns.disconnect(u, 'oura');
      expect(await request(u)).toBeUndefined();
    });
  });

  describe('Lambda entrypoint and config', () => {
    it('rejects a non-UUID userId before touching anything', async () => {
      await expect(handler({ userId: "x'; DROP TABLE users;--" })).rejects.toThrow(/UUID/);
    });

    it('bounds are config (HISTORY_REBUILD_MAX_DATES / _MAX_USERS), with sane defaults and junk fallback', () => {
      expect(loadHistoryRebuildConfig({})).toEqual({ maxDatesPerUser: 120, maxUsers: 10 });
      expect(
        loadHistoryRebuildConfig({
          HISTORY_REBUILD_MAX_DATES: '30',
          HISTORY_REBUILD_MAX_USERS: '2',
        }),
      ).toEqual({ maxDatesPerUser: 30, maxUsers: 2 });
      expect(
        loadHistoryRebuildConfig({
          HISTORY_REBUILD_MAX_DATES: '0',
          HISTORY_REBUILD_MAX_USERS: 'x',
        }),
      ).toEqual({ maxDatesPerUser: 120, maxUsers: 10 });
    });

    it('oldestOutsideWindow', () => {
      expect(oldestOutsideWindow([day(1), day(40), day(50)], today(), 28)).toBe(day(50));
      expect(oldestOutsideWindow([day(1), day(27)], today(), 28)).toBeUndefined();
      expect(oldestOutsideWindow(undefined, today(), 28)).toBeUndefined();
      expect(oldestOutsideWindow(['garbage'], today(), 28)).toBeUndefined();
    });
  });
});
