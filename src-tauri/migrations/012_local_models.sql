-- Automatic post-recording transcription is opt-in and local only.
ALTER TABLE settings ADD COLUMN auto_transcribe INTEGER NOT NULL DEFAULT 0 CHECK (auto_transcribe IN (0, 1));
-- User-supplied whisper.cpp models found by a scan or downloaded from Hugging Face. Files stay
-- where they are; rows are never pinned catalog entries.
CREATE TABLE local_models (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL CHECK (size > 0),
    source TEXT NOT NULL CHECK (source IN ('scan', 'huggingface')),
    repo TEXT,
    revision TEXT,
    sha256 TEXT,
    license TEXT
);
PRAGMA user_version = 12;
