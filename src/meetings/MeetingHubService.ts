import type {
  AnalysisDocument,
  Artifact,
  ArtifactType,
  CalendarEventAssociation,
  MeetingStatus,
} from "../domain/models";
import {
  HUB_MAX_ANALYSIS_READ_BYTES,
  HUB_MAX_TRANSCRIPT_READ_BYTES,
  type HubAnalysisDocument,
  type HubArtifactInfo,
  type HubAssistedJoinPlan,
  type HubCalendarInfo,
  type HubCaptureCapabilities,
  type HubCaptureRequest,
  type HubCaptureSnapshot,
  type HubDecisionInfo,
  type HubHistoryFilter,
  type HubMeetingAssistPlan,
  type HubMeetingSummary,
  type HubProcessingJobInfo,
  type HubTaskInfo,
  type HubTranscriptContent,
  type HubTranscriptInfo,
  type MeetingDetail,
  type MeetingHubOverview,
  type TranscriptSearchHit,
  type TranscriptSearchResults,
} from "../domain/hub";
import { MeetingAssistService } from "./MeetingAssistService";
import type {
  MeetingCaptureFlowSnapshot,
  MeetingCaptureOrchestrator,
} from "../capture/MeetingCaptureOrchestrator";
import type { LocalFirstStore } from "../storage/LocalFirstStore";
import { buildAssistedJoinPlan } from "./AssistedJoin";

export type MeetingHubErrorCode =
  | "MEETING_NOT_FOUND"
  | "MEETING_HUB_UNAVAILABLE"
  | "MEETING_CAPTURE_UNAVAILABLE"
  | "TRANSCRIPT_NOT_FOUND"
  | "ARTIFACT_UNAVAILABLE"
  | "TRANSCRIPT_TOO_LARGE"
  | "ANALYSIS_UNAVAILABLE"
  | "INVALID_REQUEST"
  | "CHAT_CLOUD_DISALLOWED";

export class MeetingHubError extends Error {
  public constructor(
    public readonly code: MeetingHubErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MeetingHubError";
  }
}

export interface MeetingHubServiceDependencies {
  store: LocalFirstStore;
  /** Real multi-source capture orchestrator (main process); optional when no capture is available. */
  orchestrator?: MeetingCaptureOrchestrator;
  clock?: () => Date;
}

const RECENT_HISTORY_LIMIT = 12;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
const MAX_QUERY_LENGTH = 200;
const SNIPPET_RADIUS = 120;
const SNIPPET_LENGTH = 280;

const TERMINAL_MEETING_STATUSES: ReadonlySet<MeetingStatus> = new Set([
  "COMPLETED",
  "PROCESSING",
  "INCOMPLETE",
  "FAILED",
  "CANCELLED",
]);

const LIVE_MEETING_STATUSES: ReadonlySet<MeetingStatus> = new Set([
  "PREPARING",
  "RECORDING",
  "FINALIZING",
]);

const ARTIFACT_TYPE_LABELS: Readonly<Record<string, string>> = {
  MEETING_MANIFEST: "Meeting manifest",
  RECORDING_ORIGINAL: "Original recording",
  RECORDING_NORMALIZED: "Normalized recording",
  TRANSCRIPT_JSON: "Transcript (JSON)",
  TRANSCRIPT_TEXT: "Transcript (text)",
  TRANSCRIPT_VTT: "Transcript (VTT)",
  TRANSCRIPT_SRT: "Transcript (SRT)",
  ANALYSIS_SUMMARY_JSON: "Analysis summary (JSON)",
  ANALYSIS_SUMMARY_MARKDOWN: "Analysis summary (Markdown)",
  ANALYSIS_DECISIONS: "Decisions",
  ANALYSIS_TASKS: "Tasks",
  ANALYSIS_RISKS: "Risks",
  ANALYSIS_QUESTIONS: "Questions",
  ANALYSIS_FOLLOWUPS: "Follow-ups",
  DOCUMENT_ANALYSIS: "Analysis document",
  DOCUMENT_ATTACHMENT: "Attachment",
  AUDIO_EXCERPT: "Audio excerpt",
};

