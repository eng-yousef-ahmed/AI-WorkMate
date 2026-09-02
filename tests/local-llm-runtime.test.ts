import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalAIProvider, OpenAIProvider } from "../src/ai/AIProvider";
import { loadAnalysisTranscriptFixture } from "../src/ai/AnalysisTranscriptFixture";
import { LocalAnalysisService } from "../src/ai/LocalAnalysisService";
import { LocalLlmError } from "../src/ai/LocalLlmErrors";
import { writeGgufFileMagic } from "../src/ai/LocalLlmModelFormat";
import { installLocalLlmModel } from "../src/ai/LocalLlmModelInstaller";
import {
  LocalLlmProvider,
  assertUsableLocalLlmModelFile,
  type LocalLlmHelperProcess,
  type LocalLlmHelperRunner,
} from "../src/ai/LocalLlmProvider";
import { LOCAL_LLM_MODEL_CATALOG } from "../src/ai/LocalLlmRuntimeCatalog";
import { discoverLocalLlmRuntime } from "../src/ai/LocalLlmRuntimeDiscovery";
import { runWindowsLocalAnalysisVerification } from "../src/ai/WindowsLocalAnalysisVerification";
import { STORAGE_IPC_CHANNELS } from "../src/desktop/storage-api";
import type { AnalysisDocument, TranscriptDocument } from "../src/domain/models";
import type { LocalFirstStore } from "../src/storage/LocalFirstStore";
import { withTempStore } from "./helpers";

test("discovery reports missing CLI and model without claiming real AI verification", async () => {
  const discovery = await discoverLocalLlmRuntime({
    platform: "linux",
    localAppData: join(tmpdir(), "ai-workmate-no-llm"),
  });
  assert.equal(discovery.helperFound, false);
  assert.equal(discovery.modelFound, false);
  assert.equal(discovery.failureCode, "ANALYSIS_ENGINE_UNAVAILABLE");
});

test("path traversal and wrong model directories are rejected", async () => {
  await assert.rejects(
    installLocalLlmModel({
      modelId: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
      localAppData: join(tmpdir(), "app"),
      destinationRoot: join(tmpdir(), "app", "..", "escape"),
    }),
    (error: unknown) => error instanceof LocalLlmError && error.code === "ANALYSIS_PATH_REJECTED",
  );
});

test("unknown catalog ids and checksum mismatches fail closed", async () => {
  await assert.rejects(
    installLocalLlmModel({ modelId: "https://evil.example/model.gguf", localAppData: join(tmpdir(), "app") }),
    (error: unknown) => error instanceof LocalLlmError && error.code === "ANALYSIS_ENGINE_UNAVAILABLE",
  );
  const localAppData = await mkdirTemp();
  const entry = LOCAL_LLM_MODEL_CATALOG[0];
  assert.ok(entry);
  await assert.rejects(
    installLocalLlmModel({
      modelId: entry.id,
      localAppData,
      transport: {
        async get() {
          return { status: 200, body: bytesOf("not-the-model") };
        },
      },
    }),
    (error: unknown) => error instanceof LocalLlmError && error.message.includes("SHA-256"),
  );
});

test("interrupted download is cleaned up without installing a truncated model", async () => {
  const localAppData = await mkdirTemp();
  const payload = writeGgufFileMagic(Buffer.alloc(64, 7));
  await assert.rejects(
    installLocalLlmModel({
      modelId: LOCAL_LLM_MODEL_CATALOG[0]!.id,
      localAppData,
      transport: {
        async get() {
          return {
            status: 200,
            body: (async function* () {
              yield payload.subarray(0, 10);
              throw new Error("socket reset");
            })(),
          };
        },
      },
    }),
    (error: unknown) => error instanceof LocalLlmError,
  );
});

test("allowlisted Qwen GGUF catalog metadata matches the published file pointer", () => {
  const model = LOCAL_LLM_MODEL_CATALOG.find((entry) => entry.id === "qwen2.5-0.5b-instruct-q4_k_m.gguf");
  assert.ok(model);
  assert.equal(model.bytes, 491_400_032);
  assert.equal(model.sha256, "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db");
  assert.equal(model.format, "GGUF");
  assert.equal(model.instructionTuned, true);
  assert.ok(model.url.startsWith("https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/"));
});

