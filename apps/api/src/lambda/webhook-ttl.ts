import type pg from 'pg';
import { getPool } from '../users/pool';
import { ensureBootstrapped } from './bootstrap';

// PLAN §13: webhook_events is a debugging/audit log and the only place raw-ish payloads briefly exist,
// so TTL it. Uses idx_webhook_events_received_at (phase-2 migration).

export const DEFAULT_TTL_DAYS = 30;

export function resolveDays(eventDays: unknown, env: NodeJS.ProcessEnv = process.env): number {
  for (const raw of [eventDays, env.WEBHOOK_TTL_DAYS]) {
    const n = Number(raw);
    if (raw !== undefined && raw !== '' && Number.isInteger(n) && n >= 1) return n;
  }
  return DEFAULT_TTL_DAYS;
}

export async function deleteOldWebhookEvents(pool: pg.Pool, days: number): Promise<number> {
  const res = await pool.query(
    `DELETE FROM webhook_events WHERE received_at < now() - make_interval(days => $1)`,
    [days],
  );
  return res.rowCount ?? 0;
}

/** `{ "days": 14 }` overrides WEBHOOK_TTL_DAYS for a one-off run. Returns a count only. */
export const handler = async (event: { days?: number } = {}) => {
  await ensureBootstrapped();
  const days = resolveDays(event.days);
  return { days, deleted: await deleteOldWebhookEvents(getPool(), days) };
};
