import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";

import { LocalFirstStore } from "../src/storage/LocalFirstStore";
import { StorageError } from "../src/storage/errors";
import { temporaryDirectory } from "./helpers";

test("requires approval for deliberate meeting deletion and supports separate metadata/file choices", async () => {
  const root = await temporaryDirectory("ai-workmate-delete-");
  const store = new LocalFirstStore(root, {
    spaceSafetyMarginBytes: 0,
    approvalEngine: { approve: () => true },
  });
  await store.initialize();
  try {
    const meeting = await store.createMeeting({ title: "Delete policy", meetingDate: "2026-09-01" });
    const deniedStore = new LocalFirstStore(root, { spaceSafetyMarginBytes: 0 });
    await deniedStore.initialize();
    await assert.rejects(deniedStore.deleteMeeting(meeting.meetingId, {
      deleteDatabaseMetadata: true,
      deleteLocalFiles: true,
      deleteRecording: true,
      deleteTranscript: true,
      deleteAnalysis: true,
    }, "AI requested deletion"), StorageError);
    deniedStore.close();
    const artifact = await store.saveAudio(meeting.meetingId, { extension: "m4a", mimeType: "audio/mp4", contents: Buffer.from("delete") });
    await store.deleteMeeting(
      meeting.meetingId,
      { deleteDatabaseMetadata: false, deleteLocalFiles: true, deleteRecording: false, deleteTranscript: false, deleteAnalysis: false },
      "User selected local file deletion",
    );
    assert.equal(store.database.getArtifact(artifact.fileId)?.status, "DELETED");
    assert.equal(store.getMeeting(meeting.meetingId)?.meetingId, meeting.meetingId);
    await store.deleteMeeting(
      meeting.meetingId,
      { deleteDatabaseMetadata: true, deleteLocalFiles: false, deleteRecording: false, deleteTranscript: false, deleteAnalysis: false },
      "User selected metadata deletion",
    );
    assert.equal(store.getMeeting(meeting.meetingId), undefined);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