/**
 * Meeting Hub domain service. Every method produces renderer-safe DTOs: no
 * absolute filesystem paths, no DATA_ROOT location, no credentials, no
 * provider cursors. Calendar linkage is read from the real persisted
 * `calendar_event_associations` rows (which always reference persisted
 * meeting ids), and capture controls drive the real
 * `MeetingCaptureOrchestrator` with the persisted meeting id.
 */
export class MeetingHubService {
  private readonly store: LocalFirstStore;
  private readonly orchestrator?: MeetingCaptureOrchestrator;
  private readonly clock: () => Date;

  public constructor(dependencies: MeetingHubServiceDependencies) {
    this.store = dependencies.store;
    this.orchestrator = dependencies.orchestrator;
    this.clock = dependencies.clock ?? (() => new Date());
  }

  public getOverview(): MeetingHubOverview {
    const meetings = this.store.listMeetings();
    const associations = this.store.database.listCalendarEventAssociations();
    const associationsByMeeting = new Map<string, CalendarEventAssociation[]>();
    for (const association of associations) {
      const existing = associationsByMeeting.get(association.meetingId);
      if (existing === undefined) {
        associationsByMeeting.set(association.meetingId, [association]);
      } else {
        existing.push(association);
      }
    }
    const artifacts = this.store.database.listArtifacts();
    const now = this.clock();
    const todayKey = localDateKey(now);
    const activeFlowMeetingIds = new Set(this.orchestrator?.getActiveMeetingIds() ?? []);

    const summaries: Array<HubMeetingSummary & { dateKey: string }> = [];
    let historyTotal = 0;
    for (const meeting of meetings) {
      const meetingArtifacts = artifacts.filter((artifact) => artifact.meetingId === meeting.meetingId);
      const association = associationsByMeeting.get(meeting.meetingId)?.[0];
      const summary = summarizeMeeting(meeting, meetingArtifacts, association,
        activeFlowMeetingIds.has(meeting.meetingId) || LIVE_MEETING_STATUSES.has(meeting.status));
      summaries.push(summary);
      if (TERMINAL_MEETING_STATUSES.has(meeting.status)) {
        historyTotal += 1;
      }
    }

    const isScheduled = (status: MeetingStatus): boolean =>
      status === "SCHEDULED" || status === "DETECTED";
    // "Today" also shows capture flows that have already started (PREPARING /
    // RECORDING / FINALIZING) so an in-progress recording stays visible.
    const isTodayOccurrence = (status: MeetingStatus): boolean =>
      isScheduled(status) || LIVE_MEETING_STATUSES.has(status);

    const today = summaries
      .filter((summary) => !summary.calendar?.isCancelled && summary.dateKey === todayKey && isTodayOccurrence(summary.status))
      .sort(compareOccurrence);
    const upcoming = summaries
      .filter((summary) => summary.dateKey > todayKey && isScheduled(summary.status))
      .sort(compareOccurrence);
    const recent = summaries
      .filter((summary) => TERMINAL_MEETING_STATUSES.has(summary.status))
      .sort((a, b) => (occurrenceValue(b) ?? "").localeCompare(occurrenceValue(a) ?? ""))
      .slice(0, RECENT_HISTORY_LIMIT);

    return {
      serverTime: now.toISOString(),
      todayLabel: formatLongDate(now),
      today,
      upcoming,
      recent,
      historyTotal,
    };
  }

