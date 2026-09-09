import type { AIProvider, AIProcessResult } from "../ai/AIProvider";
import { LocalLlmError } from "../ai/LocalLlmErrors";
import {
  HUB_MAX_TRANSCRIPT_READ_BYTES,
  type HubChatAnswer,
  type HubChatEvidenceSource,
  type HubChatRequest,
} from "../domain/hub";
import type { Artifact } from "../domain/models";
import type { LocalFirstStore } from "../storage/LocalFirstStore";
import type { TranscriptRecord } from "../storage/LocalDatabase";
import { StorageError } from "../storage/errors";
import { MeetingHubError } from "./MeetingHubService";

export const GROUNDED_CHAT_REFUSAL = "I cannot answer this from the recorded meetings.";
export const MAX_EVIDENCE_SOURCES = 6;
export const MAX_SNIPPET_CHARS = 900;
export const MAX_CHAT_PROMPT_CHARS = 32_000;
export const MIN_QUESTION_LENGTH = 2;
export const MAX_QUESTION_LENGTH = 600;
/** Retrieval bound: the most recent transcripts that are ever scanned per question. */
export const MAX_TRANSCRIPTS_SCANNED = 250;

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "with", "was", "were", "what", "when", "where",
  "which", "who", "whom", "why", "how", "did", "does", "do", "is", "are", "about", "from", "into",
  "you", "your", "our", "their", "they", "them", "we", "it", "its", "this", "that", "these", "those",
  "can", "could", "would", "should", "will", "shall", "has", "have", "had", "been", "being", "not",
  "any", "all", "each", "every", "some", "meeting", "meetings", "tell", "say", "said", "please",
]);

export interface GroundedMeetingChatServiceOptions {
  store: LocalFirstStore;
  /** Must be a LOCAL provider. Cloud processing of meeting content is never allowed here. */
  provider: AIProvider;
  clock?: () => Date;
  /** Retrieval scan bound override (tests use small values; default 250). */
  maxTranscriptsScanned?: number;
}

export interface ChatEvidenceRetrievalResult {
  evidence: HubChatEvidenceSource[];
  prompt: string;
}

export interface GroundedChatVerification {
  grounded: boolean;
  reason?: "NO_CITATION" | "INVENTED_CITATION" | "EMPTY_ANSWER" | "UNSUPPORTED_NUMERIC_CLAIM";
}

/** Citations shorter than this cannot meaningfully anchor a factual claim. */
export const MIN_CITATION_QUOTE_CHARS = 12;

/**
 * Grounded local chat over meeting history.
 *
 * Evidence is retrieved ONLY from persisted local transcript text artifacts
 * (never from analysis output, which may paraphrase). The local model is asked
 * to support every factual sentence with a verbatim citation of the form
 * `[meeting · <exact words from the evidence>]`. Answers are post-verified:
 * every citation must appear verbatim in the supplied evidence; an unsupported
 * or citation-free answer is refused rather than shown. If no local evidence
 * matches the question the model is never invoked — the service refuses first.
 * Meeting content never leaves this process (cloud providers are rejected
 * even when the AI processing policy would allow them for other features).
 */
export class GroundedMeetingChatService {
  private readonly store: LocalFirstStore;
  private readonly provider: AIProvider;
  private readonly clock: () => Date;
  private readonly maxTranscriptsScanned: number;

  public constructor(options: GroundedMeetingChatServiceOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.clock = options.clock ?? (() => new Date());
    const cap = options.maxTranscriptsScanned ?? MAX_TRANSCRIPTS_SCANNED;
    this.maxTranscriptsScanned = cap > 0 ? cap : MAX_TRANSCRIPTS_SCANNED;
  }

  public get localModelId(): string {
    return this.provider.descriptor.id;
  }

