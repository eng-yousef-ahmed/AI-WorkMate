import { join } from "node:path";

import type { AIProcessingPolicy, AnalysisArtifacts, AnalysisDocument, TranscriptDocument } from "../domain/models";
import type { LocalFirstStore } from "../storage/LocalFirstStore";
import { DataRootValidationError, StorageError, UnsafePathError } from "../storage/errors";
import { AIProcessingPolicyEnforcer, type AIProvider, LocalAIProvider } from "./AIProvider";

export interface LocalAnalysisServiceOptions {
  store: LocalFirstStore;
  provider?: AIProvider;
  policy?: AIProcessingPolicy;
}

export interface AnalyzeCommittedTranscriptRequest {
  meetingId: string;
  recordingId: string;
  userApprovedForThisRequest?: boolean;
  policy?: AIProcessingPolicy;
  provider?: AIProvider;
}

export interface AnalysisPersistResult {
  artifacts: AnalysisArtifacts;
  analysis: AnalysisDocument;
  relativePath: string;
  sha256: string;
}

export class AnalysisProviderNotConfiguredError extends StorageError {
  public readonly code = "ANALYSIS_PROVIDER_NOT_CONFIGURED";

  public constructor() {
    super("A local AI provider transport is not configured. Analysis text was not invented.");
    this.name = "AnalysisProviderNotConfiguredError";
  }
}

export class AnalysisPolicyDeniedError extends StorageError {
  public readonly code = "ANALYSIS_POLICY_DENIED";

  public constructor(message: string) {
    super(message);
    this.name = "AnalysisPolicyDeniedError";
  }
}

/** Production default: fail closed. Never invent summaries, decisions, or tasks. */
export function unconfiguredLocalAIProvider(): AIProvider {
  return new LocalAIProvider(async () => {
    throw new AnalysisProviderNotConfiguredError();
  });
}

export class LocalAnalysisService {
  private readonly store: LocalFirstStore;
  private readonly provider: AIProvider;
  private readonly policy: AIProcessingPolicy;
  private readonly enforcer = new AIProcessingPolicyEnforcer();

  public constructor(options: LocalAnalysisServiceOptions) {
    this.store = options.store;
    this.provider = options.provider ?? unconfiguredLocalAIProvider();
    this.policy = options.policy ?? "ASK_EACH_TIME";
  }

  public async analyzeCommittedTranscript(request: AnalyzeCommittedTranscriptRequest): Promise<AnalysisPersistResult> {
    const provider = request.provider ?? this.provider;
    const policy = request.policy ?? this.policy;
    const document = await this.loadCommittedTranscript(request.meetingId, request.recordingId);
    try {
      this.enforcer.assertAllowed(policy, provider.descriptor, request.userApprovedForThisRequest === true);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AnalysisPolicyDeniedError(message);
    }

    this.store.beginAnalysis(request.meetingId, request.recordingId);
    try {
      const analysis = await this.store.processTranscriptWithProvider(document, provider);
      const artifacts = this.store.database.listAnalysis(request.meetingId);
      const summary = artifacts.find((row) => row.kind === "SUMMARY");
      const summaryArtifact = summary === undefined ? undefined : this.store.database.getArtifact(summary.artifactId);
      if (summaryArtifact === undefined) {
        throw new StorageError("Analysis metadata was not indexed after saveAnalysis().");
      }
      return {
        analysis,
        artifacts: await this.readArtifacts(request.meetingId),
        relativePath: summaryArtifact.relativePath,
        sha256: summaryArtifact.sha256,
      };
    } catch (error: unknown) {
      if (error instanceof AnalysisPolicyDeniedError) {
        throw error;
      }
      const meeting = this.store.getMeeting(request.meetingId);
      if (meeting?.status === "PROCESSING") {
        const retryable = error instanceof StorageError && /interrupted|abort/i.test(error.message);
        this.store.failAnalysis(request.meetingId, retryable ? "INCOMPLETE" : "FAILED");
      }
      throw error;
    }
  }

  private async loadCommittedTranscript(meetingId: string, recordingId: string): Promise<TranscriptDocument> {
    const meeting = this.store.getMeeting(meetingId);
    if (meeting === undefined) {
      throw new DataRootValidationError(`Meeting not found: ${meetingId}`);
    }
    const recording = this.store.getRecording(recordingId);
    if (recording === undefined) {
      throw new DataRootValidationError(`Recording not found: ${recordingId}`);
    }
    if (recording.meetingId !== meetingId) {
      throw new DataRootValidationError("Recording does not belong to the requested meeting.");
    }
    const transcripts = this.store.database.listTranscripts(meetingId);
    const record = transcripts.find((item) => item.recordingId === recordingId);
    if (record === undefined) {
      throw new DataRootValidationError("A committed transcript for this meeting and recording was not found.");
    }
    const artifact = this.store.database.getArtifact(record.jsonArtifactId);
    if (artifact === undefined || artifact.status !== "AVAILABLE") {
      throw new DataRootValidationError("Transcript artifact metadata is missing or not AVAILABLE.");
    }
    this.assertPathInsideDataRoot(artifact.relativePath);
    const bytes = await this.store.readArtifactBytes(artifact.relativePath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    } catch (error: unknown) {
      throw new DataRootValidationError("Committed transcript JSON is malformed.", { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new DataRootValidationError("Committed transcript JSON is not an object.");
    }
    const document = parsed as TranscriptDocument;
    if (document.meetingId !== meetingId) {
      throw new DataRootValidationError("Transcript meeting ID does not match the requested meeting.");
    }
    if (document.recordingId !== undefined && document.recordingId !== recordingId) {
      throw new DataRootValidationError("Transcript recording ID does not match the requested recording.");
    }
    if (!Array.isArray(document.segments) || document.segments.length === 0) {
      throw new DataRootValidationError("Committed transcript has no segments.");
    }
    return document;
  }

  private async readArtifacts(meetingId: string): Promise<AnalysisArtifacts> {
    const rows = this.store.database.listAnalysis(meetingId);
    const byKind = new Map(rows.map((row) => [row.kind, this.store.database.getArtifact(row.artifactId)]));
    const requireKind = (kind: string) => {
      const artifact = byKind.get(kind);
      if (artifact === undefined) {
        throw new StorageError(`Analysis artifact ${kind} was not indexed.`);
      }
      return artifact;
    };
    return {
      summaryJson: requireKind("SUMMARY"),
      summaryMarkdown: requireKind("SUMMARY_MARKDOWN"),
      decisions: requireKind("DECISIONS"),
      tasks: requireKind("TASKS"),
      risks: requireKind("RISKS"),
      questions: requireKind("QUESTIONS"),
      followups: requireKind("FOLLOWUPS"),
    };
  }

  private assertPathInsideDataRoot(relativePath: string): void {
    if (relativePath.includes("\0") || relativePath.includes("..")) {
      throw new DataRootValidationError("Transcript path escaped DATA_ROOT.");
    }
    const dataRoot = this.store.getDataRoot();
    try {
      const resolved = this.store.resolveArtifactAbsolutePath(relativePath);
      const expectedPrefix = join(dataRoot, "Meetings");
      if (!resolved.startsWith(expectedPrefix)) {
        throw new DataRootValidationError("Transcript path escaped DATA_ROOT.");
      }
    } catch (error: unknown) {
      if (error instanceof UnsafePathError) {
        throw new DataRootValidationError("Transcript path escaped DATA_ROOT.", { cause: error });
      }
      throw error;
    }
  }
}
