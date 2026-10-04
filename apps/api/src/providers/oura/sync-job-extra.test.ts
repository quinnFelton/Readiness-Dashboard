import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalAesGcmCipher } from '../../crypto/token-cipher';
import { ConnectionService } from '../../connections/connection-service';
import { ConnectionConfigService } from '../../connections/config-service';
import { closePool, getPool } from '../../users/pool';
import { createAdapterRegistry } from '@rd/provider-adapters';
import { OuraAdapter, ouraConfigFromEnv } from './register';
import { syncOuraAll, syncOuraUser } from './sync-job';
import { acquireOuraTestMutex } from './test-mutex';

const pool = getPool();
const cipher = new LocalAesGcmCipher(randomBytes(32).toString('base64'));
const now = new Date('2026-09-10T12:00:00Z');
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const SECRET_TOKENS = ['SECRETACCESS', 'SECRETREFRESH'];

describe('oura sync job: lock, isolation, logging', () => {
  const failFor = new Set<string>();
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
    if (failFor.has(auth)) return json({ detail: 'SECRET-HEALTH-BODY' }, 500);
    return json({ data: [{ day: '2026-09-09', score: 70 }] });
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
  const users: string[] = [];

  let releaseMutex: () => Promise<void>;
  beforeAll(async () => {
    releaseMutex = await acquireOuraTestMutex(pool);
    const registry = createAdapterRegistry();
    registry.register(adapter);
    const conns = new ConnectionService(
      pool,
      registry,
      cipher,
      new ConnectionConfigService(pool, registry),
    );
    for (let i = 0; i < 2; i++) {
      const { rows } = await pool.query(`INSERT INTO users(email) VALUES ($1) RETURNING id`, [
        `oura-x${i}-${randomBytes(4).toString('hex')}@test.invalid`,
      ]);
      users.push(rows[0].id);
      await conns.saveGrant(rows[0].id, 'oura', 'daily_metrics_source', {
        accessToken: i === 0 ? 'SECRETACCESS' : 'GOODTOKEN',
        refreshToken: `SECRETREFRESH${i}`,
        expiresAt: new Date('2026-09-10T20:00:00Z'),
      });
    }
  });
  afterAll(async () => {
    for (const u of users) await pool.query('DELETE FROM users WHERE id = $1', [u]);
    await releaseMutex();
    await closePool();
  });

  it('returns SyncInProgress when the per-user advisory lock is held, and releases afterwards', async () => {
    const key = `oura-sync:${users[1]}`;
    const c = await pool.connect();
    try {
      await c.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [key]);
      const res = await syncOuraUser(users[1]!, deps);
      expect(res).toMatchObject({ ok: false, error: 'SyncInProgress' });
      await c.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [key]);
    } finally {
      c.release();
    }
    expect((await syncOuraUser(users[1]!, deps)).ok).toBe(true);
  });

  it('syncOuraAll isolates failures per user; nothing sensitive is logged or returned', async () => {
    failFor.add('Bearer SECRETACCESS');
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const out = await syncOuraAll(deps);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    spies.forEach((s) => s.mockRestore());
    expect(out.get(users[0]!)).toMatchObject({ ok: false, error: 'OuraHttpError' });
    expect(out.get(users[1]!)?.ok).toBe(true);
    const all = JSON.stringify([...out.values()]) + logged;
    for (const t of [...SECRET_TOKENS, 'SECRET-HEALTH-BODY']) expect(all).not.toContain(t);
  });
});
