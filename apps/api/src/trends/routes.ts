import {
  type StrategyRegistry,
  type TrendClassifier,
  createClassifierRegistry,
} from '@rd/scoring-engine';
import { Router } from 'express';
import type pg from 'pg';
import { HttpError } from '../connections/errors';
import { requireSelfOrMaster, requireUser } from '../middleware/rbac';
import { getPool } from '../users/pool';
import { resolveClassifierForViewer } from './default-classifier';
import { isUuid, parseRangeDays, safeErrorHandler, todayUtc } from './http';
import { TrendService } from './trend-service';

export interface ReadRouterDeps {
  pool?: pg.Pool;
  classifiers?: StrategyRegistry<TrendClassifier>;
  now?: () => Date;
}

type Kind = 'trends' | 'scores';

/**
 * GET /:userId?range=28d[&classifier=<id>] — serves precomputed rows only.
 * Authorization: requireUser, then requireSelfOrMaster('userId') (403 for another user's id).
 * `?classifier=` for a non-default id is master-only (403 for a plain user).
 */
function readRouter(kind: Kind, deps: ReadRouterDeps): Router {
  const pool = deps.pool ?? getPool();
  const registry = deps.classifiers ?? createClassifierRegistry();
  const now = deps.now ?? (() => new Date());
  const service = new TrendService(pool);

  const router = Router();
  router.get('/:userId', requireUser, requireSelfOrMaster('userId'), async (req, res) => {
    const userId = req.params.userId;
    if (!isUuid(userId)) throw new HttpError(400, 'invalid user id');
    const days = parseRangeDays(req.query.range, 28);
    const classifierId = await resolveClassifierForViewer(
      pool,
      registry,
      req.user!,
      req.query.classifier,
    );
    const today = todayUtc(now());
    if (kind === 'trends') {
      const trends = await service.getTrends(userId, classifierId, days, today);
      res.json({ userId, classifierId, range: `${days}d`, trends });
    } else {
      const scores = await service.getScores(userId, classifierId, days, today);
      res.json({ userId, classifierId, range: `${days}d`, scores });
    }
  });
  router.use(safeErrorHandler);
  return router;
}

/** Mount at /api/v1/trends (integrator). */
export const trendsRouter = (deps: ReadRouterDeps = {}): Router => readRouter('trends', deps);

/** Mount at /api/v1/scores (integrator). Re-exported from scores/routes.ts. */
export const scoresRouter = (deps: ReadRouterDeps = {}): Router => readRouter('scores', deps);
