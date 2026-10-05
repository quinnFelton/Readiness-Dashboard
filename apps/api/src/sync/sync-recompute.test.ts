import { randomBytes } from 'node:crypto';
import { createAdapterRegistry } from '@rd/provider-adapters';
import type { NormalizedActivityEffort, NormalizedDailyMetric } from '@rd/shared-types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConnectionConfigService } from '../connections/config-service';
import { ConnectionService } from '../connections/connection-service';
import { LocalAesGcmCipher } from '../crypto/token-cipher';
import { closePool, getPool } from '../users/pool';
import { FakeAdapter } from './fake-adapter';
import { SyncService } from './sync-service';

// Phase 9: SyncService.syncUser / syncAll skipped the recompute hook every other ingest path calls
// (PLAN §8.4, integration stage E item 2). Needs migrated local Postgres.

const cipher = new LocalAesGcmCipher(randomBytes(32).toString('base64'));
const oura = new FakeAdapter<NormalizedDailyMetric>('oura', 'daily_metrics_source');
const strava = new FakeAdapter<NormalizedActivityEffort>('strava', 'activity_source');
// FakeAdapter has no push-only marker; give strava a fetchRaw by enqueueing (it has one).
const registry = createAdapterRegistry();
registry.register(oura);
registry.register(strava);

const metric = (date: string, value: number) =>
  ({ date, metricType: 'hrv', value }) as unknown as NormalizedDailyMetric;
const effort = (id: string, date: string) =>
  ({
    externalActivityId: id,
    date,
    durationSec: 3600,
    avgHr: 140,
  }) as unknown as NormalizedActivityEffort;

describe('SyncService -> recompute hook', () => {
  const pool = () => getPool();
  let userId: string;

  beforeAll(async () => {
    userId = (
      await pool().query<{ id: string }>(`INSERT INTO users(email) VALUES ($1) RETURNING id`, [
        `sync-${randomBytes(4).toString('hex')}@phase9.invalid`,
      ])
    ).rows[0]!.id;
    const conns = new ConnectionService(
      pool(),
      registry,
      cipher,
      new ConnectionConfigService(pool(), registry),
    );
    await conns.saveGrant(userId, 'oura', 'daily_metrics_source', { accessToken: 't' });
    await conns.saveGrant(userId, 'strava', 'activity_source', { accessToken: 't2' });
  });
  afterAll(async () => {
    await pool().query('DELETE FROM users WHERE id = $1', [userId]);
    await closePool();
  });

  it('calls the hook once per synced provider with the right kind and the dates written', async () => {
    const recompute = vi.fn(async () => undefined);
    const sync = new SyncService(pool(), registry, cipher, undefined, recompute);
    oura.enqueue([metric('2026-03-01', 60), metric('2026-03-02', 61), metric('2026-03-02', 62)]);
    strava.enqueue([effort('a1', '2026-03-03')]);
    const results = await sync.syncUser(userId);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(recompute).toHaveBeenCalledTimes(2);
    const byKind = Object.fromEntries(
      recompute.mock.calls.map((c) => [(c as unknown[])[1] as string, (c as unknown[])[2]]),
    );
    expect(recompute).toHaveBeenCalledWith(userId, 'daily_metrics', expect.any(Array));
    expect(byKind.daily_metrics).toEqual(['2026-03-01', '2026-03-02']); // distinct dates, once each
    expect(byKind.activity).toEqual(['2026-03-03']);
  });

  it('syncAll goes through the same path', async () => {
    const recompute = vi.fn(async () => undefined);
    const sync = new SyncService(pool(), registry, cipher, undefined, recompute);
    oura.enqueue([metric('2026-03-04', 60)]);
    strava.enqueue([]);
    const all = await sync.syncAll();
    expect(all.get(userId)?.every((r) => r.ok)).toBe(true);
    expect(recompute).toHaveBeenCalledWith(userId, 'daily_metrics', ['2026-03-04']);
  });

  it('a failed fetch does not recompute (nothing changed)', async () => {
    const recompute = vi.fn(async () => undefined);
    const sync = new SyncService(pool(), registry, cipher, undefined, recompute);
    const spy = vi.spyOn(oura, 'fetchRaw').mockRejectedValueOnce(new Error('boom'));
    strava.enqueue([]);
    const results = await sync.syncUser(userId);
    expect(results.find((r) => r.provider === 'oura')?.ok).toBe(false);
    expect(
      recompute.mock.calls.filter((c) => (c as unknown[])[1] === 'daily_metrics'),
    ).toHaveLength(0);
    spy.mockRestore();
  });

  it('the default hook really writes trend rows for the synced day', async () => {
    const sync = new SyncService(pool(), registry, cipher); // production default: sharedRecompute()
    const today = new Date().toISOString().slice(0, 10);
    // The classifier needs a baseline: 28 prior days of recovery data (as recompute-wiring.test.ts).
    await pool().query(
      `INSERT INTO daily_metrics (user_id, date, source, metric_type, value)
       SELECT $1, d::date, 'oura', m.t, 55 + (extract(day from d)::int % 7)
         FROM generate_series((now() at time zone 'utc')::date - 28, (now() at time zone 'utc')::date - 1, interval '1 day') AS d,
              (VALUES ('hrv'), ('resting_hr')) AS m(t)
       ON CONFLICT DO NOTHING`,
      [userId],
    );
    await pool().query(
      `INSERT INTO activity_efforts (user_id, external_activity_id, source, date, duration_sec, avg_hr, ef_peak20, deriver_id)
       SELECT $1, 'hist-' || n, 'strava', (now() at time zone 'utc')::date - n, 3600, 140,
              (CASE WHEN n < 7 THEN 2.0 ELSE 1.5 END) + (n % 3) * 0.02, 'peak20_v1'
         FROM generate_series(2, 27, 2) AS n
       ON CONFLICT DO NOTHING`,
      [userId],
    );
    oura.enqueue([metric(today, 70)]);
    strava.enqueue([]);
    await sync.syncUser(userId);
    const { rowCount } = await pool().query(
      `SELECT 1 FROM trends WHERE user_id = $1 AND as_of = $2`,
      [userId, today],
    );
    expect(rowCount).toBeGreaterThan(0);
  });
});
