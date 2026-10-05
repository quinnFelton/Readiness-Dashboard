import type pg from 'pg';
import { addDays, isIsoDate, todayUtc } from '../trends/http';
import type { FatigueFitnessService } from './service';

// Owner decision 2026-10-04: history is kept, so trends / readiness_scores must exist for EVERY date
// that has data, not just the last BASELINE_LONG_DAYS the ingest hook recomputes (PLAN §8.4). Gaps
// appear after (a) a Terra 90-day backfill, (b) an old Strava ride, (c) the erase path of disconnect.
//
// Design:
//  * `history_rebuild_requests` (one row per user) says "rebuild from earliest_date". It is written by
//    markHistoryDirty(): the recompute hook does it when an ingest touches a date older than its
//    window, and disconnect-with-erase does it for the whole history.
//  * runHistoryRebuild() works through pending requests in BOUNDED batches (max users and max dates
//    per invocation, config below) and resumes from cursor_date, so one Lambda invocation can never
//    run away on a long history.
//  * It is idempotent: it only calls FatigueFitnessService.onSyncComplete, which upserts on natural
//    keys, so re-running a date (or a whole request) converges on the same rows.
//  * Only dates that have data are processed (daily_metrics U activity_efforts), oldest first so
//    flagged_at runs forward in time like it would have live.
// Triggers: a daily schedule (infra/cdk), `aws lambda invoke` with {"userId": ..., "full": true} to
// force one user, or `pnpm --filter @rd/api rebuild-history` locally (scripts/rebuild-history.ts).

/** Sentinel for "the whole history". Earlier than any real data. */
export const FULL_HISTORY_FROM = '1970-01-01';

export interface HistoryRebuildConfig {
  /** Max distinct dates processed per user per invocation. HISTORY_REBUILD_MAX_DATES, default 120. */
  maxDatesPerUser: number;
  /** Max users handled per invocation. HISTORY_REBUILD_MAX_USERS, default 10. */
  maxUsers: number;
}

export function loadHistoryRebuildConfig(
  env: NodeJS.ProcessEnv = process.env,
): HistoryRebuildConfig {
  const pos = (raw: string | undefined, d: number) => {
    const n = Number(raw);
    return raw !== undefined && raw !== '' && Number.isInteger(n) && n >= 1 ? n : d;
  };
  return {
    maxDatesPerUser: pos(env.HISTORY_REBUILD_MAX_DATES, 120),
    maxUsers: pos(env.HISTORY_REBUILD_MAX_USERS, 10),
  };
}

type Queryable = pg.Pool | pg.PoolClient;

/**
 * Records that `userId` needs trend rows from `earliestDate` on. Idempotent; a pending request only
 * ever moves its start EARLIER, and a finished one restarts from the new date.
 */
export async function markHistoryDirty(
  db: Queryable,
  userId: string,
  earliestDate: string = FULL_HISTORY_FROM,
): Promise<void> {
  await db.query(
    `INSERT INTO history_rebuild_requests (user_id, earliest_date)
     VALUES ($1, $2::date)
     ON CONFLICT (user_id) DO UPDATE SET
       earliest_date = CASE WHEN history_rebuild_requests.completed_at IS NULL
                            THEN LEAST(history_rebuild_requests.earliest_date, EXCLUDED.earliest_date)
                            ELSE EXCLUDED.earliest_date END,
       cursor_date   = CASE WHEN history_rebuild_requests.completed_at IS NULL
                            THEN LEAST(history_rebuild_requests.cursor_date, EXCLUDED.earliest_date)
                            ELSE NULL END,
       requested_at  = now(),
       completed_at  = NULL`,
    [userId, earliestDate],
  );
}

export interface RebuildResult {
  /** Users that had work done this invocation. */
  users: number;
  /** Dates (re)computed. */
  dates: number;
  /** Dates whose computation threw; they are retried by the next full request, never silently lost. */
  failures: number;
  /** Requests still pending after this invocation (more runs needed). */
  pending: number;
}

export interface RebuildOptions {
  /** Rebuild exactly this user (creating the request if needed). */
  userId?: string;
  /** With userId: from the very beginning, regardless of any earlier progress. */
  full?: boolean;
  config?: HistoryRebuildConfig;
  now?: () => Date;
  log?: (message: string) => void;
}

interface RequestRow {
  user_id: string;
  earliest_date: string;
  cursor_date: string | null;
}

