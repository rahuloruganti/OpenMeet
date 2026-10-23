-- Keep the name shown when an app was ignored; macOS bundle identifiers do not read as names.
-- Rows from schema v26 keep an empty name and fall back to one derived from the identifier.
ALTER TABLE detection_ignored_apps ADD COLUMN name TEXT NOT NULL DEFAULT '';
PRAGMA user_version = 27;