test("invalid executable names and truncated models are not discovered as usable", async () => {
  const localAppData = await mkdirTemp();
  await mkdir(join(localAppData, "AI-WorkMate", "native"), { recursive: true });
  await mkdir(join(localAppData, "AI-WorkMate", "models", "llm"), { recursive: true });
  await writeFile(join(localAppData, "AI-WorkMate", "native", "not-llama.exe"), "x");
  await writeFile(join(localAppData, "AI-WorkMate", "models", "llm", "qwen2.5-0.5b-instruct-q4_k_m.gguf"), "nope");
  const discovery = await discoverLocalLlmRuntime({ platform: "win32", localAppData });
  assert.equal(discovery.helperFound, false);
  assert.equal(discovery.modelFound, false);
});

test("GGUF magic files without catalog checksum are not treated as the allowlisted model", async () => {
  const localAppData = await mkdirTemp();
  await mkdir(join(localAppData, "AI-WorkMate", "native"), { recursive: true });
  await mkdir(join(localAppData, "AI-WorkMate", "models", "llm"), { recursive: true });
  await writeFile(join(localAppData, "AI-WorkMate", "native", "llama-cli.exe"), "placeholder");
  const modelPath = join(localAppData, "AI-WorkMate", "models", "llm", "qwen2.5-0.5b-instruct-q4_k_m.gguf");
  await writeFile(modelPath, writeGgufFileMagic(Buffer.alloc(128, 3)));
  const discovery = await discoverLocalLlmRuntime({ platform: "win32", localAppData });
  assert.equal(discovery.helperFound, true);
  assert.equal(discovery.modelFound, true);
  assert.equal(discovery.modelChecksumOk, false);
  await assert.rejects(
    () => assertUsableLocalLlmModelFile(modelPath),
    (error: unknown) => error instanceof LocalLlmError && error.message.includes("SHA-256"),
  );
});

test("production llama provider fail-closes when CLI and model are missing", async () => {
  const provider = new LocalLlmProvider({
    platform: "win32",
    localAppData: join(tmpdir(), "ai-workmate-missing-llm"),
  });
  await assert.rejects(
    provider.process(sampleRequest()),
    (error: unknown) => error instanceof LocalLlmError && error.code === "ANALYSIS_ENGINE_UNAVAILABLE",
  );
});

test("non-Windows platforms are unavailable without an injected helper", async () => {
  const provider = new LocalLlmProvider({ platform: "linux" });
  await assert.rejects(
    provider.process(sampleRequest()),
    (error: unknown) => error instanceof LocalLlmError && error.code === "ANALYSIS_ENGINE_UNAVAILABLE",
  );
});

test("injected llama helper returns model JSON without inventing a cloud hop", async () => {
  const meetingId = "11111111-1111-4111-8111-111111111111";
  const provider = new LocalLlmProvider({
    platform: "linux",
    helperRunner: scriptedLlamaRunner(validAnalysis(meetingId)),
  });
  const result = await provider.process(sampleRequest(meetingId));
  assert.equal(result.providerId, "local-llama-cpp");
  assert.equal(result.persistedByProvider, false);
  const parsed = JSON.parse(result.output) as AnalysisDocument;
  assert.equal(parsed.summary, "Validated local summary");
});

test("malformed helper JSON, crash, timeout, and cancellation fail closed", async () => {
  await assert.rejects(
    new LocalLlmProvider({ platform: "linux", helperRunner: scriptedLlamaRunner("not-json") }).process(sampleRequest()),
    (error: unknown) => error instanceof LocalLlmError && error.code === "ANALYSIS_ENGINE_INVALID_OUTPUT",
  );
  await assert.rejects(
    new LocalLlmProvider({ platform: "linux", helperRunner: crashingRunner() }).process(sampleRequest()),
    (error: unknown) => error instanceof LocalLlmError && error.code === "ANALYSIS_ENGINE_CRASHED",
  );
  await assert.rejects(
    new LocalLlmProvider({ platform: "linux", timeoutMs: 20, helperRunner: unkillableRunner() }).process(sampleRequest()),
    (error: unknown) => error instanceof LocalLlmError && error.code === "ANALYSIS_ENGINE_TIMEOUT",
  );
  const controller = new AbortController();
  const pending = new LocalLlmProvider({
    platform: "linux",
    timeoutMs: 5_000,
    helperRunner: hangingRunner(),
    signal: controller.signal,
  }).process(sampleRequest());
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof LocalLlmError && error.code === "ANALYSIS_CANCELLED");
});

