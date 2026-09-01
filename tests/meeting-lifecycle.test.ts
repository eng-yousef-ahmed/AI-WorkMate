import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import type { AIProvider } from "../src/ai/AIProvider";
import { InvalidMeetingTransitionError } from "../src/storage/errors";
import { withTempStore } from "./helpers";

test("enforces the meeting lifecycle and rejects invalid transitions", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Lifecycle", meetingDate: "2026-09-01" });
    assert.equal(meeting.status, "SCHEDULED");
    store.database.updateMeetingStatus(meeting.meetingId, "DETECTED");
    store.database.updateMeetingStatus(meeting.meetingId, "PREPARING");
    store.database.updateMeetingStatus(meeting.meetingId, "RECORDING");
    await assert.rejects(
      Promise.resolve().then(() => store.database.updateMeetingStatus(meeting.meetingId, "COMPLETED")),
      InvalidMeetingTransitionError,
    );
    store.markRecordingIncomplete(meeting.meetingId, "capture stopped");
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "INCOMPLETE");
  });
});

test("ingests a real recording file and transcript without cross-meeting paths", async () => {
  await withTempStore(async (store, root) => {
    const first = await store.createMeeting({ title: "Same title", meetingDate: "2026-09-01" });
    const second = await store.createMeeting({ title: "Same title", meetingDate: "2026-09-01" });
    const source = join(root, "capture.webm");
    await writeFile(source, "real capture bytes");
    const recording = await store.ingestRecording({
      meetingId: first.meetingId,
      sourceType: "FILE",
      sourcePath: source,
      originalFilename: "capture.webm",
      mimeType: "video/webm",
      capturedAt: "2026-09-01T10:00:00.000Z",
    });
    const transcript = await store.ingestTranscript({
      meetingId: second.meetingId,
      format: "PLAIN_TEXT",
      content: "A real transcript supplied by the transcription boundary.",
      language: "en-US",
    });
    assert.notEqual(first.meetingId, second.meetingId);
    assert.ok(recording.relativePath.startsWith(`${first.folderRelativePath}/`));
    assert.ok(transcript.json.relativePath.startsWith(`${second.folderRelativePath}/`));
    assert.equal(store.database.listArtifacts(first.meetingId).some((a) => a.relativePath.includes(second.meetingId)), false);
  });
});

test("persists only a validated provider result through the local analysis store", async () => {
  await withTempStore(async (store) => {
    const meeting = await store.createMeeting({ title: "Provider boundary", meetingDate: "2026-09-01" });
    const provider: AIProvider = {
      descriptor: { id: "test-local-boundary", displayName: "Configured local provider", kind: "LOCAL", dataTransmission: "local" },
      async process(request) {
        assert.equal(request.meetingId, meeting.meetingId);
        return {
          providerId: "test-local-boundary",
          processedAt: "2026-09-01T10:00:00.000Z",
          persistedByProvider: false,
          output: JSON.stringify({ meetingId: meeting.meetingId, createdAt: "2026-09-01T10:00:00.000Z", summary: "Validated", decisions: [], tasks: [], risks: [], questions: [], followups: [] }),
        };
      },
    };
    const result = await store.processTranscriptWithProvider({ meetingId: meeting.meetingId, speakers: [], timestamps: true, segments: [], language: "en-US", createdAt: "2026-09-01T10:00:00.000Z" }, provider);
    assert.equal(result.summary, "Validated");
    assert.equal(store.database.listAnalysis(meeting.meetingId).length, 7);
    assert.equal(store.getMeeting(meeting.meetingId)?.status, "COMPLETED");
  });
});
