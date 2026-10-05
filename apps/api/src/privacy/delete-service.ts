import type pg from 'pg';
import { type RevokeDeps, type RevokeOutcome, revokeProviderGrants } from './revoke';

// PLAN §12: full per-user delete. Order matters:
//  1. revoke every provider grant (needs the stored tokens, so before the rows go);
//  2. delete the users row. Every per-user table references users(id) ON DELETE CASCADE (CLAUDE.md
//     rule 4), so one statement removes connections, tokens, configs, metrics, efforts, scores,
//     trends, feedback (about and by the user), athlete events and webhook receipts atomically.
//     privacy.test.ts asserts "no table with a user_id column keeps a row", driven by
//     information_schema, so a table added without the cascade fails the test.
// Provider revocation is best effort and reported; it never blocks the user's delete.

export class LastMasterError extends Error {
  constructor() {
    super('cannot delete the last master account');
    this.name = 'LastMasterError';
  }
}

export interface DeleteResult {
  deleted: boolean;
  revoked: Record<string, RevokeOutcome>;
}

export async function deleteUserCompletely(
  deps: RevokeDeps,
  userId: string,
): Promise<DeleteResult> {
  const { pool } = deps;
  const exists = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
  if (exists.rowCount === 0) return { deleted: false, revoked: {} };

  // Refuse before revoking anything, so a refused delete has no side effects at the providers.
  await assertNotLastMaster(pool, userId);

  const revoked = await revokeProviderGrants(deps, userId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialise concurrent master deletes so two masters cannot each delete the other.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('rd-last-master-guard', 0))`);
    await assertNotLastMaster(client, userId);
    const res = await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await client.query('COMMIT');
    return { deleted: (res.rowCount ?? 0) > 0, revoked };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function assertNotLastMaster(db: pg.Pool | pg.PoolClient, userId: string): Promise<void> {
  const { rows } = await db.query<{ is_master: boolean; masters: number }>(
    `SELECT (SELECT role = 'master' FROM users WHERE id = $1) AS is_master,
            (SELECT count(*)::int FROM users WHERE role = 'master') AS masters`,
    [userId],
  );
  const r = rows[0];
  if (r?.is_master && r.masters <= 1) throw new LastMasterError();
}
