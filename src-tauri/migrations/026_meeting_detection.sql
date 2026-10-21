-- Opt-in meeting detection: off until the user turns it on. A detection only offers a prompt.
ALTER TABLE settings ADD COLUMN detection_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (detection_enabled IN (0, 1));
-- Apps the user chose never to be prompted about, by microphone privacy-store key.
CREATE TABLE detection_ignored_apps (
    app_id TEXT PRIMARY KEY
);
PRAGMA user_version = 26;
