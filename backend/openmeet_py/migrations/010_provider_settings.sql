-- Previous Merge selection stays in settings for non-destructive upgrades, but is inactive.
CREATE TABLE provider_connections (
    role TEXT PRIMARY KEY CHECK (role IN ('llm', 'cloud_stt')),
    base_url TEXT NOT NULL,
    model TEXT,
    credential_account TEXT,
    revision INTEGER NOT NULL CHECK (revision > 0)
);
ALTER TABLE settings ADD COLUMN stt_mode TEXT NOT NULL DEFAULT 'local'
    CHECK (stt_mode IN ('local', 'cloud'));
PRAGMA user_version = 10;
