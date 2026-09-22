import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { APP_VERSION, assertAppVersionCompatible, compareAppVersions } from "../src/app-version";
import { DATABASE_SCHEMA_VERSION } from "../src/domain/models";
import { InsufficientDiskSpaceError, StorageError } from "../src/storage/errors";
import { LocalFirstStore } from "../src/storage/LocalFirstStore";
import { StorageConfigService } from "../src/storage/StorageConfigService";
import { FIRST_RUN_MINIMUM_FREE_BYTES, StorageRuntime } from "../src/storage/StorageRuntime";

test("APP_VERSION matches package.json", async () => {
  const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version: string };
  assert.equal(APP_VERSION, pkg.version);
  assert.equal(compareAppVersions("0.1.0", "0.1.0"), 0);
  assert.equal(compareAppVersions("0.1.0", "0.2.0"), -1);
  assert.equal(compareAppVersions("1.0.0", "0.9.9"), 1);
  assertAppVersionCompatible(undefined, APP_VERSION);
  assertAppVersionCompatible("0.0.1", APP_VERSION);
  assert.throws(
    () => assertAppVersionCompatible("9.9.9", APP_VERSION),
    (error: unknown) => error instanceof StorageError && error.message.includes("newer AI WorkMate version"),
  );
  assert.throws(() => compareAppVersions("v1", "0.1.0"), (error: unknown) => error instanceof StorageError);
});

