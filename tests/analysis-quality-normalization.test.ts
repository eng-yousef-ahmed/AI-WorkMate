import test from "node:test";
import assert from "node:assert";

import {
  ANALYSIS_GROUNDED_ROW_MIN_RUN_WORDS,
  ANALYSIS_GROUNDED_SUMMARY_MIN_RUN_WORDS,
  analysisRowGroundedInTranscript,
  evaluateAnalysisQuality,
  isPlaceholderAnalysis,
  normalizeAnalysisMarkerText,
  transcriptSegmentsContainMarker,
} from "../src/ai/AnalysisQuality";
import * as AnalysisQualityModule from "../src/ai/AnalysisQuality";
import { buildAnalysisPrompt } from "../src/ai/LocalLlmProvider";
import { rendererErrorContainsFilesystemLeak } from "../src/desktop/ipc-sanitize";
import { buildUnifiedTranscriptDocument } from "../src/processing/sourceAttribution";
import type { AnalysisDocument, TranscriptDocument } from "../src/domain/models";

/**
 * Generic grounding contract tests for the quality evaluator and the Qwen
 * analysis prompt. The gate checks PRECISION, not fixture recall: every
 * decision row, every task row, and the summary must ground in the transcript
 * via an ordered bounded-gap word run inside ONE segment (row runs are 4+
 * contiguous row words, summary runs 3+; shorter rows must match in full).
 * Normalization is Unicode-aware, so Arabic and other non-Latin transcripts
 * ground exactly like English.
 *
 * Why precision replaced the old 2-of-3 fixture-marker slots: the slots
 * counted six hard-coded English phrases ("local only", "meeting files",
 * ...), so on ANY real meeting - and on every Arabic transcript, where ASCII
 * normalization reduced the text to spaces - faithful model output scored
 * 0/0 and was rejected. The rejection reason then named fixture vocabulary,
 * tripped the IPC sanitizer, and surfaced as the sanitized `meetings:process`
 * fallback (real Windows E2E: transcription COMPLETED, analysis never did).
 * Precision is strictly stronger for real content: the old gate ignored every
 * row beyond the slots, while the new gate rejects when ANY row is
 * ungrounded. Invented rows, invented names, and placeholder text still fail.
 */

function spokenTranscript(texts: string[]): TranscriptDocument {
  return {
    meetingId: "m-1",
    language: "en",
    createdAt: "2026-09-12T10:00:00.000Z",
    speakers: [],
    timestamps: true,
    segments: texts.map((text, index) => ({ segmentId: `s-${index}`, startMs: index * 1_000, endMs: index * 1_000 + 999, text })),
  };
}

const SPOKEN_CORPUS = [
  "Decision one. We keep analysis local only on Windows, and no transcript content goes to a cloud provider.",
  "Decision two. We will not move meeting files to a remote store.",
  "Decision three. Windows verification of the real AI ships before we add a larger instruct model.",
  "Omar will write the install guide under LocalAppData by 12 September 2026.",
  "Nadia will review encryption of transcripts before 12 September 2026.",
  "Samir will add fail closed tests that reject invented tasks by 10 September 2026.",
];

const SPOKEN_ANALYSIS: AnalysisDocument = {
  meetingId: "m-1",
  createdAt: "2026-09-12T11:00:00.000Z",
  summary: "The team kept analysis local only and kept meeting files on the user's machine.",
  decisions: [
    { decisionId: "d1", text: "Keep analysis local only with no cloud provider." },
    { decisionId: "d2", text: "Do not move meeting files to a remote store." },
    { decisionId: "d3", text: "Windows verification ships before adding a larger instruct model." },
  ],
  tasks: [
    { taskId: "t1", text: "Write the install guide", assignee: "Omar", dueDate: "2026-09-12", status: "OPEN" },
    { taskId: "t2", text: "Review encryption of transcripts", assignee: "Nadia", dueDate: "2026-09-12", status: "OPEN" },
    { taskId: "t3", text: "Add fail closed tests that reject invented tasks", assignee: "Samir", dueDate: "2026-09-10", status: "OPEN" },
  ],
  risks: [],
  questions: [],
  followups: [],
};

test("normalizeAnalysisMarkerText maps identifier punctuation to spoken word forms", () => {
  assert.equal(normalizeAnalysisMarkerText("LOCAL_ONLY"), "local only");
  assert.equal(normalizeAnalysisMarkerText("DATA_ROOT"), "data root");
  assert.equal(normalizeAnalysisMarkerText("llama.cpp install"), "llama cpp install");
  assert.equal(normalizeAnalysisMarkerText("Windows real-AI verification"), "windows real ai verification");
  assert.equal(normalizeAnalysisMarkerText("fail-closed tests"), "fail closed tests");
  assert.equal(normalizeAnalysisMarkerText("Windows Verification"), "windows verification");
  assert.equal(normalizeAnalysisMarkerText("  Mixed   Punctuation,,Case//Extra  "), "mixed punctuation case extra");
});

test("normalizeAnalysisMarkerText keeps non-Latin scripts as words instead of spaces", () => {
  // Diacritics (tashkeel) strip to the bare word forms on BOTH sides, so
  // vocalized and unvocalized Arabic ground identically.
  assert.equal(normalizeAnalysisMarkerText("نبقي التحليل محلياً فقط!"), "نبقي التحليل محليا فقط");
  assert.equal(normalizeAnalysisMarkerText("القرار الأول: التثبيت"), "القرار الأول التثبيت");
  assert.equal(normalizeAnalysisMarkerText("  دليل،،التثبيت//عمر  "), "دليل التثبيت عمر");
});

test("grounded decision rows match the spoken transcript wording", () => {
  const transcript = spokenTranscript(["Windows verification of the real AI ships first."]);
  const analysis: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d3", text: "Windows verification of the release ships first." }],
    tasks: [],
  };
  const quality = evaluateAnalysisQuality(analysis, transcript);
  assert.equal(quality.matchedDecisions, 1);
});

