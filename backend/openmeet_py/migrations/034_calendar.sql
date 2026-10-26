-- Calendar context: read-only iCalendar feeds, the events they expand to, and optional meeting links.
-- The feed address itself is a secret and lives only in the Credential Manager (account calendar:<feed id>).
CREATE TABLE calendar_feeds (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'ics'),
  created_at TEXT NOT NULL,
  last_sync_at TEXT,
  last_status TEXT NOT NULL DEFAULT 'never',
  last_error TEXT
);
-- One row per expanded instance inside the sync window. Ids are derived from the instance, so a
-- re-sync updates rows in place and meeting links survive.
CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES calendar_feeds(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  recurrence_id TEXT,                         -- original start (UTC) of an overridden instance
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0,1)),
  title TEXT NOT NULL,
  location TEXT,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('confirmed','tentative','cancelled')),
  attendees_json TEXT NOT NULL DEFAULT '[]',
  meeting_url TEXT,
  UNIQUE(feed_id, uid, recurrence_id, start_utc)
);
CREATE INDEX calendar_events_start ON calendar_events(start_utc);
CREATE INDEX calendar_events_uid ON calendar_events(uid);
ALTER TABLE meetings ADD COLUMN calendar_event_id TEXT REFERENCES calendar_events(id) ON DELETE SET NULL;
ALTER TABLE settings ADD COLUMN calendar_reminders INTEGER NOT NULL DEFAULT 1 CHECK (calendar_reminders IN (0,1));
ALTER TABLE settings ADD COLUMN calendar_reminder_minutes INTEGER NOT NULL DEFAULT 2 CHECK (calendar_reminder_minutes BETWEEN 0 AND 30);
PRAGMA user_version = 34;
