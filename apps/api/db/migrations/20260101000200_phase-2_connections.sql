-- Up Migration
-- PLAN §7 (phase 2): provider_connections, connection_configs, daily_metrics,
-- activity_efforts, webhook_events. Matches the plan verbatim except where marked "phase-2 addition".

CREATE TABLE provider_connections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL CHECK (provider IN ('oura','strava','terra')),
  role                TEXT NOT NULL CHECK (role IN ('activity_source','daily_metrics_source')),
  external_user_id    TEXT,               -- Terra's user_id, Oura/Strava athlete id
  access_token_enc    BYTEA,              -- KMS-encrypted (local AES-GCM in dev), see TokenCipher
  refresh_token_enc   BYTEA,              -- KMS-encrypted
  expires_at          TIMESTAMPTZ,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  last_synced_at      TIMESTAMPTZ,
  connected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

-- which connection is authoritative per role, per user
CREATE TABLE connection_configs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                TEXT NOT NULL CHECK (role IN ('activity_source','daily_metrics_source')),
  provider            TEXT NOT NULL,
  priority            SMALLINT NOT NULL DEFAULT 0,  -- for daily_metrics_source: lower = preferred on conflict
  UNIQUE (user_id, role, provider)
);
-- phase-2 addition: PLAN §6 says exactly ONE active activity source per user; enforce it in the DB too.
CREATE UNIQUE INDEX uq_connection_configs_one_activity_source
  ON connection_configs (user_id) WHERE role = 'activity_source';

CREATE TABLE daily_metrics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  source          TEXT NOT NULL,       -- 'oura' | 'terra' | future adapters
  metric_type     TEXT NOT NULL,       -- 'hrv' | 'resting_hr' | 'sleep_score' | 'readiness'
  value           NUMERIC NOT NULL,
  derivation_version SMALLINT NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, date, source, metric_type)
);
CREATE INDEX idx_daily_metrics_user_date ON daily_metrics (user_id, date);

-- derived, scalar-only — no raw stream data retained (§8, §13)
CREATE TABLE activity_efforts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_activity_id TEXT NOT NULL,
  source              TEXT NOT NULL,
  date                DATE NOT NULL,
  duration_sec        INTEGER NOT NULL,
  avg_power           NUMERIC,
  normalized_power     NUMERIC,
  avg_hr              NUMERIC NOT NULL,
  peak20_power         NUMERIC,
  peak20_avg_hr        NUMERIC,
  ef_overall           NUMERIC,          -- normalized_power / avg_hr
  ef_peak20            NUMERIC,          -- peak20_power / peak20_avg_hr
  derivation_version   SMALLINT NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, external_activity_id)
);
CREATE INDEX idx_activity_efforts_user_date ON activity_efforts (user_id, date);

-- short-retention audit/replay log, not for analytics (§13: TTL ~30 days)
CREATE TABLE webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        TEXT NOT NULL,
  payload_jsonb   JSONB NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  status          TEXT CHECK (status IN ('pending','processed','failed'))
);
-- phase-2 addition: supports the §13 TTL sweep (delete where received_at < now() - 30d).
CREATE INDEX idx_webhook_events_received_at ON webhook_events (received_at);

-- Down Migration
DROP TABLE webhook_events;
DROP TABLE activity_efforts;
DROP TABLE daily_metrics;
DROP TABLE connection_configs;
DROP TABLE provider_connections;
