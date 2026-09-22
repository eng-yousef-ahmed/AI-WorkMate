import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { OpenAIProvider } from "../src/ai/AIProvider";
import { LocalLlmProvider, type LocalLlmHelperProcess, type LocalLlmHelperRunner } from "../src/ai/LocalLlmProvider";
import { LocalLlmError } from "../src/ai/LocalLlmErrors";
import type { AIProcessResult } from "../src/ai/AIProvider";
import type { HubChatAnswer, HubChatEvidenceSource } from "../src/domain/hub";
import type { TranscriptDocument } from "../src/domain/models";
import {
  GROUNDED_CHAT_REFUSAL,
  GroundedMeetingChatService,
  MAX_CHAT_PROMPT_CHARS,
  MAX_EVIDENCE_SOURCES,
  MAX_QUESTION_LENGTH,
  MAX_SNIPPET_CHARS,
  buildGroundedChatPrompt,
  buildSnippetWindow,
  normalizeWhitespace,
  tokenizeTerms,
  verifyGroundedAnswer,
} from "../src/meetings/GroundedMeetingChatService";
import { MeetingHubError } from "../src/meetings/MeetingHubService";
import { StorageError } from "../src/storage/errors";
import type { LocalFirstStore } from "../src/storage/LocalFirstStore";
import { withTempStore } from "./helpers";

function transcript(meetingId: string, segments: Array<{ text: string; speaker?: string }>, createdAt = "2026-09-07T09:00:00.000Z"): TranscriptDocument {
  const speakers = [...new Set(segments.map((segment) => segment.speaker ?? "Ada"))];
  return {
    meetingId,
    speakers: speakers.map((displayName, index) => ({ speakerId: `s${index + 1}`, displayName })),
    timestamps: true,
    language: "en",
    createdAt,
    segments: segments.map((segment, index) => ({
      segmentId: randomUUID(),
      startMs: index * 1000,
      endMs: (index + 1) * 1000,
      speakerId: segment.speaker !== undefined ? `s${speakers.indexOf(segment.speaker) + 1}` : undefined,
      text: segment.text,
    })),
  };
}

async function seedMeeting(store: LocalFirstStore, title: string, segments: Array<{ text: string; speaker?: string }>, options: { meetingDate?: string; createdAt?: string } = {}): Promise<string> {
  const meetingId = randomUUID();
  await store.createMeeting({
    meetingId,
    title,
    meetingDate: options.meetingDate ?? "2026-09-07",
    startedAt: `${options.meetingDate ?? "2026-09-07"}T09:00:00.000Z`,
  });
  await store.saveTranscript(transcript(meetingId, segments, options.createdAt), {});
  return meetingId;
}

/** Local llama runner that answers with a fixed text (optionally from args). */
function scriptedChatRunner(script: (prompt: string) => string): { runner: LocalLlmHelperRunner; prompts: string[] } {
  const prompts: string[] = [];
  const runner: LocalLlmHelperRunner = (args) => {
    const index = args.indexOf("-p");
    const prompt = index >= 0 ? String(args[index + 1] ?? "") : "";
    prompts.push(prompt);
    const output = script(prompt);
    return completed(output, 0);
  };
  return { runner, prompts };
}

function completed(stdout: string, code = 0): LocalLlmHelperProcess {
  return {
    stdout: (async function* () {
      yield Buffer.from(stdout, "utf8");
    })(),
    stderr: (async function* () {})(),
    exited: Promise.resolve({ code, signal: null }),
    kill: () => undefined,
  };
}

function crashingRunner(code = 7): LocalLlmHelperRunner {
  return () => completed("", code);
}

function unkillableRunner(): LocalLlmHelperRunner {
  return () => ({
    stdout: (async function* () {})(),
    stderr: (async function* () {})(),
    exited: new Promise(() => undefined),
    kill: () => undefined,
  });
}

