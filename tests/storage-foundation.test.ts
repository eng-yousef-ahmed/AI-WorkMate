import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";

import type { TranscriptDocument } from "../src/domain/models";
import { DuplicateMeetingError, InsufficientDiskSpaceError } from "../src/storage/errors";
import {
  buildMeetingFolderName,
  getDataRootProtectionError,
  LocalStorageService,
} from "../src/storage/LocalStorageService";
import { withTempStore } from "./helpers";

test("creates the required local DATA_ROOT layout and SQLite index", async () => {
  await withTempStore(async (store, root) => {
    for (const directory of ["Meetings", "Database", "Backups", "Exports"]) {
      assert.equal((await stat(join(root, directory))).isDirectory(), true);
    }
    assert.equal((await stat(join(root, "storage.json"))).isFile(), true);
    assert.equal((await stat(store.database.path)).isFile(), true);
    assert.equal(store.listMeetings().length, 0);
  });
});

test("keeps media out of SQLite while indexing only stable artifact metadata", async () => {
  await withTempStore(async (store, root) => {
    const meeting = await store.createMeeting({ title: "Blob boundary", meetingDate: "2026-09-01" });
    const recording = await store.saveRecording({
      meetingId: meeting.meetingId,
      extension: "mp4",
      mimeType: "video/mp4",
      contents: Buffer.from("not a database blob"),
    });
    const database = new DatabaseSync(store.database.path, { readOnly: true });
    try {
      const columns = database.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string; type: string }>;
      assert.equal(columns.some((column) => column.name === "relative_path"), true);
      assert.equal(columns.some((column) => column.type.toUpperCase().includes("BLOB")), false);
      const row = database.prepare("SELECT relative_path, size, sha256 FROM artifacts WHERE file_id = $fileId").get({ $fileId: recording.fileId }) as { relative_path: string; size: number; sha256: string };
      assert.equal(row.relative_path, recording.relativePath);
      assert.equal(row.size, Buffer.byteLength("not a database blob"));
      assert.equal(row.sha256, recording.sha256);
      assert.equal((await readFile(join(root, recording.relativePath), "utf8")), "not a database blob");
    } finally {
      database.close();
    }
  });
});

test("isolates 100 meetings with identical titles and deterministic ID-based filenames", async () => {
  await withTempStore(async (store) => {
    const meetings = [];
    const audioArtifacts = [];
    for (let index = 0; index < 100; index += 1) {
      const meeting = await store.createMeeting({ title: "Recurring planning", meetingDate: "2026-09-01" });
      meetings.push(meeting);
      audioArtifacts.push(await store.saveAudio(meeting.meetingId, {
        extension: "m4a",
        mimeType: "audio/mp4",
        contents: Buffer.from(`audio-${index}`),
      }));
    }
    const meetingIds = new Set(meetings.map((meeting) => meeting.meetingId));
    const folderNames = new Set(meetings.map((meeting) => meeting.folderName));
    const folderPaths = await store.storage.listMeetingFolderPaths();
    assert.equal(meetingIds.size, 100);
    assert.equal(folderNames.size, 100);
    assert.equal(folderPaths.length, 100);
    assert.ok(meetings.every((meeting) => meeting.folderName.startsWith("2026-09-01_Recurring-planning_")));
    assert.ok(meetings.every((meeting) => meeting.folderName.endsWith(meeting.meetingId)));

    const artifacts = store.database.listArtifacts();
    const paths = new Set(artifacts.map((artifact) => artifact.relativePath));
    const meetingById = new Map(meetings.map((meeting) => [meeting.meetingId, meeting]));
    assert.equal(artifacts.length, 200);
    assert.equal(paths.size, artifacts.length);
    for (const artifact of artifacts) {
      const owner = meetingById.get(artifact.meetingId);
      assert.ok(owner);
      assert.ok(artifact.relativePath.startsWith(`${owner.folderRelativePath}/`));
      assert.equal(store.database.getArtifactByPath(artifact.relativePath)?.fileId, artifact.fileId);
      assert.equal((await store.storage.inspectFile(artifact.relativePath, artifact.sha256)).status, "AVAILABLE");
    }
    for (const [index, artifact] of audioArtifacts.entries()) {
      assert.equal(await readFile(join(store.storage.dataRoot, artifact.relativePath), "utf8"), `audio-${index}`);
    }
    assert.equal(store.listMeetings().length, 100);
  });
});