test("invalid helper and model paths are rejected", async () => {
  const provider = new LocalLlmProvider({
    platform: "win32",
    helperPath: "../llama-cli.exe",
  });
  await assert.rejects(
    provider.process(sampleRequest()),
    (error: unknown) => error instanceof LocalLlmError && (error.code === "ANALYSIS_PATH_REJECTED" || error.code === "ANALYSIS_ENGINE_UNAVAILABLE"),
  );
});

test("LOCAL_ONLY never transmits transcript content to a cloud provider", async () => {
  await withTempStore(async (store) => {
    const prepared = await commitFixtureTranscript(store);
    let transmitted = false;
    const service = new LocalAnalysisService({
      store,
      policy: "LOCAL_ONLY",
      provider: new OpenAIProvider(async () => {
        transmitted = true;
        return "{}";
      }),
    });
    await assert.rejects(service.analyzeCommittedTranscript({ meetingId: prepared.meetingId, recordingId: prepared.recordingId }));
    assert.equal(transmitted, false);
  });
});

test("injected local provider persists validated analysis through saveAnalysis", async () => {
  await withTempStore(async (store) => {
    const prepared = await commitFixtureTranscript(store);
    const service = new LocalAnalysisService({
      store,
      policy: "LOCAL_ONLY",
      provider: new LocalAIProvider(async (request) => JSON.stringify(validAnalysis(request.meetingId))),
    });
    const result = await service.analyzeCommittedTranscript({
      meetingId: prepared.meetingId,
      recordingId: prepared.recordingId,
    });
    assert.equal(store.getMeeting(prepared.meetingId)?.status, "COMPLETED");
    assert.equal(result.analysis.summary, "Validated local summary");
    assert.equal(store.database.listAnalysis(prepared.meetingId).length, 7);
  });
});

test("schema-invalid injected llama JSON fails without claiming success", async () => {
  await withTempStore(async (store) => {
    const prepared = await commitFixtureTranscript(store);
    const service = new LocalAnalysisService({
      store,
      policy: "LOCAL_ONLY",
      provider: new LocalLlmProvider({
        platform: "linux",
        helperRunner: scriptedLlamaRunner({
          meetingId: prepared.meetingId,
          createdAt: "2026-09-02T12:00:00.000Z",
          summary: "ok",
          decisions: [{ decisionId: "", text: "" }],
          tasks: [],
          risks: [],
          questions: [],
          followups: [],
        }),
      }),
    });
    await assert.rejects(service.analyzeCommittedTranscript({ meetingId: prepared.meetingId, recordingId: prepared.recordingId }));
    assert.equal(store.getMeeting(prepared.meetingId)?.status, "FAILED");
    assert.equal(store.database.listAnalysis(prepared.meetingId).length, 0);
  });
});

test("meeting and recording identity isolation is preserved for local LLM analysis", async () => {
  await withTempStore(async (store) => {
    const first = await commitFixtureTranscript(store, "First");
    const second = await commitFixtureTranscript(store, "Second");
    const service = new LocalAnalysisService({
      store,
      policy: "LOCAL_ONLY",
      provider: new LocalLlmProvider({
        platform: "linux",
        helperRunner: scriptedLlamaRunner(validAnalysis(first.meetingId)),
      }),
    });
    await assert.rejects(service.analyzeCommittedTranscript({ meetingId: first.meetingId, recordingId: second.recordingId }));
  });
});

test("analysis transcript fixture contains recognizable meeting-style speech", async () => {
  const fixture = await loadAnalysisTranscriptFixture();
  const text = fixture.segments.map((segment) => segment.text).join(" ");
  assert.match(text, /AI WorkMate/);
  assert.match(text, /llama\.cpp/);
  assert.match(text, /DATA_ROOT/);
});

test("Windows analysis verification fail-closes off Windows without fake analysis text", async () => {
  const result = await runWindowsLocalAnalysisVerification({ platform: "linux" });
  assert.equal(result.windowsVerified, false);
  assert.equal(result.realAiVerified, false);
  assert.equal(result.success, false);
  assert.equal(result.cloudServiceUsed, false);
  assert.equal(result.analysisCompleted, false);
  assert.equal(result.summaryText, undefined);
  assert.equal(result.failureCode, "ANALYSIS_ENGINE_UNAVAILABLE");
});

