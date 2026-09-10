import { randomUUID } from "node:crypto";
import type { LocalFirstStore } from "../storage/LocalFirstStore";
import type { TranscriptionEngine } from "../transcription/TranscriptionEngine";
import { AIProcessingPolicyEnforcer, type AIProvider } from "../ai/AIProvider";
import type { RecordingRecord, TranscriptRecord, ProcessingJobRecord } from "../storage/LocalDatabase";
import type { AIProcessingPolicy, TranscriptDocument } from "../domain/models";
import { decodeAiwpcmRecording } from "../transcription/AiwpcmRecordingDecoder";
import { buildUnifiedTranscriptDocument } from "./sourceAttribution";
import { StorageError, DataRootValidationError } from "../storage/errors";
import { evaluateAnalysisQuality } from "../ai/AnalysisQuality";
import { rm } from "node:fs/promises";
import { parseAnalysisDocument } from "../ai/AnalysisDocument";

export interface MeetingTranscriptionOrchestratorOptions {
  store: LocalFirstStore;
  transcriptionEngine: TranscriptionEngine;
  analysisProvider: AIProvider;
  policy?: AIProcessingPolicy;
  clock?: () => Date;
}

export class MeetingTranscriptionOrchestrator {
  private readonly store: LocalFirstStore;
  private readonly transcriptionEngine: TranscriptionEngine;
  private readonly analysisProvider: AIProvider;
  private readonly policy: AIProcessingPolicy;
  private readonly enforcer = new AIProcessingPolicyEnforcer();
  private readonly clock: () => Date;

  constructor(options: MeetingTranscriptionOrchestratorOptions) {
    this.store = options.store;
    this.transcriptionEngine = options.transcriptionEngine;
    this.analysisProvider = options.analysisProvider;
    this.policy = options.policy ?? "ASK_EACH_TIME";
    this.clock = options.clock ?? (() => new Date());
  }

  public async processCompletedMeeting(meetingId: string, options?: { userApprovedForThisRequest?: boolean }): Promise<void> {
    const meeting = this.store.getMeeting(meetingId);
    if (!meeting) {
      throw new DataRootValidationError(`Meeting not found: ${meetingId}`);
    }
    if (meeting.status !== "COMPLETED" && meeting.status !== "PROCESSING" && meeting.status !== "INCOMPLETE" && meeting.status !== "FAILED") {
      throw new StorageError(`Meeting is not ready for processing: ${meeting.status}`);
    }

    const recordings = this.store.database.listRecordings(meetingId);
    const micRecordings = recordings.filter(r => r.captureSource?.endsWith(":MICROPHONE_AUDIO") && r.finalStatus === "COMMITTED");
    const sysRecordings = recordings.filter(r => r.captureSource?.endsWith(":SYSTEM_AUDIO") && r.finalStatus === "COMMITTED");

    if (micRecordings.length === 0 && sysRecordings.length === 0) {
      throw new StorageError("No completed microphone or system audio recordings found to process.");
    }

    this.store.transitionMeeting(meetingId, "PROCESSING");

    try {
      const [micTranscriptRecord, sysTranscriptRecord] = await Promise.all([
        micRecordings.length > 0 && micRecordings[0] ? this.processSource(meetingId, micRecordings[0], "MICROPHONE_AUDIO") : Promise.resolve(undefined),
        sysRecordings.length > 0 && sysRecordings[0] ? this.processSource(meetingId, sysRecordings[0], "SYSTEM_AUDIO") : Promise.resolve(undefined),
      ]);

      await this.runAnalysis(meetingId, micTranscriptRecord, sysTranscriptRecord, options?.userApprovedForThisRequest);

      this.store.transitionMeeting(meetingId, "COMPLETED");
    } catch (e) {
      const isRetryable = e instanceof StorageError && /interrupted|abort/i.test(e.message);
      this.store.transitionMeeting(meetingId, isRetryable ? "INCOMPLETE" : "FAILED");
      throw e;
    }
  }

