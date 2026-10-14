-- NULL times represent untimed provider text, never a fabricated zero timestamp.
CREATE TABLE segments_new (
    id INTEGER PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    speaker TEXT NOT NULL CHECK (speaker IN ('You', 'Others')),
    start_ms INTEGER,
    end_ms INTEGER,
    text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('fixture', 'whisper', 'cloud_stt')),
    pass TEXT NOT NULL CHECK (pass = 'final'),
    CHECK ((start_ms IS NULL AND end_ms IS NULL) OR
           (start_ms IS NOT NULL AND end_ms IS NOT NULL AND start_ms >= 0 AND end_ms >= start_ms))
);
INSERT INTO segments_new(id, meeting_id, speaker, start_ms, end_ms, text, source, pass)
SELECT id, meeting_id, speaker, start_ms, end_ms, text, source, pass FROM segments;
DROP TABLE segments;
ALTER TABLE segments_new RENAME TO segments;
CREATE INDEX segments_meeting_time ON segments(meeting_id, start_ms, id);

CREATE TRIGGER search_segments_insert AFTER INSERT ON segments BEGIN
    INSERT INTO search(rowid, meeting_id, kind, body) VALUES (new.id, new.meeting_id, 'transcript', new.text);
END;
CREATE TRIGGER search_segments_update AFTER UPDATE ON segments BEGIN
    DELETE FROM search WHERE rowid = old.id;
    INSERT INTO search(rowid, meeting_id, kind, body) VALUES (new.id, new.meeting_id, 'transcript', new.text);
END;
CREATE TRIGGER search_segments_delete AFTER DELETE ON segments BEGIN
    DELETE FROM search WHERE rowid = old.id;
END;
DELETE FROM search WHERE kind = 'transcript';
INSERT INTO search(rowid, meeting_id, kind, body)
SELECT id, meeting_id, 'transcript', text FROM segments;

CREATE TABLE meeting_transcriptions (
    meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT
);
-- Earlier local transcripts have no recorded model. Preserve that uncertainty.
INSERT INTO meeting_transcriptions(meeting_id, provider, model)
SELECT DISTINCT meeting_id, 'whisper', NULL FROM segments WHERE source = 'whisper';
PRAGMA user_version = 11;
