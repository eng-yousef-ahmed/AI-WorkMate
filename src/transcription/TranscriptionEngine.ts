import type { TranscriptDocument, TranscriptSegment, TranscriptSpeaker } from "../domain/models";

export type TranscriptionEngineKind = "LOCAL";

export type TranscriptionErrorCode =
  | "TRANSCRIPTION_ENGINE_NOT_CONFIGURED"
  | "TRANSCRIPTION_ENGINE_FAILED"
  | "TRANSCRIPTION_RECORDING_INVALID"
  | "TRANSCRIPTION_RECORDING_EMPTY"
  | "TRANSCRIPTION_RECORDING_CORRUPTED"
  | "TRANSCRIPTION_SEQUENCE_INVALID"
  | "TRANSCRIPTION_MEETING_MISMATCH"
  | "TRANSCRIPTION_RECORDING_NOT_FOUND"
  | "TRANSCRIPTION_INTERRUPTED"
  | "TRANSCRIPTION_PATH_REJECTED";

export interface TranscriptionEngineDescriptor {
  id: string;
  displayName: string;
  kind: TranscriptionEngineKind;
  model?: string;
}

export interface PreparedPcmAudio {
  sampleRateHz: number;
  channels: number;
  bitsPerSample: number;
  pcm: Uint8Array;
  wav: Uint8Array;
  durationMs: number;
  chunkCount: number;
  source?: string;
}

export interface TranscriptionRequest {
  meetingId: string;
  recordingId: string;
  language?: string;
  audio: PreparedPcmAudio;
}

export interface TranscriptionEngineResult {
  meetingId: string;
  recordingId: string;
  language: string;
  speakers: TranscriptSpeaker[];
  segments: TranscriptSegment[];
  timestamps: boolean;
  confidence?: number;
  engine: TranscriptionEngineDescriptor;
}

export interface TranscriptionEngine {
  readonly descriptor: TranscriptionEngineDescriptor;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionEngineResult>;
}

export class TranscriptionError extends Error {
  public readonly code: TranscriptionErrorCode;
  public readonly retryable: boolean;

  public constructor(code: TranscriptionErrorCode, message: string, retryable = true, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranscriptionError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Production default. A real local speech-to-text runtime must be injected by
 * the desktop/native layer. This adapter never invents transcript text.
 */
export class UnconfiguredTranscriptionEngine implements TranscriptionEngine {
  public readonly descriptor: TranscriptionEngineDescriptor = {
    id: "unconfigured-local-transcription",
    displayName: "Unconfigured local transcription engine",
    kind: "LOCAL",
  };

  public async transcribe(request: TranscriptionRequest): Promise<TranscriptionEngineResult> {
    void request;
    throw new TranscriptionError(
      "TRANSCRIPTION_ENGINE_NOT_CONFIGURED",
      "No local speech-to-text engine is configured. Transcript text is not generated.",
      false,
    );
  }
}

export function transcriptDocumentFromEngineResult(result: TranscriptionEngineResult, createdAt: string): TranscriptDocument {
  const document: TranscriptDocument = {
    meetingId: result.meetingId,
    recordingId: result.recordingId,
    speakers: result.speakers,
    timestamps: result.timestamps,
    segments: result.segments,
    language: result.language,
    createdAt,
    engine: {
      id: result.engine.id,
      displayName: result.engine.displayName,
      ...(result.engine.model === undefined ? {} : { model: result.engine.model }),
    },
  };
  if (result.confidence !== undefined) {
    document.confidence = result.confidence;
  }
  return document;
}
