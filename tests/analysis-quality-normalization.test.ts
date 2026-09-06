import test from "node:test";
import assert from "node:assert";

import {
  ANALYSIS_QUALITY_MARKERS,
  evaluateAnalysisQuality,
  isPlaceholderAnalysis,
  normalizeAnalysisMarkerText,
} from "../src/ai/AnalysisQuality";
import { buildAnalysisPrompt } from "../src/ai/LocalLlmProvider";
import { buildUnifiedTranscriptDocument } from "../src/processing/sourceAttribution";
import type { AnalysisDocument, TranscriptDocument } from "../src/domain/models";

/**
 * Spoken-normalization and speaker-label contract tests for the Phase 9
 * quality evaluator and the Qwen analysis prompt. Real Whisper transcripts
 * render identifier tokens as spoken words ("local only", "data root",
 * "llama CPP"), so marker matching normalizes both sides symmetrically while
 * every threshold and grounding requirement stays unchanged.
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
  "Welcome to the AI WorkMate planning call for local meeting analysis.",
  "Decision one. We keep analysis local only with llama CPP on Windows, and no transcript content goes to a cloud provider.",
  "Decision two. Data root remains on the user's machine, and we do not move meeting files to a remote store.",
  "Omar will document the llama CPP install under LocalAppData by 12 September 2026.",
  "Nadia will review encryption of transcripts before 12 September 2026.",
  "Samir will add fail closed tests that reject invented tasks by 10 September 2026.",
];

const SPOKEN_ANALYSIS: AnalysisDocument = {
  meetingId: "m-1",
  createdAt: "2026-09-12T11:00:00.000Z",
  summary: "AI WorkMate planning kept analysis local only with data root on the machine.",
  decisions: [
    { decisionId: "d1", text: "Keep analysis local only with llama CPP and do not send transcript content to a cloud provider." },
    { decisionId: "d2", text: "Data root remains on the user's machine." },
  ],
  tasks: [
    { taskId: "t1", text: "Document the llama CPP install under LocalAppData", assignee: "Omar", dueDate: "2026-09-12", status: "OPEN" },
    { taskId: "t2", text: "Review encryption of transcripts", assignee: "Nadia", dueDate: "2026-09-12", status: "OPEN" },
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
  assert.equal(normalizeAnalysisMarkerText("  Mixed   Punctuation,,Case//Extra  "), "mixed punctuation case extra");
});

test("LOCAL_ONLY spoken as \"local only\" in transcript and analysis matches the LOCAL_ONLY decision marker", () => {
  const transcript = spokenTranscript(["We keep analysis local only with llama CPP on Windows."]);
  const analysis: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d1", text: "Keep analysis local only on Windows." }],
    tasks: [],
  };
  const quality = evaluateAnalysisQuality(analysis, transcript);
  assert.equal(quality.matchedDecisions >= 1, true);
});

test("DATA_ROOT spoken as \"data root\" in transcript and analysis matches the DATA_ROOT decision marker", () => {
  const transcript = spokenTranscript(["Decision two. Data root remains on the user's machine."]);
  const analysis: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    decisions: [{ decisionId: "d2", text: "Data root remains on the user's machine." }],
    tasks: [],
  };
  const quality = evaluateAnalysisQuality(analysis, transcript);
  assert.equal(quality.matchedDecisions >= 1, true);
});

test("written identifier markers still match after normalization (identity for typed corpora)", () => {
  const typedAnalysis: AnalysisDocument = {
    ...SPOKEN_ANALYSIS,
    tasks: [
      ...SPOKEN_ANALYSIS.tasks,
      { taskId: "t3", text: "Add fail-closed tests that reject invented tasks", assignee: "Samir", dueDate: "2026-09-10", status: "OPEN" },
    ],
  };
  const quality = evaluateAnalysisQuality(typedAnalysis, spokenTranscript([
    "We keep analysis LOCAL_ONLY.",
    "DATA_ROOT remains on the user's machine.",
    "Document the llama.cpp install, the encryption of transcripts, and the fail-closed tests.",
  ]));
  assert.equal(quality.matchedDecisions, 2);
  assert.equal(quality.matchedTasks, 3);
  assert.equal(quality.summaryMentionsMeeting, true);
});

test("a fully spoken-form meeting passes with thresholds intact", () => {
  const quality = evaluateAnalysisQuality(SPOKEN_ANALYSIS, spokenTranscript(SPOKEN_CORPUS));
  assert.equal(quality.matchedDecisions, 2);
  assert.equal(quality.matchedTasks, 2);
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
    tasks: [{ taskId: "t1", text: "Document the llama CPP install", assignee: "Omar", status: "OPEN" }],
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
      { taskId: "t1", text: "Document the llama CPP install under LocalAppData", assignee: "Speaker", status: "OPEN" },
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
    tasks: [{ taskId: "t1", text: "Document the llama CPP install", assignee: "Speaker", status: "OPEN" }],
  };
  const quality = evaluateAnalysisQuality(invented, withTags);
  assert.equal(quality.hallucinatedNames.includes("Speaker"), true);
});

test("spoken names ground case-insensitively without ungrounding rules changing", () => {
  const transcript = spokenTranscript(["omar will document the llama CPP install", "nadia will review encryption of transcripts"]);
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
    ...spokenTranscript(["I finished wiring llama CPP on Windows."]),
    speakers: [{ speakerId: "omar", displayName: "Omar Farouk" }],
    segments: [{ segmentId: "s1", startMs: 0, endMs: 1_000, text: "I finished wiring llama CPP on Windows.", speakerId: "omar" }],
  };
  const prompt = buildAnalysisPrompt(transcript, "2026-09-12T11:00:00.000Z");
  assert.equal(prompt.includes("Omar Farouk: I finished wiring llama CPP on Windows."), true);
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

test("quality marker constants are unchanged", () => {
  assert.deepEqual([...ANALYSIS_QUALITY_MARKERS.decisions], ["LOCAL_ONLY", "DATA_ROOT", "Windows real-AI verification"]);
  assert.deepEqual([...ANALYSIS_QUALITY_MARKERS.tasks], ["llama.cpp install", "encryption of transcripts", "fail-closed tests"]);
  assert.deepEqual([...ANALYSIS_QUALITY_MARKERS.assignees], ["Omar", "Nadia", "Samir"]);
  assert.deepEqual([...ANALYSIS_QUALITY_MARKERS.dates], ["12 September 2026", "10 September 2026"]);
});
