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

-- Down Migration
DROP INDEX uq_provider_connections_external_active;
ALTER TABLE webhook_events DROP CONSTRAINT webhook_events_status_check;
UPDATE webhook_events SET status = 'failed' WHERE status = 'abandoned';
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_status_check
  CHECK (status IN ('pending','processed','failed'));
ALTER TABLE webhook_events DROP COLUMN attempts;