const FOLLOWUP_QUOTE = "the follow-up is to verify the backup restore flow on windows";

function groundedFollowupAnswer(): string {
  return [
    "The follow-up is to verify the backup restore flow on Windows.",
    `[meeting · ${FOLLOWUP_QUOTE}]`,
  ].join("\n");
}

function localProvider(runner: LocalLlmHelperRunner, options: { timeoutMs?: number } = {}): LocalLlmProvider {
  return new LocalLlmProvider({ platform: "linux", helperRunner: runner, timeoutMs: options.timeoutMs });
}

test("grounded chat: answers only from persisted transcripts with verbatim citations and evidence source ids", async () => {
  await withTempStore(async (store) => {
    const firstId = await seedMeeting(store, "Planning sync", [
      { text: "We discussed the encryption roadmap and decided local files stay on this device.", speaker: "Ada" },
      { text: "The follow-up is to verify the backup restore flow on Windows.", speaker: "Bilal" },
    ]);
    await seedMeeting(store, "Status standup", [
      { text: "Everyone confirmed they are on track for the demo.", speaker: "Ada" },
    ]);
    let seenPrompt = "";
    const { runner, prompts } = scriptedChatRunner((prompt) => {
      seenPrompt = prompt;
      return groundedFollowupAnswer();
    });
    const chat = new GroundedMeetingChatService({ store, provider: localProvider(runner), clock: () => new Date("2026-09-09T08:00:00.000Z") });
    const answer = await chat.ask({ question: "What was the follow-up discussed in planning?" });

    assert.equal(answer.refusal, false);
    assert.equal(answer.providerId, "local-llama-cpp");
    assert.equal(prompts.length, 1);
    assert.equal(answer.evidence.length, 1);
    const source = answer.evidence[0]!;
    assert.equal(source.meetingId, firstId);
    assert.equal(source.meetingTitle, "Planning sync");
    assert.equal(typeof source.transcriptId, "string");
    assert.equal(typeof source.artifactFileId, "string");
    assert.equal(source.language, "en");
    assert.match(source.sourceId, new RegExp(`^${firstId}:`));
    assert.ok(source.snippet.length > 0 && source.snippet.length <= MAX_SNIPPET_CHARS);
    // The evidence snippet is verbatim transcript text (includes speaker line format).
    assert.match(source.snippet, /follow-up is to verify the backup restore flow on Windows/);
    // Prompt references the evidence with explicit source ids and never a filesystem path.
    assert.ok(seenPrompt.includes(`id ${source.sourceId}`));
    assert.ok(seenPrompt.includes(`[source 1] Meeting "Planning sync"`));
    assert.equal(seenPrompt.includes("\\"), false);
    assert.equal(seenPrompt.includes("transcript.txt"), false);
    assert.ok(seenPrompt.includes(GROUNDED_CHAT_REFUSAL));
    assert.ok(seenPrompt.includes("Question: What was the follow-up discussed in planning?"));
  });
});

test("grounded chat: refuses when no local transcript supports the question and never invokes the model", async () => {
  await withTempStore(async (store) => {
    await seedMeeting(store, "Planning sync", [
      { text: "We discussed the encryption roadmap and decided local files stay on this device.", speaker: "Ada" },
    ]);
    // Analysis contains a claim that does NOT appear in any transcript: it can never ground an answer.
    await store.saveAnalysis(
      {
        meetingId: (await store.listMeetings())[0]!.meetingId,
        createdAt: "2026-09-08T10:00:00.000Z",
        summary: "The migration deadline is November 30th.",
        decisions: [],
        tasks: [],
        risks: [],
        questions: [],
        followups: [],
      },
      {},
    );
    let invoked = false;
    const { runner } = scriptedChatRunner(() => {
      invoked = true;
      return groundedFollowupAnswer();
    });
    const chat = new GroundedMeetingChatService({ store, provider: localProvider(runner), clock: () => new Date("2026-09-09T08:00:00.000Z") });
    const answer = await chat.ask({ question: "When is the migration deadline?" });

    assert.equal(invoked, false);
    assert.equal(answer.refusal, true);
    assert.equal(answer.refusalReason, "NO_EVIDENCE");
    assert.equal(answer.answer, GROUNDED_CHAT_REFUSAL);
    assert.deepEqual(answer.evidence, []);
  });
});