test("grounded task rows match the spoken transcript wording", () => {
  const transcript = spokenTranscript(["We will not move meeting files to a remote store."]);
  const analysis: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [],
    tasks: [{ taskId: "t1", text: "Do not move meeting files to a remote store.", status: "OPEN" }],
  };
  const quality = evaluateAnalysisQuality(analysis, transcript);
  assert.equal(quality.matchedTasks, 1);
});

test("hyphenated markers still ground against their spoken forms (fail-closed tests)", () => {
  const transcript = spokenTranscript(["Samir will add fail closed tests that reject invented tasks."]);
  const analysis: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [],
    tasks: [{ taskId: "t3", text: "Add fail-closed tests", assignee: "Samir", status: "OPEN" }],
  };
  const quality = evaluateAnalysisQuality(analysis, transcript);
  assert.equal(quality.matchedTasks >= 1, true);
});

test("written identifier forms still ground after normalization (identity for typed corpora)", () => {
  const typedAnalysis: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    summary: "We keep analysis local only and ship Windows verification first.",
    decisions: [
      { decisionId: "d1", text: "Keep analysis LOCAL_ONLY on this machine." },
      { decisionId: "d2", text: "We will not move meeting files to a remote store." },
      { decisionId: "d3", text: "Windows verification ships first." },
    ],
    tasks: [
      { taskId: "t1", text: "Document the install guide", status: "OPEN" },
      { taskId: "t2", text: "Review the encryption of transcripts", status: "OPEN" },
      { taskId: "t3", text: "Add the fail-closed tests", status: "OPEN" },
    ],
  };
  const quality = evaluateAnalysisQuality(typedAnalysis, spokenTranscript([
    "We keep analysis LOCAL_ONLY.",
    "We will not move meeting files to a remote store.",
    "Windows verification ships first. Document the install guide, review the encryption of transcripts, and add the fail-closed tests.",
  ]));
  assert.equal(quality.matchedDecisions, 3);
  assert.equal(quality.matchedTasks, 3);
  assert.equal(quality.summaryGrounded, true);
  assert.equal(quality.acceptable, true);
});

test("a fully spoken-form meeting passes with precision checks intact", () => {
  const quality = evaluateAnalysisQuality(SPOKEN_ANALYSIS, spokenTranscript(SPOKEN_CORPUS));
  assert.equal(quality.matchedDecisions, 3);
  assert.equal(quality.matchedTasks, 3);
  assert.equal(quality.summaryGrounded, true);
  assert.equal(quality.hallucinatedNames.length, 0);
  assert.equal(quality.acceptable, true);
});

test("precision over fixed recall: one grounded decision passes, one invented decision fails", () => {
  const grounded: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d1", text: "Keep analysis local only with no cloud provider." }],
  };
  const passing = evaluateAnalysisQuality(grounded, spokenTranscript(SPOKEN_CORPUS));
  assert.equal(passing.matchedDecisions, 1);
  assert.equal(passing.acceptable, true);
  const invented: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d1", text: "Approve the quarterly marketing budget for Dubai." }],
  };
  const failing = evaluateAnalysisQuality(invented, spokenTranscript(SPOKEN_CORPUS));
  assert.equal(failing.matchedDecisions, 0);
  assert.equal(failing.acceptable, false);
  assert.equal(failing.reasons.some((reason) => reason.includes("Decision is not grounded in the meeting transcript")), true);
});

test("precision over fixed recall: one grounded task passes, one invented task fails", () => {
  const grounded: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    tasks: [{ taskId: "t1", text: "Write the install guide", assignee: "Omar", status: "OPEN" }],
  };
  const passing = evaluateAnalysisQuality(grounded, spokenTranscript(SPOKEN_CORPUS));
  assert.equal(passing.matchedTasks, 1);
  assert.equal(passing.acceptable, true);
  const invented: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    tasks: [{ taskId: "t1", text: "Hire five external contractors next month", assignee: "Omar", status: "OPEN" }],
  };
  const failing = evaluateAnalysisQuality(invented, spokenTranscript(SPOKEN_CORPUS));
  assert.equal(failing.matchedTasks, 0);
  assert.equal(failing.acceptable, false);
  assert.equal(failing.reasons.some((reason) => reason.includes("Task is not grounded in the meeting transcript")), true);
});

test("rows must still be grounded in the transcript: analysis-only claims do not count", () => {
  const ungroundedCorpus = spokenTranscript(["The team discussed the weather and nothing else today."]);
  const quality = evaluateAnalysisQuality(SPOKEN_ANALYSIS, ungroundedCorpus);
  assert.equal(quality.matchedDecisions, 0);
  assert.equal(quality.matchedTasks, 0);
  assert.equal(quality.acceptable, false);
});

test("invented names remain rejected, including \"Speaker\" as a prompt-style label", () => {
  const invented: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    tasks: [
      { taskId: "t1", text: "Write the install guide", assignee: "Speaker", status: "OPEN" },
      { taskId: "t2", text: "Review encryption of transcripts", assignee: "John", status: "OPEN" },
    ],
  };
  const quality = evaluateAnalysisQuality(invented, spokenTranscript(SPOKEN_CORPUS));
  assert.equal(quality.hallucinatedNames.includes("Speaker"), true);
  assert.equal(quality.hallucinatedNames.includes("John"), true);
  assert.equal(quality.acceptable, false);
});

test("\"Speaker\" stays rejected even when the corpus contains source tags", () => {
  const withTags = spokenTranscript(["[Microphone]", "[System Audio]", ...SPOKEN_CORPUS]);
  const invented: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    tasks: [{ taskId: "t1", text: "Write the install guide", assignee: "Speaker", status: "OPEN" }],
  };
  const quality = evaluateAnalysisQuality(invented, withTags);
  assert.equal(quality.hallucinatedNames.includes("Speaker"), true);
});

test("spoken names ground case-insensitively without ungrounding rules changing", () => {
  const transcript = spokenTranscript([
    "omar will write the install guide",
    "nadia will review encryption of transcripts",
    "samir will add fail closed tests",
  ]);
  const quality = evaluateAnalysisQuality(SPOKEN_ANALYSIS, transcript);
  assert.equal(quality.hallucinatedNames.length, 0);
});

