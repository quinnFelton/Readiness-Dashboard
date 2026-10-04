import type { TerraClient } from '@rd/provider-adapters';
import type pg from 'pg';

// PLAN §5.3: ONE-TIME historical backfill right after connect — never a poller. Terra delivers the
// history asynchronously to our own webhook (to_webhook=true), where it goes through the same
// verify -> webhook_events -> normalize -> idempotent upsert path as live data. So re-running is safe.

export interface BackfillConfig {
  /** How far back to ask for. Config, not a constant (CLAUDE.md rule 9). */
  days: number;
}

export const backfillConfigFromEnv = (env = process.env): BackfillConfig => ({
  days: Math.max(1, Number(env.TERRA_BACKFILL_DAYS) || 90),
});

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Requests the backfill once per connection: guarded by provider_connections.last_synced_at IS NULL
 * (set only after Terra accepted the request), so retried `auth` webhooks and reconnects of an
 * already-backfilled row don't re-request. Failures propagate (the webhook replies 5xx and Terra
 * retries with backoff); last_synced_at stays NULL so the retry re-attempts.
 */
export async function runTerraBackfillOnce(
  pool: pg.Pool,
  client: TerraClient,
  userId: string,
  terraUserId: string,
  cfg: BackfillConfig,
  now: () => Date = () => new Date(),
): Promise<'requested' | 'skipped'> {
  const { rows } = await pool.query<{ last_synced_at: Date | null }>(
    `SELECT last_synced_at FROM provider_connections WHERE user_id = $1 AND provider = 'terra'`,
    [userId],
  );
  if (rows.length === 0 || rows[0]!.last_synced_at !== null) return 'skipped';

  const end = now();
  const start = new Date(end.getTime() - cfg.days * 86_400_000);
  // end_date is exclusive; +1 day so today's sleep is included.
  const endExclusive = new Date(end.getTime() + 86_400_000);
  await client.requestSleepBackfill({
    terraUserId,
    startDate: ymd(start),
    endDate: ymd(endExclusive),
  });
  await pool.query(
    `UPDATE provider_connections SET last_synced_at = $2 WHERE user_id = $1 AND provider = 'terra'`,
    [userId, end],
  );
  return 'requested';
}