test("preserves original recordings and keeps normalized media in a separate variant", async () => {
  await withTempStore(async (store, root) => {
    const meeting = await store.createMeeting({ title: "Media review", meetingDate: "2026-09-01" });
    const sourcePath = join(root, "outside-recording.webm");
    await writeFile(sourcePath, Buffer.from("original bytes"));
    const original = await store.saveRecording({
      meetingId: meeting.meetingId,
      extension: "webm",
      mimeType: "video/webm",
      sourcePath,
    });
    const normalized = await store.saveRecording({
      meetingId: meeting.meetingId,
      variant: "NORMALIZED",
      extension: "mp4",
      mimeType: "video/mp4",
      contents: Buffer.from("normalized bytes"),
    });
    assert.match(original.relativePath, /Recording\/Original\/meeting_.*\.webm$/);
    assert.match(normalized.relativePath, /Recording\/Normalized\/meeting_.*\.mp4$/);
    assert.deepEqual(await readFile(join(root, original.relativePath)), Buffer.from("original bytes"));
    assert.deepEqual(await readFile(join(root, normalized.relativePath)), Buffer.from("normalized bytes"));
    assert.notEqual(original.relativePath, normalized.relativePath);
    assert.equal(store.database.listArtifacts(meeting.meetingId).filter((artifact) => artifact.artifactType.startsWith("RECORDING")).length, 2);
    assert.equal((await store.storage.listFiles()).some((file) => file.relativePath.includes(".tmp-")), false);
    assert.equal(store.database.listArtifactOperations().every((operation) => operation.state === "COMMITTED"), true);
    assert.equal(original.sha256, store.storage.hashBytes("original bytes"));
  });
});

test("stores structured transcript JSON plus timestamp-preserving text, VTT, and SRT", async () => {
  await withTempStore(async (store, root) => {
    const meeting = await store.createMeeting({ title: "Transcript review", meetingDate: "2026-09-01" });
    const transcript: TranscriptDocument = {
      meetingId: meeting.meetingId,
      speakers: [{ speakerId: "s1", displayName: "Ada" }],
      timestamps: true,
      language: "en-US",
      createdAt: "2026-09-01T10:00:00.000Z",
      segments: [{ segmentId: "segment-1", speakerId: "s1", startMs: 1_234, endMs: 4_567, text: "Keep this local.", confidence: 0.98 }],
    };
    const artifacts = await store.saveTranscript(transcript, { includeVtt: true, includeSrt: true });
    const json = JSON.parse(await readFile(join(root, artifacts.json.relativePath), "utf8")) as TranscriptDocument;
    assert.equal(json.meetingId, meeting.meetingId);
    assert.equal(json.segments[0]?.startMs, 1_234);
    assert.match(await readFile(join(root, artifacts.text.relativePath), "utf8"), /\[00:00:01\.234\] Ada/);
    assert.match(await readFile(join(root, artifacts.vtt?.relativePath ?? ""), "utf8"), /00:00:01\.234 --> 00:00:04\.567/);
    assert.match(await readFile(join(root, artifacts.srt?.relativePath ?? ""), "utf8"), /00:00:01,234 --> 00:00:04,567/);
    assert.equal(store.database.listTranscripts(meeting.meetingId).length, 1);
  });
});

test("stores analysis artifacts and indexes decisions, tasks, and relationships locally", async () => {
  await withTempStore(async (store, root) => {
    const meeting = await store.createMeeting({ title: "Analysis review", meetingDate: "2026-09-01" });
    const result = await store.saveAnalysis({
      meetingId: meeting.meetingId,
      createdAt: "2026-09-01T10:00:00.000Z",
      summary: "Ship the local-first foundation.",
      decisions: [{ decisionId: "decision-1", text: "Use SQLite for the local index." }],
      tasks: [{ taskId: "task-1", text: "Verify backups", assignee: "Ada", status: "OPEN" }],
      risks: ["Disk may become full."],
      questions: ["Which local model should be configured?"],
      followups: ["Review storage policy next week."],
    });
    assert.equal((await readFile(join(root, result.summaryMarkdown.relativePath), "utf8")).includes("Ship the local-first foundation."), true);
    assert.deepEqual(store.database.listDecisions(meeting.meetingId).map((decision) => decision.text), ["Use SQLite for the local index."]);
    assert.deepEqual(store.database.listTasks(meeting.meetingId).map((task) => task.text), ["Verify backups"]);
    assert.equal(store.database.listAnalysis(meeting.meetingId).length, 7);
  });
});