test("placeholder checks are unchanged", () => {
  const placeholder: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    summary: "Local analysis artifacts",
    decisions: [{ decisionId: "d1", text: "Review the local analysis artifacts" }],
    tasks: [{ taskId: "t1", text: "Review the local analysis artifacts", status: "OPEN" }],
  };
  assert.equal(isPlaceholderAnalysis(placeholder), true);
  assert.equal(evaluateAnalysisQuality(placeholder, spokenTranscript(SPOKEN_CORPUS)).acceptable, false);
});

test("analysis prompt renders speaker-less segments as bare lines with no \"Speaker:\" prefix", () => {
  const transcript = spokenTranscript(SPOKEN_CORPUS);
  const prompt = buildAnalysisPrompt(transcript, "2026-09-12T11:00:00.000Z");
  assert.equal(prompt.includes("Speaker:"), false);
  assert.equal(prompt.includes(SPOKEN_CORPUS[0] ?? ""), true);
});

test("analysis prompt keeps real speaker labels when speakers exist", () => {
  const transcript: TranscriptDocument = {
    ...spokenTranscript(["I finished wiring the local analysis pipeline on Windows."]),
    speakers: [{ speakerId: "omar", displayName: "Omar Farouk" }],
    segments: [{ segmentId: "s1", startMs: 0, endMs: 1_000, text: "I finished wiring the local analysis pipeline on Windows.", speakerId: "omar" }],
  };
  const prompt = buildAnalysisPrompt(transcript, "2026-09-12T11:00:00.000Z");
  assert.equal(prompt.includes("Omar Farouk: I finished wiring the local analysis pipeline on Windows."), true);
});

test("analysis prompt explains unlabeled lines, source tags, and omit-when-unstated owners", () => {
  const prompt = buildAnalysisPrompt(spokenTranscript(SPOKEN_CORPUS), "2026-09-12T11:00:00.000Z");
  assert.match(prompt, /no speaker label/i);
  assert.match(prompt, /\[Microphone\] or \[System Audio\] as a person/);
  assert.match(prompt, /omit the owner\/assignee field/);
});

test("unified transcript keeps source tags as plain text segments, not speakers", () => {
  const mic = spokenTranscript(["mic line one"]);
  const sys = spokenTranscript(["sys line one"]);
  const unified = buildUnifiedTranscriptDocument("m-1", mic, sys);
  assert.equal(unified.speakers.length, 0);
  assert.equal(unified.segments.some((s) => s.text === "[Microphone]"), true);
  assert.equal(unified.segments.some((s) => s.text === "[System Audio]"), true);
  const prompt = buildAnalysisPrompt(unified, "2026-09-12T11:00:00.000Z");
  assert.equal(prompt.includes("Speaker:"), false);
  assert.equal(prompt.includes("[Microphone]"), true);
});

test("grounding run lengths are the proven contract: 4-word rows, 3-word summaries", () => {
  assert.equal(ANALYSIS_GROUNDED_ROW_MIN_RUN_WORDS, 4);
  assert.equal(ANALYSIS_GROUNDED_SUMMARY_MIN_RUN_WORDS, 3);
});

test("the quality gate exports no fixture vocabulary to couple against", () => {
  const moduleRecord = AnalysisQualityModule as unknown as Record<string, unknown>;
  assert.equal("ANALYSIS_QUALITY_MARKERS" in moduleRecord, false);
  assert.equal("ANALYSIS_QUALITY_DECISION_ANCHOR_ALTERNATES" in moduleRecord, false);
});

// ---------------------------------------------------------------------------
// Transcript-side bounded-gap ordered-word matching (STT interloper tolerance)
// ---------------------------------------------------------------------------

test("transcript-side matching: exact contiguous marker phrases match", () => {
  assert.equal(
    transcriptSegmentsContainMarker(spokenTranscript(["Ship Windows verification of the real AI first."]).segments, "Windows verification"),
    true,
  );
});

test("transcript-side matching: one interloper word between marker words still matches", () => {
  assert.equal(
    transcriptSegmentsContainMarker(spokenTranscript(["Windows relay verification ships first."]).segments, "Windows verification"),
    true,
  );
});

test("transcript-side matching: two interloper words between marker words still match", () => {
  assert.equal(
    transcriptSegmentsContainMarker(spokenTranscript(["Windows real AI verification ships first."]).segments, "Windows verification"),
    true,
  );
  assert.equal(
    transcriptSegmentsContainMarker(spokenTranscript(["He will fail very slowly closed tests today."]).segments, "fail-closed tests"),
    true,
  );
});

test("transcript-side matching: three interloper words fail", () => {
  assert.equal(
    transcriptSegmentsContainMarker(spokenTranscript(["Windows one two three verification ships first."]).segments, "Windows verification"),
    false,
  );
});

test("transcript-side matching: reversed order fails", () => {
  assert.equal(
    transcriptSegmentsContainMarker(spokenTranscript(["Verification relay windows ships first."]).segments, "Windows verification"),
    false,
  );
});

test("transcript-side matching: missing marker word fails", () => {
  assert.equal(
    transcriptSegmentsContainMarker(spokenTranscript(["Windows ships first."]).segments, "Windows verification"),
    false,
  );
  assert.equal(
    transcriptSegmentsContainMarker(spokenTranscript(["Meeting never leave the data route."]).segments, "meeting files"),
    false,
  );
});

test("transcript-side matching: words split across segments fail", () => {
  assert.equal(
    transcriptSegmentsContainMarker(spokenTranscript(["We ship Windows today.", "Verification ships first."]).segments, "Windows verification"),
    false,
  );
});

