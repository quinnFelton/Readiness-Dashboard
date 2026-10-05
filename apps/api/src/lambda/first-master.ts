import type pg from 'pg';
import { getPool } from '../users/pool';
import { ensureBootstrapped } from './bootstrap';

// Stage E item: "there is no way to create the first master account in AWS". Sign-in needs a `users`
// row (apps/api/src/auth, invite-only), the database is unreachable from outside the VPC, and
// db/seed only runs against a reachable Postgres. So this one-off function exists, with three guards:
//  1. It is only DEPLOYED with `-c enableFirstMaster=true` (infra/cdk) and is meant to be removed again
//     right after use (DEPLOY.md). It has no HTTP trigger: only an IAM principal that may invoke
//     Lambda functions can call it.
//  2. At runtime it refuses unless NO master exists yet, so it can never mint a second one or take
//     over an installation that is already set up, even if it is left deployed.
//  3. Its database role (rd_first_master) can read/insert `users` and update only `users.role`.
// It creates the master, or promotes the existing user with that email when there is no master.
// Returns only {created}: no id, no email (CLAUDE.md rule 6).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class MasterExistsError extends Error {
  constructor() {
    super('a master account already exists');
    this.name = 'MasterExistsError';
  }
}

export async function createFirstMaster(
  pool: Pick<pg.Pool, 'query'>,
  input: { email?: unknown; name?: unknown },
): Promise<{ created: true }> {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 320) throw new Error('a valid email is required');
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : null;

  // One statement: the INSERT only produces a row while no master exists, and the conflict branch
  // (an existing user with this email) is promoted under the same condition. Not serialised against
  // a concurrent call: this is a manual one-off, and the guard is re-evaluated on every invocation.
  const res = await pool.query(
    `INSERT INTO users (email, name, role)
     SELECT $1, $2, 'master'
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'master')
     ON CONFLICT (email) DO UPDATE SET role = 'master'
     RETURNING id`,
    [email, name],
  );
  if (res.rowCount === 0) throw new MasterExistsError();
  return { created: true };
}

export const handler = async (event: { email?: unknown; name?: unknown } = {}) => {
  await ensureBootstrapped();
  const out = await createFirstMaster(getPool(), event);
  console.log(JSON.stringify({ firstMaster: 'created' }));
  return out;
};
