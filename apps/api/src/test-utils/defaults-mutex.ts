import type pg from 'pg';

// Test helper. DB tests share one Postgres, and the `is_default` flags on `classifiers` / `derivers`
// are global (PLAN §8.7/§8.8). comparison.test.ts promotes a test classifier to default while it
// runs, so any test file that reads or changes a default flag holds this session-level advisory
// lock for its whole run. That serialises those files across worker processes.
const TEST_MUTEX_KEY = 'registry-defaults-db-tests-mutex';

export async function acquireDefaultsTestMutex(pool: pg.Pool): Promise<() => Promise<void>> {
  const client = await pool.connect();
  await client.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [TEST_MUTEX_KEY]);
  return async () => {
    await client
      .query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [TEST_MUTEX_KEY])
      .catch(() => undefined);
    client.release();
  };
}