test("end-to-end: interloper-bearing transcript still grounds faithful rows and passes precision checks", () => {
  const transcript = spokenTranscript([
    "Decision one. We keep analysis local only on Windows.",
    "Decision three. Windows relay verification ships before we add a larger instruct model.",
    "Omar will write the install guide under LocalAppData by 12 September 2026.",
    "Nadia will review encryption of transcripts before 12 September 2026.",
    "Samir will add fail closed tests that reject invented tasks by 10 September 2026.",
  ]);
  const analysis: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [
      { decisionId: "d1", text: "Keep analysis local only with no cloud provider." },
      { decisionId: "d3", text: "Ship Windows verification before adding a larger instruct model." },
    ],
  };
  const quality = evaluateAnalysisQuality(analysis, transcript);
  assert.equal(quality.matchedDecisions, 2);
  assert.equal(quality.matchedTasks, 3);
  assert.equal(quality.summaryGrounded, true);
  assert.equal(quality.hallucinatedNames.length, 0);
  assert.equal(quality.acceptable, true);
});

test("analysis-side matching stays contiguous: interloper words inside analysis rows do not count", () => {
  const transcript = spokenTranscript(["Ship Windows verification today."]);
  const interloperRow: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d3", text: "Ship windows relay verification today." }],
    tasks: [],
  };
  const cleanRow: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d3", text: "Ship Windows verification today." }],
    tasks: [],
  };
  assert.equal(evaluateAnalysisQuality(interloperRow, transcript).matchedDecisions, 0);
  assert.equal(evaluateAnalysisQuality(cleanRow, transcript).matchedDecisions, 1);
});

test("bounded-gap transcript matching does not leak into name grounding", () => {
  const transcript = spokenTranscript(["o m a r will write the install guide"]);
  const quality = evaluateAnalysisQuality(SPOKEN_ANALYSIS, transcript);
  assert.equal(quality.hallucinatedNames.includes("Omar"), true);
  assert.equal(quality.acceptable, false);
});

// ---------------------------------------------------------------------------
// Generic row-run mechanics: short rows, scattered words, and reason hygiene.
// ---------------------------------------------------------------------------

test("short rows ground when fully present in one segment", () => {
  const segments = spokenTranscript(["Omar will write the install guide soon."]).segments;
  assert.equal(analysisRowGroundedInTranscript("Write the install guide", segments, ANALYSIS_GROUNDED_ROW_MIN_RUN_WORDS), true);
  assert.equal(analysisRowGroundedInTranscript("install guide", segments, ANALYSIS_GROUNDED_ROW_MIN_RUN_WORDS), true);
});

test("short rows fail on partial matches: every word must ground", () => {
  const segments = spokenTranscript(["Omar will write the install guide soon."]).segments;
  assert.equal(analysisRowGroundedInTranscript("Write the quarterly budget", segments, ANALYSIS_GROUNDED_ROW_MIN_RUN_WORDS), false);
  assert.equal(analysisRowGroundedInTranscript("install moon", segments, ANALYSIS_GROUNDED_ROW_MIN_RUN_WORDS), false);
});

test("scattered row words across segments do not ground: runs stay single-segment", () => {
  const segments = spokenTranscript(["We ship the install package today.", "The user guide draft is ready."]).segments;
  assert.equal(
    analysisRowGroundedInTranscript("Ship the install user guide draft", segments, ANALYSIS_GROUNDED_ROW_MIN_RUN_WORDS),
    false,
  );
});

test("quality reasons never trip the IPC filesystem-leak guard", () => {
  const failing: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    summary: "The team had a productive planning discussion about next steps.",
    decisions: [{ decisionId: "d1", text: "Approve the quarterly marketing budget for Dubai." }],
    tasks: [{ taskId: "t1", text: "Hire five external contractors next month", assignee: "John", status: "OPEN" }],
  };
  const quality = evaluateAnalysisQuality(failing, spokenTranscript(SPOKEN_CORPUS));
  assert.equal(quality.acceptable, false);
  assert.equal(quality.reasons.length > 0, true);
  for (const reason of quality.reasons) {
    assert.equal(rendererErrorContainsFilesystemLeak(reason), false);
  }
});

// ---------------------------------------------------------------------------
// Qwen 7B production replay regression (Phase 9 Windows verification failure:
// Decisions 1-3 merged into one decision; owner "Omar, Nadia, Samir" emitted
// as one combined string). Grounding mechanics are unchanged.
// ---------------------------------------------------------------------------

test("analysis prompt requires separate decision objects and single-person owners", () => {
  const prompt = buildAnalysisPrompt(spokenTranscript(SPOKEN_CORPUS), "2026-09-12T11:00:00.000Z");
  assert.match(prompt, /every numbered decision .* separate decision object/i);
  assert.match(prompt, /never merge multiple decisions into one decision/i);
  assert.match(prompt, /at most one person/i);
  assert.match(prompt, /if no single owner is clearly stated, omit the owner\/assignee field/i);
  assert.match(prompt, /preserve important decision and task wording/i);
});

test("Qwen 7B replay shape: three separate decisions and three single-owner tasks pass", () => {
  assert.equal(SPOKEN_ANALYSIS.decisions.length, 3);
  assert.equal(SPOKEN_ANALYSIS.tasks.length, 3);
  const quality = evaluateAnalysisQuality(SPOKEN_ANALYSIS, spokenTranscript(SPOKEN_CORPUS));
  assert.equal(quality.matchedDecisions, 3);
  assert.equal(quality.matchedTasks, 3);
  assert.equal(quality.matchedAssignees, 3);
  assert.equal(quality.hallucinatedNames.length, 0);
  assert.equal(quality.acceptable, true);
});

test("Qwen 7B replay shape: one grounded decision passes; invented wording still fails", () => {
  const single: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d1", text: "Keep analysis local only with no cloud provider." }],
  };
  const passing = evaluateAnalysisQuality(single, spokenTranscript(SPOKEN_CORPUS));
  assert.equal(passing.matchedDecisions, 1);
  assert.equal(passing.acceptable, true);
  const invented: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d1", text: "Approve the quarterly marketing budget for Dubai." }],
  };
  const failing = evaluateAnalysisQuality(invented, spokenTranscript(SPOKEN_CORPUS));
  assert.equal(failing.matchedDecisions, 0);
  assert.equal(failing.acceptable, false);
  assert.equal(failing.reasons.some((reason) => reason.includes("Decision is not grounded in the meeting transcript")), true);
});

