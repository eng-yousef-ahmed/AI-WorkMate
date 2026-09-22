import type { AnalysisDocument, TranscriptDocument } from "../domain/models";

const PLACEHOLDER_PATTERNS = [
  /local analysis artifacts/i,
  /validated local summary/i,
  /review the analysis artifacts/i,
  /ship the local pipeline/i,
  /^ok$/i,
];

/**
 * Generic per-row grounding contract (replaces the old fixture-marker slots).
 *
 * The old gate counted how many of SIX hard-coded English fixture phrases
 * ("local only", "meeting files", "Windows verification", ...) appeared in
 * the analysis AND the transcript, and required at least two decision slots
 * and two task slots plus one summary phrase. That contract is satisfiable
 * only by the scripted English fixture: on ANY real meeting - and on every
 * non-English transcript, where the old ASCII-only normalizer reduced the
 * text to spaces - matchedDecisions and matchedTasks score 0, the summary
 * check fails, and the gate rejects faithful Qwen output. The rejection
 * reason then names the fixture vocabulary, trips the IPC sanitizer's
 * filesystem-leak guard, and surfaces as the sanitized `meetings:process`
 * fallback (real Windows E2E: transcriptions COMPLETE, analysis never does).
 *
 * The new gate checks PRECISION instead of fixture recall: EVERY decision
 * row, EVERY task row, and the summary must ground in the transcript via the
 * same bounded-gap ordered-word run mechanic the transcript side always used
 * (STT interloper tolerance: at most ANALYSIS_GROUNDED_MAX_GAP_WORDS
 * non-row words between consecutive row words, all within ONE transcript
 * segment; the row side stays contiguous because model output is not
 * STT-corrupted). Thresholds are not weakened: the old gate accepted output
 * when 2-of-3 fixture slots matched and ignored every other row; the new
 * gate rejects when ANY row is ungrounded, which is strictly stronger for
 * real content. Faithful extraction of any meeting in any language passes;
 * invented rows still fail.
 */
export const ANALYSIS_GROUNDED_ROW_MIN_RUN_WORDS = 4;
export const ANALYSIS_GROUNDED_SUMMARY_MIN_RUN_WORDS = 3;

/**
 * Maximum non-row words allowed between consecutive row words inside a
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
  summaryGrounded: boolean;
  reasons: string[];
}

/**
 * Normalize text for spoken-transcript grounding: lowercase, map
 * underscores/hyphens/dots/slashes and any other punctuation to word spaces,
 * and collapse whitespace. Unicode-aware (letters/numbers in ANY script are
 * word characters), so Arabic and other non-Latin transcripts ground exactly
 * like English; the old ASCII-only class reduced non-English text to spaces
 * and made every real Arabic meeting unscoreable. Applied symmetrically to
 * the transcript corpus, the analysis text, and name grounding.
 */
export function normalizeAnalysisMarkerText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
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
 * Transcript-side grounding: the marker's words must appear IN ORDER within
 * ONE transcript segment, with at most ANALYSIS_MARKER_TRANSCRIPT_MAX_GAP
 * non-marker words between consecutive marker words. Real STT inserts
 * interloper words ("windows relay verification"), which is faithful
 * recognition of the concept; scattered, reversed, cross-segment, or
 * partial-word matches still fail. The analysis side keeps contiguous runs
 * (Qwen output is not STT-corrupted).
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

/**
 * Generic row grounding: a run of `minRunWords` CONTIGUOUS row words must
 * appear in order within ONE transcript segment (bounded-gap on the
 * transcript side). Rows shorter than the run length must match in full.
 * Rejects scattered-word salads (ordered single-segment runs only) while
 * accepting faithful paraphrase that preserves the transcript's wording -
 * in any language, with no fixture vocabulary. Short rows (< minRunWords)
 * are the strictest case: every word must ground, so "Do it" cannot match
 * a segment that only says "do".
 */
