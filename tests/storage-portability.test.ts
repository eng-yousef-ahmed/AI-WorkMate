import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import unzipper from "unzipper";

import { LocalFirstStore } from "../src/storage/LocalFirstStore";
import { withTempStore, temporaryDirectory } from "./helpers";

test("creates and restores a standard local backup with a consistent SQLite snapshot", async () => {
  await withTempStore(async (store) => {
    const external = await temporaryDirectory("ai-workmate-backup-");
    try {
      const meeting = await store.createMeeting({ title: "Backup test", meetingDate: "2026-09-01" });
      const audio = await store.saveAudio(meeting.meetingId, { extension: "m4a", mimeType: "audio/mp4", contents: Buffer.from("backup audio") });
      const transcript = await store.saveTranscript({
        meetingId: meeting.meetingId,
        speakers: [],
        timestamps: true,
        language: "en",
        createdAt: "2026-09-01T10:00:00.000Z",
        segments: [{ segmentId: "s1", startMs: 0, endMs: 500, text: "backup transcript" }],
      });
      const backup = await store.backups.createBackup(external);
      const entries = await unzipper.Open.file(backup.path);
      const names = entries.files.map((entry) => entry.path);
      assert.ok(names.includes("BackupManifest.json"));
      assert.ok(names.includes("storage.json"));
      assert.ok(names.includes("Database/ai-workmate.sqlite"));
      assert.ok(names.includes(audio.relativePath));
      assert.ok(names.includes(transcript.json.relativePath));

      const restoredRoot = join(external, "restored");
      const restored = await store.backups.restore(backup.path, restoredRoot);
      assert.equal(restored.verified, true);
      const restoredStore = new LocalFirstStore(restoredRoot, { spaceSafetyMarginBytes: 0 });
      await restoredStore.initialize();
      try {
        assert.equal(restoredStore.listMeetings()[0]?.meetingId, meeting.meetingId);
        assert.equal(await readFile(join(restoredRoot, audio.relativePath), "utf8"), "backup audio");
        assert.equal(restoredStore.database.listTranscripts(meeting.meetingId).length, 1);
      } finally {
        restoredStore.close();
      }
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

test("exports a meeting as a portable ZIP with relationship metadata", async () => {
  await withTempStore(async (store) => {
    const external = await temporaryDirectory("ai-workmate-export-");
    try {
      const meeting = await store.createMeeting({ title: "Export test", meetingDate: "2026-09-01" });
      await store.saveRecording({ meetingId: meeting.meetingId, extension: "mp4", mimeType: "video/mp4", contents: Buffer.from("video") });
      await store.saveAnalysis({
        meetingId: meeting.meetingId,
        createdAt: "2026-09-01T10:00:00.000Z",
        summary: "Portable summary",
        decisions: [{ decisionId: "d1", text: "Keep relationships" }],
        tasks: [{ taskId: "t1", text: "Open the export", status: "OPEN" }],
        risks: [],
        questions: [],
        followups: [],
      });
      const exported = await store.exports.exportMeeting(meeting.meetingId, external);
      const entries = await unzipper.Open.file(exported.path);
      const names = entries.files.map((entry) => entry.path);
      assert.ok(names.includes("ExportManifest.json"));
      assert.ok(names.includes("Meeting.json"));
      assert.ok(names.includes("MeetingMetadata.json"));
      assert.ok(names.includes("Analysis/summary.md"));
      assert.ok(names.includes("Recording/Original/meeting_" + meeting.meetingId + ".mp4"));
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});