test("Qwen 7B replay shape: combined owner string is not three valid owners", () => {
  const transcript = spokenTranscript(SPOKEN_CORPUS);
  const combined: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: SPOKEN_ANALYSIS.decisions.map((row) => ({ ...row, owner: "Omar, Nadia, Samir" })),
    tasks: [
      { taskId: "t1", text: "Write the install guide", assignee: "Omar, Nadia, Samir", dueDate: "2026-09-12", status: "OPEN" },
      ...SPOKEN_ANALYSIS.tasks.slice(1),
    ],
  };
  const quality = evaluateAnalysisQuality(combined, transcript);
  assert.equal(quality.hallucinatedNames.includes("Omar, Nadia, Samir"), true);
  assert.equal(quality.acceptable, false);
  const singleOwner = evaluateAnalysisQuality(SPOKEN_ANALYSIS, transcript);
  assert.equal(singleOwner.matchedAssignees, 3);
  assert.equal(singleOwner.hallucinatedNames.length, 0);
  assert.equal(singleOwner.acceptable, true);
});

// ---------------------------------------------------------------------------
// Latest real Windows Phase 9 failure: Qwen 7B still merged the numbered
// decisions (old recall wording: "Only 1 transcript decisions were
// recovered.") and emitted "N/A" as an owner/assignee (old wording:
// "Invented assignee/owner names: N/A."). Prompt-only strengthening for the
// numbered-decision and N/A-owner rules; the N/A owner fix stays in force.
// ---------------------------------------------------------------------------

const NUMBERED_CORPUS = [
  "Decision 1. We keep analysis local only on Windows, and no transcript content goes to a cloud provider.",
  "Decision 2. We will not move meeting files to a remote store.",
  "Decision 3. Windows verification of the real AI ships before we add a larger instruct model.",
  "Omar will write the install guide under LocalAppData by 12 September 2026.",
  "Nadia will review encryption of transcripts before 12 September 2026.",
  "Samir will add fail closed tests that reject invented tasks by 10 September 2026.",
];

test("analysis prompt requires one decisions[] object per numbered decision and bans placeholder owners", () => {
  const prompt = buildAnalysisPrompt(spokenTranscript(NUMBERED_CORPUS), "2026-09-12T11:00:00.000Z");
  assert.match(prompt, /one separate decisions\[\] object for EACH numbered decision/i);
  assert.match(prompt, /never combine two numbered decisions into one object/i);
  assert.match(prompt, /number of decision objects must match the numbered decisions/i);
  assert.match(prompt, /preserve each numbered decision's important wording/i);
  assert.match(prompt, /owner and assignee are optional/i);
  assert.match(prompt, /NEVER output "N\/A", "NA", "n\/a", "unknown", "none", "null", "not specified"/);
  assert.match(prompt, /a comma-separated list of people is invalid for owner\/assignee/i);
  assert.match(prompt, /single assignee only when the transcript clearly assigns that task to one person/i);
});

test("Decision 1/2/3 transcript: three separate decision objects pass", () => {
  const transcript = spokenTranscript(NUMBERED_CORPUS);
  const analysis: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [
      { decisionId: "d1", text: "Decision 1: keep analysis local only with no cloud provider." },
      { decisionId: "d2", text: "Decision 2: do not move meeting files to a remote store." },
      { decisionId: "d3", text: "Decision 3: Windows verification ships before adding a larger instruct model." },
    ],
  };
  assert.equal(analysis.decisions.length, 3);
  const quality = evaluateAnalysisQuality(analysis, transcript);
  assert.equal(quality.matchedDecisions, 3);
  assert.equal(quality.matchedTasks, 3);
  assert.equal(quality.hallucinatedNames.length, 0);
  assert.equal(quality.acceptable, true);
});

test("Decision 1/2/3 transcript: one grounded decision passes; invented wording is not acceptable", () => {
  const transcript = spokenTranscript(NUMBERED_CORPUS);
  const single: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d1", text: "Keep analysis local only with no cloud provider." }],
  };
  assert.equal(single.decisions.length, 1);
  const passing = evaluateAnalysisQuality(single, transcript);
  assert.equal(passing.matchedDecisions, 1);
  assert.equal(passing.acceptable, true);
  const invented: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d1", text: "Approve the quarterly marketing budget for Dubai." }],
  };
  const failing = evaluateAnalysisQuality(invented, transcript);
  assert.equal(failing.matchedDecisions, 0);
  assert.equal(failing.acceptable, false);
  assert.equal(failing.reasons.some((reason) => reason.includes("Decision is not grounded in the meeting transcript")), true);
});

test("placeholder owners are rejected: N/A, unknown, and none cannot be owner or assignee", () => {
  const transcript = spokenTranscript(NUMBERED_CORPUS);
  for (const placeholder of ["N/A", "unknown", "none"]) {
    const analysis: AnalysisDocument = {
      ...SPOKEN_ANALYSIS,
      decisions: SPOKEN_ANALYSIS.decisions.map((row) => ({ ...row, owner: placeholder })),
      tasks: SPOKEN_ANALYSIS.tasks.map((row) => ({ ...row, assignee: placeholder })),
    };
    const quality = evaluateAnalysisQuality(analysis, transcript);
    assert.equal(quality.matchedDecisions, 3);
    assert.equal(quality.matchedTasks, 3);
    assert.equal(quality.hallucinatedNames.includes(placeholder), true);
    assert.equal(quality.acceptable, false);
    assert.equal(quality.reasons.some((reason) => reason.includes("Invented assignee/owner names")), true);
  }
});

test("omitted owner/assignee passes when no single person is clearly assigned", () => {
  const transcript = spokenTranscript(NUMBERED_CORPUS);
  const unassigned: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    tasks: [
      { taskId: "t1", text: "Write the install guide", status: "OPEN" },
      { taskId: "t2", text: "Review encryption of transcripts", status: "OPEN" },
      { taskId: "t3", text: "Add fail closed tests that reject invented tasks", status: "OPEN" },
    ],
  };
  assert.equal(unassigned.decisions.every((row) => row.owner === undefined), true);
  assert.equal(unassigned.tasks.every((row) => row.assignee === undefined), true);
  const quality = evaluateAnalysisQuality(unassigned, transcript);
  assert.equal(quality.matchedDecisions, 3);
  assert.equal(quality.matchedTasks, 3);
  assert.equal(quality.hallucinatedNames.length, 0);
  assert.equal(quality.acceptable, true);
});

