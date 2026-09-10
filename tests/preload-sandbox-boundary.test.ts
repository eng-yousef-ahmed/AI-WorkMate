import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const PRELOAD_TS = resolve("src/desktop/preload.ts");
const PRELOAD_JS = resolve("dist/src/desktop/preload.js");

test("sandboxed preload source never value-imports main-process runtime IPC", () => {
  const source = readFileSync(PRELOAD_TS, "utf8");
  assert.match(source, /from "\.\/runtime-api"/);
  assert.equal(/from ["']\.\/runtime-ipc["']/.test(source), false);
  assert.equal(/from ["']\.\/storage-ipc["']/.test(source), false);
  assert.equal(/from ["']node:fs/.test(source), false);
  assert.equal(/from ["']node:child_process["']/.test(source), false);
});

test("packaged sandboxed preload requires only electron and exposes aiWorkMate", () => {
  assert.equal(existsSync(PRELOAD_JS), true, "preload.js must be built before this test");
  const source = readFileSync(PRELOAD_JS, "utf8");
  assert.equal(/\brequire\((['"])\./.test(source), false, "relative require is rejected by Electron sandbox polyfill");
  assert.match(source, /require\(["']electron["']\)/);
  assert.equal(/\brequire\((['"])[^'"]*runtime-ipc/.test(source), false);
  assert.equal(/\brequire\((['"])[^'"]*storage-ipc/.test(source), false);
  assert.equal(/\brequire\((['"])[^'"]*LocalRuntimeSetupService/.test(source), false);

  const exposed: Record<string, { storage?: { getSnapshot?: unknown }; runtime?: { getSnapshot?: unknown }; calendar?: { getMicrosoftStatus?: unknown } }> = {};
  const electron = {
    contextBridge: {
      exposeInMainWorld(name: string, api: (typeof exposed)[string]): void {
        exposed[name] = api;
      },
    },
    ipcRenderer: {
      invoke: async () => undefined,
      on(): void {
        return;
      },
      removeListener(): void {
        return;
      },
    },
  };
  const requireFn = (spec: string): unknown => {
    if (spec === "electron") {
      return electron;
    }
    throw new Error(`sandboxed preload cannot require ${spec}`);
  };
  const module = { exports: {} };
  const run = new Function("require", "module", "exports", "__dirname", "__filename", source) as (
    requireImpl: (spec: string) => unknown,
    moduleImpl: { exports: object },
    exportsImpl: object,
    dirname: string,
    filename: string,
  ) => void;
  run(
    requireFn,
    module,
    module.exports,
    "C:\\\\Program Files\\\\AI-WorkMate\\\\resources\\\\app.asar\\\\dist\\\\src\\\\desktop",
    "C:\\\\Program Files\\\\AI-WorkMate\\\\resources\\\\app.asar\\\\dist\\\\src\\\\desktop\\\\preload.js",
  );
  assert.equal(typeof exposed.aiWorkMate?.storage?.getSnapshot, "function");
  assert.equal(typeof exposed.aiWorkMate?.runtime?.getSnapshot, "function");
  assert.equal(typeof exposed.aiWorkMate?.calendar?.getMicrosoftStatus, "function");
});