test("grounded chat: model refusal line maps to a refusal without evidence", async () => {
  await withTempStore(async (store) => {
    await seedMeeting(store, "Planning sync", [
      { text: "The follow-up is to verify the backup restore flow on Windows.", speaker: "Ada" },
    ]);
    const { runner } = scriptedChatRunner(() => `${GROUNDED_CHAT_REFUSAL}\n`);
    const chat = new GroundedMeetingChatService({ store, provider: localProvider(runner), clock: () => new Date("2026-09-09T08:00:00.000Z") });
    const answer = await chat.ask({ question: "What was the follow-up discussed in planning?" });
    assert.equal(answer.refusal, true);
    assert.equal(answer.refusalReason, "NO_EVIDENCE");
    assert.equal(answer.providerId, "local-llama-cpp");
    assert.deepEqual(answer.evidence, []);
  });
});

test("grounded chat: invented or citation-free model answers are withheld (GROUNDING_FAILED)", async () => {
  await withTempStore(async (store) => {
    await seedMeeting(store, "Planning sync", [
      { text: "The follow-up is to verify the backup restore flow on Windows.", speaker: "Ada" },
    ]);
    const cases: Array<{ output: string; reason: "NO_CITATION" | "INVENTED_CITATION" | "EMPTY_ANSWER" | "UNSUPPORTED_NUMERIC_CLAIM" }> = [
      { output: "The follow-up is to verify the backup restore flow on Windows.", reason: "NO_CITATION" },
      { output: "Ada invented a Q4 launch date.\n[meeting · Ada invented a Q4 launch date]", reason: "INVENTED_CITATION" },
      { output: "The follow-up is to verify it.\n[meeting · we will move the office to Mars next year]", reason: "INVENTED_CITATION" },
      { output: "The follow-up is to verify the restore flow.\n[meeting · ]", reason: "INVENTED_CITATION" },
      { output: "The follow-up is to verify the restore flow.\n[meeting · follow-up]", reason: "INVENTED_CITATION" },
      { output: "The backup restore work is worth 9000 dollars.\n[meeting · the backup restore flow on windows]", reason: "UNSUPPORTED_NUMERIC_CLAIM" },
      { output: "   ", reason: "EMPTY_ANSWER" },
    ];
    for (const entry of cases) {
      const { runner } = scriptedChatRunner(() => entry.output);
      const chat = new GroundedMeetingChatService({ store, provider: localProvider(runner), clock: () => new Date("2026-09-09T08:00:00.000Z") });
      const answer = await chat.ask({ question: "What was the follow-up discussed in planning?" });
      assert.equal(answer.refusal, true, `expected refusal for ${JSON.stringify(entry.output)}`);
      assert.equal(answer.refusalReason, "GROUNDING_FAILED", `for ${JSON.stringify(entry.output)}`);
      assert.equal(answer.answer, GROUNDED_CHAT_REFUSAL);
      assert.deepEqual(answer.evidence, []);
    }
  });
});

test("grounded chat: engine crash and timeout fail closed without leaking model output", async () => {
  await withTempStore(async (store) => {
    await seedMeeting(store, "Planning sync", [
      { text: "The follow-up is to verify the backup restore flow on Windows.", speaker: "Ada" },
    ]);
    const crashed = new GroundedMeetingChatService({
      store,
      provider: localProvider(crashingRunner(9)),
      clock: () => new Date("2026-09-09T08:00:00.000Z"),
    });
    await assert.rejects(
      crashed.ask({ question: "What was the follow-up discussed in planning?" }),
      (error: unknown) => error instanceof StorageError && /local model/i.test(error.message),
    );
    const hung = new GroundedMeetingChatService({
      store,
      provider: localProvider(unkillableRunner(), { timeoutMs: 25 }),
      clock: () => new Date("2026-09-09T08:00:00.000Z"),
    });
    await assert.rejects(
      hung.ask({ question: "What was the follow-up discussed in planning?" }),
      (error: unknown) => error instanceof StorageError && /too long/i.test(error.message),
    );
  });
});

