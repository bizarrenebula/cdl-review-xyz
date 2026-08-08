CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  username TEXT,
  verification_code_hash TEXT,
  verification_expires_at INTEGER,
  verification_attempts INTEGER NOT NULL DEFAULT 0,
  verification_sent_at INTEGER,
  verification_window_started_at INTEGER,
  verification_send_count INTEGER NOT NULL DEFAULT 0,
  trial_start_at INTEGER,
  trial_end_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_trial_end ON users(trial_end_at);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
