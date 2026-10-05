-- Up Migration
-- Phase 5b: precomputed trends + readiness scores (PLAN §7), per-classifier output (§8.7),
-- insight feedback and athlete events for comparing classifiers (§8.7).
-- Every table here is per-person data: user_id NOT NULL, ON DELETE CASCADE (CLAUDE.md rule 4, §12).

CREATE TABLE readiness_scores (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date             DATE NOT NULL,
  score            NUMERIC NOT NULL,
  components_jsonb JSONB NOT NULL,     -- {"hrv":..,"resting_hr":..,"sleep":..} (0-100 each) + weights used
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, date)
);
CREATE INDEX idx_readiness_user_date ON readiness_scores (user_id, date);

-- Deviations from the PLAN §7 sketch (all additive or forced):
--  * `window` is a reserved word in Postgres, so the column is `trend_window`.
--  * `as_of` DATE: the day whose 7d/28d baselines were classified (needed for an idempotent key).
--  * `classifier_id`: one row per registered classifier per window (§8.7).
--  * `recovery_z`: combined recovery z next to `z_score` (EF z) for the state rows.
--  * `direction` also allows 'steady' and 'insufficient_data', which the scoring engine can return.
-- For metric_type = 'fatigue_fitness_state', `direction` holds the classified state, `z_score` the
-- EF z, and `trend_window` is '7d' (the short window being judged against its 28d baseline).
CREATE TABLE trends (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  classifier_id   TEXT NOT NULL REFERENCES classifiers(id),
  as_of           DATE NOT NULL,
  metric_type     TEXT NOT NULL,        -- 'hrv' | 'resting_hr' | 'ef_overall' | 'ef_peak20' | 'fatigue_fitness_state'
  trend_window    TEXT NOT NULL CHECK (trend_window IN ('7d','28d')),
  z_score         NUMERIC,
  recovery_z      NUMERIC,
  direction       TEXT CHECK (direction IN ('up','down','flat',
                   'fitness_gain','overreaching_risk','acute_fatigue','ambiguous',
                   'steady','insufficient_data')),
  insight_text    TEXT,                -- plain-language flag, e.g. "EF rising while HRV falling — overreaching risk"
  flagged_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, classifier_id, metric_type, trend_window, as_of)
);
CREATE INDEX idx_trends_user_classifier_asof ON trends (user_id, classifier_id, as_of);

-- Thumbs up/down on a flagged insight, recorded against the classifier that produced it.
-- `comment` is health-adjacent: never logged (CLAUDE.md rule 6).
CREATE TABLE insight_feedback (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- the athlete
  classifier_id  TEXT NOT NULL REFERENCES classifiers(id),
  as_of          DATE NOT NULL,                                          -- the trend's date
  state          TEXT NOT NULL,                                          -- state at vote time
  vote           SMALLINT NOT NULL CHECK (vote IN (-1, 1)),
  comment        TEXT CHECK (comment IS NULL OR char_length(comment) <= 500),
  voted_by       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, classifier_id, as_of, voted_by)
);
CREATE INDEX idx_insight_feedback_classifier_asof ON insight_feedback (classifier_id, as_of);

-- Real-world outcomes logged after the fact, for backtesting classifiers. `notes` is never logged.
-- created_by is nullable so deleting a coach doesn't delete the athlete's history.
CREATE TABLE athlete_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  event_type  TEXT NOT NULL CHECK (event_type IN ('illness','injury','race','planned_rest')),
  notes       TEXT CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_athlete_events_user_date ON athlete_events (user_id, date);

-- Down Migration
DROP TABLE athlete_events;
DROP TABLE insight_feedback;
DROP TABLE trends;
DROP TABLE readiness_scores;