test("grounded chat: refuses cloud providers even when one is configured", async () => {
  await withTempStore(async (store) => {
    const firstId = await seedMeeting(store, "Planning sync", [
      { text: "The follow-up is to verify the backup restore flow on Windows.", speaker: "Ada" },
    ]);
    let cloudCalls = 0;
    const cloud = new OpenAIProvider(async () => {
      cloudCalls += 1;
      return groundedFollowupAnswer();
    });
    const chat = new GroundedMeetingChatService({ store, provider: cloud, clock: () => new Date("2026-09-09T08:00:00.000Z") });
    await assert.rejects(
      chat.ask({ question: "What was the follow-up discussed in planning?" }),
      (error: unknown) => error instanceof MeetingHubError && error.code === "CHAT_CLOUD_DISALLOWED",
    );
    assert.equal(cloudCalls, 0);
    assert.ok(firstId.length > 0);
  });
});

test("grounded chat: retrieval caps at six sources with bounded snippets and a bounded prompt", async () => {
  await withTempStore(async (store) => {
    for (let i = 0; i < 9; i += 1) {
      await seedMeeting(store, `Budget review ${i}`, [
        { text: `In budget meeting ${i} the migration reserve was increased by ${i + 1} thousand.`, speaker: "Ada" },
      ], { meetingDate: "2026-09-01" });
    }
    const { runner, prompts } = scriptedChatRunner(() => "The migration reserve was increased.\n[meeting · the migration reserve was increased]");
    const chat = new GroundedMeetingChatService({ store, provider: localProvider(runner), clock: () => new Date("2026-09-09T08:00:00.000Z") });
    const answer = await chat.ask({ question: "How much was the migration reserve increased?" });
    assert.equal(answer.refusal, false);
    assert.ok(answer.evidence.length <= MAX_EVIDENCE_SOURCES);
    assert.ok(answer.evidence.length >= 6);
    for (const source of answer.evidence) {
      assert.ok(source.snippet.length <= MAX_SNIPPET_CHARS);
    }
    assert.ok(prompts.length === 1);
    assert.ok(Buffer.byteLength(prompts[0]!, "utf8") <= MAX_CHAT_PROMPT_CHARS);
  });
});

test("grounded chat: meeting scope restricts retrieval and unknown meetings are rejected", async () => {
  await withTempStore(async (store) => {
    const budgetId = await seedMeeting(store, "Budget review", [
      { text: "The migration reserve was increased by five thousand.", speaker: "Ada" },
    ]);
    await seedMeeting(store, "Team lunch", [
      { text: "We reserved a table at the seafood place for Friday.", speaker: "Bilal" },
    ]);
    const { runner, prompts } = scriptedChatRunner(() => "The migration reserve was increased.\n[meeting · the migration reserve was increased]");
    const chat = new GroundedMeetingChatService({ store, provider: localProvider(runner), clock: () => new Date("2026-09-09T08:00:00.000Z") });

    const scoped = await chat.ask({ question: "How much was the migration reserve increased?", meetingIds: [budgetId] });
    assert.equal(scoped.refusal, false);
    assert.equal(scoped.evidence.length, 1);
    assert.equal(scoped.evidence[0]?.meetingId, budgetId);
    assert.equal(prompts[0]?.includes("seafood"), false);

    await assert.rejects(
      chat.ask({ question: "How much was the migration reserve increased?", meetingIds: [randomUUID()] }),
      (error: unknown) => error instanceof MeetingHubError && error.code === "MEETING_NOT_FOUND",
    );

    await assert.rejects(
      chat.ask({ question: "x".repeat(MAX_QUESTION_LENGTH + 1) }),
      (error: unknown) => error instanceof MeetingHubError && error.code === "INVALID_REQUEST",
    );
    await assert.rejects(
      chat.ask({ question: "a" }),
      (error: unknown) => error instanceof MeetingHubError && error.code === "INVALID_REQUEST",
    );
  });
});

