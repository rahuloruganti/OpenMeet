-- Notes-only meetings: widen meetings.source with 'note'. notes, tracks, segments, summaries and
-- capture_events reference meetings, so Core::open runs this with foreign_keys OFF outside the
-- transaction and verifies foreign_key_check before commit. Every column and row is copied unchanged.
CREATE TABLE meetings_new (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    source TEXT NOT NULL CHECK (source IN ('simulation', 'fixture', 'desktop', 'note')),
    status TEXT NOT NULL CHECK (status IN ('recording', 'paused', 'stopped', 'interrupted')),
    capture_error TEXT
);
INSERT INTO meetings_new(id, title, started_at, ended_at, source, status, capture_error)
SELECT id, title, started_at, ended_at, source, status, capture_error FROM meetings;
DROP TABLE meetings;
ALTER TABLE meetings_new RENAME TO meetings;
PRAGMA user_version = 6;