// ---------------------------------------------------------------------------
// Latest real Windows Phase 9 failure after the digit-form patch: the actual
// spoken fixture numbers decisions as WORDS ("Decision one", "Decision two",
// "Decision three"). Prompt-only strengthening for word-form numbered
// decisions; the N/A owner fix stays in force.
// ---------------------------------------------------------------------------

const SPOKEN_WORD_CORPUS = [
  "Decision one. We keep analysis local only on Windows, and no transcript content goes to a cloud provider.",
  "Decision two. All meeting data stays in DATA_ROOT on the user's machine, and meeting files never leave the data root.",
  "Decision three. We ship Windows verification of the real AI before we add a larger instruct model.",
  "Omar will write the install guide under LocalAppData by 12 September 2026.",
  "Nadia will review encryption of transcripts before 12 September 2026.",
  "Samir will add fail closed tests that reject invented tasks by 10 September 2026.",
];

const WORD_NUMBERED_ANALYSIS: AnalysisDocument = {
  meetingId: "m-1",
  createdAt: "2026-09-12T11:00:00.000Z",
  summary: "The team kept analysis local only during this AI WorkMate planning call.",
  decisions: [
    { decisionId: "d1", text: "Decision one: keep analysis local only with no cloud provider." },
    { decisionId: "d2", text: "Decision two: meeting files stay in the data root on the machine." },
    { decisionId: "d3", text: "Decision three: ship Windows verification before adding a larger instruct model." },
  ],
  tasks: [
    { taskId: "t1", text: "Write the install guide", assignee: "Omar", status: "OPEN" },
    { taskId: "t2", text: "Review encryption of transcripts", assignee: "Nadia", status: "OPEN" },
    { taskId: "t3", text: "Add fail closed tests that reject invented tasks", assignee: "Samir", status: "OPEN" },
  ],
  risks: [],
  questions: [],
  followups: [],
};

test("analysis prompt handles spoken word-form numbered decisions, not only digits", () => {
  const prompt = buildAnalysisPrompt(spokenTranscript(SPOKEN_WORD_CORPUS), "2026-09-12T11:00:00.000Z");
  assert.match(prompt, /as digits \(Decision 1, Decision 2, Decision 3\)/);
  assert.match(prompt, /as spoken words \(Decision one, Decision two, Decision three\)/);
  assert.match(prompt, /any equivalent numbered-decision wording in the transcript/i);
  assert.match(prompt, /never merge them into one object/i);
});

test("analysis prompt names no fixture phrases and explains the trim notice", () => {
  const prompt = buildAnalysisPrompt(spokenTranscript(SPOKEN_WORD_CORPUS), "2026-09-12T11:00:00.000Z");
  assert.equal(prompt.includes("\"local only\", \"meeting files\", or \"Windows verification\""), false);
  assert.equal(prompt.includes("at least one exact core decision phrase"), false);
  assert.match(prompt, /ends with a bracketed trim notice/i);
  assert.match(prompt, /never guess content beyond it/i);
});

test("word-form Decision one/two/three: three separate decision objects pass", () => {
  const transcript = spokenTranscript(SPOKEN_WORD_CORPUS);
  assert.equal(WORD_NUMBERED_ANALYSIS.decisions.length, 3);
  const quality = evaluateAnalysisQuality(WORD_NUMBERED_ANALYSIS, transcript);
  assert.equal(quality.matchedDecisions, 3);
  assert.equal(quality.matchedTasks, 3);
  assert.equal(quality.summaryGrounded, true);
  assert.equal(quality.hallucinatedNames.length, 0);
  assert.equal(quality.acceptable, true);
});

test("word-form transcript: one grounded decision passes; invented wording still fails", () => {
  const transcript = spokenTranscript(SPOKEN_WORD_CORPUS);
  const single: AnalysisDocument = {
    ...WORD_NUMBERED_ANALYSIS,
    decisions: [{ decisionId: "d1", text: "Keep analysis local only with no cloud provider." }],
  };
  assert.equal(single.decisions.length, 1);
  const passing = evaluateAnalysisQuality(single, transcript);
  assert.equal(passing.matchedDecisions, 1);
  assert.equal(passing.acceptable, true);
  const invented: AnalysisDocument = {
    ...WORD_NUMBERED_ANALYSIS,
    decisions: [{ decisionId: "d1", text: "Approve the quarterly marketing budget for Dubai." }],
  };
  const failing = evaluateAnalysisQuality(invented, transcript);
  assert.equal(failing.matchedDecisions, 0);
  assert.equal(failing.acceptable, false);
  assert.equal(failing.reasons.some((reason) => reason.includes("Decision is not grounded in the meeting transcript")), true);
});

test("grounded summary passes, ungrounded summary fails", () => {
  const transcript = spokenTranscript(SPOKEN_WORD_CORPUS);
  const passing = evaluateAnalysisQuality(WORD_NUMBERED_ANALYSIS, transcript);
  assert.equal(passing.summaryGrounded, true);
  assert.equal(passing.acceptable, true);
  const missingPhrase: AnalysisDocument = {
    ...WORD_NUMBERED_ANALYSIS,
    summary: "The team had a productive planning discussion about next steps.",
  };
  const failing = evaluateAnalysisQuality(missingPhrase, transcript);
  assert.equal(failing.matchedDecisions, 3);
  assert.equal(failing.matchedTasks, 3);
  assert.equal(failing.summaryGrounded, false);
  assert.equal(failing.acceptable, false);
  assert.equal(failing.reasons.some((reason) => reason.includes("Summary is not grounded in the meeting transcript")), true);
});

