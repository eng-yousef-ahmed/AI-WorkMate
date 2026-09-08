import test from "node:test";
import assert from "node:assert";

import {
  ANALYSIS_QUALITY_MARKERS,
  evaluateAnalysisQuality,
  isPlaceholderAnalysis,
  normalizeAnalysisMarkerText,
  transcriptSegmentsContainMarker,
} from "../src/ai/AnalysisQuality";
import { buildAnalysisPrompt } from "../src/ai/LocalLlmProvider";
import { buildUnifiedTranscriptDocument } from "../src/processing/sourceAttribution";
import type { AnalysisDocument, TranscriptDocument } from "../src/domain/models";

/**
 * Spoken-normalization and speaker-label contract tests for the Phase 9
 * quality evaluator and the Qwen analysis prompt. The marker vocabulary is
 * plain-English phrasing proven to survive real Whisper tiny transcription
 * ("local only", "meeting files", "Windows verification", "encryption of
 * transcripts", "fail-closed tests", "install guide"); identity tokens
 * (AI WorkMate / DATA_ROOT / llama.cpp / real-AI) are spoken in the fixture
 * but are not load-bearing markers because real STT corrupts them.
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

test("the \"Windows verification\" decision marker matches spoken transcript and analysis text", () => {
  const transcript = spokenTranscript(["Windows verification of the real AI ships first."]);
  const analysis: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d3", text: "Ship Windows verification before adding a larger instruct model." }],
    tasks: [],
  };
  const quality = evaluateAnalysisQuality(analysis, transcript);
  assert.equal(quality.matchedDecisions >= 1, true);
});

test("the \"meeting files\" decision marker matches spoken transcript and analysis text", () => {
  const transcript = spokenTranscript(["We will not move meeting files to a remote store."]);
  const analysis: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d2", text: "Meeting files stay on the user's machine." }],
    tasks: [],
  };
  const quality = evaluateAnalysisQuality(analysis, transcript);
  assert.equal(quality.matchedDecisions >= 1, true);
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

test("written identifier markers still match after normalization (identity for typed corpora)", () => {
  const typedAnalysis: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [
      { decisionId: "d1", text: "Keep analysis LOCAL_ONLY with no cloud provider." },
      { decisionId: "d2", text: "We will not move meeting files to a remote store." },
      { decisionId: "d3", text: "Ship Windows verification of the real AI first." },
    ],
    tasks: [
      ...SPOKEN_ANALYSIS.tasks,
      { taskId: "t4", text: "Document the install guide", status: "OPEN" },
    ],
  };
  const quality = evaluateAnalysisQuality(typedAnalysis, spokenTranscript([
    "We keep analysis LOCAL_ONLY.",
    "We will not move meeting files to a remote store.",
    "Windows verification ships first. Document the install guide, the encryption of transcripts, and the fail-closed tests.",
  ]));
  assert.equal(quality.matchedDecisions, 3);
  assert.equal(quality.matchedTasks, 3);
  assert.equal(quality.summaryMentionsMeeting, true);
});

test("a fully spoken-form meeting passes with thresholds intact", () => {
  const quality = evaluateAnalysisQuality(SPOKEN_ANALYSIS, spokenTranscript(SPOKEN_CORPUS));
  assert.equal(quality.matchedDecisions, 3);
  assert.equal(quality.matchedTasks, 3);
  assert.equal(quality.summaryMentionsMeeting, true);
  assert.equal(quality.hallucinatedNames.length, 0);
  assert.equal(quality.acceptable, true);
});

test("thresholds are not weakened: fewer than two matched decisions still rejects", () => {
  const oneDecision: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d1", text: "Keep analysis local only." }],
  };
  const quality = evaluateAnalysisQuality(oneDecision, spokenTranscript(SPOKEN_CORPUS));
  assert.equal(quality.matchedDecisions, 1);
  assert.equal(quality.acceptable, false);
  assert.equal(quality.reasons.some((reason) => reason.includes("Only 1 transcript decisions")), true);
});

test("thresholds are not weakened: fewer than two matched tasks still rejects", () => {
  const oneTask: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    tasks: [{ taskId: "t1", text: "Write the install guide", assignee: "Omar", status: "OPEN" }],
  };
  const quality = evaluateAnalysisQuality(oneTask, spokenTranscript(SPOKEN_CORPUS));
  assert.equal(quality.matchedTasks, 1);
  assert.equal(quality.acceptable, false);
  assert.equal(quality.reasons.some((reason) => reason.includes("Only 1 transcript tasks")), true);
});

test("marker must still be grounded in the transcript: analysis-only claims do not count", () => {
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

test("quality markers use the Whisper-robust scenario vocabulary", () => {
  assert.deepEqual([...ANALYSIS_QUALITY_MARKERS.decisions], ["local only", "meeting files", "Windows verification"]);
  assert.deepEqual([...ANALYSIS_QUALITY_MARKERS.tasks], ["encryption of transcripts", "fail-closed tests", "install guide"]);
  assert.deepEqual([...ANALYSIS_QUALITY_MARKERS.assignees], ["Omar", "Nadia", "Samir"]);
  assert.deepEqual([...ANALYSIS_QUALITY_MARKERS.dates], ["12 September 2026", "10 September 2026"]);
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

test("end-to-end: interloper-bearing transcript still grounds two decisions and passes unchanged thresholds", () => {
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
  assert.equal(quality.summaryMentionsMeeting, true);
  assert.equal(quality.hallucinatedNames.length, 0);
  assert.equal(quality.acceptable, true);
});

test("analysis-side matching stays contiguous: interloper words inside analysis rows do not count", () => {
  const transcript = spokenTranscript(["Ship Windows verification of the real AI first."]);
  const interloperRow: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d3", text: "Ship windows relay verification before adding a larger instruct model." }],
    tasks: [],
  };
  const cleanRow: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d3", text: "Ship Windows verification before adding a larger instruct model." }],
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
// Qwen 7B production replay regression (Phase 9 Windows verification failure:
// Decisions 1-3 merged into one decision; owner "Omar, Nadia, Samir" emitted
// as one combined string). Thresholds and grounding mechanics are unchanged.
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

test("Qwen 7B replay shape: merged decisions that drop wording still fail unchanged thresholds", () => {
  const merged: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d1", text: "Keep analysis local only with no cloud provider." }],
  };
  const quality = evaluateAnalysisQuality(merged, spokenTranscript(SPOKEN_CORPUS));
  assert.equal(quality.matchedDecisions, 1);
  assert.equal(quality.acceptable, false);
  assert.equal(quality.reasons.some((reason) => reason.includes("Only 1 transcript decisions")), true);
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
// decisions ("Only 1 transcript decisions were recovered.") and emitted "N/A"
// as an owner/assignee ("Invented assignee/owner names: N/A."). Prompt-only
// strengthening; quality thresholds and grounding mechanics are unchanged.
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

test("Decision 1/2/3 transcript: merging numbered decisions into one object is not acceptable", () => {
  const transcript = spokenTranscript(NUMBERED_CORPUS);
  const merged: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d1", text: "Keep analysis local only with no cloud provider." }],
  };
  assert.equal(merged.decisions.length, 1);
  const quality = evaluateAnalysisQuality(merged, transcript);
  assert.equal(quality.matchedDecisions, 1);
  assert.equal(quality.acceptable, false);
  assert.equal(quality.reasons.some((reason) => reason.includes("Only 1 transcript decisions")), true);
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
