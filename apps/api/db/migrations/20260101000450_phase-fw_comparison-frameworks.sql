-- Up Migration
-- Side-by-side variants (PLAN §8.7 classifiers, §8.8 activity-effort derivers).
-- Registry tables are global config (no user_id): they describe methods, not anyone's data.
-- Ids match the code registries in @rd/scoring-engine; exactly one row per table is_default.

CREATE TABLE derivers (
  id           TEXT PRIMARY KEY,
  description  TEXT,
  is_default   BOOLEAN NOT NULL DEFAULT false,   -- the one whose rows feed the live classifier
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_derivers_one_default ON derivers (is_default) WHERE is_default;
INSERT INTO derivers (id, description, is_default)
VALUES ('peak20_v1', 'Best rolling 20-min power with matched-window HR (PLAN §8.1)', true);

CREATE TABLE classifiers (
  id           TEXT PRIMARY KEY,
  description  TEXT,
  is_default   BOOLEAN NOT NULL DEFAULT false,   -- the one the dashboard shows
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_classifiers_one_default ON classifiers (is_default) WHERE is_default;
INSERT INTO classifiers (id, description, is_default)
VALUES ('ef_quadrant_v1', 'EF × recovery quadrant, default thresholds (PLAN §8.3)', true);

-- One activity_efforts row per (activity, deriver). Existing rows were all made by peak20_v1.
ALTER TABLE activity_efforts
  ADD COLUMN deriver_id TEXT NOT NULL DEFAULT 'peak20_v1' REFERENCES derivers(id);
ALTER TABLE activity_efforts DROP CONSTRAINT activity_efforts_user_id_external_activity_id_key;
ALTER TABLE activity_efforts ADD CONSTRAINT activity_efforts_user_activity_deriver_key
  UNIQUE (user_id, external_activity_id, deriver_id);
-- Readers filter to one deriver per user and date range.
DROP INDEX idx_activity_efforts_user_date;
CREATE INDEX idx_activity_efforts_user_deriver_date ON activity_efforts (user_id, deriver_id, date);

-- Down Migration
DROP INDEX idx_activity_efforts_user_deriver_date;
CREATE INDEX idx_activity_efforts_user_date ON activity_efforts (user_id, date);
DELETE FROM activity_efforts WHERE deriver_id <> 'peak20_v1';
ALTER TABLE activity_efforts DROP CONSTRAINT activity_efforts_user_activity_deriver_key;
ALTER TABLE activity_efforts ADD CONSTRAINT activity_efforts_user_id_external_activity_id_key
  UNIQUE (user_id, external_activity_id);
ALTER TABLE activity_efforts DROP COLUMN deriver_id;
DROP TABLE classifiers;
DROP TABLE derivers;
