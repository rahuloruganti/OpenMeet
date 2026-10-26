-- Automatic capture: a second opt-in, separate from meeting detection and off until the user turns it on.
ALTER TABLE settings ADD COLUMN auto_capture INTEGER NOT NULL DEFAULT 0 CHECK (auto_capture IN (0,1));
-- One row per detected call. The lifecycle owns the state machine; this table only stores it.
CREATE TABLE call_sessions (
  id TEXT PRIMARY KEY,                        -- lifecycle session id (uuid4)
  call_key TEXT NOT NULL UNIQUE,              -- app_id + '#' + epoch; the dedupe key
  app_id TEXT NOT NULL,
  meeting_id TEXT UNIQUE REFERENCES meetings(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN ('candidate','recording','paused','end_pending','finalizing','complete','recoverable_error','prompted','cancelled')),
  origin TEXT NOT NULL CHECK (origin IN ('auto','manual')),
  reason TEXT NOT NULL,                       -- short code, never content
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0,1)),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  opened_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- At most one call is active at a time; inactive history rows are unconstrained.
CREATE UNIQUE INDEX call_sessions_one_active ON call_sessions(active) WHERE active = 1;
PRAGMA user_version = 33;
