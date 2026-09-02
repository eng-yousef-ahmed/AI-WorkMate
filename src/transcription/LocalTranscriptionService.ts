import { join } from "node:path";

import { UnsafePathError } from "../storage/errors";
import type { LocalFirstStore } from "../storage/LocalFirstStore";
import { decodeAiwpcmRecording } from "./AiwpcmRecordingDecoder";
import {
  TranscriptionError,
  transcriptDocumentFromEngineResult,
  type TranscriptionEngine,
  UnconfiguredTranscriptionEngine,
} from "./TranscriptionEngine";

export interface LocalTranscriptionServiceOptions {
  store: LocalFirstStore;
  engine?: TranscriptionEngine;
}

export interface TranscriptionPersistResult {
  artifactId: string;
  sha256: string;
  relativePath: string;
}

export class LocalTranscriptionService {
  private readonly store: LocalFirstStore;
  private readonly engine: TranscriptionEngine;

  public constructor(options: LocalTranscriptionServiceOptions) {
    this.store = options.store;
    this.engine = options.engine ?? new UnconfiguredTranscriptionEngine();
  }

  public async transcribeRecording(meetingId: string, recordingId: string): Promise<TranscriptionPersistResult> {
    const meeting = this.store.getMeeting(meetingId);
    if (meeting === undefined) {
      throw new TranscriptionError("TRANSCRIPTION_MEETING_MISMATCH", `Meeting ${meetingId} was not found.`, false);
    }
    const recording = this.store.getRecording(recordingId);
    if (recording === undefined) {
      throw new TranscriptionError("TRANSCRIPTION_RECORDING_NOT_FOUND", `Recording ${recordingId} was not found.`, false);
    }
    if (recording.meetingId !== meetingId) {
      throw new TranscriptionError("TRANSCRIPTION_MEETING_MISMATCH", "Recording does not belong to the requested meeting.", false);
    }
    if (recording.finalStatus !== "COMMITTED") {
      throw new TranscriptionError("TRANSCRIPTION_RECORDING_INVALID", "Recording must be COMMITTED before transcription.", false);
    }
    if (recording.relativePath === undefined) {
      throw new TranscriptionError("TRANSCRIPTION_RECORDING_INVALID", "Recording is missing a DATA_ROOT-relative artifact path.", false);
    }
    this.assertPathInsideDataRoot(recording.relativePath);

    this.store.beginTranscription(meetingId, recordingId);

    try {
      const payload = await this.store.readArtifactBytes(recording.relativePath);
      const audio = decodeAiwpcmRecording(payload);
      const result = await this.engine.transcribe({
        meetingId,
        recordingId,
        audio,
      });
      if (result.meetingId !== meetingId || result.recordingId !== recordingId) {
        throw new TranscriptionError("TRANSCRIPTION_ENGINE_FAILED", "Transcription engine returned a mismatched meeting or recording.", false);
      }
      const createdAt = new Date().toISOString();
      const document = transcriptDocumentFromEngineResult(result, createdAt);
      const saved = await this.store.saveTranscript(document, {
        recordingId,
        engineId: result.engine.id,
      });
      this.store.completeTranscription(meetingId);
      return {
        artifactId: saved.json.fileId,
        sha256: saved.json.sha256,
        relativePath: saved.json.relativePath,
      };
    } catch (error: unknown) {
      const next = error instanceof TranscriptionError && !error.retryable ? "FAILED" : "INCOMPLETE";
      this.store.failTranscription(meetingId, next);
      throw error;
    }
  }

  private assertPathInsideDataRoot(relativePath: string): void {
    if (relativePath.includes("\0") || relativePath.includes("..")) {
      throw new TranscriptionError("TRANSCRIPTION_PATH_REJECTED", "Recording path escaped DATA_ROOT.", false);
    }
    const dataRoot = this.store.getDataRoot();
    try {
      const resolved = this.store.resolveArtifactAbsolutePath(relativePath);
      const expectedPrefix = join(dataRoot, "Meetings");
      if (!resolved.startsWith(expectedPrefix)) {
        throw new TranscriptionError("TRANSCRIPTION_PATH_REJECTED", "Recording path escaped DATA_ROOT.", false);
      }
    } catch (error: unknown) {
      if (error instanceof TranscriptionError) {
        throw error;
      }
      if (error instanceof UnsafePathError) {
        throw new TranscriptionError("TRANSCRIPTION_PATH_REJECTED", "Recording path escaped DATA_ROOT.", false, { cause: error });
      }
      throw error;
    }
  }
}