  private async processSource(meetingId: string, recording: RecordingRecord, capability: string): Promise<TranscriptRecord> {
    const jobId = randomUUID();
    const job: ProcessingJobRecord = {
      jobId,
      meetingId,
      jobType: "TRANSCRIPTION",
      state: "PROCESSING",
      engineId: this.transcriptionEngine.descriptor.id,
      sourceRecordingId: recording.recordingId,
      createdAt: this.clock().toISOString(),
      updatedAt: this.clock().toISOString()
    };
    this.store.database.registerProcessingJob(job);

    try {
      // 1. Check for reuse
      const transcripts = this.store.database.listTranscripts(meetingId);
      const existingAll = transcripts.filter(t => 
        t.recordingId === recording.recordingId &&
        t.sourceCapability === capability
      );
      
      let reusable: TranscriptRecord | undefined;
      for (const t of existingAll) {
        if (t.engineId === this.transcriptionEngine.descriptor.id && t.sourceSha256 === recording.sha256) {
          const jsonArtifact = this.store.database.getArtifact(t.jsonArtifactId);
          const textArtifact = this.store.database.getArtifact(t.textArtifactId);
          if (jsonArtifact && jsonArtifact.status === "AVAILABLE" && textArtifact && textArtifact.status === "AVAILABLE") {
            const verification = await this.store.storage.inspectFile(jsonArtifact.relativePath, jsonArtifact.sha256);
            if (verification.status === "AVAILABLE") {
              reusable = t;
              break;
            }
          }
        }
      }

      if (reusable) {
        this.store.database.updateProcessingJob(jobId, { state: "COMPLETED", updatedAt: this.clock().toISOString() });
        return reusable;
      }

      // Stale or missing/corrupt - delete old records/files to allow overwrite
      for (const t of existingAll) {
        if (t === reusable) continue;
        this.store.database.deleteTranscript(t.transcriptId);
        const relatedArtifacts = [t.jsonArtifactId, t.textArtifactId, t.vttArtifactId, t.srtArtifactId].filter(Boolean) as string[];
        for (const fileId of relatedArtifacts) {
          const a = this.store.database.getArtifact(fileId);
          if (a) {
             try {
               const absPath = this.store.resolveArtifactAbsolutePath(a.relativePath);
               await rm(absPath, { force: true });
             } catch { /* ignore */ }
             this.store.database.deleteArtifactRow(fileId);
          }
        }
      }

      // We need to re-transcribe or do a fresh transcription
      const recordingArtifact = this.store.database.getArtifact(recording.artifactId);
      if (!recordingArtifact || recordingArtifact.status !== "AVAILABLE") {
        throw new StorageError(`Source recording artifact missing: ${recording.recordingId}`);
      }

      // Verify SHA
      if (recording.sha256) {
        const verification = await this.store.storage.inspectFile(recordingArtifact.relativePath, recording.sha256);
        if (verification.status !== "AVAILABLE") {
          throw new StorageError("Source recording SHA verification failed.");
        }
      }

      const bytes = await this.store.readArtifactBytes(recordingArtifact.relativePath);
      const decoded = await decodeAiwpcmRecording(bytes);

      const result = await this.transcriptionEngine.transcribe({
        meetingId,
        recordingId: recording.recordingId,
        audio: decoded,
        sourceRecordingSha256: recording.sha256,
      });

      const document: TranscriptDocument = {
        meetingId: result.meetingId,
        recordingId: result.recordingId,
        language: result.language,
        createdAt: this.clock().toISOString(),
        speakers: [],
        timestamps: true,
        segments: result.segments,
        engine: result.engine,
      };

      const artifacts = await this.store.saveTranscript(document, {
        recordingId: recording.recordingId,
        engineId: this.transcriptionEngine.descriptor.id,
        sourceCapability: capability,
        sourceSha256: recording.sha256,
      });

      const newRecordList = this.store.database.listTranscripts(meetingId);
      const newRecord = newRecordList.find(t => t.jsonArtifactId === artifacts.json.fileId);
      if (!newRecord) {
        throw new StorageError("Transcript record was not indexed.");
      }

      this.store.database.updateProcessingJob(jobId, { state: "COMPLETED", updatedAt: this.clock().toISOString() });
      return newRecord;
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      const isRetryable = /interrupted|abort/i.test(e.message);
      this.store.database.updateProcessingJob(jobId, {
        state: isRetryable ? "INCOMPLETE" : "FAILED",
        error: sanitizeStoredJobError(e.message),
        updatedAt: this.clock().toISOString()
      });
      throw e;
    }
  }

  private async loadTranscriptDocument(record: TranscriptRecord): Promise<TranscriptDocument> {
    const artifact = this.store.database.getArtifact(record.jsonArtifactId);
    if (!artifact) throw new StorageError("Transcript artifact missing.");
    const bytes = await this.store.readArtifactBytes(artifact.relativePath);
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as TranscriptDocument;
  }

