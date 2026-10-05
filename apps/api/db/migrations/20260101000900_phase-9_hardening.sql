-- Up Migration
-- Phase 9 (hardening). One file for the phase; additive only.

-- 1. Retry cap + terminal status for failed webhook events (stage E item: replayStravaEvents retried
--    a permanently failing event until the 30-day TTL removed it). `attempts` counts replay runs that
--    failed; once it reaches STRAVA_REPLAY_MAX_ATTEMPTS the row becomes 'abandoned' and is never
--    selected again. The cap itself is config, not a constant (CLAUDE.md rule 9).
ALTER TABLE webhook_events ADD COLUMN attempts SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE webhook_events DROP CONSTRAINT webhook_events_status_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_status_check
  CHECK (status IN ('pending','processed','failed','abandoned'));

-- 2. Security review M2: one local user per provider account. Webhook routing resolves
--    (provider, external_user_id) -> user and used to take rows[0] when two users shared an id.
--    Partial: Terra/Oura rows without an external id, and deactivated connections, don't count.
CREATE UNIQUE INDEX uq_provider_connections_external_active
  ON provider_connections (provider, external_user_id)
  WHERE external_user_id IS NOT NULL AND is_active;

-- 3. History rebuild bookkeeping (owner decision 2026-10-04: history is kept). trends and
--    readiness_scores are recomputed for the last BASELINE_LONG_DAYS on every ingest (PLAN §8.4); data
--    that lands older than that (a Terra 90-day backfill, an old Strava ride) or an erase leaves older
--    dates without rows. A request row says "rebuild this user from earliest_date". The rebuild job
--    (apps/api/src/fatigue-fitness/history-rebuild.ts) works through requests in bounded batches and
--    resumes from cursor_date. Per-person data: user_id PK, ON DELETE CASCADE (CLAUDE.md rule 4).
CREATE TABLE history_rebuild_requests (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  earliest_date DATE NOT NULL,             -- oldest date that needs (re)computing
  cursor_date   DATE,                      -- next date to process when a run stopped at its bound
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ                -- NULL = pending
);
CREATE INDEX idx_history_rebuild_pending ON history_rebuild_requests (requested_at)
  WHERE completed_at IS NULL;

-- 4. Per-function database roles (PLAN §11 least privilege; stage E item: every Lambda used to share
--    the Aurora master credential). One role per deployed function, each with exactly the table
--    privileges its handler's SQL needs (derived by reading the handlers; db-roles.test.ts pins the
--    exact set and also runs real handler code under each role).
--
--    Login is AWS IAM database authentication on Aurora: the roles have NO password and are members of
--    `rds_iam`, so the only way in is a short-lived IAM token for that one db user, granted per
--    function in infra/cdk (rds-db:connect). Locally the roles exist but cannot log in; tests use
--    SET ROLE. The master user (rd_admin) is then used only by the `migrate` function.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['rd_api', 'rd_hook_terra', 'rd_hook_strava', 'rd_hook_oura',
                           'rd_oura_sync', 'rd_strava_replay', 'rd_webhook_ttl', 'rd_history_rebuild']
  LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', r);
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'rds_iam') THEN
      EXECUTE format('GRANT rds_iam TO %I', r);
    END IF;
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
  END LOOP;
END $$;

-- REST API: every table, data only (no DDL, no TRUNCATE, no pgmigrations).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, provider_connections, connection_configs, daily_metrics, activity_efforts,
  readiness_scores, trends, insight_feedback, athlete_events, webhook_events,
  derivers, classifiers, history_rebuild_requests
TO rd_api;

-- The trend/readiness recompute that every ingest runs after writing (PLAN §8.4): read the inputs,
-- upsert trends and readiness_scores, and mark very old dates for the history rebuild.
GRANT SELECT ON connection_configs, daily_metrics, activity_efforts, derivers, classifiers
  TO rd_hook_terra, rd_hook_strava, rd_hook_oura, rd_oura_sync, rd_strava_replay, rd_history_rebuild;
GRANT SELECT, INSERT, UPDATE ON trends, readiness_scores, history_rebuild_requests
  TO rd_hook_terra, rd_hook_strava, rd_hook_oura, rd_oura_sync, rd_strava_replay, rd_history_rebuild;

-- Strava webhook + replay: refresh/rotate the user's token (SELECT ... FOR UPDATE + UPDATE), upsert
-- and delete efforts, keep the receipt log.
GRANT SELECT, UPDATE ON provider_connections TO rd_hook_strava, rd_strava_replay;
GRANT SELECT, INSERT, UPDATE, DELETE ON activity_efforts TO rd_hook_strava, rd_strava_replay;
GRANT SELECT, INSERT, UPDATE ON webhook_events TO rd_hook_strava, rd_strava_replay;

-- Oura webhook (also handles `delete` events) and the daily safety-net sync.
GRANT SELECT, UPDATE ON provider_connections TO rd_hook_oura, rd_oura_sync;
GRANT SELECT, INSERT, UPDATE, DELETE ON daily_metrics TO rd_hook_oura;
GRANT SELECT, INSERT, UPDATE ON daily_metrics TO rd_oura_sync;
GRANT SELECT, INSERT, UPDATE ON webhook_events TO rd_hook_oura;

-- Terra webhook: an `auth` event records the connection (existing user only: one column of `users`),
-- sleep events upsert daily metrics, every delivery leaves a receipt.
GRANT SELECT (id) ON users TO rd_hook_terra;
GRANT SELECT, INSERT, UPDATE ON provider_connections TO rd_hook_terra;
GRANT SELECT, INSERT, UPDATE ON connection_configs TO rd_hook_terra;
GRANT SELECT, INSERT, UPDATE ON daily_metrics TO rd_hook_terra;
GRANT SELECT, INSERT, UPDATE ON webhook_events TO rd_hook_terra;

-- webhook_events TTL sweep: delete by age, nothing else (it never reads a payload).
GRANT SELECT (received_at) ON webhook_events TO rd_webhook_ttl;
GRANT DELETE ON webhook_events TO rd_webhook_ttl;

-- Down Migration
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['rd_api', 'rd_hook_terra', 'rd_hook_strava', 'rd_hook_oura',
                           'rd_oura_sync', 'rd_strava_replay', 'rd_webhook_ttl', 'rd_history_rebuild']
  LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
END $$;
-- The roles themselves are cluster-wide and may be shared by other databases; drop them by hand if
-- they are really unused:  DROP ROLE rd_api, rd_hook_terra, ...;
DROP TABLE IF EXISTS history_rebuild_requests;
DROP INDEX IF EXISTS uq_provider_connections_external_active;
ALTER TABLE webhook_events DROP CONSTRAINT webhook_events_status_check;
UPDATE webhook_events SET status = 'failed' WHERE status = 'abandoned';
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_status_check
  CHECK (status IN ('pending','processed','failed'));
ALTER TABLE webhook_events DROP COLUMN attempts;
