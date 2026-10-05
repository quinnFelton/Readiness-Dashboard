import {
  type StrategyRegistry,
  type TrendClassifier,
  createClassifierRegistry,
} from '@rd/scoring-engine';
import { Router } from 'express';
import type pg from 'pg';
import { HttpError } from '../connections/errors';
import { requireSelfOrMaster, requireUser } from '../middleware/rbac';
import { getDefaultClassifierId } from '../trends/default-classifier';
import {
  addDays,
  isIsoDate,
  isUuid,
  parseRangeDays,
  safeErrorHandler,
  todayUtc,
} from '../trends/http';
import { getPool } from '../users/pool';

export const MAX_COMMENT_CHARS = 500;

export interface FeedbackRouterDeps {
  pool?: pg.Pool;
  classifiers?: StrategyRegistry<TrendClassifier>;
  now?: () => Date;
}

/**
 * Thumbs up/down on a flagged insight (PLAN §8.7). Mount at /api/v1/feedback (integrator).
 * `comment` is health-adjacent: it is stored and returned, never logged (CLAUDE.md rule 6).
 */
export function feedbackRouter(deps: FeedbackRouterDeps = {}): Router {
  const pool = deps.pool ?? getPool();
  const registry = deps.classifiers ?? createClassifierRegistry();
  const now = deps.now ?? (() => new Date());
  const router = Router();

  router.put('/:userId', requireUser, requireSelfOrMaster('userId'), async (req, res) => {
    const userId = req.params.userId;
    if (!isUuid(userId)) throw new HttpError(400, 'invalid user id');
    const body: unknown = req.body;
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    if (
      typeof b.classifierId !== 'string' ||
      b.classifierId.length === 0 ||
      b.classifierId.length > 64
    ) {
      throw new HttpError(400, 'classifierId is required');
    }
    if (!isIsoDate(b.asOf)) throw new HttpError(400, 'asOf must be YYYY-MM-DD');
    if (b.vote !== 1 && b.vote !== -1) throw new HttpError(400, 'vote must be 1 or -1');
    if (
      b.comment !== undefined &&
      b.comment !== null &&
      (typeof b.comment !== 'string' || b.comment.length > MAX_COMMENT_CHARS)
    ) {
      throw new HttpError(
        400,
        `comment must be a string of at most ${MAX_COMMENT_CHARS} characters`,
      );
    }
    const comment =
      typeof b.comment === 'string' && b.comment.trim() !== '' ? b.comment.trim() : null;

    // A plain user can only see (and so only rate) the default classifier's insights.
    if (
      req.user!.role !== 'master' &&
      b.classifierId !== (await getDefaultClassifierId(pool, registry))
    ) {
      throw new HttpError(403, 'forbidden');
    }

    // The vote must refer to an insight that exists; record the state the voter was looking at.
    const { rows: t } = await pool.query<{ direction: string }>(
      `SELECT direction FROM trends
        WHERE user_id = $1 AND classifier_id = $2 AND as_of = $3::date
          AND metric_type = 'fatigue_fitness_state' AND trend_window = '7d'`,
      [userId, b.classifierId, b.asOf],
    );
    const state = t[0]?.direction;
    if (!state) throw new HttpError(404, 'no insight for that classifier and date');

    // Idempotent on (user_id, classifier_id, as_of, voted_by): a re-vote updates in place.
    const { rows } = await pool.query(
      `INSERT INTO insight_feedback (user_id, classifier_id, as_of, state, vote, comment, voted_by)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7)
       ON CONFLICT (user_id, classifier_id, as_of, voted_by) DO UPDATE SET
         state = EXCLUDED.state, vote = EXCLUDED.vote, comment = EXCLUDED.comment, updated_at = now()
       RETURNING to_char(as_of, 'YYYY-MM-DD') AS as_of, classifier_id, state, vote, comment, voted_by`,
      [userId, b.classifierId, b.asOf, state, b.vote, comment, req.user!.id],
    );
    res.json(toVote(rows[0]));
  });

  router.get('/:userId', requireUser, requireSelfOrMaster('userId'), async (req, res) => {
    const userId = req.params.userId;
    if (!isUuid(userId)) throw new HttpError(400, 'invalid user id');
    const days = parseRangeDays(req.query.range, 90);
    const today = todayUtc(now());
    // Plain users only see votes on the default classifier; masters see every variant.
    const onlyDefault =
      req.user!.role === 'master' ? null : await getDefaultClassifierId(pool, registry);
    const { rows } = await pool.query(
      `SELECT to_char(as_of, 'YYYY-MM-DD') AS as_of, classifier_id, state, vote, comment, voted_by
         FROM insight_feedback
        WHERE user_id = $1 AND as_of BETWEEN $2::date AND $3::date
          AND ($4::text IS NULL OR classifier_id = $4)
        ORDER BY as_of, classifier_id, voted_by`,
      [userId, addDays(today, -(days - 1)), today, onlyDefault],
    );
    res.json({ userId, range: `${days}d`, votes: rows.map(toVote) });
  });

  router.use(safeErrorHandler);
  return router;
}

function toVote(r: Record<string, unknown> | undefined) {
  if (!r) throw new Error('missing feedback row');
  return {
    asOf: r.as_of,
    classifierId: r.classifier_id,
    state: r.state,
    vote: r.vote,
    comment: r.comment,
    votedBy: r.voted_by,
  };
}
