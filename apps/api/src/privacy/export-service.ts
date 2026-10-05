import type pg from 'pg';

// PLAN §12: per-user export of everything stored about the user. Explicit column lists on purpose:
// `*_token_enc` must never be exported (a new secret column should not leak by default), while every
// other column of every per-user table is included. privacy.test.ts drives the table list from
// information_schema, so a new per-user table fails the test until it is exported here and deleted.
//
// History kept from disconnected providers (owner decision 2026-10-04) is exported like any other
// row: daily_metrics / activity_efforts are selected by user_id, not by "currently connected".
//
// Everything is read in ONE repeatable-read transaction so the document is a consistent snapshot even
// while a webhook is writing. Size is bounded by one person's scalars (a few thousand small rows), so
// it is built in memory; revisit with streaming if a user ever has years of high-frequency data.

export const EXPORT_FORMAT_VERSION = 1;

const D = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;

const QUERIES: Record<string, string> = {
  providerConnections: `SELECT id, provider, role, external_user_id, expires_at, is_active,
         last_synced_at, connected_at
       FROM provider_connections WHERE user_id = $1 ORDER BY provider`,
  connectionConfigs: `SELECT id, role, provider, priority
       FROM connection_configs WHERE user_id = $1 ORDER BY role, priority, provider`,
  dailyMetrics: `SELECT id, ${D('date')} AS date, source, metric_type, value, derivation_version,
         created_at
       FROM daily_metrics WHERE user_id = $1 ORDER BY date, source, metric_type`,
  activityEfforts: `SELECT id, deriver_id, external_activity_id, source,${D('date')} AS date, duration_sec,
         avg_power, normalized_power, avg_hr, peak20_power, peak20_avg_hr, ef_overall, ef_peak20,
         training_load, training_load_method, derivation_version, created_at
       FROM activity_efforts WHERE user_id = $1 ORDER BY date, external_activity_id`,
  readinessScores: `SELECT id, ${D('date')} AS date, score, components_jsonb, computed_at
       FROM readiness_scores WHERE user_id = $1 ORDER BY date`,
  trends: `SELECT id, classifier_id, ${D('as_of')} AS as_of, metric_type, trend_window, z_score,
         recovery_z, direction, insight_text, flagged_at
       FROM trends WHERE user_id = $1 ORDER BY as_of, classifier_id, metric_type, trend_window`,
  // Feedback about this person's insights (by anyone) ...
  insightFeedbackAbout: `SELECT id, classifier_id, ${D('as_of')} AS as_of, state, vote, comment,
         voted_by, created_at, updated_at
       FROM insight_feedback WHERE user_id = $1 ORDER BY as_of, classifier_id`,
  // ... and votes this person cast on anyone's (their own authored data).
  insightFeedbackGiven: `SELECT id, user_id AS athlete_id, classifier_id, ${D('as_of')} AS as_of,
         state, vote, comment, created_at, updated_at
       FROM insight_feedback WHERE voted_by = $1 AND user_id <> $1 ORDER BY as_of, classifier_id`,
  athleteEvents: `SELECT id, ${D('date')} AS date, event_type, notes, created_by, created_at
       FROM athlete_events WHERE user_id = $1 ORDER BY date, created_at`,
  // Receipts not yet removed by the 30-day sweep (PLAN §13). Includes the stored notification.
  webhookEvents: `SELECT id, provider, payload_jsonb, received_at, processed_at, status, attempts
       FROM webhook_events WHERE user_id = $1 ORDER BY received_at`,
};

export interface UserExport {
  formatVersion: number;
  exportedAt: string;
  user: { id: string; email: string; name: string | null; role: string; createdAt: string };
  [section: string]: unknown;
}

export async function exportUserData(
  pool: pg.Pool,
  userId: string,
  now: () => Date = () => new Date(),
): Promise<UserExport | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const u = await client.query<{
      id: string;
      email: string;
      name: string | null;
      role: string;
      created_at: Date;
    }>(`SELECT id, email, name, role, created_at FROM users WHERE id = $1`, [userId]);
    const user = u.rows[0];
    if (!user) {
      await client.query('ROLLBACK');
      return null;
    }
    const sections: Record<string, unknown[]> = {};
    for (const [name, sql] of Object.entries(QUERIES)) {
      sections[name] = (await client.query(sql, [userId])).rows;
    }
    await client.query('COMMIT');
    return {
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: now().toISOString(),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        createdAt: user.created_at.toISOString(),
      },
      ...sections,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
