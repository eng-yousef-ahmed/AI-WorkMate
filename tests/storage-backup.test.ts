import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import unzipper from "unzipper";

import { ArchiveService, normalizeArchiveEntryName } from "../src/storage/ArchiveService";
import {
  BackupService,
  LOCAL_BACKUP_ORIGIN,
  RESTORE_STAGING_PREFIX,
} from "../src/storage/BackupService";
import { ArchiveSecurityError, InsufficientDiskSpaceError, StorageError } from "../src/storage/errors";
import type { BackupManifest, StorageManifest } from "../src/domain/models";
import { temporaryDirectory, withTempStore } from "./helpers";

async function readZipFiles(archivePath: string): Promise<Map<string, Buffer>> {
  const directory = await unzipper.Open.file(archivePath);
  const files = new Map<string, Buffer>();
  for (const entry of directory.files) {
    const name = entry.path.replaceAll("\\", "/");
    if (name.endsWith("/")) {
      continue;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of entry.stream()) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    files.set(name, Buffer.concat(chunks));
  }
  return files;
}

async function rewriteZip(destination: string, files: Map<string, Buffer>): Promise<void> {
  const archive = new ArchiveService();
  const entries = [...files.entries()].map(([name, contents]) => ({ name, contents }));
  await archive.createZip(destination, entries);
}

