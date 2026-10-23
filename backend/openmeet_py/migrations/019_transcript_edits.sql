-- Segment edits keep the engine's text in original_text (NULL when unedited). ADD COLUMN keeps
-- the segments table and its search triggers, so edited text is re-indexed by the update trigger.
ALTER TABLE segments ADD COLUMN original_text TEXT;
-- Read-only copies of a transcript, including any edits, taken before a new transcription replaces it.
CREATE TABLE transcript_versions (
    id INTEGER PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    provider TEXT,
    model TEXT,
    edited INTEGER NOT NULL CHECK (edited IN (0, 1)),
    segment_count INTEGER NOT NULL,
    segments_json TEXT NOT NULL
);
CREATE INDEX transcript_versions_meeting ON transcript_versions(meeting_id, id);
PRAGMA user_version = 19;
