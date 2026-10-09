-- Run with foreign_keys OFF outside the transaction; verify foreign_key_check before commit.
CREATE TABLE meetings_new (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    source TEXT NOT NULL CHECK (source IN ('simulation', 'fixture', 'desktop')),
    status TEXT NOT NULL CHECK (status IN ('recording', 'paused', 'stopped', 'interrupted')),
    capture_error TEXT
);
INSERT INTO meetings_new(id, title, started_at, ended_at, source, status)
SELECT id, title, started_at, ended_at, source, status FROM meetings;
DROP TABLE meetings;
ALTER TABLE meetings_new RENAME TO meetings;
CREATE TABLE tracks (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('mic', 'system')),
    path TEXT NOT NULL,
    timing_path TEXT NOT NULL,
    device_name TEXT NOT NULL,
    sample_rate INTEGER NOT NULL CHECK (sample_rate > 0),
    channels INTEGER NOT NULL CHECK (channels > 0),
    frames INTEGER NOT NULL DEFAULT 0,
    dropped_frames INTEGER NOT NULL DEFAULT 0,
    finalized INTEGER NOT NULL DEFAULT 0 CHECK (finalized IN (0, 1)),
    PRIMARY KEY (meeting_id, kind)
);
CREATE TABLE capture_events (
    id INTEGER PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('paused', 'resumed', 'error', 'stopped')),
    offset_us INTEGER NOT NULL CHECK (offset_us >= 0)
);
ALTER TABLE settings ADD COLUMN microphone_id TEXT;
ALTER TABLE settings ADD COLUMN output_id TEXT;
PRAGMA user_version = 2;
