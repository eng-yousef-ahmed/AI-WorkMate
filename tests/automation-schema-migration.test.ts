import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DATABASE_SCHEMA_VERSION } from "../src/domain/models";
import { LocalDatabase } from "../src/storage/LocalDatabase";

test("schema v9 databases gain a notifications table at v10 without losing tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-schema-v9-"));
  const dbPath = join(root, "local.db");
  const legacy = new DatabaseSync(dbPath);
  try {
    legacy.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at) VALUES (9, '2026-09-09T00:00:00.000Z');
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL,
        project_id TEXT,
        text TEXT NOT NULL,
        assignee TEXT,
        due_date TEXT,
        status TEXT NOT NULL CHECK (status IN ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED')),
        source_artifact_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tasks (task_id, meeting_id, text, status, created_at, updated_at)
      VALUES ('task-keep', 'meeting-keep', 'Keep this task', 'OPEN', '2026-09-08T10:00:00.000Z', '2026-09-08T10:00:00.000Z');
    `);
  } finally {
    legacy.close();
  }

  const database = new LocalDatabase(dbPath, () => new Date("2026-09-09T12:00:00.000Z"));
  try {
    assert.equal(DATABASE_SCHEMA_VERSION, 10);
    assert.ok(database.describeTable("notifications").includes("fingerprint"));
    assert.equal(database.getTask("task-keep")?.text, "Keep this task");
    const inserted = database.registerNotification({
      notificationId: "n-1",
      kind: "DAILY_MEETING_REPORT",
      title: "Daily report",
      body: "Local only.",
      fingerprint: "daily:2026-09-09",
      createdAt: "2026-09-09T12:00:00.000Z",
    });
    assert.equal(inserted, true);
    const duplicate = database.registerNotification({
      notificationId: "n-2",
      kind: "DAILY_MEETING_REPORT",
      title: "Daily report",
      body: "Local only.",
      fingerprint: "daily:2026-09-09",
      createdAt: "2026-09-09T12:01:00.000Z",
    });
    assert.equal(duplicate, false);
    assert.equal(database.listNotifications().length, 1);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
