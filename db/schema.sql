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
  answers JSONB
);

CREATE INDEX IF NOT EXISTS attempts_submitted_at_idx ON attempts (submitted_at);
