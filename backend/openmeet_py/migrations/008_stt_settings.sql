-- Transcription settings (language, vocabulary prompt, model) and the optional stop-recording shortcut.
ALTER TABLE settings ADD COLUMN stt_language TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE settings ADD COLUMN stt_prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN stt_model TEXT NOT NULL DEFAULT 'small';
ALTER TABLE settings ADD COLUMN stop_shortcut TEXT;
PRAGMA user_version = 8;
