// E2E seed (run as a child process of globalSetup, via tsx from apps/api so workspace packages and
// TS source resolve exactly as they do for the real API).
//
// 1. Reuses apps/api/db/seed to create the deterministic accounts.
// 2. For the seed accounts that need data: inserts daily_metrics + activity_efforts (scalars only, as
//    in production), provider_connections and connection_configs.
// 3. Produces trends / readiness_scores by calling FatigueFitnessService.onSyncComplete, never by
//    inserting trend rows by hand.
//
// Idempotent and limited to the seed accounts: every run first wipes the *e2e-owned* tables for the
// accounts listed in `USERS` (the mutating flows leave them changed), then re-inserts relative to
// today (the dashboard windows are "last 28/90 days from now").
// Relative (not `@rd/…`): tests/e2e has no workspace deps of its own.
import { defaultRegistry } from '../../../packages/provider-adapters/src/index';
import { runSeed } from '../../../apps/api/db/seed/seed';
import { ConnectionConfigService } from '../../../apps/api/src/connections/config-service';
import { FatigueFitnessService } from '../../../apps/api/src/fatigue-fitness/service';
import { closePool, getPool } from '../../../apps/api/src/users/pool';
import { USERS } from './env';

const DAY_MS = 86_400_000;
const DAYS = 28;

const dayStr = (daysAgo: number): string =>
  new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS - daysAgo * DAY_MS).toISOString().slice(0, 10);

/**
 * Deterministic "fitness gain" story: over the last week efficiency rises while HRV rises and
 * resting HR falls. i = days ago (0 = today).
 */
export function dailyValues(i: number): { hrv: number; resting_hr: number; sleep_score: number } {
  const wobble = ((i * 7) % 5) - 2; // -2..2, deterministic
  const recent = i < 7;
  return {
    hrv: (recent ? 68 : 60) + wobble,
    resting_hr: (recent ? 50 : 54) - wobble / 2,
    sleep_score: 80 + wobble,
  };
}

/** A ride every other day (EF is sparse by design, PLAN §8.1). */
export function rideEf(i: number): { efPeak20: number; efOverall: number } | null {
  if (i % 2 !== 0) return null;
  const wobble = ((i * 3) % 5) - 2;
  const recent = i < 7;
  return {
    efPeak20: (recent ? 1.72 : 1.55) + wobble * 0.01,
    efOverall: (recent ? 1.62 : 1.45) + wobble * 0.01,
  };
}

async function resetUser(userId: string): Promise<void> {
  const pool = getPool();
  // Every table that holds per-user e2e state (CLAUDE.md rule 4: all of them have user_id).
  for (const table of [
    'insight_feedback',
    'athlete_events',
    'trends',
    'readiness_scores',
    'daily_metrics',
    'activity_efforts',
    'connection_configs',
    'provider_connections',
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
  }
}

async function insertData(userId: string): Promise<void> {
  const pool = getPool();
  for (let i = 0; i < DAYS; i++) {
    const date = dayStr(i);
    for (const [metric, value] of Object.entries(dailyValues(i))) {
      await pool.query(
        `INSERT INTO daily_metrics (user_id, date, source, metric_type, value)
         VALUES ($1, $2::date, 'oura', $3, $4)
         ON CONFLICT (user_id, date, source, metric_type) DO UPDATE SET value = EXCLUDED.value`,
        [userId, date, metric, value],
      );
    }
    const ef = rideEf(i);
    if (ef) {
      const avgHr = 140;
      const peakHr = 150;
      await pool.query(
        `INSERT INTO activity_efforts
           (user_id, external_activity_id, source, date, duration_sec, avg_power, normalized_power,
            avg_hr, peak20_power, peak20_avg_hr, ef_overall, ef_peak20, deriver_id)
         VALUES ($1, $2, 'strava', $3::date, 3600, $4, $5, $6, $7, $8, $9, $10, 'peak20_v1')
         ON CONFLICT (user_id, external_activity_id, deriver_id) DO UPDATE SET
           ef_overall = EXCLUDED.ef_overall, ef_peak20 = EXCLUDED.ef_peak20, date = EXCLUDED.date`,
        [
          userId,
          `e2e-ride-${i}`,
          date,
          Math.round(ef.efOverall * avgHr),
          Math.round(ef.efOverall * avgHr),
          avgHr,
          Math.round(ef.efPeak20 * peakHr),
          peakHr,
          ef.efOverall,
          ef.efPeak20,
        ],
      );
    }
  }
  // Connected providers. Tokens stay NULL: these rows exist for the UI/disconnect, nothing syncs.
  await pool.query(
    `INSERT INTO provider_connections (user_id, provider, role, external_user_id, last_synced_at)
     VALUES ($1, 'oura', 'daily_metrics_source', 'oura-seed', now()),
            ($1, 'strava', 'activity_source', 'strava-seed', now())
     ON CONFLICT (user_id, provider) DO UPDATE SET is_active = true`,
    [userId],
  );
  await pool.query(
    `INSERT INTO connection_configs (user_id, role, provider, priority)
     VALUES ($1, 'daily_metrics_source', 'oura', 0), ($1, 'activity_source', 'strava', 0)
     ON CONFLICT (user_id, role, provider) DO NOTHING`,
    [userId],
  );
}

async function main(): Promise<void> {
  const pool = getPool();
  await runSeed(); // accounts
  const { rows } = await pool.query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE email = ANY($1)`,
    [Object.values(USERS)],
  );
  const idOf = (email: string): string => {
    const id = rows.find((r) => r.email === email)?.id;
    if (!id) throw new Error(`seed account missing: ${email}`);
    return id;
  };

  for (const email of Object.values(USERS)) await resetUser(idOf(email));

  const fatigueFitness = new FatigueFitnessService(
    pool,
    new ConnectionConfigService(pool, defaultRegistry),
  );
  for (const email of [USERS.viewer, USERS.disconnecter]) {
    const userId = idOf(email);
    await insertData(userId);
    // A week of classifier history so the dashboard has a state timeline, not a single point.
    for (let i = 6; i >= 0; i--) {
      const out = await fatigueFitness.onSyncComplete(userId, 'daily_metrics', dayStr(i));
      if (!out.ran)
        throw new Error(`classifier did not run for ${email} @${dayStr(i)}: ${out.skipReason}`);
    }
  }
  console.log('e2e seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
