-- User-created tags organize meetings; matching ignores case so "Client" and "client" are one tag.
CREATE TABLE meeting_tags (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    tag TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (meeting_id, tag)
);
CREATE INDEX meeting_tags_tag ON meeting_tags(tag);
PRAGMA user_version = 21;
