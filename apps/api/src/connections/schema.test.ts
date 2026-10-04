import { afterAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../users/pool';

// Needs migrated local Postgres. PLAN §7 phase-2 tables.
const USER_TABLES = [
  'provider_connections',
  'connection_configs',
  'daily_metrics',
  'activity_efforts',
];

describe('phase 2 schema (PLAN §7)', () => {
  afterAll(closePool);

  it('has the unique keys and indexes from the plan', async () => {
    const { rows } = await getPool().query(
      `SELECT tablename, indexdef FROM pg_indexes WHERE schemaname='public'`,
    );
    const defs = rows.map((r) => `${r.tablename}: ${r.indexdef}`);
    const has = (t: string, re: RegExp) => defs.some((d) => d.startsWith(`${t}:`) && re.test(d));
    expect(has('provider_connections', /UNIQUE.*\(user_id, provider\)/)).toBe(true);
    expect(has('connection_configs', /UNIQUE.*\(user_id, role, provider\)/)).toBe(true);
    expect(has('daily_metrics', /UNIQUE.*\(user_id, date, source, metric_type\)/)).toBe(true);
    expect(has('daily_metrics', /idx_daily_metrics_user_date.*\(user_id, date\)/)).toBe(true);
    expect(has('activity_efforts', /UNIQUE.*\(user_id, external_activity_id\)/)).toBe(true);
    expect(has('activity_efforts', /idx_activity_efforts_user_date.*\(user_id, date\)/)).toBe(true);
  });

  it('per-user tables have user_id; derived tables have derivation_version; webhook status CHECK', async () => {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_name = ANY($1)`,
      [USER_TABLES],
    );
    const col = (t: string, c: string) =>
      rows.some((r) => r.table_name === t && r.column_name === c);
    for (const t of USER_TABLES) expect(col(t, 'user_id')).toBe(true);
    for (const t of ['daily_metrics', 'activity_efforts'])
      expect(col(t, 'derivation_version')).toBe(true);
    await expect(
      pool.query(
        `INSERT INTO webhook_events(provider,payload_jsonb,status) VALUES ('x','{}','bogus')`,
      ),
    ).rejects.toThrow();
  });

  it('rejects invalid provider/role and cascades on user delete', async () => {
    const pool = getPool();
    const email = `p2schema-${Date.now()}@schema-check.invalid`;
    const { rows } = await pool.query('INSERT INTO users(email) VALUES ($1) RETURNING id', [email]);
    const id = rows[0].id;
    try {
      await expect(
        pool.query(
          `INSERT INTO provider_connections(user_id,provider,role) VALUES ($1,'fitbit','activity_source')`,
          [id],
        ),
      ).rejects.toThrow();
      await expect(
        pool.query(
          `INSERT INTO provider_connections(user_id,provider,role) VALUES ($1,'oura','nope')`,
          [id],
        ),
      ).rejects.toThrow();
      await pool.query(
        `INSERT INTO provider_connections(user_id,provider,role) VALUES ($1,'oura','daily_metrics_source')`,
        [id],
      );
      await pool.query(
        `INSERT INTO daily_metrics(user_id,date,source,metric_type,value) VALUES ($1,'2026-01-01','oura','hrv',50)`,
        [id],
      );
    } finally {
      await pool.query('DELETE FROM users WHERE id=$1', [id]);
    }
    expect((await pool.query('SELECT 1 FROM daily_metrics WHERE user_id=$1', [id])).rowCount).toBe(
      0,
    );
    expect(
      (await pool.query('SELECT 1 FROM provider_connections WHERE user_id=$1', [id])).rowCount,
    ).toBe(0);
  });
});