export function analysisRowGroundedInTranscript(
  rowText: string,
  segments: TranscriptDocument["segments"],
  minRunWords: number,
): boolean {
  const rowWords = normalizedWords(rowText);
  if (rowWords.length === 0) {
    return false;
  }
  if (rowWords.length < minRunWords) {
    return segments.some((segment) => orderedWordsMatchFrom(normalizedWords(segment.text), rowWords, 0, -1, ANALYSIS_MARKER_TRANSCRIPT_MAX_GAP));
  }
  for (let start = 0; start + minRunWords <= rowWords.length; start += 1) {
    const run = rowWords.slice(start, start + minRunWords);
    const runText = run.join(" ");
    if (transcriptSegmentsContainMarker(segments, runText)) {
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
  const ungroundedDecisions = analysis.decisions.filter(
    (row) => !analysisRowGroundedInTranscript(row.text, transcript.segments, ANALYSIS_GROUNDED_ROW_MIN_RUN_WORDS),
  );
  const ungroundedTasks = analysis.tasks.filter(
    (row) => !analysisRowGroundedInTranscript(row.text, transcript.segments, ANALYSIS_GROUNDED_ROW_MIN_RUN_WORDS),
  );
  const matchedDecisions = analysis.decisions.length - ungroundedDecisions.length;
  const matchedTasks = analysis.tasks.length - ungroundedTasks.length;
  const matchedAssignees = uniqueStrings(
    [...analysis.decisions.map((row) => row.owner ?? ""), ...analysis.tasks.map((row) => row.assignee ?? "")]
      .map((name) => name.trim())
      .filter((name) => name.length > 0 && nameAppearsInTranscript(name, namedPeople, corpus, normalizedCorpus)),
  ).length;
  const matchedDates = analysis.tasks.filter((row) => {
    const dueDate = (row.dueDate ?? "").trim();
    return dueDate.length > 0 && normalizedCorpus.includes(normalizeAnalysisMarkerText(dueDate));
  }).length;
  const summaryGrounded = analysisRowGroundedInTranscript(
    analysis.summary,
    transcript.segments,
    ANALYSIS_GROUNDED_SUMMARY_MIN_RUN_WORDS,
  );
  const placeholder = isPlaceholderAnalysis(analysis);
  const reasons: string[] = [];
  if (placeholder) {
    reasons.push("Analysis repeats generic placeholder wording instead of the meeting transcript.");
  }
  // Reasons stay content-derived (row text echoed back) and NEVER name host
  // paths, storage roots, or fixture vocabulary: these strings travel through
  // the IPC sanitizer, and any path-shaped token degrades them into the
  // sanitized `meetings:process` fallback on the renderer.
  if (!summaryGrounded) {
    reasons.push("Summary is not grounded in the meeting transcript.");
  }
  for (const row of ungroundedDecisions) {
    reasons.push(`Decision is not grounded in the meeting transcript: "${truncateRowText(row.text)}".`);
  }
  for (const row of ungroundedTasks) {
    reasons.push(`Task is not grounded in the meeting transcript: "${truncateRowText(row.text)}".`);
  }
  if (hallucinatedNames.length > 0) {
    reasons.push(`Invented assignee/owner names: ${hallucinatedNames.join(", ")}.`);
  }
  const acceptable = !placeholder &&
    summaryGrounded &&
    ungroundedDecisions.length === 0 &&
    ungroundedTasks.length === 0 &&
    hallucinatedNames.length === 0;
  return {
    acceptable,
    placeholder,
    hallucinatedNames,
    matchedDecisions,
    matchedTasks,
    matchedAssignees,
    matchedDates,
    summaryGrounded,
    reasons,
  };
}

function truncateRowText(text: string): string {
  const condensed = text.replace(/\s+/g, " ").trim();
  return condensed.length > 80 ? `${condensed.slice(0, 77)}...` : condensed;
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
