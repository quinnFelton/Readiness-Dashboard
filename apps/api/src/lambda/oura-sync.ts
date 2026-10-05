import { handler as syncHandler } from '../providers/oura/sync-job';
import { ensureBootstrapped } from './bootstrap';

// EventBridge Scheduler target (PLAN §5.1/§13). Oura webhooks are the primary path; this is the daily
// safety net, so it must NOT run often enough to keep Aurora awake. `{ "userId": "<uuid>" }` syncs one user.
export const handler = async (event: { userId?: string } = {}) => {
  await ensureBootstrapped();
  return syncHandler(event);
};
