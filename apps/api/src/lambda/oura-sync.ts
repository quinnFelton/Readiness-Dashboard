import { handler as syncHandler } from '../providers/oura/sync-job';
import { ensureBootstrapped } from './bootstrap';

// EventBridge Scheduler target (PLAN §5.1/§13). Oura webhooks are the primary path; this is the daily
// safety net, so it must NOT run often enough to keep Aurora awake. `{ "userId": "<uuid>" }` syncs one user.

/** infra/cdk's CloudWatch metric filter matches this exact token (observability-stack.ts). */
export const SYNC_FAILURE_MARKER = 'oura_sync_failures';
// Not failures: nothing to sync / another run holds the per-user lock.
const BENIGN = new Set(['NotConnected', 'SyncInProgress']);

export const handler = async (event: { userId?: string } = {}) => {
  await ensureBootstrapped();
  const out = await syncHandler(event);
  // The job isolates per-user failures and returns normally, so Lambda "Errors" never fires. Emit a
  // counts-only marker line for the alarm (no user ids, no messages: CLAUDE.md rule 6).
  const failed = Object.values(out.results).filter(
    (r) => !r.ok && !BENIGN.has(r.error ?? ''),
  ).length;
  if (failed > 0) console.error(`${SYNC_FAILURE_MARKER} ${JSON.stringify({ failed })}`);
  return out;
};