  public listHistory(filter: HubHistoryFilter = {}): HubMeetingSummary[] {
    const overviewMeetings = this.store.listMeetings();
    const associations = this.store.database.listCalendarEventAssociations();
    const associationsByMeeting = new Map<string, CalendarEventAssociation>();
    for (const association of associations) {
      if (!associationsByMeeting.has(association.meetingId)) {
        associationsByMeeting.set(association.meetingId, association);
      }
    }
    const artifacts = this.store.database.listArtifacts();
    const activeFlowMeetingIds = new Set(this.orchestrator?.getActiveMeetingIds() ?? []);
    const query = filter.query?.trim().toLowerCase() ?? "";
    const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 50)), 200);
    const results: HubMeetingSummary[] = [];
    for (const meeting of overviewMeetings) {
      if (!TERMINAL_MEETING_STATUSES.has(meeting.status)) continue;
      if (filter.status !== undefined && meeting.status !== filter.status) continue;
      const association = associationsByMeeting.get(meeting.meetingId);
      if (filter.provider !== undefined && association?.provider !== filter.provider) continue;
      if (query.length > 0) {
        const haystack = `${meeting.title} ${association?.subject ?? ""} ${association?.location ?? ""}`.toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      const meetingArtifacts = artifacts.filter((artifact) => artifact.meetingId === meeting.meetingId);
      results.push(summarizeMeeting(
        meeting,
        meetingArtifacts,
        association,
        activeFlowMeetingIds.has(meeting.meetingId) || LIVE_MEETING_STATUSES.has(meeting.status),
      ));
    }
    return results
      .sort((a, b) => (occurrenceValue(b) ?? "").localeCompare(occurrenceValue(a) ?? ""))
      .slice(0, limit);
  }

  public getAssistedJoinPlan(meetingId: string): HubAssistedJoinPlan {
    const meeting = this.requireMeeting(meetingId);
    const association = this.store.database.listCalendarEventAssociations(meeting.meetingId)[0];
    return buildAssistedJoinPlan({
      meetingId: meeting.meetingId,
      meetingTitle: meeting.title,
      ...(association === undefined ? {} : { association }),
    });
  }

  public getMeetingDetail(meetingId: string): MeetingDetail {
    const meeting = this.requireMeeting(meetingId);
    const artifacts = this.store.database.listArtifacts(meetingId);
    const association = this.store.database.listCalendarEventAssociations(meetingId)[0];
    const activeFlowMeetingIds = new Set(this.orchestrator?.getActiveMeetingIds() ?? []);
    const summary = summarizeMeeting(meeting, artifacts, association,
      activeFlowMeetingIds.has(meetingId) || LIVE_MEETING_STATUSES.has(meeting.status));
    const artifactInfos = artifacts
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((artifact) => toArtifactInfo(artifact));
    const transcripts = this.store.database
      .listTranscripts(meetingId)
      .map((record) => toTranscriptInfo(record));
    const jobs = this.store.database
      .listProcessingJobs(meetingId)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((job) => ({
        jobId: job.jobId,
        jobType: job.jobType,
        state: job.state,
        createdAt: job.createdAt,
        ...(job.error === undefined ? {} : { error: job.error }),
      } satisfies HubProcessingJobInfo));
    return {
      meeting: summary,
      folderLabel: meeting.folderName,
      artifacts: artifactInfos,
      transcripts,
      processingJobs: jobs,
    };
  }

  public async getTranscriptContent(meetingId: string, transcriptId: string): Promise<HubTranscriptContent> {
    this.requireMeeting(meetingId);
    const record = this.store.database.listTranscripts(meetingId).find((item) => item.transcriptId === transcriptId);
    if (record === undefined) {
      throw new MeetingHubError("TRANSCRIPT_NOT_FOUND", `Transcript ${transcriptId} is not part of meeting ${meetingId}.`);
    }
    const artifact = this.store.database.getArtifact(record.textArtifactId);
    if (artifact === undefined) {
      throw new MeetingHubError("ARTIFACT_UNAVAILABLE", `Transcript ${transcriptId} has no indexed text artifact.`);
    }
    if (artifact.status !== "AVAILABLE") {
      return {
        transcriptId,
        meetingId,
        language: record.language,
        createdAt: record.createdAt,
        truncated: false,
        available: false,
        reason: "ARTIFACT_UNAVAILABLE",
        artifactFileId: artifact.fileId,
      };
    }
    if (artifact.size > HUB_MAX_TRANSCRIPT_READ_BYTES) {
      return {
        transcriptId,
        meetingId,
        language: record.language,
        createdAt: record.createdAt,
        truncated: false,
        available: false,
        reason: "TRANSCRIPT_TOO_LARGE",
        artifactFileId: artifact.fileId,
      };
    }
    const bytes = await this.store.readArtifactBytes(artifact.relativePath);
    const text = Buffer.from(bytes).toString("utf8");
    return {
      transcriptId,
      meetingId,
      language: record.language,
      createdAt: record.createdAt,
      text,
      truncated: text.length > HUB_MAX_TRANSCRIPT_READ_BYTES,
      available: true,
      artifactFileId: artifact.fileId,
    };
  }

  public async searchTranscripts(query: string, options: { limit?: number } = {}): Promise<TranscriptSearchResults> {
    const trimmed = query.trim().slice(0, MAX_QUERY_LENGTH);
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? DEFAULT_SEARCH_LIMIT)), MAX_SEARCH_LIMIT);
    const empty: TranscriptSearchResults = { query: trimmed, hitCount: 0, matches: [], truncated: false };
    if (trimmed.length === 0) {
      return empty;
    }
    const meetingsById = new Map(this.store.listMeetings().map((meeting) => [meeting.meetingId, meeting]));
    const artifactById = new Map(this.store.database.listArtifacts().map((artifact) => [artifact.fileId, artifact]));
    const transcripts = this.store.database.listAllTranscripts().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const loweredQuery = trimmed.toLowerCase();
    const matches: TranscriptSearchHit[] = [];

    for (const record of transcripts) {
      const meeting = meetingsById.get(record.meetingId);
      if (meeting === undefined) {
        continue;
      }
      const artifact = artifactById.get(record.textArtifactId);
      if (artifact === undefined || artifact.status !== "AVAILABLE" || artifact.size === 0 || artifact.size > HUB_MAX_TRANSCRIPT_READ_BYTES) {
        continue;
      }
      let text: string;
      try {
        const bytes = await this.store.readArtifactBytes(artifact.relativePath);
        text = Buffer.from(bytes).toString("utf8");
      } catch {
        continue; // A single unreadable transcript must not break the search.
      }
      const index = text.toLowerCase().indexOf(loweredQuery);
      if (index < 0) {
        continue;
      }
      matches.push({
        meetingId: meeting.meetingId,
        meetingTitle: meeting.title,
        meetingDate: meeting.meetingDate,
        meetingStatus: meeting.status,
        transcriptId: record.transcriptId,
        language: record.language,
        snippet: buildSnippet(text, index, trimmed.length),
        artifactFileId: artifact.fileId,
      });
    }
    const truncated = matches.length > limit;
    return { query: trimmed, hitCount: matches.length, matches: matches.slice(0, limit), truncated };
  }

  // --- Capture controls (real MeetingCaptureOrchestrator) -------------------

  public async getCaptureCapabilities(): Promise<HubCaptureCapabilities> {
    const orchestrator = this.requireOrchestrator();
    const capabilities = await orchestrator.discoverCapabilities();
    const kinds = capabilities.capabilities;
    return {
      supported: capabilities.supported,
      platform: capabilities.platform,
      adapterId: capabilities.adapterId,
      microphone: kinds.MICROPHONE_AUDIO?.available === true,
      systemLoopback: kinds.SYSTEM_AUDIO?.available === true,
      screen: kinds.SCREEN?.available === true,
      window: kinds.WINDOW?.available === true,
    };
  }

  /**
   * Assisted flow plan for a calendar-linked meeting (Teams/Zoom/Google
   * Meet/other). The plan is derived from persisted meeting data and the
   * locally discovered capture capabilities; no URLs or paths are returned.
   * When capture discovery fails the plan still answers (capture off), so
   * join-and-note guidance always works.
   */
  public async getAssistedFlowPlan(meetingId: string): Promise<HubMeetingAssistPlan> {
    this.requireMeeting(meetingId);
    let capabilities: HubCaptureCapabilities = {
      supported: false,
      microphone: false,
      systemLoopback: false,
      screen: false,
      window: false,
    };
    try {
      capabilities = await this.getCaptureCapabilities();
    } catch {
      // No capture adapter (or discovery failure): plan without capture.
    }
    return new MeetingAssistService({ store: this.store }).plan(meetingId, capabilities);
  }

  public async startMeetingCapture(request: HubCaptureRequest): Promise<HubCaptureSnapshot> {
    const orchestrator = this.requireOrchestrator();
    this.requireMeeting(request.meetingId);
    if (!request.microphone && !request.systemLoopback && !request.screen && !request.window) {
      throw new MeetingHubError("INVALID_REQUEST", "A capture requires at least one enabled source.");
    }
    const snapshot = await orchestrator.start(
      {
        microphone: request.microphone,
        systemLoopback: request.systemLoopback,
        screen: request.screen,
        ...(request.window === undefined ? {} : { window: request.window }),
      },
      { meetingId: request.meetingId },
    );
    return toCaptureSnapshot(snapshot);
  }

  public async stopMeetingCapture(meetingId: string): Promise<HubCaptureSnapshot> {
    const snapshot = await this.requireOrchestrator().stop(meetingId);
    return toCaptureSnapshot(snapshot);
  }

  public async abortMeetingCapture(meetingId: string, reason?: string): Promise<HubCaptureSnapshot> {
    const snapshot = await this.requireOrchestrator().abort(meetingId, reason);
    return toCaptureSnapshot(snapshot);
  }

  public listActiveCaptures(): HubCaptureSnapshot[] {
    return (this.orchestrator?.getActiveFlowSnapshots() ?? []).map((flow) => toCaptureSnapshot(flow));
  }

  /**
   * Returns the stored join/web URL for a linked calendar event, only when it
   * is a safe external http(s) address. The renderer never supplies the URL —
   * it sends the persisted meeting id and this process resolves the stored
   * provider value, so arbitrary renderer-supplied links can never be opened.
   */
  public getLinkedUrl(meetingId: string, kind: "JOIN" | "WEB"): string | undefined {
    const meeting = this.requireMeeting(meetingId);
    const association = this.store.database.listCalendarEventAssociations(meeting.meetingId)[0];
    const url = kind === "JOIN" ? association?.onlineMeeting?.joinUrl : association?.webUrl;
    return url !== undefined && isSafeExternalUrl(url) ? url : undefined;
  }

  // --- Analysis documents (grounded summary content) -------------------------

  public async getAnalysisDocument(meetingId: string): Promise<HubAnalysisDocument | undefined> {
    const meeting = this.requireMeeting(meetingId);
    const artifacts = this.store.database.listArtifacts(meetingId);
    const summaryArtifact = artifacts
      .filter((artifact) => artifact.artifactType === "ANALYSIS_SUMMARY_JSON" && artifact.status === "AVAILABLE")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (summaryArtifact === undefined) {
      return undefined;
    }
    if (summaryArtifact.size > HUB_MAX_ANALYSIS_READ_BYTES) {
      throw new MeetingHubError("ANALYSIS_UNAVAILABLE", `The analysis summary for ${meetingId} is larger than the read limit.`);
    }
    const bytes = await this.store.readArtifactBytes(summaryArtifact.relativePath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    } catch {
      throw new MeetingHubError("ANALYSIS_UNAVAILABLE", `The analysis summary for ${meetingId} is not valid JSON.`);
    }
    const document = parsed as Partial<AnalysisDocument> & { createdAt?: string };
    if (document.summary === undefined || typeof document.summary !== "string") {
      throw new MeetingHubError("ANALYSIS_UNAVAILABLE", `The analysis summary for ${meetingId} is malformed.`);
    }
    const createdAt = typeof document.createdAt === "string" ? document.createdAt : summaryArtifact.createdAt;
    return {
      meetingId: meeting.meetingId,
      createdAt,
      summary: document.summary,
      decisions: (Array.isArray(document.decisions) ? document.decisions : []).map((decision) => ({
        decisionId: typeof decision.decisionId === "string" ? decision.decisionId : "",
        text: typeof decision.text === "string" ? decision.text : "",
        ...(typeof decision.owner === "string" && decision.owner ? { owner: decision.owner } : {}),
        ...(typeof decision.decidedAt === "string" && decision.decidedAt ? { decidedAt: decision.decidedAt } : {}),
      }) satisfies HubDecisionInfo),
      tasks: (Array.isArray(document.tasks) ? document.tasks : []).map((task) => ({
        taskId: typeof task.taskId === "string" ? task.taskId : "",
        text: typeof task.text === "string" ? task.text : "",
        ...(typeof task.assignee === "string" && task.assignee ? { assignee: task.assignee } : {}),
        ...(typeof task.dueDate === "string" && task.dueDate ? { dueDate: task.dueDate } : {}),
        status: isTaskStatus(task.status) ? task.status : "OPEN",
        createdAt: typeof (task as { createdAt?: unknown }).createdAt === "string"
          ? ((task as { createdAt?: unknown }).createdAt as string)
          : createdAt,
      }) satisfies HubTaskInfo),
      risks: stringArray(document.risks),
      questions: stringArray(document.questions),
      followups: stringArray(document.followups),
    };
  }

  private requireMeeting(meetingId: string) {
    const meeting = this.store.getMeeting(meetingId);
    if (meeting === undefined) {
      throw new MeetingHubError("MEETING_NOT_FOUND", `Meeting not found: ${meetingId}`);
    }
    return meeting;
  }

  private requireOrchestrator(): MeetingCaptureOrchestrator {
    if (this.orchestrator === undefined) {
      throw new MeetingHubError("MEETING_CAPTURE_UNAVAILABLE", "Meeting capture is not available in this session.");
    }
    return this.orchestrator;
  }
}

