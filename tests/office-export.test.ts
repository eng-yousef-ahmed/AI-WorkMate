import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { OfficeExportService } from "../src/office/OfficeExportService";
import { temporaryDirectory, withTempStore } from "./helpers";

test("office exports write Word HTML, Excel CSV, and briefing outside DATA_ROOT without paths or invented facts", async () => {
  await withTempStore(async (store, root) => {
    const meeting = await store.createMeeting({ title: "Planning <sync>", meetingDate: "2026-09-08", startedAt: "2026-09-08T10:00:00.000Z" });
    await store.saveRecording({ meetingId: meeting.meetingId, contents: Buffer.from("bytes"), extension: "wav", mimeType: "audio/wav" });
    const transcript = await store.saveTranscript({
      meetingId: meeting.meetingId,
      speakers: [],
      timestamps: true,
      language: "en",
      createdAt: "2026-09-08T11:00:00.000Z",
      segments: [{ segmentId: randomUUID(), startMs: 0, endMs: 900, text: "Keep files local." }],
    });
    await store.saveAnalysis({
      meetingId: meeting.meetingId,
      createdAt: "2026-09-08T11:05:00.000Z",
      summary: "Keep files local.",
      decisions: [{ decisionId: randomUUID(), text: "Stay local-first." }],
      tasks: [{ taskId: randomUUID(), text: "Verify restore", assignee: "Ada", dueDate: "2026-10-01", status: "OPEN" }],
      risks: [],
      questions: [],
      followups: [],
    }, { sourceTranscriptIds: transcript.json.fileId });

    const destination = await temporaryDirectory("ai-workmate-office-");
    const service = new OfficeExportService(store, () => new Date("2026-09-09T00:00:00.000Z"));
    const word = await service.exportMeetingDocument(meeting.meetingId, "WORD_SUMMARY", destination);
    const excel = await service.exportMeetingDocument(meeting.meetingId, "EXCEL_TASKS", destination);
    const briefing = await service.exportMeetingDocument(meeting.meetingId, "POWERPOINT_BRIEFING", destination);

    assert.equal(word.kind, "WORD_SUMMARY");
    assert.equal(excel.kind, "EXCEL_TASKS");
    assert.equal(briefing.kind, "POWERPOINT_BRIEFING");
    assert.equal(word.filename.includes(meeting.meetingId), true);

    const wordText = await readFile(join(destination, word.filename), "utf8");
    assert.match(wordText, /Keep files local/);
    assert.match(wordText, /Stay local-first/);
    assert.match(wordText, /Planning &lt;sync&gt;/);
    assert.equal(wordText.includes(root), false);
    assert.equal(wordText.includes("Quarterly marketing"), false);

    const csv = await readFile(join(destination, excel.filename), "utf8");
    assert.match(csv, /Verify restore/);
    assert.match(csv, /Ada/);
    assert.equal(csv.charCodeAt(0), 0xfeff);

    await assert.rejects(
      () => service.exportMeetingDocument(meeting.meetingId, "WORD_SUMMARY", root),
      /outside DATA_ROOT/,
    );
  });
});
