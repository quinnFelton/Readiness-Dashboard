import type { TrendClassifier } from '@rd/scoring-engine';
import type { StrategyRegistry } from '@rd/scoring-engine';
import type { User } from '@rd/shared-types';
import type pg from 'pg';
import { HttpError } from '../connections/errors';

type Queryable = pg.Pool | pg.PoolClient;

/**
 * The runtime default classifier is the DB's `is_default` flag, never the code constant
 * (PLAN §8.7). If the flagged id isn't registered in code this throws: a mismatch between
 * the DB and the deployed code is a deploy error, not something to paper over with a fallback.
 */
export async function getDefaultClassifierId(
  db: Queryable,
  registry: StrategyRegistry<TrendClassifier>,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM classifiers WHERE is_default`);
  const id = rows[0]?.id;
  if (!id) throw new Error('no classifier is flagged is_default in the classifiers table');
  registry.require(id); // throws "unknown classifier" for a flag with no code behind it
  return id;
}

/**
 * Which classifier a request may see. Plain users get the default only; `?classifier=` for a
 * non-default id is 403 for them (it must not reveal whether the id exists). Masters may pick any
 * classifier that has a row in `classifiers`.
 */
export async function resolveClassifierForViewer(
  db: Queryable,
  registry: StrategyRegistry<TrendClassifier>,
  viewer: Pick<User, 'role'>,
  requested: unknown,
): Promise<string> {
  const defaultId = await getDefaultClassifierId(db, registry);
  if (requested === undefined) return defaultId;
  if (typeof requested !== 'string' || requested.length === 0 || requested.length > 64) {
    throw new HttpError(400, 'invalid classifier');
  }
  if (requested === defaultId) return defaultId;
  if (viewer.role !== 'master') throw new HttpError(403, 'forbidden');
  const { rows } = await db.query(`SELECT 1 FROM classifiers WHERE id = $1`, [requested]);
  if (rows.length === 0) throw new HttpError(404, 'unknown classifier');
  return requested;
}