test("N/A owner remains rejected on the spoken word-form transcript", () => {
  const transcript = spokenTranscript(SPOKEN_WORD_CORPUS);
  const placeholder: AnalysisDocument = {
    ...WORD_NUMBERED_ANALYSIS,
    decisions: WORD_NUMBERED_ANALYSIS.decisions.map((row) => ({ ...row, owner: "N/A" })),
    tasks: WORD_NUMBERED_ANALYSIS.tasks.map((row) => ({ ...row, assignee: "N/A" })),
  };
  const quality = evaluateAnalysisQuality(placeholder, transcript);
  assert.equal(quality.matchedDecisions, 3);
  assert.equal(quality.matchedTasks, 3);
  assert.equal(quality.hallucinatedNames.includes("N/A"), true);
  assert.equal(quality.acceptable, false);
  assert.equal(quality.reasons.some((reason) => reason.includes("Invented assignee/owner names")), true);
});

// ---------------------------------------------------------------------------
// Real Windows meeting-processing replay: the verified system transcript
// states Decision 2 with "data route" and Decision 3 with "Windows relay
// verification", and Qwen faithfully preserves that wording. Generic row-run
// grounding accepts that faithful STT-variant wording with no alternates
// table: verbatim rows ground, invented or ungrounded rows still fail.
// ---------------------------------------------------------------------------

const REPLAY_SYSTEM_TRANSCRIPT = [
  "Decision 1. We keep analysis local only on Windows.",
  "Decision 2. All meeting data stays in data route on the user's machine.",
  "Decision 3. We ship Windows relay verification before we add a larger instruct model.",
  "Omar will write the install guide under LocalAppData by 12 September 2026.",
  "Nadia will review encryption of transcripts before 12 September 2026.",
  "Samir will add fail tests that reject invented tasks by 10 September 2026.",
];

const REPLAY_QWEN_ANALYSIS: AnalysisDocument = {
  meetingId: "m-1",
  createdAt: "2026-09-12T11:00:00.000Z",
  summary: "The team kept analysis local only on Windows for this meeting.",
  decisions: [
    { decisionId: "d1", text: "Keep analysis local only on Windows with no cloud provider." },
    { decisionId: "d2", text: "All meeting data stays in data route on the user's machine." },
    { decisionId: "d3", text: "Ship Windows relay verification before adding a larger instruct model." },
  ],
  tasks: [
    { taskId: "t1", text: "Write the install guide", assignee: "Omar", status: "OPEN" },
    { taskId: "t2", text: "Review encryption of transcripts", assignee: "Nadia", status: "OPEN" },
    { taskId: "t3", text: "Add fail tests that reject invented tasks", assignee: "Samir", status: "OPEN" },
  ],
  risks: [],
  questions: [],
  followups: [],
};

test("replay Decision 2: faithful 'data route' wording grounds without canonical phrases", () => {
  const decisionText = "All meeting data stays in data route on the user's machine.";
  assert.equal(normalizeAnalysisMarkerText(decisionText).includes("meeting files"), false);
  const transcript = spokenTranscript(["Decision 2. All meeting data stays in data route on the user's machine."]);
  const analysis: AnalysisDocument = {
    ...REPLAY_QWEN_ANALYSIS,
    decisions: [{ decisionId: "d2", text: decisionText }],
    tasks: [],
  };
  const quality = evaluateAnalysisQuality(analysis, transcript);
  assert.equal(quality.matchedDecisions, 1);
});

test("replay Decision 3: 'Windows relay verification' grounds the row", () => {
  const decisionText = "Ship Windows relay verification before adding a larger instruct model.";
  assert.equal(normalizeAnalysisMarkerText(decisionText).includes("windows verification"), false);
  const transcript = spokenTranscript(["Decision 3. We ship Windows relay verification before we add a larger instruct model."]);
  const analysis: AnalysisDocument = {
    ...REPLAY_QWEN_ANALYSIS,
    decisions: [{ decisionId: "d3", text: decisionText }],
    tasks: [],
  };
  const quality = evaluateAnalysisQuality(analysis, transcript);
  assert.equal(quality.matchedDecisions, 1);
});

test("full replay shape passes with the exact replay numbers", () => {
  const transcript = spokenTranscript(REPLAY_SYSTEM_TRANSCRIPT);
  assert.equal(REPLAY_QWEN_ANALYSIS.decisions.length, 3);
  assert.equal(REPLAY_QWEN_ANALYSIS.tasks.length, 3);
  const quality = evaluateAnalysisQuality(REPLAY_QWEN_ANALYSIS, transcript);
  assert.equal(quality.matchedDecisions, 3);
  // The STT-dropped word ("fail tests" heard for "fail-closed tests") no
  // longer fails: the row is verbatim in the transcript, so it grounds.
  assert.equal(quality.matchedTasks, 3);
  assert.equal(quality.matchedAssignees, 3);
  assert.deepEqual(quality.hallucinatedNames, []);
  assert.equal(quality.summaryGrounded, true);
  assert.equal(quality.acceptable, true);
  assert.deepEqual(quality.reasons, []);
});

test("faithful wording still requires transcript grounding: ungrounded rows do not match", () => {
  const transcript = spokenTranscript(["The team discussed the weather and nothing else today."]);
  const analysis: AnalysisDocument = {
    ...REPLAY_QWEN_ANALYSIS,
    decisions: [
      { decisionId: "d2", text: "All meeting data stays in data route on the user's machine." },
      { decisionId: "d3", text: "Ship Windows relay verification before adding a larger instruct model." },
    ],
    tasks: [],
  };
  const quality = evaluateAnalysisQuality(analysis, transcript);
  assert.equal(quality.matchedDecisions, 0);
  assert.equal(quality.acceptable, false);
});

test("invented decisions are still rejected on the replay transcript", () => {
  const transcript = spokenTranscript(REPLAY_SYSTEM_TRANSCRIPT);
  const invented: AnalysisDocument = {
    ...REPLAY_QWEN_ANALYSIS,
    decisions: [
      { decisionId: "d1", text: "Approve the quarterly marketing budget for Dubai." },
      { decisionId: "d2", text: "Hire five external contractors next month." },
    ],
  };
  const quality = evaluateAnalysisQuality(invented, transcript);
  assert.equal(quality.matchedDecisions, 0);
  assert.equal(quality.matchedTasks, 3);
  assert.equal(quality.acceptable, false);
  assert.equal(quality.reasons.some((reason) => reason.includes("Decision is not grounded in the meeting transcript")), true);
});