test("grounded chat: retrieval scans only the bounded most-recent transcript set", async () => {
  await withTempStore(async (store) => {
    // Oldest first: the "neptune rover" fact lives only in the two oldest
    // transcripts, which fall outside a scan cap of three.
    const oldOne = await seedMeeting(store, "Very old one", [
      { text: "The neptune rover budget was approved.", speaker: "Ada" },
    ], { meetingDate: "2026-08-01", createdAt: "2026-08-01T09:00:00.000Z" });
    await seedMeeting(store, "Very old two", [
      { text: "The neptune rover budget was doubled.", speaker: "Ada" },
    ], { meetingDate: "2026-08-02", createdAt: "2026-08-02T09:00:00.000Z" });
    await seedMeeting(store, "Recent", [
      { text: "Standup is at nine.", speaker: "Ada" },
    ], { meetingDate: "2026-09-01", createdAt: "2026-09-01T09:00:00.000Z" });

    const script = (prompt: string): string => prompt.includes("budget was doubled")
      ? "The neptune rover budget was doubled.\n[meeting · the neptune rover budget was doubled]"
      : GROUNDED_CHAT_REFUSAL;
    const within = new GroundedMeetingChatService({
      store,
      provider: localProvider(scriptedChatRunner(script).runner),
      maxTranscriptsScanned: 2,
      clock: () => new Date("2026-09-09T08:00:00.000Z"),
    });
    // Cap 2 still reaches the two newest (one carries the rover fact)...
    const scopedTwo = await within.ask({ question: "What happened with the neptune rover budget?" });
    assert.equal(scopedTwo.refusal, false);

    const capped = new GroundedMeetingChatService({
      store,
      provider: localProvider(scriptedChatRunner(script).runner),
      maxTranscriptsScanned: 1,
      clock: () => new Date("2026-09-09T08:00:00.000Z"),
    });
    // ...cap 1 only looks at the newest transcript, which has no rover fact.
    const answer = await capped.ask({ question: "What happened with the neptune rover budget?" });
    assert.equal(answer.refusal, true);
    assert.equal(answer.refusalReason, "NO_EVIDENCE");
    assert.ok(oldOne.length > 0);
  });
});

test("grounded chat: one unreadable transcript never blocks evidence from the rest", async () => {
  await withTempStore(async (store, root) => {
    const goodId = await seedMeeting(store, "Budget review", [
      { text: "The migration reserve was increased by five thousand.", speaker: "Ada" },
    ]);
    const brokenId = await seedMeeting(store, "Broken notes", [
      { text: "The migration reserve was increased by nine thousand.", speaker: "Ada" },
    ]);
    const brokenArtifact = store.database.listArtifacts(brokenId).find((artifact) => artifact.artifactType === "TRANSCRIPT_TEXT");
    assert.ok(brokenArtifact !== undefined);
    await rm(join(root, brokenArtifact.relativePath), { force: true });

    const { runner } = scriptedChatRunner(() => "The migration reserve was increased.\n[meeting · the migration reserve was increased]");
    const chat = new GroundedMeetingChatService({ store, provider: localProvider(runner), clock: () => new Date("2026-09-09T08:00:00.000Z") });
    const answer = await chat.ask({ question: "How much was the migration reserve increased?" });
    assert.equal(answer.refusal, false);
    assert.ok(answer.evidence.length >= 1);
    assert.ok(answer.evidence.some((source) => source.meetingId === goodId));
    assert.equal(answer.evidence.some((source) => source.meetingId === brokenId), false);
  });
});

