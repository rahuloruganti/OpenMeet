-- Defaults chosen in Settings. The processing default only preselects the recording review;
-- every recording still needs its own reviewed consent. It used to live in webview storage.
ALTER TABLE settings ADD COLUMN processing_mode TEXT NOT NULL DEFAULT 'recording'
    CHECK (processing_mode IN ('recording', 'live', 'final', 'both'));
ALTER TABLE settings ADD COLUMN processing_summary TEXT;
-- The template the Enhance picker starts at: a built-in id or a custom template id.
ALTER TABLE settings ADD COLUMN summary_default TEXT NOT NULL DEFAULT 'general-v1';
PRAGMA user_version = 25;
