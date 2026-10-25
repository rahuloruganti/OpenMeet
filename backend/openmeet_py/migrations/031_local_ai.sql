-- Local AI: the managed llama.cpp server this PC runs. One row, created here so reading it never
-- has to handle "no row": the engine backend that matches this PC's graphics, the loopback port, the
-- chosen model id, and the saved connection named "Local AI". The API key is never stored here; it
-- lives in the OS credential store under that connection's account.
CREATE TABLE local_ai (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    backend TEXT CHECK (backend IN ('cuda', 'vulkan', 'cpu')),
    port INTEGER CHECK (port IS NULL OR (port > 1023 AND port < 65536)),
    active_model TEXT,
    connection_id TEXT
);

INSERT INTO local_ai (id) VALUES (1);

PRAGMA user_version = 31;
