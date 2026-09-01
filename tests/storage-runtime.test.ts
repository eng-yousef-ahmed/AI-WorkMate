import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { StorageLayoutMigrator } from "../src/storage/StorageMigrator";
import { LocalStorageService } from "../src/storage/LocalStorageService";
import { StorageConfigService } from "../src/storage/StorageConfigService";
import { StorageRuntime } from "../src/storage/StorageRuntime";

test("runs only an explicitly registered storage-layout migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-layout-"));
  try {
    await writeFile(join(root, "storage.json"), JSON.stringify({
      storageVersion: 0,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      dataRootLabel: root,
    }));
    const migrator = new StorageLayoutMigrator([{
      fromVersion: 0,
      toVersion: 1,
      description: "Initial versioned layout",
      migrate: async () => undefined,
    }]);
    const storage = new LocalStorageService(root, { spaceSafetyMarginBytes: 0, layoutMigrator: migrator });
    const manifest = await storage.initialize();
    assert.equal(manifest.storageVersion, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first-run configuration persists DATA_ROOT outside meeting data and location changes update the config", async () => {
  const appConfigRoot = await mkdtemp(join(tmpdir(), "ai-workmate-config-"));
  const firstRoot = await mkdtemp(join(tmpdir(), "ai-workmate-root-"));
  const secondRootParent = await mkdtemp(join(tmpdir(), "ai-workmate-new-root-"));
  const configPath = join(appConfigRoot, "storage-config.json");
  const config = new StorageConfigService(configPath);
  const runtime = new StorageRuntime(config);
  try {
    assert.equal(await runtime.initialize(), false);
    await runtime.configureFirstRun(firstRoot);
    assert.equal(runtime.getDataRoot(), firstRoot);
    const firstConfig = JSON.parse(await readFile(configPath, "utf8")) as { dataRoot: string; aiProcessingPolicy: string };
    assert.equal(firstConfig.dataRoot, firstRoot);
    assert.equal(firstConfig.aiProcessingPolicy, "ASK_EACH_TIME");
    const snapshot = await runtime.getSnapshot();
    assert.equal(snapshot.dataLocation.pathExposed, false);
    assert.equal("dataRoot" in snapshot.stats, false);
    assert.equal(snapshot.dataLocation.label, "Local workspace (path hidden)");
    const meeting = await runtime.store?.createMeeting({ title: "Runtime move", meetingDate: "2026-09-01" });
    assert.ok(meeting);
    const destination = join(secondRootParent, "AI WorkMate Data");
    const changed = await runtime.changeDataRoot(destination, true);
    assert.equal(changed.migrated, true);
    assert.equal(runtime.getDataRoot(), destination);
    assert.equal(runtime.store?.database.path, join(destination, "Database", "ai-workmate.sqlite"));
    const secondConfig = JSON.parse(await readFile(configPath, "utf8")) as { dataRoot: string; pendingMigration?: unknown };
    assert.equal(secondConfig.dataRoot, destination);
    assert.equal(secondConfig.pendingMigration, undefined);
  } finally {
    runtime.store?.close();
    await rm(appConfigRoot, { recursive: true, force: true });
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRootParent, { recursive: true, force: true });
  }
});

test("recovers a runtime-switched migration before configuration activation", async () => {
  const appConfigRoot = await mkdtemp(join(tmpdir(), "ai-workmate-runtime-recovery-config-"));
  const source = await mkdtemp(join(tmpdir(), "ai-workmate-runtime-recovery-source-"));
  const destinationParent = await mkdtemp(join(tmpdir(), "ai-workmate-runtime-recovery-destination-"));
  const destination = join(destinationParent, "new-data");
  const config = new StorageConfigService(join(appConfigRoot, "storage-config.json"));
  const runtime = new StorageRuntime(config);
  try {
    await config.setDataRoot(source);
    assert.equal(await runtime.initialize(), true);
    await runtime.store?.createMeeting({ title: "Runtime recovery", meetingDate: "2026-09-01" });
    await runtime.store?.migrateDataRoot(destination);
    runtime.store?.close();

    await config.setDataRoot(source);
    await config.setMigrationJournal({
      operationId: "migration-runtime-switched-1",
      source,
      destination,
      state: "RUNTIME_SWITCHED",
      updatedAt: "2026-09-01T10:00:00.000Z",
    });

    const recovered = new StorageRuntime(config);
    try {
      assert.equal(await recovered.initialize(), true);
      assert.equal(recovered.getDataRoot(), destination);
      assert.equal(recovered.store?.listMeetings().length, 1);
      assert.equal((await config.read()).pendingMigration, undefined);
    } finally {
      recovered.store?.close();
    }
  } finally {
    await rm(appConfigRoot, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
    await rm(destinationParent, { recursive: true, force: true });
  }
});

test("marks an interrupted migration journal incomplete and keeps the verified source active", async () => {
  const appConfigRoot = await mkdtemp(join(tmpdir(), "ai-workmate-journal-config-"));
  const source = await mkdtemp(join(tmpdir(), "ai-workmate-journal-source-"));
  const destinationParent = await mkdtemp(join(tmpdir(), "ai-workmate-journal-destination-"));
  const destination = join(destinationParent, "new-data");
  const config = new StorageConfigService(join(appConfigRoot, "storage-config.json"));
  const runtime = new StorageRuntime(config);
  try {
    await config.setDataRoot(source);
    assert.equal(await runtime.initialize(), true);
    await runtime.store?.createMeeting({ title: "Journal source", meetingDate: "2026-09-01" });
    runtime.store?.close();
    await config.setMigrationJournal({
      operationId: "migration-interrupted-1",
      source,
      destination,
      state: "COPYING",
      updatedAt: "2026-09-01T10:00:00.000Z",
    });

    const recovered = new StorageRuntime(config);
    try {
      assert.equal(await recovered.initialize(), true);
      assert.equal(recovered.getDataRoot(), source);
      const recoveredConfig = await config.read();
      assert.equal(recoveredConfig.pendingMigration?.state, "INCOMPLETE");
      assert.equal(recovered.store?.listMeetings().length, 1);
    } finally {
      recovered.store?.close();
    }
  } finally {
    await rm(appConfigRoot, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
    await rm(destinationParent, { recursive: true, force: true });
  }
});
