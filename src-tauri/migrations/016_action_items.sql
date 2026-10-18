-- Editable meeting tasks. Unknown owners and due dates stay NULL rather than guessed.
-- `origin_text` keeps the imported summary bullet unchanged so re-importing skips edited tasks.
CREATE TABLE action_items (
    id INTEGER PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    owner TEXT,
    due_date TEXT,
    done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
    source TEXT NOT NULL CHECK (source IN ('manual', 'summary')),
    summary_id INTEGER REFERENCES summaries(id) ON DELETE SET NULL,
    origin_text TEXT
);
CREATE INDEX action_items_meeting ON action_items(meeting_id, id);
PRAGMA user_version = 16;
