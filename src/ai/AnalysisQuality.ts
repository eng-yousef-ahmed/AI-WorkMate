import type { AnalysisDocument, TranscriptDocument } from "../domain/models";

const PLACEHOLDER_PATTERNS = [
  /local analysis artifacts/i,
  /validated local summary/i,
  /review the analysis artifacts/i,
  /ship the local pipeline/i,
  /^ok$/i,
];

/**
 * Scenario marker vocabulary for analysis quality grounding. The strings are
 * plain-English phrases proven to survive the real Windows SAPI5 -> playback
 * -> WASAPI capture -> whisper.cpp tiny transcription path; identity tokens
 * (AI WorkMate, DATA_ROOT, llama.cpp, real-AI) are systematically corrupted
 * by tiny-model STT ("ai work made", "data route", "lama cpp", "relay") and
 * are therefore spoken in the fixture but not used as matching markers. The
 * matching mechanics (two-sided grounding, thresholds, normalization) are
 * unchanged.
 */
export const ANALYSIS_QUALITY_MARKERS = {
  attendees: ["Layla Hassan", "Omar Farouk", "Nadia Rahman", "Samir Haddad"],
  decisions: [
    "local only",
    "meeting files",
    "Windows verification",
  ],
  tasks: [
    "encryption of transcripts",
    "fail-closed tests",
    "install guide",
  ],
  assignees: ["Omar", "Nadia", "Samir"],
  dates: ["12 September 2026", "10 September 2026"],
  openItem: "7B",
} as const;

/** Summary must echo the meeting's core decision vocabulary (any one). */
const SUMMARY_MEETING_MARKERS = ["local only", "meeting files", "Windows verification"] as const;

/**
 * Maximum non-marker words allowed between consecutive marker words inside a
 * single transcript segment (transcript-side grounding only).
 */
export const ANALYSIS_MARKER_TRANSCRIPT_MAX_GAP = 2;

export interface AnalysisQualityReport {
  acceptable: boolean;
  placeholder: boolean;
  hallucinatedNames: string[];
  matchedDecisions: number;
  matchedTasks: number;
  matchedAssignees: number;
  matchedDates: number;
  summaryMentionsMeeting: boolean;
  reasons: string[];
}

/**
 * Normalize text for spoken-transcript marker matching: lowercase, map
 * underscores/hyphens/dots/slashes and any other punctuation to word spaces,
 * and collapse whitespace. Applied symmetrically to quality markers, the
 * transcript corpus, the analysis text, and name grounding so a marker spoken
 * as words ("local only") grounds exactly like its written identifier form
 * ("LOCAL_ONLY"). This changes representation only: every threshold, marker
 * string, and grounding requirement (a marker counts only when it appears in
 * BOTH the analysis and the transcript) is unchanged.
 */
export function normalizeAnalysisMarkerText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function transcriptCorpus(document: TranscriptDocument): string {
  return document.segments.map((segment) => segment.text).join(" ");
}

function normalizedWords(text: string): string[] {
  const normalized = normalizeAnalysisMarkerText(text);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/**
 * Transcript-side marker grounding: the marker's words must appear IN ORDER
 * within ONE transcript segment, with at most ANALYSIS_MARKER_TRANSCRIPT_MAX_GAP
 * non-marker words between consecutive marker words. Real STT inserts
 * interloper words ("windows relay verification"), which is faithful
 * recognition of the concept; scattered, reversed, cross-segment, or
 * partial-word matches still fail. The analysis side keeps contiguous
 * substring matching (Qwen output is not STT-corrupted).
 */
export function transcriptSegmentsContainMarker(
  segments: TranscriptDocument["segments"],
  marker: string,
  maxGap = ANALYSIS_MARKER_TRANSCRIPT_MAX_GAP,
): boolean {
  const markerWords = normalizedWords(marker);
  if (markerWords.length === 0) {
    return false;
  }
  return segments.some((segment) => {
    const words = normalizedWords(segment.text);
    return orderedWordsMatchFrom(words, markerWords, 0, -1, maxGap);
  });
}

function orderedWordsMatchFrom(
  words: string[],
  markerWords: string[],
  markerIndex: number,
  previousPosition: number,
  maxGap: number,
): boolean {
  if (markerIndex === markerWords.length) {
    return true;
  }
  const lowerBound = markerIndex === 0 ? 0 : previousPosition + 1;
  const upperBound = markerIndex === 0
    ? words.length - 1
    : Math.min(words.length - 1, previousPosition + 1 + maxGap);
  for (let position = lowerBound; position <= upperBound; position += 1) {
    if (words[position] === markerWords[markerIndex] &&
      orderedWordsMatchFrom(words, markerWords, markerIndex + 1, position, maxGap)) {
      return true;
    }
  }
  return false;
}

export function isPlaceholderAnalysis(document: AnalysisDocument): boolean {
  const blob = [document.summary, ...document.decisions.map((row) => row.text), ...document.tasks.map((row) => row.text)].join("\n");
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(blob));
}

