CREATE TABLE processing_configuration (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (revision > 0)
);
INSERT INTO processing_configuration(id, revision) VALUES (1, 1);

CREATE TABLE processing_sessions (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'consent_required', 'cancelled', 'interrupted')),
    plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    authorized_until INTEGER NOT NULL CHECK (authorized_until > started_at)
);

-- A revision survives edit-and-revert and credential replacement without storing a secret.
CREATE TRIGGER processing_speech_changed
AFTER UPDATE OF stt_mode, stt_language, stt_prompt, stt_model ON settings
WHEN OLD.stt_mode IS NOT NEW.stt_mode OR OLD.stt_language IS NOT NEW.stt_language
  OR OLD.stt_prompt IS NOT NEW.stt_prompt OR OLD.stt_model IS NOT NEW.stt_model
BEGIN
    UPDATE processing_configuration SET revision = revision + 1 WHERE id = 1;
    UPDATE processing_sessions SET state = 'consent_required', revision = revision + 1 WHERE state = 'prepared';
END;

CREATE TRIGGER processing_assignment_changed AFTER UPDATE ON provider_assignments
BEGIN
    UPDATE processing_configuration SET revision = revision + 1 WHERE id = 1;
    UPDATE processing_sessions SET state = 'consent_required', revision = revision + 1 WHERE state = 'prepared';
END;

CREATE TRIGGER processing_connection_changed AFTER UPDATE ON saved_connections
BEGIN
    UPDATE processing_configuration SET revision = revision + 1 WHERE id = 1;
    UPDATE processing_sessions SET state = 'consent_required', revision = revision + 1 WHERE state = 'prepared';
END;

CREATE TRIGGER processing_connection_deleted AFTER DELETE ON saved_connections
BEGIN
    UPDATE processing_configuration SET revision = revision + 1 WHERE id = 1;
    UPDATE processing_sessions SET state = 'consent_required', revision = revision + 1 WHERE state = 'prepared';
END;

PRAGMA user_version = 13;
