-- Up Migration
-- PLAN §5.2 training-load heuristic: one scalar per activity plus the method that produced it
-- ('tss' power-based | 'trimp' HR-based) because the two are on different scales.
ALTER TABLE activity_efforts
  ADD COLUMN training_load        NUMERIC,
  ADD COLUMN training_load_method TEXT CHECK (training_load_method IN ('tss','trimp'));

-- Down Migration
ALTER TABLE activity_efforts
  DROP COLUMN training_load_method,
  DROP COLUMN training_load;