test("grounded chat: retrieval respects LOCAL_ONLY policy and never shows paths or artifacts metadata to the model", async () => {
  await withTempStore(async (store) => {
    await seedMeeting(store, "Planning sync", [
      { text: "The follow-up is to verify the backup restore flow on Windows.", speaker: "Ada" },
    ]);
    const retrieval = await new GroundedMeetingChatService({
      store,
      provider: localProvider(scriptedChatRunner(() => "x").runner),
    }).retrieveEvidence("follow-up restore backup");
    assert.equal(retrieval.evidence.length, 1);
    for (const source of retrieval.evidence) {
      assert.equal(source.artifactFileId.includes("/"), false);
      assert.equal(source.artifactFileId.includes("\\"), false);
      assert.equal(source.snippet.includes("\0"), false);
    }
    assert.equal(retrieval.prompt.includes("DATA_ROOT"), false);
    assert.equal(retrieval.prompt.includes(".txt"), false);
  });
});

test("grounded chat: verifyGroundedAnswer validates citations against evidence only", () => {
  const evidence: HubChatEvidenceSource[] = [
    {
      sourceId: "m:1",
      meetingId: "m",
      meetingTitle: "Planning",
      meetingDate: "2026-09-07",
      transcriptId: "t1",
      artifactFileId: "f1",
      language: "en",
      snippet: "Ada said: the follow-up is to verify the backup restore flow.\nBilal: launch is on Friday.",
    },
  ];
  assert.equal(
    verifyGroundedAnswer("We must verify restore.\n[meeting · the follow-up is to verify the backup restore flow]", evidence).grounded,
    true,
  );
  // Whitespace/newlines inside a citation do not break verbatim matching.
  assert.equal(
    verifyGroundedAnswer("Friday launch.\n[meeting · launch is on\nFriday]", evidence).grounded,
    true,
  );
  assert.deepEqual(verifyGroundedAnswer("", evidence), { grounded: false, reason: "EMPTY_ANSWER" });
  assert.deepEqual(verifyGroundedAnswer("Plain unsupported claim.", evidence), { grounded: false, reason: "NO_CITATION" });
  assert.deepEqual(verifyGroundedAnswer("Claim.\n[meeting · never said anywhere]", evidence), { grounded: false, reason: "INVENTED_CITATION" });
  // Quotes shorter than the anchoring floor are refused even when verbatim.
  assert.deepEqual(verifyGroundedAnswer("Claim.\n[meeting · on friday]", evidence), { grounded: false, reason: "INVENTED_CITATION" });
  assert.deepEqual(verifyGroundedAnswer("Claim.\n[meeting · the follow-up is to verify the backup restore flow]", evidence), { grounded: true });
});

test("grounded chat: numeric claims require a citation quoting the same numbers", () => {
  const evidence: HubChatEvidenceSource[] = [
    {
      sourceId: "m:1",
      meetingId: "m",
      meetingTitle: "Budget",
      meetingDate: "2026-09-07",
      transcriptId: "t1",
      artifactFileId: "f1",
      language: "en",
      snippet: "Ada said the migration reserve was increased by five thousand on 2026-10-01.",
    },
  ];
  assert.deepEqual(
    verifyGroundedAnswer("The reserve grew.\n[meeting · the migration reserve was increased by five thousand on 2026-10-01]", evidence),
    { grounded: true },
  );
  assert.deepEqual(
    verifyGroundedAnswer("The reserve grew by 5000.\n[meeting · the reserve grew]", evidence),
    { grounded: false, reason: "INVENTED_CITATION" },
  );
  assert.deepEqual(
    verifyGroundedAnswer("The reserve grew by 5000.\n[meeting · the migration reserve was increased]", evidence),
    { grounded: false, reason: "UNSUPPORTED_NUMERIC_CLAIM" },
  );
  assert.deepEqual(
    verifyGroundedAnswer("It changed on October 1st 2026.\n[meeting · the migration reserve was increased by five thousand on 2026-10-01]", evidence),
    { grounded: false, reason: "UNSUPPORTED_NUMERIC_CLAIM" },
  );
  // The same numeric fact restated and quoted stays grounded.
  assert.deepEqual(
    verifyGroundedAnswer("On 2026-10-01 Ada announced the raise.\n[meeting · increased by five thousand on 2026-10-01]", evidence),
    { grounded: true },
  );
});

