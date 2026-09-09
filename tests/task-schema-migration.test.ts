import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DATABASE_SCHEMA_VERSION } from "../src/domain/models";
import { LocalDatabase, type TaskRecord } from "../src/storage/LocalDatabase";

/**
 * Opens a database file that was created at schema v8 (the tasks table has no
 * source_artifact_id yet) and verifies the v9 migration adds the provenance
 * column and preserves existing rows.
 */
test("schema v8 tasks migrate to v9 with provenance column and preserved rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-schema-v8-"));
  const dbPath = join(root, "local.db");
  const legacy = new DatabaseSync(dbPath);
  try {
    // The v8-era database: schema_migrations at 8, a tasks table WITHOUT the
    // source_artifact_id provenance column, and the analysis_records rows
    // that analysis persistence wrote alongside task rows (same meeting and
    // created_at). Meetings etc. are absent and get created at the current
    // shape by the migration runner.
    legacy.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at) VALUES (8, '2026-09-01T00:00:00.000Z');
      CREATE TABLE IF NOT EXISTS analysis_records (
        analysis_id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source_transcript_ids TEXT,
        source_transcript_shas TEXT
      );
      INSERT INTO analysis_records (analysis_id, meeting_id, kind, artifact_id, created_at)
      VALUES ('analysis-legacy', 'meeting-legacy', 'TASKS', 'analysis-artifact-legacy', '2026-09-08T10:00:00.000Z');
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL,
        project_id TEXT,
        text TEXT NOT NULL,
        assignee TEXT,
        due_date TEXT,
        status TEXT NOT NULL CHECK (status IN ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tasks (task_id, meeting_id, text, assignee, due_date, status, created_at, updated_at)
      VALUES ('task-legacy', 'meeting-legacy', 'Verify backup restore', 'Ada', '2026-10-01', 'OPEN', '2026-09-07T10:00:00.000Z', '2026-09-07T10:00:00.000Z');
      INSERT INTO tasks (task_id, meeting_id, text, status, created_at, updated_at)
      VALUES ('task-legacy-analyzed', 'meeting-legacy', 'Analyzed legacy task', 'OPEN', '2026-09-08T10:00:00.000Z', '2026-09-08T10:00:00.000Z');
    `);
  } finally {
    legacy.close();
  }

  const database = new LocalDatabase(dbPath, () => new Date("2026-09-09T00:00:00.000Z"));
  try {
    const columns = database.describeTable("tasks");
    assert.ok(columns.includes("source_artifact_id"), `tasks columns: ${columns.join(",")}`);
    const record = database.getTask("task-legacy");
    assert.ok(record !== undefined);
    const task = record as TaskRecord;
    assert.equal(task.meetingId, "meeting-legacy");
    assert.equal(task.text, "Verify backup restore");
    assert.equal(task.assignee, "Ada");
    assert.equal(task.dueDate, "2026-10-01");
    assert.equal(task.status, "OPEN");
    assert.equal(task.sourceArtifactId, undefined);
    // Rows written by analysis persistence are backfilled with the exact
    // ANALYSIS_TASKS artifact that produced them (matched on meeting +
    // created_at) so provenance survives the migration.
    const analyzed = database.getTask("task-legacy-analyzed") as TaskRecord;
    assert.equal(analyzed.sourceArtifactId, "analysis-artifact-legacy");
    assert.equal(DATABASE_SCHEMA_VERSION, 10);
    database.close();

    // Reopening the migrated database is idempotent: no duplicate version
    // bumps, no migration failure, and the provenance column supports writes.
    const reopened = new LocalDatabase(dbPath, () => new Date("2026-09-10T00:00:00.000Z"));
    try {
      assert.ok(reopened.describeTable("tasks").includes("source_artifact_id"));
      reopened.updateTask("task-legacy", { sourceArtifactId: "analysis-artifact-1", updatedAt: "2026-09-10T00:00:00.000Z" });
      const after = reopened.getTask("task-legacy") as TaskRecord;
      assert.equal(after.sourceArtifactId, "analysis-artifact-1");
    } finally {
      reopened.close();
    }
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
