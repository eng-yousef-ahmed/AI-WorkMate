import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalAIProvider, OpenAIProvider } from "../src/ai/AIProvider";
import { evaluateAnalysisQuality, isPlaceholderAnalysis } from "../src/ai/AnalysisQuality";
import { loadAnalysisTranscriptFixture } from "../src/ai/AnalysisTranscriptFixture";
import { LocalAnalysisService } from "../src/ai/LocalAnalysisService";
import { LocalLlmError } from "../src/ai/LocalLlmErrors";
import { writeGgufFileMagic } from "../src/ai/LocalLlmModelFormat";
import { installLocalLlmModel } from "../src/ai/LocalLlmModelInstaller";
import { ANALYSIS_DOCUMENT_JSON_SCHEMA, assignPersistentAnalysisIdentities, parseAnalysisDocument, validateAnalysisDocument } from "../src/ai/AnalysisDocument";
import {
  LocalLlmProvider,
  assertUsableLocalLlmModelFile,
  buildAnalysisPrompt,
  LOCAL_LLM_MAX_PREDICT_TOKENS,
  buildLlamaCliArgs,
  describeJsonCursor,
  describeLlamaStdout,
  extractJsonObject,
  localLlmCpuThreadCount,
  resolveLocalLlmTimeoutMs,
  type LocalLlmHelperProcess,
  type LocalLlmHelperRunner,
} from "../src/ai/LocalLlmProvider";
import { DataRootValidationError, StorageError } from "../src/storage/errors";
import {
  LOCAL_LLM_MODEL_CATALOG,
  PRODUCTION_LOCAL_LLM_MODEL_ID,
  SMOKE_TEST_LOCAL_LLM_MODEL_ID,
  getLocalLlmModelCatalogEntry,
  resolveSelectedLocalLlmModelId,
} from "../src/ai/LocalLlmRuntimeCatalog";
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
  const model = LOCAL_LLM_MODEL_CATALOG.find((entry) => entry.id === SMOKE_TEST_LOCAL_LLM_MODEL_ID);
  assert.ok(model);
  assert.equal(model.bytes, 491_400_032);
  assert.equal(model.sha256, "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db");
  assert.equal(model.format, "GGUF");
  assert.equal(model.instructionTuned, true);
  assert.equal(model.role, "smoke-test");
  assert.equal(model.splitGguf, false);
  assert.equal(model.files.length, 1);
  assert.ok(model.url.startsWith("https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/"));
});

test("allowlisted Qwen 7B Q4_K_M catalog uses official split GGUF shards", () => {
  const model = getLocalLlmModelCatalogEntry(PRODUCTION_LOCAL_LLM_MODEL_ID);
  assert.ok(model);
  assert.equal(model.role, "production-analysis");
  assert.equal(model.splitGguf, true);
  assert.equal(model.family, "Qwen2.5-7B-Instruct");
  assert.equal(model.filename, "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf");
  assert.equal(model.files.length, 2);
  assert.equal(model.files[0]?.filename, "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf");
  assert.equal(model.files[0]?.sha256, "dfce12e3862a5283ccfb88221b48480e58745165de856439950d0f22590580db");
  assert.equal(model.files[0]?.bytes, 3_993_201_344);
  assert.equal(model.files[0]?.url, "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf");
  assert.equal(model.files[1]?.filename, "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf");
  assert.equal(model.files[1]?.sha256, "539cf93f78e887edea1c04e2d7d8cdaca9d01dae9c9025bcb8accbe29df3d72a");
  assert.equal(model.files[1]?.bytes, 689_872_288);
  assert.equal(model.files[1]?.url, "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf");
  assert.equal(getLocalLlmModelCatalogEntry("qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf")?.id, PRODUCTION_LOCAL_LLM_MODEL_ID);
});

