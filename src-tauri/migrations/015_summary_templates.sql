-- User-defined summary templates and saved personal instructions for every summary.
-- Built-in templates stay in code; existing summaries and their template ids are untouched.
ALTER TABLE settings ADD COLUMN summary_instructions TEXT NOT NULL DEFAULT '';
CREATE TABLE summary_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    instructions TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
PRAGMA user_version = 15;