export async function runHistoryRebuild(
  pool: pg.Pool,
  svc: Pick<FatigueFitnessService, 'onSyncComplete'>,
  opts: RebuildOptions = {},
): Promise<RebuildResult> {
  const cfg = opts.config ?? loadHistoryRebuildConfig();
  const log = opts.log ?? ((m: string) => console.warn(m));
  const today = todayUtc((opts.now ?? (() => new Date()))());

  if (opts.userId && opts.full) {
    // A forced rebuild really starts from the beginning: drop any earlier progress, then queue the
    // whole history. (Without `full`, a userId just means "work only on this user's pending request".)
    await pool.query(`DELETE FROM history_rebuild_requests WHERE user_id = $1`, [opts.userId]);
    await markHistoryDirty(pool, opts.userId, FULL_HISTORY_FROM);
  }

  const { rows } = await pool.query<RequestRow>(
    `SELECT user_id,
            to_char(earliest_date, 'YYYY-MM-DD') AS earliest_date,
            to_char(cursor_date, 'YYYY-MM-DD') AS cursor_date
       FROM history_rebuild_requests
      WHERE completed_at IS NULL AND ($1::uuid IS NULL OR user_id = $1)
      ORDER BY requested_at
      LIMIT $2`,
    [opts.userId ?? null, cfg.maxUsers],
  );

  const out: RebuildResult = { users: 0, dates: 0, failures: 0, pending: 0 };
  for (const req of rows) {
    const done = await rebuildOneUser(pool, svc, req, cfg, today, log);
    if (!done) continue; // another invocation holds this user
    out.users++;
    out.dates += done.dates;
    out.failures += done.failures;
  }
  out.pending = (
    await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM history_rebuild_requests WHERE completed_at IS NULL`,
    )
  ).rows[0]!.n;
  return out;
}

async function rebuildOneUser(
  pool: pg.Pool,
  svc: Pick<FatigueFitnessService, 'onSyncComplete'>,
  req: RequestRow,
  cfg: HistoryRebuildConfig,
  today: string,
  log: (m: string) => void,
): Promise<{ dates: number; failures: number } | null> {
  // One rebuilder per user at a time (overlapping schedule + manual invoke): a session advisory lock
  // on a dedicated connection, released in `finally`.
  const lock = await pool.connect();
  try {
    const got = await lock.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`,
      [`history-rebuild:${req.user_id}`],
    );
    if (!got.rows[0]!.ok) return null;
    try {
      const from = req.cursor_date ?? req.earliest_date;
      const { rows } = await pool.query<{ d: string }>(
        `SELECT to_char(d, 'YYYY-MM-DD') AS d FROM (
           SELECT date AS d FROM daily_metrics   WHERE user_id = $1 AND date >= $2::date
           UNION
           SELECT date AS d FROM activity_efforts WHERE user_id = $1 AND date >= $2::date
         ) t
         WHERE d <= $3::date
         ORDER BY d
         LIMIT $4`,
        [req.user_id, from, today, cfg.maxDatesPerUser],
      );
      let failures = 0;
      for (const { d } of rows) {
        try {
          // 'daily_metrics' computes readiness AND trends for the day (an activity-only day just
          // gets its trend row; the readiness pass is a no-op without recovery data).
          await svc.onSyncComplete(req.user_id, 'daily_metrics', d);
        } catch (err) {
          failures++;
          // Class name only: messages can quote health values (CLAUDE.md rule 6).
          log(`history rebuild failed for a date: ${err instanceof Error ? err.name : 'Error'}`);
        }
      }
      const hitBound = rows.length === cfg.maxDatesPerUser;
      if (hitBound) {
        // More dates may remain: resume the day after the last one processed.
        await pool.query(
          `UPDATE history_rebuild_requests SET cursor_date = $2::date WHERE user_id = $1`,
          [req.user_id, addDays(rows[rows.length - 1]!.d, 1)],
        );
      } else {
        await pool.query(
          `UPDATE history_rebuild_requests SET completed_at = now(), cursor_date = NULL
            WHERE user_id = $1`,
          [req.user_id],
        );
      }
      return { dates: rows.length, failures };
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [
        `history-rebuild:${req.user_id}`,
      ]);
    }
  } finally {
    lock.release();
  }
}

/** The oldest of `dates` that is outside the recompute window, or undefined when none is. */
export function oldestOutsideWindow(
  dates: Iterable<string> | undefined,
  today: string,
  maxBackDays: number,
): string | undefined {
  const earliest = addDays(today, -(maxBackDays - 1));
  let oldest: string | undefined;
  for (const d of dates ?? []) {
    if (isIsoDate(d) && d < earliest && (oldest === undefined || d < oldest)) oldest = d;
  }
  return oldest;
}
