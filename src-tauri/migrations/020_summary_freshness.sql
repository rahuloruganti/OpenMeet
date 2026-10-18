-- SHA-256 of the exact transcript lines (speaker names included) a summary was made from.
-- NULL for older summaries means freshness is unknown, so they are never flagged.
ALTER TABLE summaries ADD COLUMN transcript_hash TEXT;
PRAGMA user_version = 20;
