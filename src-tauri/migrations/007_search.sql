-- Full-text search over meeting titles, notes, transcript segments and summaries (FTS5 ships with
-- rusqlite's bundled SQLite). Rowids: a transcript row reuses its segments.id (a stable INTEGER
-- PRIMARY KEY), so per-segment triggers touch one row. Title, notes and summary rows take fresh
-- negative rowids and are located by meeting_id + kind inside that small negative range.
-- A future rebuild of meetings, notes, segments or summaries drops these triggers and must recreate them.
CREATE VIRTUAL TABLE search USING fts5(meeting_id UNINDEXED, kind UNINDEXED, body);

CREATE TRIGGER search_meetings_insert AFTER INSERT ON meetings BEGIN
    INSERT INTO search(rowid, meeting_id, kind, body)
    VALUES ((SELECT coalesce(min(rowid), 0) - 1 FROM search WHERE rowid < 0), new.id, 'title', new.title);
END;
CREATE TRIGGER search_meetings_title AFTER UPDATE OF title ON meetings BEGIN
    UPDATE search SET body = new.title WHERE rowid < 0 AND meeting_id = old.id AND kind = 'title';
END;
CREATE TRIGGER search_meetings_delete AFTER DELETE ON meetings BEGIN
    DELETE FROM search WHERE meeting_id = old.id;
END;

CREATE TRIGGER search_notes_insert AFTER INSERT ON notes BEGIN
    INSERT INTO search(rowid, meeting_id, kind, body)
    VALUES ((SELECT coalesce(min(rowid), 0) - 1 FROM search WHERE rowid < 0), new.meeting_id, 'notes', new.user_markdown);
END;
CREATE TRIGGER search_notes_update AFTER UPDATE OF user_markdown ON notes BEGIN
    UPDATE search SET body = new.user_markdown WHERE rowid < 0 AND meeting_id = old.meeting_id AND kind = 'notes';
END;
CREATE TRIGGER search_notes_delete AFTER DELETE ON notes BEGIN
    DELETE FROM search WHERE rowid < 0 AND meeting_id = old.meeting_id AND kind = 'notes';
END;

CREATE TRIGGER search_segments_insert AFTER INSERT ON segments BEGIN
    INSERT INTO search(rowid, meeting_id, kind, body) VALUES (new.id, new.meeting_id, 'transcript', new.text);
END;
CREATE TRIGGER search_segments_update AFTER UPDATE ON segments BEGIN
    DELETE FROM search WHERE rowid = old.id;
    INSERT INTO search(rowid, meeting_id, kind, body) VALUES (new.id, new.meeting_id, 'transcript', new.text);
END;
CREATE TRIGGER search_segments_delete AFTER DELETE ON segments BEGIN
    DELETE FROM search WHERE rowid = old.id;
END;

-- Identical summary rows are interchangeable in the index, so removing any one match is exact.
CREATE TRIGGER search_summaries_insert AFTER INSERT ON summaries BEGIN
    INSERT INTO search(rowid, meeting_id, kind, body)
    VALUES ((SELECT coalesce(min(rowid), 0) - 1 FROM search WHERE rowid < 0), new.meeting_id, 'summary', new.markdown);
END;
CREATE TRIGGER search_summaries_update AFTER UPDATE ON summaries BEGIN
    UPDATE search SET body = new.markdown WHERE rowid = (
        SELECT rowid FROM search
        WHERE rowid < 0 AND meeting_id = old.meeting_id AND kind = 'summary' AND body = old.markdown LIMIT 1
    );
END;
CREATE TRIGGER search_summaries_delete AFTER DELETE ON summaries BEGIN
    DELETE FROM search WHERE rowid = (
        SELECT rowid FROM search
        WHERE rowid < 0 AND meeting_id = old.meeting_id AND kind = 'summary' AND body = old.markdown LIMIT 1
    );
END;

-- One-time backfill of existing rows.
INSERT INTO search(rowid, meeting_id, kind, body)
SELECT id, meeting_id, 'transcript', text FROM segments;
INSERT INTO search(rowid, meeting_id, kind, body)
SELECT -row_number() OVER (), meeting_id, kind, body FROM (
    SELECT id AS meeting_id, 'title' AS kind, title AS body FROM meetings
    UNION ALL SELECT meeting_id, 'notes', user_markdown FROM notes
    UNION ALL SELECT meeting_id, 'summary', markdown FROM summaries
);
PRAGMA user_version = 7;
