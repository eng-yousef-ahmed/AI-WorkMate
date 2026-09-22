import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { LocalRecordingCaptureEngine, LocalFirstStore } from "../src";
import { DataRootValidationError } from "../src/storage/errors";
import { temporaryDirectory, withTempStore } from "./helpers";

test("starts local capture and reports recording state for exactly one meeting UUID", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Capture start", meetingDate: "2026-09-01" });
    const engine = new LocalRecordingCaptureEngine(store, fixedClock());

    const state = await engine.startCapture({
      meetingId: meeting.meetingId,
      format: "webm",
      mimeType: "video/webm",
      estimatedBytes: 5,
      startedAt: "2026-09-01T10:00:00.000Z",
      captureSource: "TEST_CAPTURE_ADAPTER",
    });

    assert.equal(state.meetingId, meeting.meetingId);
    assert.equal(state.state, "RECORDING");
    assert.equal(state.bytesWritten, 0);
    assert.equal(state.chunksWritten, 0);
    assert.equal(state.format, "webm");
    assert.equal(state.captureSource, "TEST_CAPTURE_ADAPTER");
    assert.ok(state.relativePath?.startsWith(`${meeting.folderRelativePath}/Recording/Original/`));
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "RECORDING");
    assert.equal(store.database.listArtifactOperations().at(-1)?.state, "WRITING");
    assert.deepEqual(engine.getCaptureState(state.captureId), state);
  });
});

test("writes multiple chunks in order and finalizes through the artifact journal", async () => {
  await withTempStore(async (store, root) => {
    const meeting = await store.createMeeting({ title: "Chunk capture", meetingDate: "2026-09-01" });
    const engine = new LocalRecordingCaptureEngine(store, fixedClock());
    const started = await engine.startCapture({
      meetingId: meeting.meetingId,
      format: "webm",
      mimeType: "video/webm",
      estimatedBytes: 11,
      startedAt: "2026-09-01T10:00:00.000Z",
      captureSource: "LOCAL_CHUNK_TEST",
    });

    await engine.appendChunk({ captureId: started.captureId, meetingId: meeting.meetingId, chunk: Buffer.from("hello "), sequence: 0 });
    const afterSecond = await engine.appendChunk({ captureId: started.captureId, meetingId: meeting.meetingId, chunk: Buffer.from("world"), sequence: 1 });
    assert.equal(afterSecond.bytesWritten, 11);
    assert.equal(afterSecond.chunksWritten, 2);

    const finalized = await engine.finalizeCapture({
      captureId: started.captureId,
      meetingId: meeting.meetingId,
      endedAt: "2026-09-01T10:00:05.000Z",
    });

    const expectedSha = createHash("sha256").update("hello world").digest("hex");
    assert.equal(finalized.state, "COMPLETED");
    assert.equal(finalized.sha256, expectedSha);
    assert.equal(finalized.durationMs, 5_000);
    assert.equal(finalized.artifact?.sha256, expectedSha);
    assert.equal(finalized.artifact?.size, 11);
    assert.equal(await readFile(join(root, finalized.relativePath ?? ""), "utf8"), "hello world");
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "PROCESSING");
    assert.equal(store.database.listArtifactOperations().at(-1)?.state, "COMMITTED");
    assert.equal(store.database.listArtifacts(meeting.meetingId).filter((artifact) => artifact.artifactType === "RECORDING_ORIGINAL").length, 1);

    const [recording] = store.database.listRecordings(meeting.meetingId);
    assert.ok(recording);
    assert.equal(recording.meetingId, meeting.meetingId);
    assert.equal(recording.artifactId, finalized.artifact?.fileId);
    assert.equal(recording.format, "webm");
    assert.equal(recording.captureStartedAt, "2026-09-01T10:00:00.000Z");
    assert.equal(recording.captureEndedAt, "2026-09-01T10:00:05.000Z");
    assert.equal(recording.durationMs, 5_000);
    assert.equal(recording.byteSize, 11);
    assert.equal(recording.sha256, expectedSha);
    assert.equal(recording.relativePath, finalized.relativePath);
    assert.equal(recording.captureSource, "LOCAL_CHUNK_TEST");
    assert.equal(recording.finalStatus, "COMMITTED");
    assert.equal(store.database.getMigrationFingerprint().includes("hello world"), false);
  });
});


