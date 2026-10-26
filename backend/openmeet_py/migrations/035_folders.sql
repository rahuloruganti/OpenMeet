-- Folders: each meeting sits in at most one folder. Deleting a folder keeps its meetings (folder_id is cleared).
CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE meetings ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX meetings_folder ON meetings(folder_id);
-- The scope an answer was asked over (kind, id, label as shown then). NULL for answers made before scopes.
ALTER TABLE library_answers ADD COLUMN scope_json TEXT;
PRAGMA user_version = 35;
