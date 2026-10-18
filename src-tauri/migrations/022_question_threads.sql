-- Saved question threads: each answered question is kept, and follow-ups append to a thread.
-- Questions and answers are stored locally and unencrypted, like notes and summaries.
CREATE TABLE question_threads (
    id INTEGER PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE
);
CREATE INDEX question_threads_meeting ON question_threads(meeting_id);
CREATE TABLE question_turns (
    id INTEGER PRIMARY KEY,
    thread_id INTEGER NOT NULL REFERENCES question_threads(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL
);
CREATE INDEX question_turns_thread ON question_turns(thread_id, id);
PRAGMA user_version = 22;