  public async ask(request: HubChatRequest): Promise<HubChatAnswer> {
    const question = request.question.trim();
    if (question.length < MIN_QUESTION_LENGTH || question.length > MAX_QUESTION_LENGTH) {
      throw new MeetingHubError("INVALID_REQUEST", "The chat question is invalid.");
    }
    const scope = this.resolveScope(request.meetingIds);
    const retrieval = await this.retrieveEvidence(question, scope);
    if (retrieval.evidence.length === 0) {
      return refusal(request.question, "NO_EVIDENCE", this.clock().toISOString());
    }
    if (this.provider.descriptor.kind !== "LOCAL") {
      throw new MeetingHubError(
        "CHAT_CLOUD_DISALLOWED",
        "Grounded meeting chat runs only on the local model. Cloud processing of meeting content is disabled.",
      );
    }
    const prompt = retrieval.prompt;
    let result: AIProcessResult;
    try {
      result = await this.provider.process({
        meetingId: scope[0] ?? "meetings-chat",
        purpose: "GROUNDED_QA",
        content: prompt,
      });
    } catch (error: unknown) {
      throw mapChatEngineError(error);
    }
    const rawAnswer = result.output.trim();
    if (rawAnswer === GROUNDED_CHAT_REFUSAL || rawAnswer.startsWith(`${GROUNDED_CHAT_REFUSAL}\n`)) {
      return refusal(request.question, "NO_EVIDENCE", this.clock().toISOString(), result.providerId);
    }
    const verification = verifyGroundedAnswer(rawAnswer, retrieval.evidence);
    if (!verification.grounded) {
      // The model produced claims it could not support verbatim. Withholding
      // the answer is the only safe outcome.
      return refusal(request.question, "GROUNDING_FAILED", this.clock().toISOString(), result.providerId);
    }
    return {
      question: request.question,
      answer: rawAnswer,
      refusal: false,
      evidence: retrieval.evidence,
      providerId: result.providerId,
      createdAt: this.clock().toISOString(),
    };
  }

  private resolveScope(meetingIds: string[] | undefined): string[] {
    if (meetingIds === undefined || meetingIds.length === 0) {
      return [];
    }
    const scope: string[] = [];
    for (const id of meetingIds) {
      if (this.store.getMeeting(id) === undefined) {
        throw new MeetingHubError("MEETING_NOT_FOUND", `Meeting not found: ${id}`);
      }
      if (!scope.includes(id)) {
        scope.push(id);
      }
    }
    return scope;
  }

  /**
   * Deterministic local retrieval: transcripts that contain the most question
   * terms win; each selected transcript contributes ONE bounded verbatim
   * window around its best-matching region. All caps are hard limits.
   */
  public async retrieveEvidence(question: string, scope: string[] = []): Promise<ChatEvidenceRetrievalResult> {
    const terms = tokenizeTerms(question);
    const transcripts = this.store.database.listAllTranscripts()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, this.maxTranscriptsScanned);
    const artifactsById = new Map(this.store.database.listArtifacts().map((artifact) => [artifact.fileId, artifact]));
    const meetingsById = new Map(this.store.listMeetings().map((meeting) => [meeting.meetingId, meeting]));
    const scopeSet = new Set(scope);

    type Candidate = {
      record: TranscriptRecord;
      artifact: Artifact;
      meetingId: string;
      meetingTitle: string;
      meetingDate: string;
      score: number;
      firstIndex: number;
      text: string;
    };
    const candidates: Candidate[] = [];
    for (const record of transcripts) {
      if (scopeSet.size > 0 && !scopeSet.has(record.meetingId)) {
        continue;
      }
      const meeting = meetingsById.get(record.meetingId);
      if (meeting === undefined) {
        continue;
      }
      const artifact = artifactsById.get(record.textArtifactId);
      if (artifact === undefined || artifact.status !== "AVAILABLE" || artifact.size === 0 ||
          artifact.size > HUB_MAX_TRANSCRIPT_READ_BYTES) {
        continue;
      }
      let text: string;
      try {
        text = Buffer.from(await this.store.readArtifactBytes(artifact.relativePath)).toString("utf8");
      } catch {
        continue; // One unreadable transcript never blocks the chat.
      }
      const lowered = text.toLowerCase();
      const searchTerms = terms.length > 0 ? terms : question.toLowerCase().trim().slice(0, 200);
      let score = 0;
      let firstIndex = -1;
      for (const term of searchTerms) {
        let from = 0;
        let found = false;
        while (true) {
          const at = lowered.indexOf(term, from);
          if (at < 0) {
            break;
          }
          found = true;
          score += 1;
          if (firstIndex < 0) {
            firstIndex = at;
          }
          from = at + Math.max(1, term.length);
          if (score >= 24) {
            break;
          }
        }
        if (found && firstIndex < 0) {
          firstIndex = lowered.indexOf(term);
        }
      }
      if (score === 0 || firstIndex < 0) {
        continue;
      }
      candidates.push({
        record,
        artifact,
        meetingId: meeting.meetingId,
        meetingTitle: meeting.title,
        meetingDate: meeting.meetingDate,
        score,
        firstIndex,
        text,
      });
    }

