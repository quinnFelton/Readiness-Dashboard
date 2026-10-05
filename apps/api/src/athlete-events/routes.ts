import { Router } from 'express';
import type pg from 'pg';
import { HttpError } from '../connections/errors';
import { requireSelfOrMaster, requireUser } from '../middleware/rbac';
import {
  addDays,
  isIsoDate,
  isUuid,
  parseRangeDays,
  safeErrorHandler,
  todayUtc,
} from '../trends/http';
import { getPool } from '../users/pool';

export const EVENT_TYPES = ['illness', 'injury', 'race', 'planned_rest'] as const;
export const MAX_NOTES_CHARS = 1000;

export interface AthleteEventsRouterDeps {
  pool?: pg.Pool;
  now?: () => Date;
}

const cols = `id, to_char(date, 'YYYY-MM-DD') AS date, event_type, notes, created_by`;
const toEvent = (r: Record<string, unknown>) => ({
  id: r.id,
  date: r.date,
  eventType: r.event_type,
  notes: r.notes,
  createdBy: r.created_by,
});

/**
 * Outcomes logged after the fact, for backtesting classifiers (PLAN §8.7). Mount at
 * /api/v1/athlete-events (integrator). Every statement is scoped by the `:userId` that
 * requireSelfOrMaster authorised. `notes` is stored and returned, never logged (CLAUDE.md rule 6).
 */
export function athleteEventsRouter(deps: AthleteEventsRouterDeps = {}): Router {
  const pool = deps.pool ?? getPool();
  const now = deps.now ?? (() => new Date());
  const router = Router();

  router.get('/:userId', requireUser, requireSelfOrMaster('userId'), async (req, res) => {
    const userId = req.params.userId;
    if (!isUuid(userId)) throw new HttpError(400, 'invalid user id');
    const days = parseRangeDays(req.query.range, 90);
    const { rows } = await pool.query(
      `SELECT ${cols} FROM athlete_events
        WHERE user_id = $1 AND date >= $2::date ORDER BY date, created_at`,
      [userId, addDays(todayUtc(now()), -(days - 1))],
    );
    res.json({ userId, range: `${days}d`, events: rows.map(toEvent) });
  });

  router.post('/:userId', requireUser, requireSelfOrMaster('userId'), async (req, res) => {
    const userId = req.params.userId;
    if (!isUuid(userId)) throw new HttpError(400, 'invalid user id');
    const b = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<
      string,
      unknown
    >;
    if (!isIsoDate(b.date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
    if (
      typeof b.eventType !== 'string' ||
      !(EVENT_TYPES as readonly string[]).includes(b.eventType)
    ) {
      throw new HttpError(400, `eventType must be one of ${EVENT_TYPES.join(', ')}`);
    }
    if (
      b.notes !== undefined &&
      b.notes !== null &&
      (typeof b.notes !== 'string' || b.notes.length > MAX_NOTES_CHARS)
    ) {
      throw new HttpError(400, `notes must be a string of at most ${MAX_NOTES_CHARS} characters`);
    }
    const notes = typeof b.notes === 'string' && b.notes.trim() !== '' ? b.notes.trim() : null;
    const { rows } = await pool.query(
      `INSERT INTO athlete_events (user_id, date, event_type, notes, created_by)
       VALUES ($1, $2::date, $3, $4, $5) RETURNING ${cols}`,
      [userId, b.date, b.eventType, notes, req.user!.id],
    );
    res.status(201).json(toEvent(rows[0]));
  });

  router.delete('/:userId/:id', requireUser, requireSelfOrMaster('userId'), async (req, res) => {
    const { userId, id } = req.params;
    if (!isUuid(userId) || !isUuid(id)) throw new HttpError(400, 'invalid id');
    // Scoped by user_id: an event id belonging to someone else matches nothing here.
    const r = await pool.query(`DELETE FROM athlete_events WHERE id = $1 AND user_id = $2`, [
      id,
      userId,
    ]);
    if (r.rowCount === 0) throw new HttpError(404, 'event not found');
    res.status(204).end();
  });

  router.use(safeErrorHandler);
  return router;
}
