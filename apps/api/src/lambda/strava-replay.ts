import type pg from 'pg';
import { lazyStravaIngest } from '../providers/register-all';
import type { StravaIngestService } from '../providers/strava/strava-ingest-service';
import { getPool } from '../users/pool';
import { replayStravaEvents } from '../webhooks/strava/routes';
import { ensureBootstrapped } from './bootstrap';

// PLAN §13 (no SQS/Step Functions). The Strava webhook answers within ~1.5 s and finishes ingest in
// the background; Lambda freezes the process after the response, so slow ingests stay `pending` (and
// rate-limited ones `failed`). This job completes them. Replays are idempotent upserts.
//
// Triggers (cost: a fixed few-minute tick would keep Aurora awake 24/7, so it is NOT the default):
//  1. the Strava webhook Lambda async-invokes this right after answering a POST (the DB is already
//     awake then) with `{ "pendingAfterSec": 0 }` so a slow ingest is finished immediately;
//  2. a slow fallback schedule (context `stravaReplaySchedule`) catches `failed` (rate-limited) rows.
// Env: STRAVA_REPLAY_LIMIT (default 25), STRAVA_REPLAY_PENDING_AFTER_SEC (default 120).

export interface ReplayDeps {
  pool: pg.Pool;
  ingest: StravaIngestService;
}

export interface ReplayEvent {
  pendingAfterSec?: number;
  limit?: number;
}

export async function runReplay(
  deps: ReplayDeps,
  env: NodeJS.ProcessEnv = process.env,
  event: ReplayEvent = {},
): Promise<{ replayed: number }> {
  const replayed = await replayStravaEvents(deps.pool, deps.ingest, {
    limit: positive(event.limit ?? env.STRAVA_REPLAY_LIMIT, 25),
    pendingAfterSec:
      typeof event.pendingAfterSec === 'number' && event.pendingAfterSec >= 0
        ? event.pendingAfterSec
        : positive(env.STRAVA_REPLAY_PENDING_AFTER_SEC, 120),
  });
  return { replayed };
}

function positive(raw: string | number | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const handler = async (event: ReplayEvent = {}) => {
  await ensureBootstrapped();
  return runReplay({ pool: getPool(), ingest: lazyStravaIngest() }, process.env, event);
};
