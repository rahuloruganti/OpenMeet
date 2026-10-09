// @vitest-environment node
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../src-tauri/migrations/001_foundation.sql", import.meta.url),
  "utf8",
);

// Exercise the actual embedded SQL even when the native Tauri toolchain is unavailable.
// These checks complement, but do not replace, the Rust storage/service tests.
describe("foundation migration", () => {
  it("creates a versioned database and enforces source and state constraints", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON; BEGIN;");
      db.exec(migration);
      db.exec("COMMIT;");
      expect(db.prepare("PRAGMA user_version").get()).toMatchObject({
        user_version: 1,
      });
      expect(
        db.prepare("SELECT pause_shortcut FROM settings WHERE id = 1").get(),
      ).toMatchObject({ pause_shortcut: "CommandOrControl+Shift+Space" });
      const insert = db.prepare(
        "INSERT INTO meetings(id, title, started_at, source, status) VALUES (?, ?, ?, ?, ?)",
      );
      expect(() =>
        insert.run(
          "real",
          "Not supported",
          "2026-10-09",
          "desktop",
          "recording",
        ),
      ).toThrow();
      expect(() =>
        insert.run(
          "invalid",
          "Bad state",
          "2026-10-09",
          "simulation",
          "unknown",
        ),
      ).toThrow();
      insert.run("sample", "Example", "2026-10-09", "fixture", "stopped");
      db.prepare(
        "INSERT INTO notes(meeting_id, user_markdown) VALUES (?, ?)",
      ).run("sample", "User notes");
      expect(() =>
        db.prepare("INSERT INTO notes(meeting_id) VALUES (?)").run("missing"),
      ).toThrow();
      db.prepare("DELETE FROM meetings WHERE id = ?").run("sample");
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM notes").get(),
      ).toMatchObject({ count: 0 });
    } finally {
      db.close();
    }
  });
});