test("new backups hide DATA_ROOT and restore after SHA-256 verification", async () => {
  await withTempStore(async (store, root) => {
    const external = await temporaryDirectory("ai-workmate-backup-harden-");
    try {
      const meeting = await store.createMeeting({ title: "Backup harden", meetingDate: "2026-09-01" });
      const audio = await store.saveAudio(meeting.meetingId, {
        extension: "m4a",
        mimeType: "audio/mp4",
        contents: Buffer.from("backup audio"),
      });
      const backup = await store.backups.createBackup(external);
      const files = await readZipFiles(backup.path);
      const manifest = JSON.parse(files.get("BackupManifest.json")?.toString("utf8") ?? "{}") as BackupManifest;
      const storageManifest = JSON.parse(files.get("storage.json")?.toString("utf8") ?? "{}") as StorageManifest;
      assert.equal(manifest.sourceDataRoot, LOCAL_BACKUP_ORIGIN);
      assert.equal(storageManifest.dataRootLabel, LOCAL_BACKUP_ORIGIN);
      assert.equal(JSON.stringify(manifest).includes(root), false);
      assert.equal(files.get("storage.json")?.toString("utf8").includes(root), false);

      const restoredRoot = join(external, "restored");
      const restored = await store.backups.restore(backup.path, restoredRoot);
      assert.equal(restored.verified, true);
      assert.equal(await readFile(join(restoredRoot, audio.relativePath), "utf8"), "backup audio");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

test("restore fails closed on SHA-256 mismatch, extra members, and truncated archives", async () => {
  await withTempStore(async (store) => {
    const external = await temporaryDirectory("ai-workmate-backup-corrupt-");
    try {
      await store.createMeeting({ title: "Corrupt backup", meetingDate: "2026-09-01" });
      const backup = await store.backups.createBackup(external);
      const files = await readZipFiles(backup.path);

      const mismatched = join(external, "mismatched.aiwm.zip");
      const mismatchedFiles = new Map(files);
      mismatchedFiles.set("storage.json", Buffer.from(`${files.get("storage.json")?.toString("utf8")} `));
      await rewriteZip(mismatched, mismatchedFiles);
      await assert.rejects(
        store.backups.restore(mismatched, join(external, "restore-mismatch")),
        (error: unknown) => error instanceof ArchiveSecurityError && /SHA-256 verification failed/i.test(error.message),
      );

      const extra = join(external, "extra.aiwm.zip");
      const extraFiles = new Map(files);
      extraFiles.set("payload.exe", Buffer.from("unexpected"));
      await rewriteZip(extra, extraFiles);
      await assert.rejects(
        store.backups.restore(extra, join(external, "restore-extra")),
        (error: unknown) =>
          error instanceof ArchiveSecurityError && /file count mismatch|unexpected file/i.test(error.message),
      );

      const truncated = join(external, "truncated.aiwm.zip");
      await writeFile(truncated, "this is not a zip");
      await assert.rejects(
        store.backups.restore(truncated, join(external, "restore-truncated")),
        ArchiveSecurityError,
      );
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

test("restore rejects zip-slip entry names before writing files", () => {
  assert.throws(() => normalizeArchiveEntryName("../evil.txt"), ArchiveSecurityError);
  assert.throws(() => normalizeArchiveEntryName("C:/Windows/system32/evil.dll"), ArchiveSecurityError);
  assert.throws(() => normalizeArchiveEntryName("/tmp/evil"), ArchiveSecurityError);
  assert.equal(normalizeArchiveEntryName("storage.json"), "storage.json");
});

test("restore removes leftover crash staging and refuses a destination inside DATA_ROOT", async () => {
  await withTempStore(async (store, root) => {
    const external = await temporaryDirectory("ai-workmate-backup-staging-");
    try {
      await store.createMeeting({ title: "Staging cleanup", meetingDate: "2026-09-01" });
      const backup = await store.backups.createBackup(external);
      const leftover = join(external, `${RESTORE_STAGING_PREFIX}crash`);
      await mkdir(leftover, { recursive: true });
      await writeFile(join(leftover, "partial.json"), "{}");
      const restored = await store.backups.restore(backup.path, join(external, "restored"));
      assert.equal(restored.verified, true);
      const leftoverNames = await readdir(external);
      assert.equal(leftoverNames.some((name) => name.startsWith(RESTORE_STAGING_PREFIX)), false);

      await assert.rejects(
        store.backups.restore(backup.path, join(root, "inside-data-root")),
        /cannot contain or be contained by the active DATA_ROOT/,
      );
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

test("backup and restore fail closed when destination disk space is missing or unknown", async () => {
  await withTempStore(async (store) => {
    const external = await temporaryDirectory("ai-workmate-backup-enospc-");
    try {
      await store.createMeeting({ title: "Disk space", meetingDate: "2026-09-01" });
      const empty = new BackupService(store.storage, store.database, () => new Date(), async () => 0);
      await assert.rejects(empty.createBackup(external), InsufficientDiskSpaceError);

      const unknown = new BackupService(store.storage, store.database, () => new Date(), async () => null);
      await assert.rejects(unknown.createBackup(external), InsufficientDiskSpaceError);

      const original = await store.backups.createBackup(external);
      const restoreEmpty = new BackupService(store.storage, store.database, () => new Date(), async () => 0);
      await assert.rejects(
        restoreEmpty.restore(original.path, join(external, "restore-enospc")),
        InsufficientDiskSpaceError,
      );
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

test("backup and restore cannot run concurrently on the same service", async () => {
  await withTempStore(async (store) => {
    const external = await temporaryDirectory("ai-workmate-backup-mutex-");
    try {
      await store.createMeeting({ title: "Mutex", meetingDate: "2026-09-01" });
      let release: ((value: number) => void) | undefined;
      const gate = new Promise<number>((resolve) => {
        release = resolve;
      });
      const backups = new BackupService(store.storage, store.database, () => new Date(), async () => gate);
      const pending = backups.createBackup(external);
      await assert.rejects(backups.createBackup(join(external, "other")), (error: unknown) => {
        return error instanceof StorageError && /already in progress/i.test(error.message);
      });
      release?.(Number.MAX_SAFE_INTEGER);
      const created = await pending;
      assert.ok(created.size > 0);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

test("historical backups that stored an absolute sourceDataRoot still restore", async () => {
  await withTempStore(async (store, root) => {
    const external = await temporaryDirectory("ai-workmate-backup-legacy-");
    try {
      await store.createMeeting({ title: "Legacy backup", meetingDate: "2026-09-01" });
      const backup = await store.backups.createBackup(external);
      const files = await readZipFiles(backup.path);
      const manifest = JSON.parse(files.get("BackupManifest.json")?.toString("utf8") ?? "{}") as BackupManifest;
      manifest.sourceDataRoot = root;
      files.set("BackupManifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
      const legacy = join(external, "legacy.aiwm.zip");
      await rewriteZip(legacy, files);
      const restored = await store.backups.restore(legacy, join(external, "legacy-restored"));
      assert.equal(restored.verified, true);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});
