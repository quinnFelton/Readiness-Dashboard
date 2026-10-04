import type pg from 'pg';

// Test helper. Oura DB tests share one Postgres and syncOuraAll() touches EVERY active Oura connection, so
// test files running in parallel workers would sync (and lock) each other's users. Each such file holds this
// session-level advisory lock for its whole run, which serialises them across processes.
const TEST_MUTEX_KEY = 'oura-db-tests-mutex';

export async function acquireOuraTestMutex(pool: pg.Pool): Promise<() => Promise<void>> {
  const client = await pool.connect();
  await client.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [TEST_MUTEX_KEY]);
  return async () => {
    await client
      .query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [TEST_MUTEX_KEY])
      .catch(() => undefined);
    client.release();
  };
}