test("production local LLM selection defaults to 7B and can select the 0.5B smoke-test model", () => {
  assert.equal(resolveSelectedLocalLlmModelId(undefined), PRODUCTION_LOCAL_LLM_MODEL_ID);
  assert.equal(resolveSelectedLocalLlmModelId(""), PRODUCTION_LOCAL_LLM_MODEL_ID);
  assert.equal(resolveSelectedLocalLlmModelId("not-a-model.gguf"), PRODUCTION_LOCAL_LLM_MODEL_ID);
  assert.equal(resolveSelectedLocalLlmModelId(SMOKE_TEST_LOCAL_LLM_MODEL_ID), SMOKE_TEST_LOCAL_LLM_MODEL_ID);
  assert.equal(resolveSelectedLocalLlmModelId("qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf"), PRODUCTION_LOCAL_LLM_MODEL_ID);
});

test("split 7B install requests both official shards and rejects a checksum mismatch without leaving a partial file", async () => {
  const localAppData = await mkdirTemp();
  const requested: string[] = [];
  await assert.rejects(
    installLocalLlmModel({
      modelId: PRODUCTION_LOCAL_LLM_MODEL_ID,
      localAppData,
      transport: {
        async get(url) {
          requested.push(url);
          return { status: 200, body: bytesOf(writeGgufFileMagic(Buffer.alloc(64, 9))) };
        },
      },
    }),
    (error: unknown) => error instanceof LocalLlmError && error.message.includes("SHA-256"),
  );
  assert.deepEqual(requested, [
    "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
  ]);
});