function summarizeMeeting(
  meeting: {
    meetingId: string;
    title: string;
    meetingDate: string;
    status: MeetingStatus;
    startedAt?: string;
    endedAt?: string;
    createdAt: string;
    updatedAt: string;
    providerMeetingId?: string;
    calendarEventId?: string;
  },
  artifacts: Artifact[],
  association: CalendarEventAssociation | undefined,
  active: boolean,
): HubMeetingSummary & { dateKey: string } {
  const nonManifest = artifacts.filter((artifact) => artifact.artifactType !== "MEETING_MANIFEST");
  const summary: HubMeetingSummary = {
    meetingId: meeting.meetingId,
    title: meeting.title,
    meetingDate: meeting.meetingDate,
    status: meeting.status,
    startedAt: meeting.startedAt,
    endedAt: meeting.endedAt,
    createdAt: meeting.createdAt,
    updatedAt: meeting.updatedAt,
    providerMeetingId: meeting.providerMeetingId,
    calendarEventId: meeting.calendarEventId ?? association?.externalEventId,
    isActive: active,
    artifactCount: nonManifest.length,
    hasRecording: nonManifest.some((artifact) => artifact.artifactType.startsWith("RECORDING_")),
    hasTranscript: nonManifest.some((artifact) => artifact.artifactType === "TRANSCRIPT_TEXT" || artifact.artifactType === "TRANSCRIPT_JSON"),
    hasAnalysis: nonManifest.some((artifact) => artifact.artifactType === "ANALYSIS_SUMMARY_JSON"),
  };
  if (association !== undefined) {
    summary.calendar = {
      provider: association.provider,
      externalEventId: association.externalEventId,
      subject: association.subject,
      startTime: association.startTime,
      endTime: association.endTime,
      meetingPlatform: association.meetingPlatform,
      isCancelled: association.isCancelled,
      ...(association.location === undefined ? {} : { location: association.location }),
      ...(association.webUrl === undefined ? {} : { webUrl: association.webUrl }),
      ...(association.onlineMeeting === undefined ? {} : { onlineMeetingProvider: association.onlineMeeting.provider }),
      ...(association.onlineMeeting?.joinUrl === undefined ? {} : { joinUrl: association.onlineMeeting.joinUrl }),
    };
  }
  return { ...summary, dateKey: meeting.meetingDate };
}