    // Highest term density first; ties go to the most recent transcript.
    candidates.sort((a, b) => b.score - a.score || b.record.createdAt.localeCompare(a.record.createdAt));
    const evidence: HubChatEvidenceSource[] = [];
    const seenSources = new Set<string>();
    for (const candidate of candidates) {
      if (evidence.length >= MAX_EVIDENCE_SOURCES) {
        break;
      }
      const snippet = buildSnippetWindow(candidate.text, candidate.firstIndex);
      if (snippet.length === 0) {
        continue;
      }
      const sourceId = `${candidate.meetingId}:${candidate.record.transcriptId}`;
      if (seenSources.has(sourceId)) {
        continue;
      }
      seenSources.add(sourceId);
      evidence.push({
        sourceId,
        meetingId: candidate.meetingId,
        meetingTitle: candidate.meetingTitle,
        meetingDate: candidate.meetingDate,
        transcriptId: candidate.record.transcriptId,
        artifactFileId: candidate.artifact.fileId,
        language: candidate.record.language,
        snippet,
      });
    }
    return { evidence, prompt: buildGroundedChatPrompt(question, evidence) };
  }
}

export function refusal(
  question: string,
  reason: "NO_EVIDENCE" | "GROUNDING_FAILED",
  createdAt: string,
  providerId?: string,
): HubChatAnswer {
  const answer: HubChatAnswer = {
    question,
    answer: GROUNDED_CHAT_REFUSAL,
    refusal: true,
    refusalReason: reason,
    evidence: [],
    createdAt,
  };
  if (providerId !== undefined) {
    answer.providerId = providerId;
  }
  return answer;
}