test("incomplete split GGUF is not discovered as usable and 0.5B smoke-test remains selectable", async () => {
  const localAppData = await mkdirTemp();
  await mkdir(join(localAppData, "AI-WorkMate", "native"), { recursive: true });
  await mkdir(join(localAppData, "AI-WorkMate", "models", "llm"), { recursive: true });
  await writeFile(join(localAppData, "AI-WorkMate", "native", "llama-cli.exe"), "placeholder");
  await writeFile(
    join(localAppData, "AI-WorkMate", "models", "llm", "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf"),
    writeGgufFileMagic(Buffer.alloc(128, 3)),
  );
  await writeFile(
    join(localAppData, "AI-WorkMate", "models", "llm", "qwen2.5-0.5b-instruct-q4_k_m.gguf"),
    writeGgufFileMagic(Buffer.alloc(128, 4)),
  );
  const discovery = await discoverLocalLlmRuntime({ platform: "win32", localAppData });
  assert.equal(discovery.helperFound, true);
  assert.equal(discovery.modelFound, true);
  assert.equal(discovery.modelName, "qwen2.5-0.5b-instruct-q4_k_m.gguf");
  assert.equal(discovery.modelChecksumOk, false);
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
    (error: unknown) =>
      error instanceof LocalLlmError &&
      (error.message.includes("SHA-256") || error.message.includes("size does not match")),
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

test("b10621 llama-cli argv omits removed -no-cnv and uses --single-turn so conversation mode cannot wait on stdin", () => {
  const args = buildLlamaCliArgs("injected-llama-model.gguf", "prompt-text", "llama-cli.exe");
  assert.equal(args.includes("-no-cnv"), false);
  assert.equal(args.includes("--no-conversation"), false);
  assert.equal(args.includes("--single-turn"), true);
  assert.equal(args.includes("--json-schema"), true);
  assert.equal(args[args.indexOf("--json-schema") + 1]?.includes("\"taskId\""), true);
  assert.equal(args[args.indexOf("--json-schema") + 1]?.includes("\"maxLength\""), true);
  assert.equal(args.includes("-c"), true);
  assert.equal(args.includes("-t"), true);
  assert.equal(args.includes("-b"), true);
  assert.deepEqual(args.slice(0, 8), [
    "-m",
    "injected-llama-model.gguf",
    "-n",
    String(LOCAL_LLM_MAX_PREDICT_TOKENS),
    "-c",
    "2048",
    "-t",
    args[args.indexOf("-t") + 1],
  ]);
  assert.equal(Number(args[args.indexOf("-n") + 1]), 480);
  assert.equal(LOCAL_LLM_MAX_PREDICT_TOKENS > 320, true);
  assert.equal(LOCAL_LLM_MAX_PREDICT_TOKENS < 768, true);
  const completionArgs = buildLlamaCliArgs("injected-llama-model.gguf", "prompt-text", "llama-completion.exe");
  assert.equal(completionArgs.includes("--single-turn"), true);
  assert.equal(completionArgs.includes("--json-schema"), true);
  assert.equal(completionArgs.includes("-no-cnv"), false);
  assert.equal(completionArgs.includes("-p"), true);
  assert.equal(args.includes("768"), false);
  assert.equal(localLlmCpuThreadCount(1), 1);
  assert.equal(localLlmCpuThreadCount(32), 8);
  assert.equal(localLlmCpuThreadCount(0), 1);
});

test("local LLM timeout is configurable with a hard upper bound", () => {
  assert.equal(resolveLocalLlmTimeoutMs(undefined, ""), 180_000);
  assert.equal(resolveLocalLlmTimeoutMs(20), 20);
  assert.equal(resolveLocalLlmTimeoutMs(undefined, "600000"), 600_000);
  assert.equal(resolveLocalLlmTimeoutMs(9_999_999), 900_000);
  assert.equal(resolveLocalLlmTimeoutMs(-1, "not-a-number"), 180_000);
});

test("llama.cpp stdout extracts one complete JSON object and rejects truncated or log-wrapped invalid slices", () => {
  const document = {
    meetingId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-09-02T12:00:00.000Z",
    summary: "Keep analysis LOCAL_ONLY.",
    decisions: [{ decisionId: "d1", text: "Stay local" }],
    tasks: [{ taskId: "t1", text: "Document install" }],
    risks: [],
    questions: [],
    followups: [],
  };
  const json = JSON.stringify(document);
  const wrapped = `llama_model_loader: loaded\n${json}\nllama_perf_context_print: eval time = 12.3 ms\n`;
  assert.equal(extractJsonObject(wrapped), json);
  assert.match(describeLlamaStdout(wrapped), /runtime-log/);
  assert.match(describeLlamaStdout(wrapped), /complete-object/);
  const fenced = "```json\n" + json + "\n```";
  assert.equal(JSON.parse(extractJsonObject(fenced)).summary, document.summary);
  const truncated = "{\"meetingId\":\"11111111-1111-4111-8111-111111111111\",\"summary\":\"Keep";
  assert.throws(
    () => extractJsonObject(truncated),
    (error: unknown) => error instanceof LocalLlmError && error.message.includes("truncated"),
  );
  const twoObjects = `${json}{"meetingId":"other"}`;
  assert.equal(extractJsonObject(twoObjects), json);
  assert.match(describeLlamaStdout(truncated, "n_remain = 0"), /nPredict=480/);
  assert.match(describeLlamaStdout(truncated, "n_remain = 0"), /hit-n-limit/);
  assert.match(describeJsonCursor(truncated), /\$\.summary/);
  assert.match(describeLlamaStdout(truncated), /cursor=/);
});

test("truncated llama.cpp structured output fails closed without inventing analysis", async () => {
  const truncated = "{\"meetingId\":\"11111111-1111-4111-8111-111111111111\",\"summary\":\"Keep analysis LOCAL_ONLY\",\"decisions\":[{\"decisionId\":\"d1\",\"text\":\"Stay";
  await assert.rejects(
    new LocalLlmProvider({
      platform: "linux",
      helperRunner: () => ({
        stdout: (async function* () {
          yield Buffer.from(truncated, "utf8");
        })(),
        stderr: (async function* () {
          yield Buffer.from("n_remain = 0\n", "utf8");
        })(),
        exited: Promise.resolve({ code: 0, signal: null }),
        kill: () => undefined,
      }),
    }).process(sampleRequest()),
    (error: unknown) =>
      error instanceof LocalLlmError &&
      error.code === "ANALYSIS_ENGINE_INVALID_OUTPUT" &&
      error.message.includes("truncated") &&
      error.message.includes("nPredict=480") &&
      error.message.includes("hit-n-limit"),
  );
});

test("generation schema bounds string fields so a quality document fits in 480 tokens", () => {
  assert.equal(ANALYSIS_DOCUMENT_JSON_SCHEMA.properties.summary.maxLength, 220);
  assert.equal(ANALYSIS_DOCUMENT_JSON_SCHEMA.properties.decisions.items.properties.text.maxLength, 160);
  assert.equal(ANALYSIS_DOCUMENT_JSON_SCHEMA.properties.tasks.items.properties.text.maxLength, 140);
  const document = {
    meetingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    createdAt: "2026-09-02T12:00:00.000Z",
    summary: "AI WorkMate planning kept llama.cpp analysis LOCAL_ONLY and DATA_ROOT on the machine.",
    decisions: [
      { decisionId: "d1", text: "Keep analysis LOCAL_ONLY with llama.cpp and do not send transcript content to a cloud provider." },
      { decisionId: "d2", text: "DATA_ROOT remains on the user machine." },
      { decisionId: "d3", text: "Ship Windows real-AI verification before adding a larger instruct model." },
    ],
    tasks: [
      { taskId: "t1", text: "Document the llama.cpp install under LocalAppData", assignee: "Omar Farouk", dueDate: "2026-09-12", status: "OPEN" as const },
      { taskId: "t2", text: "Review encryption of transcripts under DATA_ROOT", assignee: "Nadia Rahman", dueDate: "2026-09-12", status: "OPEN" as const },
      { taskId: "t3", text: "Add fail-closed tests that reject invented tasks", assignee: "Samir Haddad", dueDate: "2026-09-10", status: "OPEN" as const },
    ],
    risks: ["The 0.5B model may invent people."],
    questions: ["Budget approval for a 7B local model is still needed."],
    followups: [],
  };
  const bytes = Buffer.byteLength(JSON.stringify(document), "utf8");
  assert.equal(bytes <= 1200, true);
  assert.equal(Math.ceil(bytes / 3.18) < LOCAL_LLM_MAX_PREDICT_TOKENS, true);
});

test("injected llama helper returns model JSON without inventing a cloud hop", async () => {
  const meetingId = "11111111-1111-4111-8111-111111111111";
  let seenArgs: readonly string[] | undefined;
  const provider = new LocalLlmProvider({
    platform: "linux",
    helperRunner: (args) => {
      seenArgs = args;
      return scriptedLlamaRunner(validAnalysis(meetingId))(args);
    },
  });
  const result = await provider.process(sampleRequest(meetingId));
  assert.equal(seenArgs?.includes("-no-cnv"), false);
  assert.equal(seenArgs?.includes("--single-turn"), true);
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

test("Qwen-style malformed tasks fail closed with field-level diagnostics and do not invent taskId or text", () => {
  const meetingId = "11111111-1111-4111-8111-111111111111";
  const base = {
    meetingId,
    createdAt: "2026-09-02T12:00:00.000Z",
    summary: "Local summary",
    decisions: [],
    risks: [],
    questions: [],
    followups: [],
  };
  assert.throws(
    () => validateAnalysisDocument({ ...base, tasks: ["Review the pipeline"] }),
    (error: unknown) =>
      error instanceof DataRootValidationError &&
      error.message.includes("Invalid task at index 0") &&
      error.message.includes("string"),
  );
  assert.throws(
    () => validateAnalysisDocument({ ...base, tasks: [{ id: "t1", title: "Review the pipeline", status: "OPEN" }] }),
    (error: unknown) =>
      error instanceof DataRootValidationError &&
      error.message.includes("taskId must be a non-empty string") &&
      error.message.includes("id:string"),
  );
  assert.throws(
    () => validateAnalysisDocument({ ...base, tasks: [{ taskId: 1, text: "Review the pipeline" }] }),
    (error: unknown) =>
      error instanceof DataRootValidationError &&
      error.message.includes("taskId must be a non-empty string") &&
      error.message.includes("number"),
  );
  assert.throws(
    () => validateAnalysisDocument({ ...base, tasks: [{ taskId: "t1" }] }),
    (error: unknown) =>
      error instanceof DataRootValidationError &&
      error.message.includes("text must be a non-empty string"),
  );
  assert.throws(
    () => parseAnalysisDocument("not-json", meetingId),
    (error: unknown) => error instanceof StorageError && error.message.includes("invalid analysis JSON"),
  );
  const fenced = "```json\n" + JSON.stringify({ ...base, tasks: [] }) + "\n```";
  const parsed = parseAnalysisDocument(fenced, meetingId);
  assert.equal(parsed.tasks.length, 0);
});

test("one-shot completion closes stdin after spawn so llama-completion does not wait for a second chat turn", async () => {
  let stdinClosed = false;
  let killCount = 0;
  const meetingId = "11111111-1111-4111-8111-111111111111";
  const provider = new LocalLlmProvider({
    platform: "linux",
    helperRunner: (args) => {
      assert.equal(args.includes("--single-turn"), true);
      assert.equal(args.includes("-p"), true);
      const helper = completed(JSON.stringify(validAnalysis(meetingId)), 0);
      return {
        ...helper,
        closeStdin: () => {
          stdinClosed = true;
        },
        kill: () => {
          killCount += 1;
        },
      };
    },
  });
  await provider.process(sampleRequest(meetingId));
  assert.equal(stdinClosed, true);
  assert.equal(killCount, 0);
});

test("conversation-mode Ctrl+C exit 130 fails closed and a successful helper is never SIGINT-killed", async () => {
  await assert.rejects(
    new LocalLlmProvider({ platform: "linux", helperRunner: crashingRunner(130) }).process(sampleRequest()),
    (error: unknown) =>
      error instanceof LocalLlmError &&
      error.code === "ANALYSIS_ENGINE_CRASHED" &&
      error.message.includes("130"),
  );
  let killCount = 0;
  const meetingId = "11111111-1111-4111-8111-111111111111";
  const provider = new LocalLlmProvider({
    platform: "linux",
    helperRunner: () => {
      const process = completed(JSON.stringify(validAnalysis(meetingId)), 0);
      return {
        ...process,
        kill: () => {
          killCount += 1;
        },
      };
    },
  });
  await provider.process(sampleRequest(meetingId));
  assert.equal(killCount, 0);
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

test("duplicate model decision_id values persist with application-owned unique keys", async () => {
  await withTempStore(async (store) => {
    const first = await commitFixtureTranscript(store, "Duplicate ids A");
    const second = await commitFixtureTranscript(store, "Duplicate ids B");
    const duplicateDecisions: AnalysisDocument = {
      meetingId: first.meetingId,
      createdAt: "2026-09-02T12:00:00.000Z",
      summary: "Keep analysis LOCAL_ONLY with llama.cpp.",
      decisions: [
        { decisionId: "d1", text: "Keep analysis LOCAL_ONLY with llama.cpp." },
        { decisionId: "d1", text: "DATA_ROOT remains on the user's machine." },
        { decisionId: "d1", text: "Ship Windows real-AI verification first." },
      ],
      tasks: [
        { taskId: "t1", text: "Document the llama.cpp install", status: "OPEN" },
        { taskId: "t1", text: "Add fail-closed tests", status: "OPEN" },
      ],
      risks: [],
      questions: [],
      followups: [],
    };
    validateAnalysisDocument(duplicateDecisions);
    await store.saveAnalysis(duplicateDecisions);
    const decisions = store.database.listDecisions(first.meetingId);
    const tasks = store.database.listTasks(first.meetingId);
    assert.equal(decisions.length, 3);
    assert.equal(new Set(decisions.map((row) => row.decisionId)).size, 3);
    assert.equal(decisions.some((row) => row.decisionId === "d1"), false);
    assert.deepEqual(decisions.map((row) => row.text), duplicateDecisions.decisions.map((row) => row.text));
    assert.equal(tasks.length, 2);
    assert.equal(new Set(tasks.map((row) => row.taskId)).size, 2);

    await store.saveAnalysis({
      ...duplicateDecisions,
      meetingId: second.meetingId,
    });
    assert.equal(store.database.listDecisions(second.meetingId).length, 3);
    const remapped = assignPersistentAnalysisIdentities(duplicateDecisions);
    assert.equal(new Set(remapped.decisions.map((row) => row.decisionId)).size, 3);
    assert.notEqual(remapped.decisions[0]?.decisionId, "d1");
    assert.equal(remapped.decisions[0]?.text, duplicateDecisions.decisions[0]?.text);
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
  assert.deepEqual(fixture.speakers.map((speaker) => speaker.displayName), [
    "Layla Hassan",
    "Omar Farouk",
    "Nadia Rahman",
    "Samir Haddad",
  ]);
  assert.match(text, /Omar,/);
  assert.match(text, /LOCAL_ONLY/);
  assert.match(text, /12 September 2026/);
});

test("extraction quality accepts transcript facts and rejects placeholders and invented people", async () => {
  const fixture = await loadAnalysisTranscriptFixture();
  const prompt = buildAnalysisPrompt(fixture, "2026-09-02T12:00:00.000Z");
  assert.equal(prompt.includes("Review the local analysis artifacts"), false);
  assert.match(prompt, /minified JSON/);
  assert.match(prompt, /states its main decision, and mentions the product or system/);
  assert.equal(/Do not copy the transcript/i.test(prompt), false);
  assert.equal(prompt.includes("AI WorkMate"), true);
  assert.equal(prompt.includes("The summary must include AI WorkMate"), false);
  assert.equal(prompt.includes("The summary must mention AI WorkMate"), false);
  const good: AnalysisDocument = {
    meetingId: fixture.meetingId,
    createdAt: "2026-09-02T12:00:00.000Z",
    summary: "AI WorkMate planning kept llama.cpp analysis LOCAL_ONLY and DATA_ROOT on the machine.",
    decisions: [
      { decisionId: "d1", text: "Keep analysis LOCAL_ONLY with llama.cpp and do not send transcript content to a cloud provider." },
      { decisionId: "d2", text: "DATA_ROOT remains on the user's machine." },
      { decisionId: "d3", text: "Ship Windows real-AI verification before adding a larger instruct model." },
    ],
    tasks: [
      { taskId: "t1", text: "Document the llama.cpp install under LocalAppData", assignee: "Omar Farouk", dueDate: "2026-09-12", status: "OPEN" },
      { taskId: "t2", text: "Review encryption of transcripts under DATA_ROOT", assignee: "Nadia Rahman", dueDate: "2026-09-12", status: "OPEN" },
      { taskId: "t3", text: "Add fail-closed tests that reject invented tasks", assignee: "Samir Haddad", dueDate: "2026-09-10", status: "OPEN" },
    ],
    risks: ["The 0.5B model may invent people."],
    questions: ["Budget approval for a 7B local model is still needed."],
    followups: [],
  };
  validateAnalysisDocument(good);
  const quality = evaluateAnalysisQuality(good, fixture);
  assert.equal(quality.acceptable, true);
  assert.equal(quality.matchedDecisions >= 2, true);
  assert.equal(quality.matchedTasks >= 2, true);
  assert.equal(quality.matchedAssignees >= 2, true);
  const placeholder: AnalysisDocument = {
    ...good,
    summary: "Local analysis artifacts",
    decisions: [{ decisionId: "d1", text: "Review the local analysis artifacts" }],
    tasks: [{ taskId: "t1", text: "Review the local analysis artifacts", status: "OPEN" }],
  };
  assert.equal(isPlaceholderAnalysis(placeholder), true);
  assert.equal(evaluateAnalysisQuality(placeholder, fixture).acceptable, false);
  const invented: AnalysisDocument = {
    ...good,
    tasks: [{ taskId: "t9", text: "Call the CEO in Dubai", assignee: "Alex Example", status: "OPEN" }],
  };
  const inventedQuality = evaluateAnalysisQuality(invented, fixture);
  assert.equal(inventedQuality.acceptable, false);
  assert.equal(inventedQuality.hallucinatedNames.includes("Alex Example"), true);
});

test("Windows analysis verification fail-closes off Windows without fake analysis text", async () => {
  const result = await runWindowsLocalAnalysisVerification({ platform: "linux" });
  assert.equal(result.windowsVerified, false);
  assert.equal(result.realAiVerified, false);
  assert.equal(result.realAiQualityVerified, undefined);
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