function toArtifactInfo(artifact: Artifact): HubArtifactInfo {
  const info: HubArtifactInfo = {
    fileId: artifact.fileId,
    artifactType: artifact.artifactType,
    mimeType: artifact.mimeType,
    size: artifact.size,
    createdAt: artifact.createdAt,
    modifiedAt: artifact.modifiedAt,
    status: artifact.status,
    label: artifactTypeLabel(artifact.artifactType),
  };
  if (artifact.recordingVariant !== undefined) {
    info.recordingVariant = artifact.recordingVariant;
  }
  return info;
}

function toTranscriptInfo(record: {
  transcriptId: string;
  meetingId: string;
  language: string;
  createdAt: string;
  engineId?: string;
  recordingId?: string;
  jsonArtifactId: string;
  textArtifactId: string;
  vttArtifactId?: string;
  srtArtifactId?: string;
}): HubTranscriptInfo {
  const info: HubTranscriptInfo = {
    transcriptId: record.transcriptId,
    language: record.language,
    createdAt: record.createdAt,
    engineId: record.engineId,
    recordingId: record.recordingId,
    jsonArtifactId: record.jsonArtifactId,
    textArtifactId: record.textArtifactId,
  };
  if (record.vttArtifactId !== undefined) info.vttArtifactId = record.vttArtifactId;
  if (record.srtArtifactId !== undefined) info.srtArtifactId = record.srtArtifactId;
  return info;
}

