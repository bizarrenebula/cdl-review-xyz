ALTER TABLE users ADD COLUMN trial_code_prefix TEXT;
ALTER TABLE users ADD COLUMN trial_ended INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN trial_ended_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_trial_code_prefix ON users(trial_code_prefix);
CREATE INDEX IF NOT EXISTS idx_users_trial_ended ON users(trial_ended);

CREATE TABLE IF NOT EXISTS trial_generation_limits (
  key_hash TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  generation_count INTEGER NOT NULL DEFAULT 0
);
