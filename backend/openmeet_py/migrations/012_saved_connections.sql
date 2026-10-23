CREATE TABLE saved_connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    credential_account TEXT,
    revision INTEGER NOT NULL CHECK (revision > 0)
);
CREATE TABLE provider_assignments (
    role TEXT PRIMARY KEY CHECK (role IN ('llm', 'cloud_stt')),
    connection_id TEXT REFERENCES saved_connections(id),
    model TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    CHECK ((connection_id IS NULL AND model IS NULL) OR (connection_id IS NOT NULL AND model IS NOT NULL))
);
INSERT INTO saved_connections(id,name,base_url,credential_account,revision)
    SELECT 'migrated-' || role, CASE role WHEN 'llm' THEN 'Language model' ELSE 'Cloud transcription' END,
           base_url,credential_account,revision FROM provider_connections;
INSERT INTO provider_assignments(role,connection_id,model,revision)
    SELECT role, CASE WHEN model IS NOT NULL THEN 'migrated-' || role END,model,revision FROM provider_connections;
INSERT OR IGNORE INTO provider_assignments(role,revision) VALUES ('llm',0),('cloud_stt',0);
DROP TABLE provider_connections;
PRAGMA user_version = 12;
