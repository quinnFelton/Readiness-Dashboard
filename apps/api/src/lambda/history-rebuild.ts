import { defaultRegistry } from '@rd/provider-adapters';
import { ConnectionConfigService } from '../connections/config-service';
import { runHistoryRebuild } from '../fatigue-fitness/history-rebuild';
import { FatigueFitnessService } from '../fatigue-fitness/service';
import { getPool } from '../users/pool';
import { ensureBootstrapped } from './bootstrap';

// Rebuilds trends / readiness_scores for every date that has data (owner decision 2026-10-04:
// history is kept). See fatigue-fitness/history-rebuild.ts for the design.
//
// Triggers:
//  * daily EventBridge schedule (empty event): works through pending requests, bounded per run
//    (HISTORY_REBUILD_MAX_USERS / HISTORY_REBUILD_MAX_DATES). Requests are queued by the ingest hook
//    (data older than the recompute window) and by disconnect-with-erase.
//  * by hand, after a backfill or an erase:
//      aws lambda invoke --function-name rd-<stage>-history-rebuild \
//        --payload '{"userId":"<uuid>","full":true}' --cli-binary-format raw-in-base64-out out.json
//    `full` restarts that user from the beginning. Re-invoke until the result's "pending" is 0.
// Returns counts only (never ids, values or messages: CLAUDE.md rule 6).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HistoryRebuildEvent {
  userId?: string;
  full?: boolean;
}

export const handler = async (event: HistoryRebuildEvent = {}) => {
  if (event.userId !== undefined && !UUID_RE.test(event.userId)) {
    throw new Error('userId must be a UUID');
  }
  await ensureBootstrapped();
  const pool = getPool();
  const svc = new FatigueFitnessService(pool, new ConnectionConfigService(pool, defaultRegistry));
  return runHistoryRebuild(pool, svc, { userId: event.userId, full: event.full === true });
};
