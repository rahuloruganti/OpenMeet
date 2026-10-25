-- Live transcript: one switch and the engine it runs, plus the final lines a recording keeps.
-- The old 10-second live preview needed the automatic processing mode to be 'live' or 'both'; live
-- now has its own setting and the two preview modes no longer exist. Stored rows are mapped, not
-- refused, so an existing database reads as 'recording' or 'final'. processing_provisional stays in
-- place for the rows a preview left behind, and nothing writes it now.
ALTER TABLE settings ADD COLUMN live_transcript INTEGER NOT NULL DEFAULT 1;
-- "" uses the Transcription model; "stream:<id>", "stream-dir:<name>" or "cloud".
ALTER TABLE settings ADD COLUMN live_model TEXT NOT NULL DEFAULT '';

UPDATE settings SET processing_mode = 'recording' WHERE processing_mode = 'live';
UPDATE settings SET processing_mode = 'final' WHERE processing_mode = 'both';

-- Final live lines only: partials live in memory until a final replaces them, and a final keeps its
-- id, so writing the same utterance twice replaces the earlier row.
CREATE TABLE live_lines (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    lane TEXT NOT NULL CHECK (lane IN ('mic', 'system')),
    speaker TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (meeting_id, id)
);

PRAGMA user_version = 32;
