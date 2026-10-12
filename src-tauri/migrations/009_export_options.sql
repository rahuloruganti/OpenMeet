-- Markdown export options. Defaults keep the previous export behaviour (everything included, title filenames).
ALTER TABLE settings ADD COLUMN export_transcript INTEGER NOT NULL DEFAULT 1 CHECK (export_transcript IN (0, 1));
ALTER TABLE settings ADD COLUMN export_summary INTEGER NOT NULL DEFAULT 1 CHECK (export_summary IN (0, 1));
ALTER TABLE settings ADD COLUMN export_filename TEXT NOT NULL DEFAULT 'title' CHECK (export_filename IN ('title', 'date_title'));
PRAGMA user_version = 9;
