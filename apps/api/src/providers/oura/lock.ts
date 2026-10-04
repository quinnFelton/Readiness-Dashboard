import type pg from 'pg';

/**
 * Per-user advisory lock shared by the polling sync and the webhook processor. Oura refresh tokens are
 * single-use, so two concurrent runs for one user must never both refresh. Returns `{ acquired: false }`
 * instead of waiting; callers decide whether that is an error (webhook: 5xx so Oura retries) or a skip.
 */
export async function withOuraUserLock<T>(
  pool: pg.Pool,
  userId: string,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const key = `oura-sync:${userId}`;
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`,
      [key],
    );
    locked = lock.rows[0]?.ok === true;
    if (!locked) return { acquired: false };
    return { acquired: true, value: await fn() };
  } finally {
    if (locked) {
      await client
        .query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [key])
        .catch(() => undefined);
    }
    client.release();
  }
}
