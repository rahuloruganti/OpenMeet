-- First-run setup is shown until it is finished or skipped; Settings can run it again.
ALTER TABLE settings ADD COLUMN setup_done INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version = 28;