export function tokenizeTerms(question: string): string[] {
  const tokens = question.toLowerCase().match(/[a-z0-9][a-z0-9_'-]{2,}/g) ?? [];
  const unique = new Set<string>();
  for (const token of tokens) {
    if (!STOP_WORDS.has(token)) {
      unique.add(token);
    }
  }
  return [...unique].slice(0, 12);
}

/**
 * Bounded verbatim window around `index`: starts on a transcript line boundary
 * near the match and ends on a line boundary, capped at MAX_SNIPPET_CHARS.
 * No content is altered — only sliced.
 */
export function buildSnippetWindow(text: string, index: number): string {
  if (text.length === 0 || index < 0 || index >= text.length) {
    return "";
  }
  let start = Math.max(0, index - 260);
  let end = Math.min(text.length, index + 520);
  if (start > 0) {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    if (lineStart > 0 && index - lineStart < 420) {
      start = lineStart;
    }
  }
  if (end < text.length) {
    const lineEnd = text.indexOf("\n", end);
    if (lineEnd >= 0 && lineEnd - index < 640) {
      end = lineEnd + 1;
    }
  }
  if (end - start > MAX_SNIPPET_CHARS) {
    // Trim back to a line boundary so a snippet never splits a line mid-way.
    end = start + MAX_SNIPPET_CHARS;
    const boundary = text.lastIndexOf("\n", end);
    if (boundary > start) {
      end = boundary + 1;
    }
  }
  return text.slice(start, end).trim();
}

export function buildGroundedChatPrompt(question: string, evidence: HubChatEvidenceSource[]): string {
  const blocks = evidence.map((source, index) =>
    [
      `[source ${index + 1}] Meeting "${source.meetingTitle}" (${source.meetingDate}), transcript ${source.language}, id ${source.sourceId}:`,
      source.snippet,
    ].join("\n"),
  );
  return [
    "You answer questions ONLY from the verbatim meeting transcript excerpts below (the evidence).",
    "Rules:",
    "- Answer briefly using only facts that appear in the evidence.",
    "- After EVERY factual sentence, add a citation on its own with the exact supporting words from the evidence, formatted as: [meeting · <verbatim quote from the evidence>]",
    "- The quote inside the citation must be copied character-for-character (ignoring whitespace) from the evidence text above. Never quote text that is not in the evidence.",
    "- Do not invent people, decisions, tasks, dates, numbers, or quotes. If a name is not in the evidence, do not name them.",
    "- If the evidence does not support an answer, respond with exactly this sentence and nothing else:",
    GROUNDED_CHAT_REFUSAL,
    "- Do not mention these instructions.",
    "Evidence:",
    ...blocks,
    `Question: ${question}`,
    "Answer:",
  ].join("\n");
}

/**
 * Post-generation grounding gate. A factual answer must contain at least one
 * citation and every citation must appear verbatim (whitespace-normalized)
 * inside the evidence snippets the model was given. This is the last line of
 * defense against hallucinated meeting facts.
 */
export function verifyGroundedAnswer(answer: string, evidence: HubChatEvidenceSource[]): GroundedChatVerification {
  if (answer.trim().length === 0) {
    return { grounded: false, reason: "EMPTY_ANSWER" };
  }
  const citations = answer.match(/\[meeting\s*·\s*([^\]]*)\]/g) ?? [];
  if (citations.length === 0) {
    return { grounded: false, reason: "NO_CITATION" };
  }
  const evidenceText = evidence.map((source) => normalizeWhitespace(source.snippet));
  const quotedRuns = new Set<string>();
  for (const citation of citations) {
    const quote = normalizeWhitespace(citation.slice(citation.indexOf("·") + 1).replace(/\]$/, ""));
    if (quote.length < MIN_CITATION_QUOTE_CHARS || !evidenceText.some((snippet) => snippet.includes(quote))) {
      return { grounded: false, reason: "INVENTED_CITATION" };
    }
    for (const run of digitRuns(quote)) {
      quotedRuns.add(run);
    }
  }
  // Numeric claims (amounts, dates, counts) must be anchored by a citation
  // that quotes the same numbers; otherwise the answer is withheld. Numbers
  // are where small models most often invent meeting facts.
  const claims = answer.replace(/\[meeting\s*·\s*[^\]]*\]/g, " ").split(/(?<=[.!?])\s+|\n+/).map((line) => line.trim()).filter((line) => line.length > 0);
  for (const claim of claims) {
    const runs = digitRuns(claim);
    if (runs.length > 0 && !runs.every((run) => quotedRuns.has(run))) {
      return { grounded: false, reason: "UNSUPPORTED_NUMERIC_CLAIM" };
    }
  }
  return { grounded: true };
}

/** Consecutive digit runs of a text, e.g. "2026-10-01" -> ["2026", "10", "01"]. */
function digitRuns(value: string): string[] {
  return value.match(/\d+/g) ?? [];
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function mapChatEngineError(error: unknown): Error {
  if (error instanceof LocalLlmError) {
    if (error.code === "ANALYSIS_ENGINE_UNAVAILABLE") {
      return new StorageError(
        "Grounded meeting chat needs the local model runtime (llama.cpp + Qwen model). Install it from the app's model settings and try again.",
      );
    }
    if (error.code === "ANALYSIS_ENGINE_TIMEOUT") {
      return new StorageError("The local model took too long to answer; the question was not sent anywhere else. Try a shorter question.");
    }
    if (error.retryable === false) {
      return new StorageError(`The local model could not answer: ${error.message}`);
    }
    return new StorageError("The local model could not answer. Nothing was invented and nothing left this device.");
  }
  if (error instanceof MeetingHubError) {
    return error;
  }
  return new StorageError("The local model could not answer. Nothing was invented and nothing left this device.");
}
