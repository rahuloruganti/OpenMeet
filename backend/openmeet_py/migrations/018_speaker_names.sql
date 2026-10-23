-- Per-meeting display names for the two track labels. Segments keep "You"/"Others",
-- which still identify the microphone and system-audio tracks for playback.
CREATE TABLE speaker_names (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    speaker TEXT NOT NULL CHECK (speaker IN ('You', 'Others')),
    name TEXT NOT NULL,
    PRIMARY KEY (meeting_id, speaker)
);
PRAGMA user_version = 18;
