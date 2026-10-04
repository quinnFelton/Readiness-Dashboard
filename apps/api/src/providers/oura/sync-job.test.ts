import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalAesGcmCipher } from '../../crypto/token-cipher';
import { ConnectionService } from '../../connections/connection-service';
import { ConnectionConfigService } from '../../connections/config-service';
import { closePool, getPool } from '../../users/pool';
import { createAdapterRegistry } from '@rd/provider-adapters';
import { OuraAdapter, ouraConfigFromEnv } from './register';
import { syncOuraUser } from './sync-job';
import { acquireOuraTestMutex } from './test-mutex';

// Needs migrated local Postgres (docker compose up -d db && pnpm db:migrate). All Oura HTTP is mocked.

const pool = getPool();
const cipher = new LocalAesGcmCipher(randomBytes(32).toString('base64'));
let now = new Date('2026-09-10T12:00:00Z');
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

const DATA: Record<string, unknown[]> = {
  daily_readiness: [{ day: '2026-09-09', score: 80 }],
  daily_sleep: [{ day: '2026-09-09', score: 75 }],
  sleep: [
    {
      day: '2026-09-09',
      type: 'long_sleep',
      average_hrv: 60,
      lowest_heart_rate: 47,
      total_sleep_duration: 1,
    },
  ],
};

describe('oura sync job', () => {
  const urls: string[] = [];
  let tokenCalls = 0;
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    urls.push(String(url));
    if (u.pathname === '/oauth/token') {
      tokenCalls++;
      expect(String(init?.body)).toContain('refresh_token=R0');
      return json({ access_token: 'A1', refresh_token: 'R1', expires_in: 3600 });
    }
    const coll = u.pathname.split('/').pop() as string;
    return json({ data: DATA[coll] ?? [] });
  });
  const adapter = new OuraAdapter({
    ...ouraConfigFromEnv({}),
    clientId: 'c',
    clientSecret: 's',
    now: () => now,
    sleep: async () => {},
    fetch: fetchMock as unknown as typeof fetch,
  });
  const deps = { pool, cipher, adapter, now: () => now };
  let userId: string;

  let releaseMutex: () => Promise<void>;
  beforeAll(async () => {
    releaseMutex = await acquireOuraTestMutex(pool);
    const { rows } = await pool.query(`INSERT INTO users(email) VALUES ($1) RETURNING id`, [
      `oura-${randomBytes(4).toString('hex')}@test.invalid`,
    ]);
    userId = rows[0].id;
    const registry = createAdapterRegistry();
    registry.register(adapter);
    const conns = new ConnectionService(
      pool,
      registry,
      cipher,
      new ConnectionConfigService(pool, registry),
    );
    await conns.saveGrant(userId, 'oura', 'daily_metrics_source', {
      accessToken: 'A0',
      refreshToken: 'R0',
      expiresAt: new Date('2026-09-10T11:00:00Z'), // already expired -> refresh path
    });
  });
  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await releaseMutex();
    await closePool();
  });

  it('refreshes, persists encrypted tokens, upserts metrics, advances last_synced_at', async () => {
    const res = await syncOuraUser(userId, deps);
    expect(res).toMatchObject({ ok: true, dailyMetrics: 4 });
    expect(tokenCalls).toBe(1);
    const { rows } = await pool.query(
      `SELECT access_token_enc, refresh_token_enc, last_synced_at FROM provider_connections WHERE user_id=$1`,
      [userId],
    );
    expect(await cipher.decrypt(rows[0].refresh_token_enc, `${userId}:oura`)).toBe('R1');
    expect(rows[0].access_token_enc.toString('utf8')).not.toContain('A1');
    expect(rows[0].last_synced_at.toISOString()).toBe(now.toISOString());
    // first sync = lookback window
    const first = urls.find((x) => x.includes('daily_readiness'))!;
    expect(new URL(first).searchParams.get('start_date')).toBe('2026-08-11');
  });

  it('second run is incremental, does not refresh again, and is idempotent', async () => {
    urls.length = 0;
    now = new Date('2026-09-10T12:30:00Z'); // before refreshed token expiry (13:00 minus skew)
    const res = await syncOuraUser(userId, deps);
    expect(res.ok).toBe(true);
    expect(tokenCalls).toBe(1);
    const second = urls.find((x) => x.includes('daily_readiness'))!;
    expect(new URL(second).searchParams.get('start_date')).toBe('2026-09-08'); // last_synced 09-10 minus 2d overlap
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM daily_metrics WHERE user_id=$1 AND source='oura'`,
      [userId],
    );
    expect(rows[0].n).toBe(4);
  });

  it('a failed fetch leaves last_synced_at untouched', async () => {
    const before = (
      await pool.query(`SELECT last_synced_at FROM provider_connections WHERE user_id=$1`, [userId])
    ).rows[0].last_synced_at;
    fetchMock.mockResolvedValueOnce(json({}, 500));
    now = new Date('2026-09-11T00:00:00Z');
    const res = await syncOuraUser(userId, deps);
    expect(res).toMatchObject({ ok: false, error: 'OuraHttpError' });
    const after = (
      await pool.query(`SELECT last_synced_at FROM provider_connections WHERE user_id=$1`, [userId])
    ).rows[0].last_synced_at;
    expect(after).toEqual(before);
  });

  it('reports NotConnected for a user with no Oura connection', async () => {
    const res = await syncOuraUser('00000000-0000-0000-0000-000000000000', deps);
    expect(res).toMatchObject({ ok: false, error: 'NotConnected' });
  });
});