test("prevents duplicate provider, calendar, and recording identities", async () => {
  await withTempStore(async (store) => {
    const first = await store.createMeeting({ title: "Identity test", meetingDate: "2026-09-01", providerMeetingId: "teams-123" });
    await assert.rejects(
      store.createMeeting({ title: "A different title", meetingDate: "2026-09-02", providerMeetingId: "teams-123" }),
      DuplicateMeetingError,
    );
    await store.createMeeting({ title: "Calendar identity", meetingDate: "2026-09-01", calendarEventId: "calendar-1" });
    await assert.rejects(
      store.createMeeting({ title: "Calendar duplicate", meetingDate: "2026-09-01", calendarEventId: "calendar-1" }),
      DuplicateMeetingError,
    );
    const recording = await store.saveRecording({
      meetingId: first.meetingId,
      extension: "mp4",
      mimeType: "video/mp4",
      contents: Buffer.from("unique-recording"),
    });
    const second = await store.createMeeting({ title: "Recording duplicate", meetingDate: "2026-09-01" });
    await assert.rejects(
      store.saveRecording({ meetingId: second.meetingId, extension: "mp4", mimeType: "video/mp4", contents: Buffer.from("unique-recording") }),
      DuplicateMeetingError,
    );
    assert.equal(recording.status, "AVAILABLE");
  });
});

test("checks available space before recording and fails loudly when the safety margin cannot fit", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Disk check", meetingDate: "2026-09-01" });
    const constrained = new LocalStorageService(store.storage.dataRoot, { spaceSafetyMarginBytes: Number.MAX_SAFE_INTEGER });
    await assert.rejects(constrained.checkDiskSpace(0), InsufficientDiskSpaceError);
    await assert.rejects(store.prepareRecording(meeting.meetingId, Number.MAX_SAFE_INTEGER), InsufficientDiskSpaceError);
    store.database.updateMeetingStatus(meeting.meetingId, "INCOMPLETE");
    await store.saveRecording({
      meetingId: meeting.meetingId,
      extension: "mp4",
      mimeType: "video/mp4",
      contents: Buffer.from("final incomplete recording"),
    });
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "INCOMPLETE");
  });
});

test("records failed artifact writes without indexing a missing file", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Failed artifact", meetingDate: "2026-09-01" });
    await assert.rejects(
      store.saveAudio(meeting.meetingId, {
        extension: "m4a",
        mimeType: "audio/mp4",
        sourcePath: "/definitely/missing/ai-workmate-recording.m4a",
      }),
    );
    const operations = store.database.listArtifactOperations();
    assert.equal(operations.at(-1)?.state, "FAILED");
    assert.equal(store.database.listArtifacts(meeting.meetingId).length, 1);
  });
});

test("fails closed when available disk space cannot be determined", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Unknown space", meetingDate: "2026-09-01" });
    await assert.rejects(store.storage.checkDiskSpace(1), /could not be determined safely/);
    let critical: number | null | undefined;
    const monitor = store.createRecordingDiskMonitor(meeting.meetingId, {
      criticalFreeBytes: 0,
      onCritical: (available) => {
        critical = available;
      },
    });
    await monitor.start();
    assert.equal(critical, null);
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "INCOMPLETE");
  }, { spaceSafetyMarginBytes: 0, availableBytesProvider: async () => null });
});

test("rejects Windows protected locations and the configured installation directory", () => {
  assert.match(
    getDataRootProtectionError("C:\\Program Files\\AI WorkMate\\Data", "C:\\Program Files\\AI WorkMate", "win32") ?? "",
    /protected|installation/i,
  );
  assert.match(
    getDataRootProtectionError("C:\\Windows\\AI WorkMate\\Data", undefined, "win32") ?? "",
    /protected/i,
  );
  assert.match(
    getDataRootProtectionError("D:\\Apps\\AI WorkMate\\Data", "D:\\Apps\\AI WorkMate", "win32") ?? "",
    /installation/i,
  );
  assert.equal(
    getDataRootProtectionError("C:\\Program Files Data\\AI WorkMate", "C:\\Program Files\\AI Workmate", "win32"),
    undefined,
  );
  assert.equal(
    getDataRootProtectionError("C:\\Users\\Ada\\AI WorkMate Data", "C:\\Program Files\\AI Workmate", "win32"),
    undefined,
  );
});

test("rejects unsafe relative paths and still supports the platform-independent storage contract", async () => {
  await withTempStore(async (store) => {
    assert.throws(() => store.storage.assertRelativePath("../outside.txt"));
    assert.throws(() => store.storage.assertRelativePath("/outside.txt"));
    assert.throws(() => store.storage.assertRelativePath("Meetings//file.txt"));
    assert.equal(buildMeetingFolderName("2026-09-01", "Planning / café", "11111111-1111-4111-8111-111111111111"), "2026-09-01_Planning-cafe_11111111-1111-4111-8111-111111111111");
    assert.equal(new LocalStorageService(store.storage.dataRoot).databasePath, store.database.path);
  });
});