test("grounded chat: snippet windows stay inside boundaries and never split mid-token boundaries", () => {
  const longLine = `[00:00:00.000] Ada: ${"x".repeat(4000)} y\n[00:00:01.000] Ada: needle in a big haystack\n[00:00:02.000] Ada: ${"z".repeat(4000)}\n`;
  const window = buildSnippetWindow(longLine, longLine.indexOf("needle"));
  assert.ok(window.length > 0);
  assert.ok(window.length <= MAX_SNIPPET_CHARS);
  assert.ok(window.includes("needle in a big haystack"));
  const multi = buildSnippetWindow("line one alpha\nline two beta\nline three gamma\n", "line two beta".length - 3);
  assert.ok(multi.includes("line one alpha") || multi.startsWith("line two beta"), multi);
  assert.equal(buildSnippetWindow("", 0), "");
  assert.equal(buildSnippetWindow("abc", 99), "");
  assert.equal(buildSnippetWindow("abc", -1), "");
});

test("grounded chat: tokenizeTerms drops stop words and caps term count", () => {
  assert.deepEqual(tokenizeTerms("What was the migration reserve increased by?"), ["migration", "reserve", "increased"]);
  assert.ok(tokenizeTerms("a b c d e f g h i j k l m n o p q r s t u v w x y z").length <= 12);
  assert.deepEqual(tokenizeTerms("the and for with"), []);
});

test("grounded chat: prompt is deterministic and orders sources for the model", () => {
  const evidence: HubChatEvidenceSource[] = [
    { sourceId: "m2:t2", meetingId: "m2", meetingTitle: "B", meetingDate: "2026-09-08", transcriptId: "t2", artifactFileId: "f2", language: "en", snippet: "alpha" },
    { sourceId: "m1:t1", meetingId: "m1", meetingTitle: "A", meetingDate: "2026-09-07", transcriptId: "t1", artifactFileId: "f1", language: "en", snippet: "beta" },
  ];
  const prompt = buildGroundedChatPrompt("Who said alpha?", evidence);
  assert.ok(prompt.includes("[source 1] Meeting \"B\" (2026-09-08), transcript en, id m2:t2:\nalpha"));
  assert.ok(prompt.includes("[source 2] Meeting \"A\" (2026-09-07), transcript en, id m1:t1:\nbeta"));
  assert.ok(prompt.indexOf("[source 1]") < prompt.indexOf("[source 2]"));
  assert.ok(prompt.endsWith("Question: Who said alpha?\nAnswer:"));
});

test("grounded chat: provider output arrives through the same LocalLlmProvider boundary with GROUNDED_QA purpose", async () => {
  await withTempStore(async (store) => {
    const firstId = await seedMeeting(store, "Planning sync", [
      { text: "The follow-up is to verify the backup restore flow on Windows.", speaker: "Ada" },
    ]);
    let sawPurpose = "";
    let sawMeetingId = "";
    const provider = new (class extends LocalLlmProvider {
      public override async process(request: Parameters<LocalLlmProvider["process"]>[0]): Promise<AIProcessResult> {
        sawPurpose = request.purpose;
        sawMeetingId = request.meetingId;
        return await super.process(request);
      }
    })({ platform: "linux", helperRunner: scriptedChatRunner(() => groundedFollowupAnswer()).runner });
    const chat = new GroundedMeetingChatService({ store, provider, clock: () => new Date("2026-09-09T08:00:00.000Z") });
    const answer: HubChatAnswer = await chat.ask({ question: "What was the follow-up discussed in planning?", meetingIds: [firstId] });
    assert.equal(answer.refusal, false);
    assert.equal(sawPurpose, "GROUNDED_QA");
    assert.equal(sawMeetingId, firstId);
  });
});

