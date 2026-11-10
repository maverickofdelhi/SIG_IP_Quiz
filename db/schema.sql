-- Source of truth for SIG_IP_Quiz. Applied on boot via CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS questions (
  id SERIAL PRIMARY KEY,
  question TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  correct CHAR(1) NOT NULL CHECK (correct IN ('A', 'B', 'C', 'D')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attempts (
  id SERIAL PRIMARY KEY,
  roll TEXT NOT NULL UNIQUE,
  name TEXT,
  score INT,
  total INT,
  time_taken TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answers JSONB,
  status TEXT NOT NULL DEFAULT 'submitted',
  started_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ,
  session_token TEXT,
  question_ids JSONB,
  progress JSONB
);

CREATE TABLE IF NOT EXISTS cumulative_scores (
  roll TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  total_score BIGINT NOT NULL DEFAULT 0,
  quizzes_completed INT NOT NULL DEFAULT 0,
  last_quiz_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE attempts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'submitted';
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS session_token TEXT;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS question_ids JSONB;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS progress JSONB;

CREATE INDEX IF NOT EXISTS attempts_submitted_at_idx ON attempts (submitted_at);
CREATE INDEX IF NOT EXISTS attempts_status_idx ON attempts (status);
CREATE INDEX IF NOT EXISTS cumulative_scores_ranking_idx
  ON cumulative_scores (total_score DESC, quizzes_completed DESC, updated_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS attempts_session_token_uidx
  ON attempts (session_token)
  WHERE session_token IS NOT NULL;
