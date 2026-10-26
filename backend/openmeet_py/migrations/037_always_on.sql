-- Always on (owner decision): meeting detection, automatic processing in its fullest mode (transcript,
-- then summary), enhanced notes after the summary, and the live transcript are no longer Settings switches.
-- Existing databases are switched on here. A fresh database gets the same values, because this file runs
-- after migration 001 creates the settings row. A summary the user already chose is kept; otherwise the
-- default one. Auto capture is not touched: it stays off until the user opts in.
UPDATE settings SET
    detection_enabled = 1,
    processing_mode = 'final',
    processing_summary = CASE
        WHEN processing_summary IN ('general-v1', 'standup-v1', 'one-to-one-v1') THEN processing_summary
        ELSE 'general-v1'
    END,
    processing_enhance = 1,
    live_transcript = 1
WHERE id = 1;
PRAGMA user_version = 37;