  private async runAnalysis(meetingId: string, micRecord?: TranscriptRecord, sysRecord?: TranscriptRecord, userApproved?: boolean): Promise<void> {
    const jobId = randomUUID();
    const job: ProcessingJobRecord = {
      jobId,
      meetingId,
      jobType: "ANALYSIS",
      state: "PROCESSING",
      engineId: this.analysisProvider.descriptor.id,
      createdAt: this.clock().toISOString(),
      updatedAt: this.clock().toISOString()
    };
    this.store.database.registerProcessingJob(job);

    try {
      this.enforcer.assertAllowed(this.policy, this.analysisProvider.descriptor, userApproved === true);

      const sourceTranscriptIds = [micRecord?.transcriptId, sysRecord?.transcriptId].filter(Boolean).join(",");
      const sourceTranscriptShas = [
        micRecord ? this.store.database.getArtifact(micRecord.jsonArtifactId)?.sha256 ?? "" : "",
        sysRecord ? this.store.database.getArtifact(sysRecord.jsonArtifactId)?.sha256 ?? "" : ""
      ].join(",");

      const existingAnalysis = this.store.database.listAnalysis(meetingId);
      const summary = existingAnalysis.find(a => a.kind === "SUMMARY");
      if (summary) {
        let isStale = true;
        if (summary.sourceTranscriptIds === sourceTranscriptIds && summary.sourceTranscriptShas === sourceTranscriptShas) {
          const artifact = this.store.database.getArtifact(summary.artifactId);
          if (artifact && artifact.status === "AVAILABLE" && artifact.sha256) {
            const verification = await this.store.storage.inspectFile(artifact.relativePath, artifact.sha256);
            if (verification.status === "AVAILABLE") {
              const allRelatedArtifacts = existingAnalysis.map(a => this.store.database.getArtifact(a.artifactId));
              let allGood = true;
              for (const a of allRelatedArtifacts) {
                if (!a || a.status !== "AVAILABLE" || !a.sha256) {
                  allGood = false;
                  break;
                }
                const v = await this.store.storage.inspectFile(a.relativePath, a.sha256);
                if (v.status !== "AVAILABLE") {
                  allGood = false;
                  break;
                }
              }
              if (allGood) {
                isStale = false;
              }
            }
          }
        }
        
        if (!isStale) {
          this.store.database.updateProcessingJob(jobId, { state: "COMPLETED", updatedAt: this.clock().toISOString() });
          return;
        }

        // Stale
        const records = this.store.database.listAnalysis(meetingId);
        this.store.database.invalidateStaleAnalysis(meetingId);
        for (const r of records) {
          const a = this.store.database.getArtifact(r.artifactId);
          if (a) {
             try {
               const absPath = this.store.resolveArtifactAbsolutePath(a.relativePath);
               await rm(absPath, { force: true });
             } catch { /* ignore */ }
             this.store.database.deleteArtifactRow(r.artifactId);
          }
        }
      }

      const micDoc = micRecord ? await this.loadTranscriptDocument(micRecord) : undefined;
      const sysDoc = sysRecord ? await this.loadTranscriptDocument(sysRecord) : undefined;
    const unifiedDoc = buildUnifiedTranscriptDocument(meetingId, micDoc, sysDoc);

    const result = await this.analysisProvider.process({
      meetingId,
      purpose: "SUMMARY",
      content: JSON.stringify(unifiedDoc),
      language: unifiedDoc.language
    });

      if (result.persistedByProvider !== false) {
        throw new StorageError("AI provider must not persist meeting data.");
      }

      const analysis = parseAnalysisDocument(result.output, meetingId);

      const quality = evaluateAnalysisQuality(analysis, unifiedDoc);
      if (!quality.acceptable) {
        throw new StorageError(`Analysis quality rejected: ${quality.reasons.join(", ")}`);
      }

      await this.store.saveAnalysis(analysis, { sourceTranscriptIds, sourceTranscriptShas });
      this.store.database.updateProcessingJob(jobId, { state: "COMPLETED", updatedAt: this.clock().toISOString() });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      const isRetryable = /interrupted|abort/i.test(e.message);
      this.store.database.updateProcessingJob(jobId, {
        state: isRetryable ? "INCOMPLETE" : "FAILED",
        error: sanitizeStoredJobError(e.message),
        updatedAt: this.clock().toISOString()
      });
      throw e;
    }
  }
}

const STORED_JOB_ERROR_LEAK =
  /(?:[A-Za-z]:(?:\\+|\/(?!\/))|\\\\|\/home\/|\/Users\/|\/tmp\/|\/var\/|file:\/\/|DATA_ROOT|Program Files|AppData|LOCALAPPDATA)/i;

function sanitizeStoredJobError(message: string): string {
  return STORED_JOB_ERROR_LEAK.test(message) ? "The processing step failed." : message;
}
