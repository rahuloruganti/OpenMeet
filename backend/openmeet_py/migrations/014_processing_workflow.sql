CREATE TABLE processing_runs (
    meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL UNIQUE,
    attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
    stage TEXT NOT NULL CHECK (stage IN ('live','finalizing_audio','transcribing','awaiting_notes','summarizing','completed','failed','cancelled','interrupted','consent_required')),
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
CREATE TABLE processing_requests (
    id INTEGER PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    fingerprint TEXT NOT NULL,
    audio_bytes INTEGER NOT NULL CHECK (audio_bytes >= 0),
    text_bytes INTEGER NOT NULL CHECK (text_bytes >= 0),
    UNIQUE(run_id,ordinal)
);
CREATE TABLE processing_provisional (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    chunk_id INTEGER NOT NULL CHECK (chunk_id >= 0),
    segment_json TEXT NOT NULL CHECK (json_valid(segment_json))
);
CREATE INDEX processing_provisional_meeting ON processing_provisional(meeting_id,chunk_id,id);
UPDATE processing_sessions SET state='consent_required',revision=revision+1 WHERE state='prepared';
INSERT INTO processing_runs(meeting_id,run_id,stage,error)
    SELECT meeting_id,id,CASE WHEN state='cancelled' THEN 'cancelled' ELSE 'consent_required' END,
    'Review session processing again before continuing.' FROM processing_sessions;
PRAGMA user_version = 14;
