-- UI preferences the window must keep across restarts. They used to live in webview storage,
-- which the current window does not keep, so both are columns on the single settings row.
-- theme 'system' follows the OS; inspector_open is the meeting page's right inspector.
ALTER TABLE settings ADD COLUMN theme TEXT NOT NULL DEFAULT 'system'
    CHECK (theme IN ('system', 'dark', 'light'));
ALTER TABLE settings ADD COLUMN inspector_open INTEGER NOT NULL DEFAULT 1
    CHECK (inspector_open IN (0, 1));
PRAGMA user_version = 30;
