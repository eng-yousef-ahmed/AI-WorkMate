import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { LocalFirstStore } from "../src/storage/LocalFirstStore";
import { withTempStore, temporaryDirectory } from "./helpers";

test("detects manually deleted and corrupted artifacts without crashing", async () => {
  await withTempStore(async (store, root) => {
    const meeting = await store.createMeeting({ title: "Integrity check", meetingDate: "2026-09-01" });
    const deleted = await store.saveAudio(meeting.meetingId, { extension: "m4a", mimeType: "audio/mp4", contents: Buffer.from("delete me") });
    const corrupted = await store.saveAudio(meeting.meetingId, { extension: "wav", mimeType: "audio/wav", contents: Buffer.from("original") });
    await rm(join(root, deleted.relativePath));
    await writeFile(join(root, corrupted.relativePath), Buffer.from("changed outside the app"));

    const report = await store.verifyStorage();
    assert.ok(report.issues.some((issue) => issue.kind === "MISSING_ARTIFACT" && issue.fileId === deleted.fileId));
    assert.ok(report.issues.some((issue) => issue.kind === "CORRUPTED_ARTIFACT" && issue.fileId === corrupted.fileId));
    assert.equal(store.database.getArtifact(deleted.fileId)?.status, "MISSING");
    assert.equal(store.database.getArtifact(corrupted.fileId)?.status, "CORRUPTED");
  });
});

test("recovery reports known orphans, incomplete recordings, and unknown folders without deleting them", async () => {
  await withTempStore(async (store, root) => {
    const meeting = await store.createMeeting({ title: "Recovery scan", meetingDate: "2026-09-01" });
    const orphanPath = `${meeting.folderRelativePath}/Attachments/orphan.txt`;
    await writeFile(join(root, orphanPath), "keep this file");
    const temporaryRecording = `${meeting.folderRelativePath}/Recording/Original/meeting_${meeting.meetingId}.mp4.tmp-interrupted`;
    await writeFile(join(root, temporaryRecording), "partial");
    const unknownFolder = join(root, "Meetings", "2026", "09", "2026-09-01_Unknown_22222222-2222-4222-8222-222222222222");
    await mkdir(unknownFolder, { recursive: true });
    await writeFile(join(unknownFolder, "Meeting.json"), JSON.stringify({ meetingId: "22222222-2222-4222-8222-222222222222" }));
    const unknownFile = join(unknownFolder, "do-not-delete.txt");
    await writeFile(unknownFile, "user file");

    const report = await store.verifyStorage();
    assert.ok(report.issues.some((issue) => issue.kind === "ORPHANED_FILE" && issue.path === orphanPath));
    assert.ok(report.issues.some((issue) => issue.kind === "INCOMPLETE_RECORDING" && issue.path === temporaryRecording));
    assert.ok(report.issues.some((issue) => issue.kind === "UNKNOWN_MEETING_FOLDER"));
    assert.equal(await readFile(unknownFile, "utf8"), "user file");

    const repaired = await store.repairStorageIndex();
    assert.equal(repaired.repairedArtifacts, 1);
    assert.equal(store.database.getArtifactByPath(orphanPath)?.status, "AVAILABLE");
    assert.equal(await readFile(join(root, orphanPath), "utf8"), "keep this file");
  });
});

test("does not silently treat a deleted SQLite database as a healthy empty workspace", async () => {
  await withTempStore(async (store, root) => {
    await store.createMeeting({ title: "Database recovery", meetingDate: "2026-09-01" });
    store.close();
    await rm(join(root, "Database", "ai-workmate.sqlite"));
    const reopened = new LocalFirstStore(root, { spaceSafetyMarginBytes: 0 });
    await reopened.initialize();
    try {
      const report = await reopened.verifyStorage();
      assert.ok(report.issues.some((issue) => issue.kind === "MISSING_DATABASE"));
      assert.ok(report.issues.some((issue) => issue.kind === "UNKNOWN_MEETING_FOLDER"));
    } finally {
      reopened.close();
    }
  });
});

test("migrates DATA_ROOT only after verification and preserves the source", async () => {
  await withTempStore(async (store, root) => {
    const external = await temporaryDirectory("ai-workmate-migration-");
    try {
      const meeting = await store.createMeeting({ title: "Migration test", meetingDate: "2026-09-01" });
      const artifact = await store.saveAudio(meeting.meetingId, { extension: "m4a", mimeType: "audio/mp4", contents: Buffer.from("must survive migration") });
      const result = await store.migrateDataRoot(join(external, "new-data"));
      assert.equal(result.verified, true);
      assert.equal(result.sourcePreserved, true);
      assert.equal(await readFile(join(root, artifact.relativePath), "utf8"), "must survive migration");
      assert.equal(await readFile(join(store.storage.dataRoot, artifact.relativePath), "utf8"), "must survive migration");
      assert.equal(store.listMeetings()[0]?.meetingId, meeting.meetingId);
      const manifest = JSON.parse(await readFile(join(store.storage.dataRoot, "storage.json"), "utf8")) as { dataRootLabel: string };
      assert.equal(manifest.dataRootLabel, store.storage.dataRoot);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});
