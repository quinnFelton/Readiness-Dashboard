import {
  type StrategyRegistry,
  type TrendClassifier,
  createClassifierRegistry,
} from '@rd/scoring-engine';
import { Router } from 'express';
import type pg from 'pg';
import { HttpError } from '../connections/errors';
import { requireMaster, requireUser } from '../middleware/rbac';
import { addDays, parseRangeDays, safeErrorHandler, todayUtc } from '../trends/http';
import { getPool } from '../users/pool';
import {
  type BacktestConfig,
  type BacktestEvent,
  type BacktestFlag,
  backtestFlags,
  sumBacktests,
} from './backtest';
import { loadComparisonConfig } from './config';

export interface ComparisonRouterDeps {
  pool?: pg.Pool;
  classifiers?: StrategyRegistry<TrendClassifier>;
  config?: BacktestConfig;
  now?: () => Date;
}

const rate = (num: number, den: number): number | null => (den === 0 ? null : num / den);

/**
 * Master-only classifier/deriver comparison (PLAN §8.7, §8.8). Mount at /api/v1/comparison
 * (integrator). requireUser + requireMaster apply to every route in this router, server-side.
 */
export function comparisonRouter(deps: ComparisonRouterDeps = {}): Router {
  const pool = deps.pool ?? getPool();
  const registry = deps.classifiers ?? createClassifierRegistry();
  const config = deps.config ?? loadComparisonConfig();
  const now = deps.now ?? (() => new Date());
  const router = Router();
  router.use(requireUser, requireMaster);

  router.get('/classifiers', async (req, res) => {
    const days = parseRangeDays(req.query.range, 90);
    const today = todayUtc(now());
    const from = addDays(today, -(days - 1));

    const { rows: cls } = await pool.query<{
      id: string;
      description: string | null;
      is_default: boolean;
      up: string;
      down: string;
    }>(
      `SELECT c.id, c.description, c.is_default,
              COUNT(f.id) FILTER (WHERE f.vote = 1)  AS up,
              COUNT(f.id) FILTER (WHERE f.vote = -1) AS down
         FROM classifiers c
         LEFT JOIN insight_feedback f
           ON f.classifier_id = c.id AND f.as_of BETWEEN $1::date AND $2::date
        GROUP BY c.id ORDER BY c.created_at, c.id`,
      [from, today],
    );

    // Flags are fetched `leadDays` before the range start so events near the start still find
    // their warnings; the backtest only *counts* things dated >= from.
    const { rows: flagRows } = await pool.query<{
      user_id: string;
      classifier_id: string;
      as_of: string;
      direction: string;
    }>(
      `SELECT user_id, classifier_id, to_char(as_of, 'YYYY-MM-DD') AS as_of, direction
         FROM trends
        WHERE metric_type = 'fatigue_fitness_state' AND trend_window = '7d'
          AND direction = ANY($1::text[]) AND as_of BETWEEN $2::date AND $3::date`,
      [[...config.flagStates], addDays(from, -config.leadDays), today],
    );
    const { rows: eventRows } = await pool.query<{
      user_id: string;
      date: string;
      event_type: string;
    }>(
      `SELECT user_id, to_char(date, 'YYYY-MM-DD') AS date, event_type
         FROM athlete_events WHERE event_type = ANY($1::text[]) AND date >= $2::date`,
      [[...config.eventTypes], from],
    );

    const eventsByUser = new Map<string, BacktestEvent[]>();
    for (const e of eventRows) {
      const l = eventsByUser.get(e.user_id) ?? [];
      l.push({ date: e.date, eventType: e.event_type });
      eventsByUser.set(e.user_id, l);
    }
    const flagsByClassifier = new Map<string, Map<string, BacktestFlag[]>>();
    for (const f of flagRows) {
      const byUser = flagsByClassifier.get(f.classifier_id) ?? new Map<string, BacktestFlag[]>();
      const l = byUser.get(f.user_id) ?? [];
      l.push({ date: f.as_of, state: f.direction });
      byUser.set(f.user_id, l);
      flagsByClassifier.set(f.classifier_id, byUser);
    }

    const classifiers = cls.map((c) => {
      const up = Number(c.up);
      const down = Number(c.down);
      // Per athlete, never across athletes; then sum. Users with events but no flags still count
      // their events as missed.
      const flagsByUser = flagsByClassifier.get(c.id) ?? new Map<string, BacktestFlag[]>();
      const userIds = new Set([...flagsByUser.keys(), ...eventsByUser.keys()]);
      const bt = sumBacktests(
        [...userIds].map((u) =>
          backtestFlags(flagsByUser.get(u) ?? [], eventsByUser.get(u) ?? [], config, {
            evaluatedThrough: today,
            from,
          }),
        ),
      );
      return {
        id: c.id,
        description: c.description,
        isDefault: c.is_default,
        registered: registry.get(c.id) !== undefined,
        agreement: { up, down, rate: rate(up, up + down) },
        backtest: {
          ...bt,
          recall: rate(bt.eventsPreceded, bt.eventsConsidered),
          falseAlarmRate: rate(bt.falseAlarms, bt.flagsJudged),
        },
      };
    });
    res.json({
      range: `${days}d`,
      leadDays: config.leadDays,
      flagStates: config.flagStates,
      eventTypes: config.eventTypes,
      classifiers,
    });
  });

  // Promote a classifier to default. All variants already have rows (PLAN §8.7), so no recompute.
  router.put('/classifiers/:id/default', async (req, res) => {
    const id = req.params.id;
    // Refuse ids the running code can't execute: a default with no code behind it breaks every read.
    if (typeof id !== 'string' || registry.get(id) === undefined) {
      throw new HttpError(400, 'classifier is not registered in code');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT 1 FROM classifiers WHERE id = $1 FOR UPDATE`, [
        id,
      ]);
      if (rows.length === 0) throw new HttpError(404, 'unknown classifier');
      // Clear first: the partial unique index allows at most one is_default row at any instant.
      await client.query(
        `UPDATE classifiers SET is_default = false WHERE is_default AND id <> $1`,
        [id],
      );
      await client.query(`UPDATE classifiers SET is_default = true WHERE id = $1`, [id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      // Two concurrent promotions race on the unique index; the loser is told to retry.
      if ((err as { code?: string }).code === '23505') {
        throw new HttpError(409, 'another promotion is in progress; retry');
      }
      throw err;
    } finally {
      client.release();
    }
    res.json({ defaultClassifierId: id });
  });

  // TODO(§8.8): no promotion endpoint for derivers yet. Switching the default deriver changes the EF
  // series every classifier reads, so it needs a recompute of trends (and a decision about
  // history) first; build it together with that recompute job.
  router.get('/derivers', async (_req, res) => {
    const { rows } = await pool.query<{
      id: string;
      description: string | null;
      is_default: boolean;
    }>(`SELECT id, description, is_default FROM derivers ORDER BY created_at, id`);
    res.json({
      derivers: rows.map((r) => ({
        id: r.id,
        description: r.description,
        isDefault: r.is_default,
      })),
    });
  });

  router.use(safeErrorHandler);
  return router;
}
