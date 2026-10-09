CREATE TABLE meetings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    source TEXT NOT NULL CHECK (source IN ('simulation', 'fixture')),
    status TEXT NOT NULL CHECK (status IN ('recording', 'paused', 'stopped', 'interrupted'))
);
CREATE TABLE notes (
    meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
    user_markdown TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE TABLE segments (
    id INTEGER PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    speaker TEXT NOT NULL CHECK (speaker IN ('You', 'Others')),
    start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
    end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
    text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source = 'fixture'),
    pass TEXT NOT NULL CHECK (pass = 'final')
);
CREATE INDEX segments_meeting_time ON segments(meeting_id, start_ms, id);
CREATE TABLE summaries (
    id INTEGER PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    template_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    markdown TEXT NOT NULL
);
CREATE INDEX summaries_meeting ON summaries(meeting_id, id);
CREATE TABLE settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    vault_folder TEXT,
    pause_shortcut TEXT NOT NULL
);
INSERT INTO settings(id, pause_shortcut) VALUES (1, 'CommandOrControl+Shift+Space');
PRAGMA user_version = 1;