test("first-run records app version and a renderer-safe lifecycle snapshot", async () => {
  const appConfigRoot = await mkdtemp(join(tmpdir(), "ai-workmate-lifecycle-config-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "ai-workmate-lifecycle-root-"));
  const config = new StorageConfigService(join(appConfigRoot, "storage-config.json"));
  const runtime = new StorageRuntime(config);
  try {
    assert.equal(await runtime.initialize(), false);
    const before = await runtime.getLifecycleSnapshot();
    assert.equal(before.workspaceReady, false);
    assert.equal(before.firstRunRequired, true);
    assert.equal(before.dataLocation.pathExposed, false);
    assert.equal("destination" in before, false);
    await runtime.configureFirstRun(dataRoot);
    const persisted = JSON.parse(await readFile(join(appConfigRoot, "storage-config.json"), "utf8")) as {
      lastOpenedAppVersion?: string;
      pendingFirstRun?: unknown;
    };
    assert.equal(persisted.lastOpenedAppVersion, APP_VERSION);
    assert.equal(persisted.pendingFirstRun, undefined);
    const snapshot = await runtime.getSnapshot();
    assert.equal(snapshot.appVersion, APP_VERSION);
    assert.equal(snapshot.schemaVersion, DATABASE_SCHEMA_VERSION);
    assert.equal(snapshot.dataLocation.pathExposed, false);
    const lifecycle = await runtime.getLifecycleSnapshot();
    assert.equal(lifecycle.workspaceReady, true);
    assert.equal(lifecycle.firstRunRequired, false);
    assert.equal(lifecycle.schemaVersion, DATABASE_SCHEMA_VERSION);
    assert.equal(JSON.stringify(lifecycle).includes(dataRoot), false);
  } finally {
    runtime.store?.close();
    await rm(appConfigRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("recovers an interrupted first-run after the workspace files were initialized", async () => {
  const appConfigRoot = await mkdtemp(join(tmpdir(), "ai-workmate-firstrun-recovery-config-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "ai-workmate-firstrun-recovery-root-"));
  const config = new StorageConfigService(join(appConfigRoot, "storage-config.json"));
  const store = new LocalFirstStore(dataRoot, { spaceSafetyMarginBytes: 0 });
  try {
    await store.initialize();
    store.close();
    await config.setFirstRunJournal({
      destination: dataRoot,
      state: "INITIALIZED",
      updatedAt: "2026-09-10T00:00:00.000Z",
    });
    const recovered = new StorageRuntime(config);
    try {
      assert.equal(await recovered.initialize(), true);
      assert.equal(recovered.getDataRoot(), dataRoot);
      assert.equal((await config.read()).pendingFirstRun, undefined);
      assert.equal(recovered.store?.listMeetings().length, 0);
    } finally {
      recovered.store?.close();
    }
  } finally {
    await rm(appConfigRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("marks an interrupted first-run incomplete when the destination was never initialized", async () => {
  const appConfigRoot = await mkdtemp(join(tmpdir(), "ai-workmate-firstrun-incomplete-config-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "ai-workmate-firstrun-incomplete-root-"));
  const config = new StorageConfigService(join(appConfigRoot, "storage-config.json"));
  await config.setFirstRunJournal({
    destination: dataRoot,
    state: "STARTED",
    updatedAt: "2026-09-10T00:00:00.000Z",
  });
  const runtime = new StorageRuntime(config);
  try {
    assert.equal(await runtime.initialize(), false);
    assert.equal((await config.read()).pendingFirstRun?.state, "INCOMPLETE");
    const lifecycle = await runtime.getLifecycleSnapshot();
    assert.equal(lifecycle.firstRunRequired, true);
    assert.equal(lifecycle.firstRunRecoveryRequired, true);
    assert.equal(JSON.stringify(lifecycle).includes(dataRoot), false);
  } finally {
    runtime.store?.close();
    await rm(appConfigRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("first-run fails closed when the destination does not have enough free space", async () => {
  const appConfigRoot = await mkdtemp(join(tmpdir(), "ai-workmate-firstrun-space-config-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "ai-workmate-firstrun-space-root-"));
  const config = new StorageConfigService(join(appConfigRoot, "storage-config.json"));
  const runtime = new StorageRuntime(config, () => new Date(), undefined, {
    spaceSafetyMarginBytes: 0,
    availableBytesProvider: async () => 1024,
  });
  try {
    await assert.rejects(
      runtime.configureFirstRun(dataRoot),
      (error: unknown) => error instanceof InsufficientDiskSpaceError && error.requiredBytes === FIRST_RUN_MINIMUM_FREE_BYTES,
    );
    assert.equal((await config.read()).pendingFirstRun?.state, "INCOMPLETE");
    assert.equal((await config.read()).dataRoot, undefined);
  } finally {
    runtime.store?.close();
    await rm(appConfigRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("refuses to open a workspace last used by a newer application version", async () => {
  const appConfigRoot = await mkdtemp(join(tmpdir(), "ai-workmate-downgrade-config-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "ai-workmate-downgrade-root-"));
  const config = new StorageConfigService(join(appConfigRoot, "storage-config.json"));
  const runtime = new StorageRuntime(config);
  try {
    await runtime.configureFirstRun(dataRoot);
    runtime.store?.close();
    await config.setLastOpenedAppVersion("9.9.9");
    const older = new StorageRuntime(config);
    await assert.rejects(
      older.initialize(),
      (error: unknown) => error instanceof StorageError && error.message.includes("newer AI WorkMate version"),
    );
  } finally {
    await rm(appConfigRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("refuses a database whose schema is newer than this build", async () => {
  const appConfigRoot = await mkdtemp(join(tmpdir(), "ai-workmate-schema-config-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "ai-workmate-schema-root-"));
  await mkdir(join(dataRoot, "Database"), { recursive: true });
  await writeFile(
    join(dataRoot, "storage.json"),
    `${JSON.stringify({
      storageVersion: 1,
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
      dataRootLabel: "LOCAL",
    }, null, 2)}\n`,
  );
  const database = new DatabaseSync(join(dataRoot, "Database", "ai-workmate.sqlite"));
  database.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations (version, applied_at) VALUES (99, '2026-09-10T00:00:00.000Z');",
  );
  database.close();
  const config = new StorageConfigService(join(appConfigRoot, "storage-config.json"));
  await config.setDataRoot(dataRoot);
  const runtime = new StorageRuntime(config);
  try {
    await assert.rejects(
      runtime.initialize(),
      (error: unknown) =>
        error instanceof StorageError &&
        error.message.includes("newer than supported") &&
        error.message.includes("99"),
    );
  } finally {
    runtime.store?.close();
    await rm(appConfigRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});
