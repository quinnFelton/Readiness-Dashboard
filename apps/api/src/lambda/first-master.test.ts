import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../users/pool';
import { MasterExistsError, createFirstMaster } from './first-master';

// Stage E item: the guarded path that creates the first master in AWS. Needs migrated local Postgres.
// The "no master yet" cases run inside a transaction that is always rolled back, so the shared test
// database keeps its real masters.

const email = () => `first-${randomBytes(4).toString('hex')}@phase9.invalid`;

/** Runs `fn` against a connection that has NO masters, as `role`, then rolls everything back. */
async function withoutMasters<T>(
  role: string | null,
  fn: (db: Pick<pg.Pool, 'query'>) => Promise<T>,
): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    await c.query(`UPDATE users SET role = 'user' WHERE role = 'master'`); // as the test superuser
    if (role) await c.query(`SET LOCAL ROLE ${role}`);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

describe('createFirstMaster', () => {
  afterAll(async () => {
    await closePool();
  });

  it('creates the master when none exists, under its own least-privilege role', async () => {
    const e = email();
    await withoutMasters('rd_first_master', async (db) => {
      await expect(createFirstMaster(db, { email: e, name: 'Owner' })).resolves.toEqual({
        created: true,
      });
      await db.query('RESET ROLE');
      const { rows } = await db.query(`SELECT role, name FROM users WHERE email = $1`, [e]);
      expect(rows[0]).toEqual({ role: 'master', name: 'Owner' });
    });
    // Rolled back: nothing leaked into the shared database.
    expect((await getPool().query(`SELECT 1 FROM users WHERE email = $1`, [e])).rowCount).toBe(0);
  });

  it('promotes an existing user with that email (case-insensitively)', async () => {
    const e = email();
    await getPool().query(`INSERT INTO users(email, role) VALUES ($1, 'user')`, [e]);
    try {
      await withoutMasters('rd_first_master', async (db) => {
        await createFirstMaster(db, { email: e.toUpperCase() });
        await db.query('RESET ROLE');
        const { rows } = await db.query(`SELECT role FROM users WHERE email = $1`, [e]);
        expect(rows).toEqual([{ role: 'master' }]);
      });
    } finally {
      await getPool().query(`DELETE FROM users WHERE email = $1`, [e]);
    }
  });

  it('REFUSES once any master exists: it can never mint a second one or promote another user', async () => {
    const m = email();
    const other = email();
    await getPool().query(`INSERT INTO users(email, role) VALUES ($1,'master'), ($2,'user')`, [
      m,
      other,
    ]);
    try {
      await expect(createFirstMaster(getPool(), { email: email() })).rejects.toBeInstanceOf(
        MasterExistsError,
      );
      await expect(createFirstMaster(getPool(), { email: other })).rejects.toBeInstanceOf(
        MasterExistsError,
      );
      const r = await getPool().query(`SELECT role FROM users WHERE email = $1`, [other]);
      expect(r.rows[0].role).toBe('user'); // not promoted
    } finally {
      await getPool().query(`DELETE FROM users WHERE email = ANY($1)`, [[m, other]]);
    }
  });

  it('validates the email and does not echo it in errors', async () => {
    await expect(createFirstMaster(getPool(), { email: 'not-an-email' })).rejects.toThrow(
      /valid email/,
    );
    await expect(createFirstMaster(getPool(), {})).rejects.toThrow(/valid email/);
    const secretish = `leak-${randomBytes(3).toString('hex')}@x.invalid`;
    const err = await createFirstMaster(getPool(), { email: secretish }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(secretish);
  });

  it('its database role cannot do anything else: no other tables, no other user columns', async () => {
    // One transaction each: a failed statement aborts the transaction it ran in.
    for (const sql of [
      `UPDATE users SET email = 'x@y.z'`,
      `DELETE FROM users`,
      `SELECT 1 FROM daily_metrics`,
    ]) {
      await withoutMasters('rd_first_master', async (db) => {
        await expect(db.query(sql), sql).rejects.toMatchObject({ code: '42501' });
      });
    }
  });
});
