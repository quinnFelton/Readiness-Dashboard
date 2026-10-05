import type pg from 'pg';
import { lazyStravaIngest } from '../providers/register-all';
import type { StravaIngestService } from '../providers/strava/strava-ingest-service';
import { getPool } from '../users/pool';
import { replayStravaEvents } from '../webhooks/strava/routes';
import { ensureBootstrapped } from './bootstrap';

// PLAN §13 (no SQS/Step Functions). The Strava webhook answers within ~1.5 s and finishes ingest in
// the background; Lambda freezes the process after the response, so slow ingests stay `pending` (and
// rate-limited ones `failed`). This scheduled job completes them. Replays are idempotent upserts.
// Env: STRAVA_REPLAY_LIMIT (default 25), STRAVA_REPLAY_PENDING_AFTER_SEC (default 120).

export interface ReplayDeps {
  pool: pg.Pool;
  ingest: StravaIngestService;
}

export async function runReplay(
  deps: ReplayDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ replayed: number }> {
  const replayed = await replayStravaEvents(deps.pool, deps.ingest, {
    limit: positive(env.STRAVA_REPLAY_LIMIT, 25),
    pendingAfterSec: positive(env.STRAVA_REPLAY_PENDING_AFTER_SEC, 120),
  });
  return { replayed };
}

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const handler = async () => {
  await ensureBootstrapped();
  return runReplay({ pool: getPool(), ingest: lazyStravaIngest() });
};
