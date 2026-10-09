# Privacy: foundation preview

This build stores meeting metadata, typed notes, fictional fixtures, and settings in a local SQLite database. Export uses a folder explicitly chosen through the native picker. There is no telemetry, updater, cloud model client, model downloader, or audio capture implementation.

The packaged frontend has no permission to read arbitrary files, register shortcuts, open dialogs directly, or call network services. Rust exposes specific operations; its folder picker is the only way to change the export destination. Development mode also uses Vite's localhost server.

The database and exported Markdown are **not encrypted**. Device administrators, OS backups, and sync software can access them. Choosing a cloud-synced folder can upload exports even though OpenMeet makes no upload request. There is no retention cleanup or in-app deletion UI yet. Close the app before manually removing its app-data directory; exported files must be removed separately.

Autosave waits 400 ms and serializes writes. Graceful close flushes notes and refuses to quit on save failure. A forced process termination or power loss can lose edits not yet saved. Use synthetic data during this unvalidated preview.

Before real capture/cloud processing ships, this policy must be updated with permissions, audio retention/deletion, model downloads, provider disclosure, and local-only egress test results.
