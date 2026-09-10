import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const RENDERER_DIR = join(process.cwd(), "dist/src/renderer");
const HTML_PATH = join(RENDERER_DIR, "storage-settings.html");

test("Node16 CJS preamble throws in a sandboxed classic script without exports", () => {
  assert.throws(() => {
    vm.runInNewContext(
      `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\n`,
      Object.create(null) as vm.Context,
    );
  }, /exports is not defined/);
});

test("packaged renderer HTML keeps classic file:// scripts (not type=module)", () => {
  const html = readFileSync(HTML_PATH, "utf8");
  assert.match(html, /<script src="\.\/storage-settings\.js"><\/script>/);
  assert.match(html, /<script src="\.\/meetings-hub\.js"><\/script>/);
  assert.match(html, /<script src="\.\/tasks\.js"><\/script>/);
  assert.match(html, /<script src="\.\/automation\.js"><\/script>/);
  assert.match(html, /<script src="\.\/notifications\.js"><\/script>/);
  assert.equal(/<script\s[^>]*type\s*=\s*["']module["']/.test(html), false);
});

test("built renderer JS is classic-script safe and Storage boot fills Loading placeholders", async () => {
  const files = readdirSync(RENDERER_DIR).filter((name) => name.endsWith(".js"));
  assert.ok(files.includes("storage-settings.js"));
  for (const name of files) {
    const source = readFileSync(join(RENDERER_DIR, name), "utf8");
    assert.equal(source.includes("Object.defineProperty(exports"), false, name);
    assert.equal(/\brequire\s*\(/.test(source), false, name);
    assert.match(source, /^\s*"use strict";\s*\(function\s*\(\)\s*\{/m);
  }

  const texts = new Map<string, string>();
  const sandbox = createRendererSandbox(texts);
  vm.runInNewContext(readFileSync(join(RENDERER_DIR, "storage-settings.js"), "utf8"), sandbox, {
    filename: "storage-settings.js",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(texts.get("data-location"), "Local workspace (path hidden)");
  assert.equal(texts.get("runtime-badge"), "Setup required");
  assert.equal(texts.get("runtime-transcription-status"), "Not installed on this computer");
  assert.equal(texts.get("runtime-analysis-status"), "Not installed on this computer");
  assert.equal(texts.get("availability"), "100 B available");
  assert.equal(texts.get("data-location") === "Loading…", false);
  assert.equal(texts.get("runtime-badge") === "Checking…", false);
});

function createRendererSandbox(texts: Map<string, string>): vm.Context {
  const never = async (): Promise<never> => {
    throw new Error("unexpected renderer API call in classic-script test");
  };
  const snapshot = {
    dataLocation: { type: "LOCAL", label: "Local workspace (path hidden)", pathExposed: false as const },
    stats: {
      totalBytes: 0,
      recordingsBytes: 0,
      audioBytes: 0,
      transcriptsBytes: 0,
      documentsBytes: 0,
      databaseBytes: 0,
      availableBytes: 100,
      fileCount: 0,
      meetingCount: 0,
    },
    storageVersion: 11,
    aiProcessingPolicy: "ASK_EACH_TIME" as const,
  };
  const runtimeSnapshot = {
    transcription: {
      id: "transcription-tiny",
      displayName: "Local transcription model",
      helperReady: false,
      modelPresent: false,
      checksumVerified: false,
      ready: false,
      installRequired: true,
    },
    analysis: {
      id: "analysis-production",
      displayName: "Local analysis model",
      helperReady: false,
      modelPresent: false,
      checksumVerified: false,
      ready: false,
      installRequired: true,
    },
    modelsOutsideDataRoot: true as const,
    cloudFallbackEnabled: false as const,
    busy: false,
  };

  function element(id: string): Record<string, unknown> {
    const record: Record<string, unknown> = {
      id,
      hidden: false,
      disabled: false,
      checked: false,
      value: id === "ai-policy" ? "ASK_EACH_TIME" : "",
      className: "",
      style: { width: "" },
      dataset: {},
      open: false,
      classList: {
        add: () => undefined,
        remove: () => undefined,
        toggle: () => undefined,
      },
      addEventListener: () => undefined,
      append: () => undefined,
      replaceChildren: () => undefined,
      querySelectorAll: () => [],
      setAttribute: () => undefined,
      contains: () => false,
    };
    Object.defineProperty(record, "textContent", {
      get: () => texts.get(id) ?? "",
      set: (value: string) => {
        texts.set(id, value);
      },
      enumerable: true,
    });
    return record;
  }

  const windowObject: Record<string, unknown> = {
    confirm: () => false,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener: () => undefined,
    aiWorkMate: {
      storage: {
        getSnapshot: async () => snapshot,
        getLifecycle: never,
        chooseInitialLocation: never,
        prepareLocationChange: never,
        confirmLocationChange: never,
        openDataFolder: never,
        verifyStorage: never,
        repairStorage: never,
        createBackup: never,
        restoreBackup: never,
        exportMeeting: never,
        exportOfficeDocument: never,
        setAiProcessingPolicy: never,
        syncMicrosoftCalendar: never,
      },
      calendar: {
        getMicrosoftStatus: async () => undefined,
        beginMicrosoftSignIn: never,
        completeMicrosoftSignIn: never,
        cancelMicrosoftSignIn: never,
        disconnectMicrosoft: never,
        syncMicrosoftCalendarAuto: never,
        syncMicrosoftCalendar: never,
        saveMicrosoftOAuthConfig: never,
        getGoogleStatus: async () => undefined,
        beginGoogleSignIn: never,
        completeGoogleSignIn: never,
        cancelGoogleSignIn: never,
        disconnectGoogle: never,
        syncGoogleCalendarAuto: never,
        saveGoogleOAuthConfig: never,
      },
      runtime: {
        getSnapshot: async () => runtimeSnapshot,
        install: never,
      },
    },
  };

  const documentObject = {
    getElementById: (id: string) => element(id),
    addEventListener: () => undefined,
    createElement: (tag: string) => element(tag),
  };
  windowObject.document = documentObject;

  return vm.createContext({
    window: windowObject,
    document: documentObject,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Error,
    JSON,
    Math,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  });
}