test("accepts controlled async streams without caller filesystem paths", async () => {
  await withTempStore(async (store, root) => {
    const meeting = await store.createMeeting({ title: "Stream capture", meetingDate: "2026-09-01" });
    const engine = new LocalRecordingCaptureEngine(store, fixedClock());
    const started = await engine.startCapture({ meetingId: meeting.meetingId, format: "opus", mimeType: "audio/ogg" });

    async function* stream(): AsyncIterable<Uint8Array> {
      yield Buffer.from("stream-");
      yield Buffer.from("owned");
    }

    const streamed = await engine.appendStream({
      captureId: started.captureId,
      meetingId: meeting.meetingId,
      stream: stream(),
      startingSequence: 0,
    });
    assert.equal(streamed.bytesWritten, 12);
    assert.equal(streamed.chunksWritten, 2);

    const finalized = await engine.finalizeCapture({ captureId: started.captureId, meetingId: meeting.meetingId });
    assert.equal(await readFile(join(root, finalized.relativePath ?? ""), "utf8"), "stream-owned");
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "PROCESSING");
  });
});

test("rejects duplicate finalization and writes after finalization", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Finalize once", meetingDate: "2026-09-01" });
    const engine = new LocalRecordingCaptureEngine(store, fixedClock());
    const started = await engine.startCapture({ meetingId: meeting.meetingId, format: "webm", mimeType: "video/webm" });
    await engine.appendChunk({ captureId: started.captureId, meetingId: meeting.meetingId, chunk: Buffer.from("final") });
    await engine.finalizeCapture({ captureId: started.captureId, meetingId: meeting.meetingId });

    await assert.rejects(
      engine.finalizeCapture({ captureId: started.captureId, meetingId: meeting.meetingId }),
      /already been finalized/,
    );
    await assert.rejects(
      engine.appendChunk({ captureId: started.captureId, meetingId: meeting.meetingId, chunk: Buffer.from("late") }),
      /not writable/,
    );
    assert.equal(store.database.listRecordings(meeting.meetingId).length, 1);
  });
});

test("rejects empty invalid and out-of-order chunks without corrupting an active capture", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Invalid chunks", meetingDate: "2026-09-01" });
    const engine = new LocalRecordingCaptureEngine(store, fixedClock());
    const started = await engine.startCapture({ meetingId: meeting.meetingId, format: "webm", mimeType: "video/webm" });

    await assert.rejects(
      engine.appendChunk({ captureId: started.captureId, meetingId: meeting.meetingId, chunk: Buffer.alloc(0) }),
      DataRootValidationError,
    );
    await assert.rejects(
      engine.appendChunk({ captureId: started.captureId, meetingId: meeting.meetingId, chunk: "not binary" }),
      DataRootValidationError,
    );
    await assert.rejects(
      engine.appendChunk({ captureId: started.captureId, meetingId: meeting.meetingId, chunk: Buffer.from("late"), sequence: 3 }),
      /does not match expected sequence 0/,
    );
    assert.equal(engine.getCaptureState(started.captureId).state, "RECORDING");
    assert.equal(engine.getCaptureState(started.captureId).bytesWritten, 0);

    await engine.appendChunk({ captureId: started.captureId, meetingId: meeting.meetingId, chunk: Buffer.from("ok"), sequence: 0 });
    assert.equal((await engine.finalizeCapture({ captureId: started.captureId, meetingId: meeting.meetingId })).state, "COMPLETED");
  });
});

test("enforces meeting ownership isolation for capture chunks and finalization", async () => {
  await withTempStore(async (store) => {
    const first = await store.createMeeting({ title: "Owner one", meetingDate: "2026-09-01" });
    const second = await store.createMeeting({ title: "Owner two", meetingDate: "2026-09-01" });
    const engine = new LocalRecordingCaptureEngine(store, fixedClock());
    const firstCapture = await engine.startCapture({ meetingId: first.meetingId, format: "webm", mimeType: "video/webm" });

    await assert.rejects(
      engine.appendChunk({ captureId: firstCapture.captureId, meetingId: second.meetingId, chunk: Buffer.from("wrong meeting") }),
      /does not match the session owner/,
    );
    await assert.rejects(
      engine.finalizeCapture({ captureId: firstCapture.captureId, meetingId: second.meetingId }),
      /does not match the session owner/,
    );
    await assert.rejects(
      engine.startCapture({ meetingId: first.meetingId, format: "webm", mimeType: "video/webm" }),
      /already active/,
    );

    const secondCapture = await engine.startCapture({ meetingId: second.meetingId, format: "webm", mimeType: "video/webm" });
    await engine.appendChunk({ captureId: firstCapture.captureId, meetingId: first.meetingId, chunk: Buffer.from("first") });
    await engine.appendChunk({ captureId: secondCapture.captureId, meetingId: second.meetingId, chunk: Buffer.from("second") });
    await engine.finalizeCapture({ captureId: firstCapture.captureId, meetingId: first.meetingId });
    await engine.abortCapture({ captureId: secondCapture.captureId, meetingId: second.meetingId, reason: "test cleanup" });

    assert.equal(store.database.listRecordings(first.meetingId).length, 1);
    assert.equal(store.database.listRecordings(second.meetingId).length, 0);
    assert.equal(store.getMeeting(second.meetingId)?.status, "INCOMPLETE");
  });
});