test("analysis remains a main-process boundary with no renderer LLM IPC", () => {
  const names = Object.keys(STORAGE_IPC_CHANNELS);
  const values = Object.values(STORAGE_IPC_CHANNELS);
  assert.equal(names.some((name) => /llama|llm|openai|model-url|helper-path/i.test(name)), false);
  assert.equal(values.some((channel) => /llama|llm|openai|model-url|helper-path/i.test(channel)), false);
});

async function commitFixtureTranscript(store: LocalFirstStore, title = "Analyze me"): Promise<{ meetingId: string; recordingId: string }> {
  const meeting = await store.createMeeting({ title, meetingDate: "2026-09-02" });
  const pcm = Buffer.from(title.padEnd(16, "\0"));
  const format = {
    container: "AIWPCM_JSONL",
    encoding: "PCM",
    sampleRateHz: 16_000,
    channels: 1,
    bitsPerSample: 16,
    blockAlign: 2,
    averageBytesPerSecond: 32_000,
  };
  const jsonl = `${JSON.stringify({ recordType: "format", source: "MICROPHONE_AUDIO", startedAt: "2026-09-02T10:00:00.000Z", format })}\n${JSON.stringify({
    recordType: "chunk",
    sequence: 0,
    timestamp: "2026-09-02T10:00:01.000Z",
    source: "MICROPHONE_AUDIO",
    format,
    byteLength: pcm.byteLength,
    sha256: createHash("sha256").update(pcm).digest("hex"),
    dataBase64: pcm.toString("base64"),
  })}\n`;
  await store.saveRecording({
    meetingId: meeting.meetingId,
    extension: "aiwpcm",
    mimeType: "application/x-ai-workmate-pcm-jsonl",
    contents: Buffer.from(jsonl, "utf8"),
  });
  const recording = store.database.listRecordings(meeting.meetingId)[0];
  assert.ok(recording);
  const fixture = await loadAnalysisTranscriptFixture();
  const document: TranscriptDocument = {
    ...fixture,
    meetingId: meeting.meetingId,
    recordingId: recording.recordingId,
  };
  await store.saveTranscript(document, { recordingId: recording.recordingId, engineId: "fixture-transcript" });
  return { meetingId: meeting.meetingId, recordingId: recording.recordingId };
}

function sampleRequest(meetingId = "11111111-1111-4111-8111-111111111111") {
  return {
    meetingId,
    purpose: "SUMMARY" as const,
    content: JSON.stringify({
      meetingId,
      language: "en",
      createdAt: "2026-09-02T11:00:00.000Z",
      speakers: [],
      timestamps: true,
      segments: [{ segmentId: "s1", startMs: 0, endMs: 1000, text: "Ship the local llama.cpp analysis path." }],
    }),
  };
}

function validAnalysis(meetingId: string): AnalysisDocument {
  return {
    meetingId,
    createdAt: "2026-09-02T12:00:00.000Z",
    summary: "Validated local summary",
    decisions: [{ decisionId: "d1", text: "Ship the local pipeline" }],
    tasks: [{ taskId: "t1", text: "Review analysis artifacts", status: "OPEN" }],
    risks: ["None"],
    questions: ["Any follow-up?"],
    followups: ["Schedule next review"],
  };
}

function scriptedLlamaRunner(output: AnalysisDocument | string): LocalLlmHelperRunner {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return () => completed(text, 0);
}

function crashingRunner(): LocalLlmHelperRunner {
  return () => completed("", 7);
}

function unkillableRunner(): LocalLlmHelperRunner {
  return () => ({
    stdout: (async function* () {})(),
    stderr: (async function* () {})(),
    exited: new Promise(() => undefined),
    kill: () => undefined,
  });
}

function hangingRunner(): LocalLlmHelperRunner {
  return () => {
    let settle: ((exit: { code: number | null; signal: NodeJS.Signals | string | null }) => void) | undefined;
    return {
      stdout: (async function* () {})(),
      stderr: (async function* () {})(),
      exited: new Promise((resolve) => {
        settle = resolve;
      }),
      kill: () => settle?.({ code: null, signal: "SIGTERM" }),
    };
  };
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

async function mkdirTemp(): Promise<string> {
  const root = join(tmpdir(), `ai-workmate-llm-install-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function* bytesOf(value: string | Buffer): AsyncIterable<Uint8Array> {
  yield Buffer.isBuffer(value) ? value : Buffer.from(value);
}
