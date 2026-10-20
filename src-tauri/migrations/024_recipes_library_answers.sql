-- Recipes: saved, reusable question prompts. Built-in recipes stay in code.
CREATE TABLE recipes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Answers to questions over several meetings, stored locally and unencrypted like question threads.
CREATE TABLE library_answers (
    id INTEGER PRIMARY KEY,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- The meetings an answer was made from, in the order sent (M1 is position 0).
CREATE TABLE library_answer_meetings (
    answer_id INTEGER NOT NULL REFERENCES library_answers(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    PRIMARY KEY (answer_id, position)
);
CREATE INDEX library_answer_meetings_meeting ON library_answer_meetings(meeting_id);
-- Deleting any source meeting deletes every answer derived from it.
CREATE TRIGGER library_answer_source_deleted AFTER DELETE ON library_answer_meetings
BEGIN
    DELETE FROM library_answers WHERE id = OLD.answer_id;
END;
PRAGMA user_version = 24;