test("capture start rejects progressed meetings without resetting lifecycle status", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Progressed lifecycle", meetingDate: "2026-09-01" });
    store.database.updateMeetingStatus(meeting.meetingId, "PROCESSING");
    const engine = new LocalRecordingCaptureEngine(store, fixedClock());

    await assert.rejects(
      engine.startCapture({ meetingId: meeting.meetingId, format: "webm", mimeType: "video/webm" }),
      /Cannot start capture while meeting/,
    );
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "PROCESSING");
    assert.equal(store.database.listArtifactOperations().length, 0);
  });
});

test("rejects caller-supplied output paths", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "No output paths", meetingDate: "2026-09-01" });
    const engine = new LocalRecordingCaptureEngine(store, fixedClock());

    await assert.rejects(
      engine.startCapture({
        meetingId: meeting.meetingId,
        format: "webm",
        mimeType: "video/webm",
        outputPath: "/tmp/attacker.webm",
      } as Parameters<LocalRecordingCaptureEngine["startCapture"]>[0] & { outputPath: string }),
      /output paths are owned/,
    );
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "SCHEDULED");
  });
});

test("disk-space preflight failures fail closed and transition safely", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "No disk", meetingDate: "2026-09-01" });
    const engine = new LocalRecordingCaptureEngine(store, fixedClock());

    await assert.rejects(
      engine.startCapture({ meetingId: meeting.meetingId, format: "webm", mimeType: "video/webm", estimatedBytes: 1 }),
      /Insufficient disk space/,
    );
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "FAILED");
    assert.equal(store.database.listArtifactOperations().length, 0);
  }, { spaceSafetyMarginBytes: 0, availableBytesProvider: async () => 0 });
});

test("unknown disk-space preflight fails closed", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Unknown disk", meetingDate: "2026-09-01" });
    const engine = new LocalRecordingCaptureEngine(store, fixedClock());

    await assert.rejects(
      engine.startCapture({ meetingId: meeting.meetingId, format: "webm", mimeType: "video/webm", estimatedBytes: 1 }),
      /could not be determined safely/,
    );
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "FAILED");
  }, { spaceSafetyMarginBytes: 0, availableBytesProvider: async () => null });
});

test("disk-space failures during chunk writes safely stop capture as incomplete", async () => {
  let availableBytes = 100;
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Mid-capture disk", meetingDate: "2026-09-01" });
    const engine = new LocalRecordingCaptureEngine(store, fixedClock());
    const started = await engine.startCapture({ meetingId: meeting.meetingId, format: "webm", mimeType: "video/webm", estimatedBytes: 0 });
    availableBytes = 0;

    await assert.rejects(
      engine.appendChunk({ captureId: started.captureId, meetingId: meeting.meetingId, chunk: Buffer.from("too large now") }),
      /Insufficient disk space/,
    );

    const state = engine.getCaptureState(started.captureId);
    assert.equal(state.state, "INCOMPLETE");
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "INCOMPLETE");
    assert.equal(store.database.listArtifactOperations().at(-1)?.state, "INCOMPLETE");
    assert.equal(store.database.listRecordings(meeting.meetingId).length, 0);
  }, { spaceSafetyMarginBytes: 0, availableBytesProvider: async () => availableBytes });
});

test("critical disk monitor safely marks an active capture incomplete", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Critical disk", meetingDate: "2026-09-01" });
    const engine = new LocalRecordingCaptureEngine(store, fixedClock());
    const started = await engine.startCapture({
      meetingId: meeting.meetingId,
      format: "webm",
      mimeType: "video/webm",
      estimatedBytes: 0,
      diskMonitor: { criticalFreeBytes: 10, intervalMs: 1 },
    });

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(engine.getCaptureState(started.captureId).state, "INCOMPLETE");
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "INCOMPLETE");
    assert.equal(store.database.listArtifactOperations().at(-1)?.state, "INCOMPLETE");
  }, { spaceSafetyMarginBytes: 0, availableBytesProvider: async () => 0 });
});