export function evaluateAnalysisQuality(analysis: AnalysisDocument, transcript: TranscriptDocument): AnalysisQualityReport {
  const corpus = transcriptCorpus(transcript);
  const normalizedCorpus = normalizeAnalysisMarkerText(corpus);
  const namedPeople = collectNamedPeople(transcript);
  const hallucinatedNames = uniqueStrings(
    [...analysis.decisions.flatMap((row) => [row.owner ?? ""]), ...analysis.tasks.map((row) => row.assignee ?? "")]
      .map((name) => name.trim())
      .filter((name) => name.length > 0 && !nameAppearsInTranscript(name, namedPeople, corpus, normalizedCorpus)),
  );
  const matchedDecisions = ANALYSIS_QUALITY_MARKERS.decisions.filter((marker) => {
    const normalizedMarker = normalizeAnalysisMarkerText(marker);
    return analysis.decisions.some((row) => normalizeAnalysisMarkerText(row.text).includes(normalizedMarker)) &&
      transcriptSegmentsContainMarker(transcript.segments, marker);
  }).length;
  const matchedTasks = ANALYSIS_QUALITY_MARKERS.tasks.filter((marker) => {
    const normalizedMarker = normalizeAnalysisMarkerText(marker);
    return analysis.tasks.some((row) => normalizeAnalysisMarkerText(row.text).includes(normalizedMarker)) &&
      transcriptSegmentsContainMarker(transcript.segments, marker);
  }).length;
  const matchedAssignees = ANALYSIS_QUALITY_MARKERS.assignees.filter((name) =>
    analysis.tasks.some((row) => (row.assignee ?? "").includes(name)),
  ).length;
  const matchedDates = ANALYSIS_QUALITY_MARKERS.dates.filter((date) =>
    analysis.tasks.some((row) => (row.dueDate ?? row.text).includes(date) || (row.dueDate ?? "").includes("2026-09")),
  ).length;
  const normalizedSummary = normalizeAnalysisMarkerText(analysis.summary);
  const summaryMentionsMeeting = SUMMARY_MEETING_MARKERS.some((marker) =>
    normalizedSummary.includes(normalizeAnalysisMarkerText(marker)),
  );
  const placeholder = isPlaceholderAnalysis(analysis);
  const reasons: string[] = [];
  if (placeholder) {
    reasons.push("Analysis repeats generic placeholder wording instead of the meeting transcript.");
  }
  if (!summaryMentionsMeeting) {
    reasons.push("Summary does not mention AI WorkMate, DATA_ROOT, or llama.cpp.");
  }
  if (matchedDecisions < 2) {
    reasons.push(`Only ${matchedDecisions} transcript decisions were recovered.`);
  }
  if (matchedTasks < 2) {
    reasons.push(`Only ${matchedTasks} transcript tasks were recovered.`);
  }
  if (hallucinatedNames.length > 0) {
    reasons.push(`Invented assignee/owner names: ${hallucinatedNames.join(", ")}.`);
  }
  const acceptable = !placeholder &&
    summaryMentionsMeeting &&
    matchedDecisions >= 2 &&
    matchedTasks >= 2 &&
    hallucinatedNames.length === 0;
  return {
    acceptable,
    placeholder,
    hallucinatedNames,
    matchedDecisions,
    matchedTasks,
    matchedAssignees,
    matchedDates,
    summaryMentionsMeeting,
    reasons,
  };
}

function collectNamedPeople(transcript: TranscriptDocument): string[] {
  return uniqueStrings(transcript.speakers.map((speaker) => speaker.displayName).filter((name): name is string => typeof name === "string" && name.length > 0));
}

function nameAppearsInTranscript(name: string, namedPeople: string[], corpus: string, normalizedCorpus: string): boolean {
  if (namedPeople.some((person) => person === name || person.includes(name) || name.includes(person.split(" ")[0] ?? ""))) {
    return true;
  }
  return corpus.includes(name) || normalizedCorpus.includes(normalizeAnalysisMarkerText(name));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