test("replay transcript: a single grounded decision passes the precision contract", () => {
  const transcript = spokenTranscript(REPLAY_SYSTEM_TRANSCRIPT);
  const single: AnalysisDocument = {
    ...REPLAY_QWEN_ANALYSIS,
    decisions: [{ decisionId: "d1", text: "Keep analysis local only on Windows with no cloud provider." }],
  };
  const quality = evaluateAnalysisQuality(single, transcript);
  assert.equal(quality.matchedDecisions, 1);
  assert.equal(quality.acceptable, true);
});

// ---------------------------------------------------------------------------
// Real Arabic meeting regression (Windows E2E failure shape): a faithful
// Arabic extraction must ACCEPT - the old ASCII-only normalizer plus the
// English fixture slots rejected every real Arabic meeting - while invented
// Arabic rows, invented summaries, and invented names still fail.
// ---------------------------------------------------------------------------

function arabicTranscript(texts: string[]): TranscriptDocument {
  return {
    meetingId: "m-1",
    language: "ar",
    createdAt: "2026-09-12T10:00:00.000Z",
    speakers: [],
    timestamps: true,
    segments: texts.map((text, index) => ({ segmentId: `s-${index}`, startMs: index * 1_000, endMs: index * 1_000 + 999, text })),
  };
}

const ARABIC_CORPUS = [
  "القرار الأول. نبقي تحليل الاجتماعات محليا فقط على نظام ويندوز.",
  "القرار الثاني. تبقى ملفات الاجتماعات داخل مخزن البيانات على جهاز المستخدم.",
  "سيكتب عمر دليل التثبيت قبل يوم الجمعة.",
  "ستراجع نادية تشفير النصوص قبل يوم الجمعة.",
];

const ARABIC_ANALYSIS: AnalysisDocument = {
  meetingId: "m-1",
  createdAt: "2026-09-12T11:00:00.000Z",
  summary: "أبقى الفريق تحليل الاجتماعات محليا فقط على نظام ويندوز.",
  decisions: [
    { decisionId: "d1", text: "نبقي تحليل الاجتماعات محليا فقط على نظام ويندوز." },
    { decisionId: "d2", text: "تبقى ملفات الاجتماعات داخل مخزن البيانات." },
  ],
  tasks: [
    { taskId: "t1", text: "سيكتب عمر دليل التثبيت", assignee: "عمر", status: "OPEN" },
    { taskId: "t2", text: "ستراجع نادية تشفير النصوص", assignee: "نادية", status: "OPEN" },
  ],
  risks: [],
  questions: [],
  followups: [],
};

test("Arabic: faithful extraction passes with grounded rows, summary, and names", () => {
  const quality = evaluateAnalysisQuality(ARABIC_ANALYSIS, arabicTranscript(ARABIC_CORPUS));
  assert.equal(quality.matchedDecisions, 2);
  assert.equal(quality.matchedTasks, 2);
  assert.equal(quality.matchedAssignees, 2);
  assert.equal(quality.summaryGrounded, true);
  assert.deepEqual(quality.hallucinatedNames, []);
  assert.equal(quality.acceptable, true);
  assert.deepEqual(quality.reasons, []);
});

test("Arabic: invented decision rows are rejected", () => {
  const invented: AnalysisDocument = {
    ...ARABIC_ANALYSIS,
    decisions: [{ decisionId: "d1", text: "نعتمد الميزانية الجديدة للمشروع." }],
  };
  const quality = evaluateAnalysisQuality(invented, arabicTranscript(ARABIC_CORPUS));
  assert.equal(quality.matchedDecisions, 0);
  assert.equal(quality.acceptable, false);
  assert.equal(quality.reasons.some((reason) => reason.includes("Decision is not grounded in the meeting transcript")), true);
});

test("Arabic: invented task rows are rejected", () => {
  const invented: AnalysisDocument = {
    ...ARABIC_ANALYSIS,
    tasks: [{ taskId: "t1", text: "نوظف خمسة متعاقدين خارجيين الشهر القادم", status: "OPEN" }],
  };
  const quality = evaluateAnalysisQuality(invented, arabicTranscript(ARABIC_CORPUS));
  assert.equal(quality.matchedTasks, 0);
  assert.equal(quality.acceptable, false);
});

test("Arabic: ungrounded summary is rejected", () => {
  const invented: AnalysisDocument = {
    ...ARABIC_ANALYSIS,
    summary: "ناقش الفريق خطط الربع القادم بشكل عام.",
  };
  const quality = evaluateAnalysisQuality(invented, arabicTranscript(ARABIC_CORPUS));
  assert.equal(quality.matchedDecisions, 2);
  assert.equal(quality.matchedTasks, 2);
  assert.equal(quality.summaryGrounded, false);
  assert.equal(quality.acceptable, false);
});

test("Arabic: invented assignee names are rejected", () => {
  const invented: AnalysisDocument = {
    ...ARABIC_ANALYSIS,
    tasks: [{ taskId: "t1", text: "سيكتب عمر دليل التثبيت", assignee: "خالد", status: "OPEN" }],
  };
  const quality = evaluateAnalysisQuality(invented, arabicTranscript(ARABIC_CORPUS));
  assert.equal(quality.hallucinatedNames.includes("خالد"), true);
  assert.equal(quality.acceptable, false);
});

test("Arabic: quality reasons never trip the IPC filesystem-leak guard", () => {
  const invented: AnalysisDocument = {
    ...ARABIC_ANALYSIS,
    summary: "ناقش الفريق خطط الربع القادم بشكل عام.",
    decisions: [{ decisionId: "d1", text: "نعتمد الميزانية الجديدة للمشروع." }],
  };
  const quality = evaluateAnalysisQuality(invented, arabicTranscript(ARABIC_CORPUS));
  assert.equal(quality.acceptable, false);
  assert.equal(quality.reasons.length > 0, true);
  for (const reason of quality.reasons) {
    assert.equal(rendererErrorContainsFilesystemLeak(reason), false);
  }
});
