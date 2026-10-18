-- A user edit is a new summary version that names the version it was edited from.
-- ADD COLUMN keeps the table (and its search triggers) intact; existing rows stay unedited.
ALTER TABLE summaries ADD COLUMN edited_from INTEGER REFERENCES summaries(id) ON DELETE SET NULL;
PRAGMA user_version = 17;
