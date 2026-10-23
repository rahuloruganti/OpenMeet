-- Transcript files written beside the Markdown snapshot: a comma-separated subset of txt,srt,vtt.
-- Empty keeps the previous behaviour of a Markdown snapshot only.
ALTER TABLE settings ADD COLUMN export_transcript_formats TEXT NOT NULL DEFAULT '';
PRAGMA user_version = 23;
