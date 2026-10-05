import { randomBytes } from 'node:crypto';
import { EF_QUADRANT_V1, type StrategyRegistry, type TrendClassifier } from '@rd/scoring-engine';
import express from 'express';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signApiToken } from '../auth/token';
import { acquireDefaultsTestMutex } from '../test-utils/defaults-mutex';
import { closePool, getPool } from '../users/pool';
import { comparisonRouter } from './routes';

// Smaller item: "concurrent classifier promotion (409) has no test". PUT /classifiers/:id/default
// clears the old default and sets the new one in a transaction; two concurrent promotions both clear
// the same old default, then collide on the partial unique index. The loser must get a 409, not a
// 500, and exactly one classifier must end up default. Needs migrated local Postgres.
process.env.NEXTAUTH_SECRET = 'test-secret-test-secret-test-secret';

const pool = () => getPool();
const tag = randomBytes(3).toString('hex');
const P = `zz-race-p-${tag}`;
const Q = `zz-race-q-${tag}`;

/** Releases everyone once `n` parties have arrived: forces the two promotions to interleave. */
function barrier(n: number) {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  return async () => {
    if (++arrived >= n) open();
    await gate;
  };
}

describe('concurrent classifier promotion', () => {
  let releaseDefaults: () => Promise<void> = async () => {};
  let master: string;
  let originalDefault: string;
  let restoreDefault = false;
  // The route only checks that the id exists in the code registry.
  const registry = { get: () => ({}) } as unknown as StrategyRegistry<TrendClassifier>;

  beforeAll(async () => {
    releaseDefaults = await acquireDefaultsTestMutex(pool());
    // The migration seeds exactly one default; fall back to it if a crashed run left none.
    originalDefault =
      (await pool().query<{ id: string }>(`SELECT id FROM classifiers WHERE is_default`)).rows[0]
        ?.id ?? EF_QUADRANT_V1.id;
    restoreDefault = true;
    // Rows leaked by an earlier crashed run of this file (none are ever the default at this point).
    await pool().query(`DELETE FROM classifiers WHERE id LIKE 'zz-race-%' AND NOT is_default`);
    for (const id of [P, Q]) {
      await pool().query(`INSERT INTO classifiers (id, description) VALUES ($1,'race test')`, [id]);
    }
    master = (
      await pool().query<{ id: string }>(
        `INSERT INTO users(email, role) VALUES ($1,'master') RETURNING id`,
        [`race-${tag}@phase9.invalid`],
      )
    ).rows[0]!.id;
  }, 60_000); // may wait for other files that hold the defaults mutex
  afterAll(async () => {
    // Put the shared default back before releasing the lock other test files wait on. Only if
    // beforeAll got far enough to know what it was (a failed setup must not clear the default).
    if (restoreDefault) {
      await pool().query(`UPDATE classifiers SET is_default = false WHERE is_default`);
      await pool().query(`UPDATE classifiers SET is_default = true WHERE id = $1`, [
        originalDefault,
      ]);
    }
    await pool().query('DELETE FROM classifiers WHERE id = ANY($1)', [[P, Q]]);
    if (master) await pool().query('DELETE FROM users WHERE id = $1', [master]);
    await releaseDefaults();
    await closePool();
  });

  /**
   * A pool whose clients pause after the row lock on the promoted classifier (the first statement
   * of the transaction) until BOTH promotions have taken theirs, so the two transactions are
   * guaranteed to overlap. They then collide naturally: the second "clear the old default" blocks on
   * the first one's row lock, and once that commits it sets its own classifier and trips the partial
   * unique index. (Pausing after the clear itself would deadlock the test: the second clear can't
   * finish while the first transaction is paused.)
   */
  const racingPool = (): pg.Pool => {
    const reached = barrier(2);
    return {
      connect: async () => {
        const client = await pool().connect();
        const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
          const out = await query(...args);
          const sql = typeof args[0] === 'string' ? args[0] : '';
          if (/SELECT 1 FROM classifiers WHERE id = \$1 FOR UPDATE/.test(sql)) await reached();
          return out;
        };
        return client;
      },
      query: (...a: unknown[]) => (pool().query as (...x: unknown[]) => unknown)(...a),
    } as unknown as pg.Pool;
  };

  const put = (app: express.Express, id: string) =>
    request(app)
      .put(`/c/classifiers/${id}/default`)
      .set(
        'Authorization',
        `Bearer ${signApiToken({ userId: master, role: 'master' }, { nowSec: Math.floor(Date.now() / 1000) })}`,
      );
  const defaults = async () =>
    (await pool().query<{ id: string }>(`SELECT id FROM classifiers WHERE is_default`)).rows.map(
      (r) => r.id,
    );

  it('one wins (200), the other gets 409 "retry" (not 500), and exactly one default remains', async () => {
    const app = express().use(
      '/c',
      comparisonRouter({ pool: racingPool(), classifiers: registry }),
    );
    const [a, b] = await Promise.all([put(app, P), put(app, Q)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    const winner = a.status === 200 ? a : b;
    expect(loser.body).toEqual({ error: 'another promotion is in progress; retry' });
    const now = await defaults();
    expect(now).toHaveLength(1); // the partial unique index held the invariant
    expect(now[0]).toBe(winner.body.defaultClassifierId);

    // The advice is right: retrying the loser (no race this time) succeeds.
    const plain = express().use('/c', comparisonRouter({ pool: pool(), classifiers: registry }));
    const loserId = winner.body.defaultClassifierId === P ? Q : P;
    expect((await put(plain, loserId)).status).toBe(200);
    expect(await defaults()).toEqual([loserId]);
  });

  it('sequential promotions never conflict', async () => {
    const app = express().use('/c', comparisonRouter({ pool: pool(), classifiers: registry }));
    for (const id of [P, Q, P]) {
      expect((await put(app, id)).status).toBe(200);
      expect(await defaults()).toEqual([id]);
    }
  });
});