test("grounded chat: empty meeting scope means all meetings and never bypasses the evidence gate", async () => {
  await withTempStore(async (store) => {
    await seedMeeting(store, "Planning sync", [
      { text: "The follow-up is to verify the backup restore flow on Windows.", speaker: "Ada" },
    ]);
    const { runner, prompts } = scriptedChatRunner(() => groundedFollowupAnswer());
    const chat = new GroundedMeetingChatService({ store, provider: localProvider(runner), clock: () => new Date("2026-09-09T08:00:00.000Z") });
    const answer = await chat.ask({ question: "What was the follow-up discussed in planning?", meetingIds: [] });
    assert.equal(answer.refusal, false);
    assert.equal(prompts.length, 1);
    // Every id in a scope is validated; unknown ids are rejected even in huge lists.
    await assert.rejects(
      chat.ask({ question: "What was the follow-up discussed in planning?", meetingIds: Array.from({ length: 500 }, () => randomUUID()) }),
      (error: unknown) => error instanceof MeetingHubError && error.code === "MEETING_NOT_FOUND",
    );
  });
});

test("grounded chat: normalizeWhitespace canonicalizes spacing for citation matching", () => {
  assert.equal(normalizeWhitespace("  The  follow-up,\nis\there! "), "the follow-up, is here!");
  assert.equal(normalizeWhitespace(""), "");
});

test("grounded chat: provider engine errors are mapped to user-safe StorageErrors", async () => {
  await withTempStore(async (store) => {
    await seedMeeting(store, "Planning sync", [
      { text: "The follow-up is to verify the backup restore flow on Windows.", speaker: "Ada" },
    ]);
    const failing = (error: LocalLlmError) => ({
      descriptor: { id: "local-llama-cpp", displayName: "Local llama.cpp", kind: "LOCAL" as const, dataTransmission: "local" },
      process: async () => {
        throw error;
      },
    });
    const chat = (provider: { descriptor: { id: string; displayName: string; kind: "LOCAL"; dataTransmission: string }; process: () => Promise<never> }) =>
      new GroundedMeetingChatService({ store, provider, clock: () => new Date("2026-09-09T08:00:00.000Z") });

    await assert.rejects(
      chat(failing(new LocalLlmError("ANALYSIS_ENGINE_UNAVAILABLE", "engine missing", false))).ask({ question: "What was the follow-up discussed in planning?" }),
      (error: unknown) => error instanceof StorageError && /local model runtime/i.test(error.message),
    );
    await assert.rejects(
      chat(failing(new LocalLlmError("ANALYSIS_ENGINE_TIMEOUT", "too slow", true))).ask({ question: "What was the follow-up discussed in planning?" }),
      (error: unknown) => error instanceof StorageError && /too long/i.test(error.message),
    );
    await assert.rejects(
      chat(failing(new LocalLlmError("ANALYSIS_ENGINE_CRASHED", "llama exited with code 7", true))).ask({ question: "What was the follow-up discussed in planning?" }),
      (error: unknown) => error instanceof StorageError && /could not answer/i.test(error.message),
    );
    // The raw engine failure text must not reach the renderer as-is.
    await assert.rejects(
      chat(failing(new LocalLlmError("ANALYSIS_ENGINE_FAILED", "raw internal stack detail", true))).ask({ question: "What was the follow-up discussed in planning?" }),
      (error: unknown) => error instanceof StorageError && !String(error.message).includes("raw internal stack detail"),
    );
  });
});
