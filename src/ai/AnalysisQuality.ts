import type { AnalysisDocument, TranscriptDocument } from "../domain/models";

const PLACEHOLDER_PATTERNS = [
  /local analysis artifacts/i,
  /validated local summary/i,
  /review the analysis artifacts/i,
  /ship the local pipeline/i,
  /^ok$/i,
];

export const ANALYSIS_QUALITY_MARKERS = {
  attendees: ["Layla Hassan", "Omar Farouk", "Nadia Rahman", "Samir Haddad"],
  decisions: [
    "LOCAL_ONLY",
    "DATA_ROOT",
    "Windows real-AI verification",
  ],
  tasks: [
    "llama.cpp install",
    "encryption of transcripts",
    "fail-closed tests",
  ],
  assignees: ["Omar", "Nadia", "Samir"],
  dates: ["12 September 2026", "10 September 2026"],
  openItem: "7B",
} as const;

/** Summary must name the meeting using these product/system identifiers (any one). */
const SUMMARY_MEETING_MARKERS = ["AI WorkMate", "DATA_ROOT", "llama.cpp"] as const;

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
      normalizedCorpus.includes(normalizedMarker);
  }).length;
  const matchedTasks = ANALYSIS_QUALITY_MARKERS.tasks.filter((marker) => {
    const normalizedMarker = normalizeAnalysisMarkerText(marker);
    return analysis.tasks.some((row) => normalizeAnalysisMarkerText(row.text).includes(normalizedMarker)) &&
      normalizedCorpus.includes(normalizedMarker);
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