test("finalization failures are journaled as failed without overwriting existing artifacts", async () => {
  await withTempStore(async (store, root) => {
    const meeting = await store.createMeeting({ title: "Finalize failure", meetingDate: "2026-09-01" });
    const engine = new LocalRecordingCaptureEngine(store, fixedClock());
    const started = await engine.startCapture({ meetingId: meeting.meetingId, format: "webm", mimeType: "video/webm" });
    await engine.appendChunk({ captureId: started.captureId, meetingId: meeting.meetingId, chunk: Buffer.from("capture") });

    const finalPath = join(root, started.relativePath ?? "");
    await mkdir(join(finalPath, ".."), { recursive: true });
    await writeFile(finalPath, "pre-existing file", { flag: "wx" });

    await assert.rejects(
      engine.finalizeCapture({ captureId: started.captureId, meetingId: meeting.meetingId }),
      /Refusing to overwrite an existing artifact/,
    );

    assert.equal(engine.getCaptureState(started.captureId).state, "FAILED");
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "FAILED");
    assert.equal(store.database.listArtifactOperations().at(-1)?.state, "FAILED");
    assert.equal(store.database.listRecordings(meeting.meetingId).length, 0);
    assert.equal(await readFile(finalPath, "utf8"), "pre-existing file");
  });
});

test("restart recovery does not silently complete an interrupted capture", async () => {
  const root = await temporaryDirectory("ai-workmate-capture-recovery-");
  const firstStore = new LocalFirstStore(root, { spaceSafetyMarginBytes: 0 });
  await firstStore.initialize();
  try {
    const meeting = await firstStore.createMeeting({ title: "Interrupted capture", meetingDate: "2026-09-01" });
    const engine = new LocalRecordingCaptureEngine(firstStore, fixedClock());
    const started = await engine.startCapture({ meetingId: meeting.meetingId, format: "webm", mimeType: "video/webm" });
    await engine.appendChunk({ captureId: started.captureId, meetingId: meeting.meetingId, chunk: Buffer.from("partial") });
    firstStore.close();

    const recovered = new LocalFirstStore(root, { spaceSafetyMarginBytes: 0 });
    await recovered.initialize();
    try {
      assert.equal(recovered.getMeeting(meeting.meetingId)?.status, "INCOMPLETE");
      assert.equal(recovered.database.listArtifactOperations().at(-1)?.state, "INCOMPLETE");
      assert.equal(recovered.database.listRecordings(meeting.meetingId).length, 0);
      assert.equal(recovered.database.listArtifacts(meeting.meetingId).some((artifact) => artifact.artifactType === "RECORDING_ORIGINAL"), false);
      const report = await recovered.verifyStorage();
      assert.ok(report.issues.some((issue) => issue.kind === "INCOMPLETE_RECORDING"));
      assert.ok(report.issues.some((issue) => issue.kind === "INCOMPLETE_ARTIFACT_OPERATION"));
    } finally {
      recovered.close();
    }
  } finally {
    firstStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("aborting capture preserves incomplete journal state and rejects completed aborts", async () => {
  await withTempStore(async (store) => {
    const incompleteMeeting = await store.createMeeting({ title: "Abort capture", meetingDate: "2026-09-01" });
    const completedMeeting = await store.createMeeting({ title: "Abort completed", meetingDate: "2026-09-01" });
    const engine = new LocalRecordingCaptureEngine(store, fixedClock());

    const incomplete = await engine.startCapture({ meetingId: incompleteMeeting.meetingId, format: "webm", mimeType: "video/webm" });
    await engine.appendChunk({ captureId: incomplete.captureId, meetingId: incompleteMeeting.meetingId, chunk: Buffer.from("partial") });
    const aborted = await engine.abortCapture({ captureId: incomplete.captureId, meetingId: incompleteMeeting.meetingId, reason: "user stopped capture" });
    assert.equal(aborted.state, "INCOMPLETE");
    assert.equal(store.getMeeting(incompleteMeeting.meetingId)?.status, "INCOMPLETE");
    assert.equal(store.database.listArtifactOperations().at(-1)?.state, "INCOMPLETE");

    const completed = await engine.startCapture({ meetingId: completedMeeting.meetingId, format: "webm", mimeType: "video/webm" });
    await engine.appendChunk({ captureId: completed.captureId, meetingId: completedMeeting.meetingId, chunk: Buffer.from("complete") });
    await engine.finalizeCapture({ captureId: completed.captureId, meetingId: completedMeeting.meetingId });
    await assert.rejects(
      engine.abortCapture({ captureId: completed.captureId, meetingId: completedMeeting.meetingId, reason: "too late" }),
      /cannot be aborted/,
    );
  });
});

function fixedClock(): () => Date {
  return () => new Date("2026-09-01T10:00:00.000Z");
}
