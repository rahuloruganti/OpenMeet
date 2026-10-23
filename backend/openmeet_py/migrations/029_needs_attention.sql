-- Renames the stored 'consent_required' stage/state to 'needs_attention'. SQLite cannot alter a
-- CHECK constraint, so both tables are rebuilt; neither is referenced by a foreign key, and the
-- rows, notes, and transcripts are copied unchanged apart from that value.
DROP TRIGGER processing_speech_changed;
DROP TRIGGER processing_assignment_changed;
DROP TRIGGER processing_connection_changed;
DROP TRIGGER processing_connection_deleted;

CREATE TABLE processing_sessions_next (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'needs_attention', 'cancelled', 'interrupted')),
    plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    authorized_until INTEGER NOT NULL CHECK (authorized_until > started_at)
);
INSERT INTO processing_sessions_next(id, meeting_id, revision, state, plan_json, started_at, authorized_until)
    SELECT id, meeting_id, revision,
        CASE WHEN state = 'consent_required' THEN 'needs_attention' ELSE state END,
        plan_json, started_at, authorized_until
    FROM processing_sessions;
DROP TABLE processing_sessions;
ALTER TABLE processing_sessions_next RENAME TO processing_sessions;

CREATE TABLE processing_runs_next (
    meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL UNIQUE,
    attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
    stage TEXT NOT NULL CHECK (stage IN ('live','finalizing_audio','transcribing','awaiting_notes','summarizing','completed','failed','cancelled','interrupted','needs_attention')),
    error TEXT,
    live_incomplete INTEGER NOT NULL DEFAULT 0 CHECK (live_incomplete IN (0,1)),
    transcript_done INTEGER NOT NULL DEFAULT 0 CHECK (transcript_done IN (0,1)),
    notes_barrier TEXT,
    notes_revision INTEGER,
    notes_snapshot TEXT,
    requests_used INTEGER NOT NULL DEFAULT 0 CHECK (requests_used >= 0),
    upload_bytes_used INTEGER NOT NULL DEFAULT 0 CHECK (upload_bytes_used >= 0),
    text_bytes_used INTEGER NOT NULL DEFAULT 0 CHECK (text_bytes_used >= 0)
);
INSERT INTO processing_runs_next
    SELECT meeting_id, run_id, attempt,
        CASE WHEN stage = 'consent_required' THEN 'needs_attention' ELSE stage END,
        error, live_incomplete, transcript_done, notes_barrier, notes_revision, notes_snapshot,
        requests_used, upload_bytes_used, text_bytes_used
    FROM processing_runs;
DROP TABLE processing_runs;
ALTER TABLE processing_runs_next RENAME TO processing_runs;

CREATE TRIGGER processing_speech_changed
AFTER UPDATE OF stt_mode, stt_language, stt_prompt, stt_model ON settings
WHEN OLD.stt_mode IS NOT NEW.stt_mode OR OLD.stt_language IS NOT NEW.stt_language
  OR OLD.stt_prompt IS NOT NEW.stt_prompt OR OLD.stt_model IS NOT NEW.stt_model
BEGIN
    UPDATE processing_configuration SET revision = revision + 1 WHERE id = 1;
    UPDATE processing_sessions SET state = 'needs_attention', revision = revision + 1 WHERE state = 'prepared';
END;

CREATE TRIGGER processing_assignment_changed AFTER UPDATE ON provider_assignments
BEGIN
    UPDATE processing_configuration SET revision = revision + 1 WHERE id = 1;
    UPDATE processing_sessions SET state = 'needs_attention', revision = revision + 1 WHERE state = 'prepared';
END;

CREATE TRIGGER processing_connection_changed AFTER UPDATE ON saved_connections
BEGIN
    UPDATE processing_configuration SET revision = revision + 1 WHERE id = 1;
    UPDATE processing_sessions SET state = 'needs_attention', revision = revision + 1 WHERE state = 'prepared';
END;

CREATE TRIGGER processing_connection_deleted AFTER DELETE ON saved_connections
BEGIN
    UPDATE processing_configuration SET revision = revision + 1 WHERE id = 1;
    UPDATE processing_sessions SET state = 'needs_attention', revision = revision + 1 WHERE state = 'prepared';
END;

PRAGMA user_version = 29;