function toCaptureSnapshot(snapshot: MeetingCaptureFlowSnapshot): HubCaptureSnapshot {
  const result: HubCaptureSnapshot = {
    flowId: snapshot.flowId,
    meetingId: snapshot.meetingId,
    phase: snapshot.phase,
    meetingStatus: snapshot.meetingStatus,
    startedAt: snapshot.startedAt,
    requestedCapabilities: [...snapshot.requestedCapabilities],
    startedCapabilities: [...snapshot.startedCapabilities],
    activeSources: [...snapshot.activeSources],
  };
  if (snapshot.failure !== undefined) {
    const failedSource = snapshot.failure.source === undefined
      ? undefined
      : snapshot.sources.find((source) => source.kind === snapshot.failure?.source);
    result.error = {
      message: snapshot.failure.reason,
      failed: snapshot.failure.failed,
      ...(failedSource?.error?.code === undefined ? {} : { code: failedSource.error.code }),
    };
  }
  return result;
}

function artifactTypeLabel(type: ArtifactType): string {
  return ARTIFACT_TYPE_LABELS[type] ?? type;
}

function isTaskStatus(value: unknown): value is "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED" {
  return value === "OPEN" || value === "IN_PROGRESS" || value === "DONE" || value === "CANCELLED";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** First calendar occurrence start, or the meeting date at 00:00 local, as an ISO sort key. */
function occurrenceValue(summary: { calendar?: HubCalendarInfo; meetingDate: string }): string | undefined {
  return summary.calendar?.startTime ?? `${summary.meetingDate}T00:00:00`;
}

function compareOccurrence(a: HubMeetingSummary, b: HubMeetingSummary): number {
  return (occurrenceValue(a) ?? "").localeCompare(occurrenceValue(b) ?? "");
}

function isSafeExternalUrl(value: string): boolean {
  if (value.length > 8192) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return false;
  }
  const loopback = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  if (loopback.test(host)) {
    return false;
  }
  return true;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLongDate(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function buildSnippet(text: string, index: number, queryLength: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + queryLength + SNIPPET_RADIUS);
  let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (snippet.length > SNIPPET_LENGTH) {
    snippet = `${snippet.slice(0, SNIPPET_LENGTH).trimEnd()}…`;
  }
  if (start > 0) snippet = `…${snippet}`;
  return snippet;
}
