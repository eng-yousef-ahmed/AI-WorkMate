import type { TranscriptDocument, TranscriptSegment } from "../domain/models";
import { randomUUID } from "node:crypto";

export function buildUnifiedTranscriptDocument(
  meetingId: string,
  microphoneDoc?: TranscriptDocument,
  systemDoc?: TranscriptDocument
): TranscriptDocument {
  const segments: TranscriptSegment[] = [];

  if (microphoneDoc && microphoneDoc.segments.length > 0) {
    segments.push({
      segmentId: randomUUID(),
      startMs: 0,
      endMs: 0,
      text: "[Microphone]",
    });
    for (const segment of microphoneDoc.segments) {
      segments.push({ ...segment, segmentId: randomUUID() });
    }
  }

  if (systemDoc && systemDoc.segments.length > 0) {
    segments.push({
      segmentId: randomUUID(),
      startMs: 0,
      endMs: 0,
      text: "[System Audio]",
    });
    for (const segment of systemDoc.segments) {
      segments.push({ ...segment, segmentId: randomUUID() });
    }
  }

    return {
      meetingId,
      language: microphoneDoc?.language || systemDoc?.language || "en",
      createdAt: new Date().toISOString(),
      speakers: [],
      timestamps: true,
      segments,
    };
}
