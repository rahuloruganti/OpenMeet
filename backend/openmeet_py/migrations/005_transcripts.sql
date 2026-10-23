-- Real transcripts: widen segments.source from fixture-only to fixture|whisper.
-- Nothing references segments, so a plain rebuild is safe; existing rows are copied unchanged.
CREATE TABLE segments_new (
    id INTEGER PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    speaker TEXT NOT NULL CHECK (speaker IN ('You', 'Others')),
    start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
    end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
    text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('fixture', 'whisper')),
    pass TEXT NOT NULL CHECK (pass = 'final')
);
INSERT INTO segments_new(id, meeting_id, speaker, start_ms, end_ms, text, source, pass)
SELECT id, meeting_id, speaker, start_ms, end_ms, text, source, pass FROM segments;
DROP TABLE segments;
ALTER TABLE segments_new RENAME TO segments;
CREATE INDEX segments_meeting_time ON segments(meeting_id, start_ms, id);
PRAGMA user_version = 5;
