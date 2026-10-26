-- Enhanced notes: a second summary kind made from the user's notes plus the final transcript.
-- kind separates it from the plain summary; notes_revision records the notes it was made from;
-- sources_json lists the transcript segments its [sNNN] markers cite (a JSON array).
ALTER TABLE summaries ADD COLUMN kind TEXT NOT NULL DEFAULT 'summary' CHECK (kind IN ('summary', 'enhanced'));
ALTER TABLE summaries ADD COLUMN notes_revision INTEGER;
ALTER TABLE summaries ADD COLUMN sources_json TEXT NOT NULL DEFAULT '[]';
-- Opt-in: automatic processing also writes enhanced notes after the summary when this is on (off by default).
ALTER TABLE settings ADD COLUMN processing_enhance INTEGER NOT NULL DEFAULT 0 CHECK (processing_enhance IN (0, 1));
-- Set once the automatic summary is committed; a retry after a failed enhancement skips the summary.
ALTER TABLE processing_runs ADD COLUMN summary_saved INTEGER NOT NULL DEFAULT 0 CHECK (summary_saved IN (0, 1));
PRAGMA user_version = 36;
