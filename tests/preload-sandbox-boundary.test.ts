import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { test } from "node:test";

const PRELOAD_TS = resolve("src/desktop/preload.ts");
const PRELOAD_JS = resolve("dist/src/desktop/preload.js");

const FORBIDDEN_MODULES = new Set([
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "child_process",
  "node:child_process",
  "node:sqlite",
  "sqlite",
  "net",
  "node:net",
  "http",
  "node:http",
  "https",
  "node:https",
  "os",
  "node:os",
  "crypto",
  "node:crypto",
  "dgram",
  "tls",
  "dns",
]);

const FORBIDDEN_BASENAMES = [
  "runtime-ipc.js",
  "LocalRuntimeSetupService.js",
  "LocalDatabase.js",
  "storage-ipc.js",
  "WhisperModelInstaller.js",
  "LocalLlmModelInstaller.js",
];

test("sandboxed preload source never value-imports main-process runtime IPC", () => {
  const source = readFileSync(PRELOAD_TS, "utf8");
  assert.match(source, /from "\.\/runtime-api"/);
  assert.equal(/from ["']\.\/runtime-ipc["']/.test(source), false);
  assert.equal(/from ["']\.\/storage-ipc["']/.test(source), false);
  assert.equal(/from ["']node:fs/.test(source), false);
  assert.equal(/from ["']node:child_process["']/.test(source), false);
});

test("compiled preload require graph stays sandbox-safe", () => {
  assert.equal(existsSync(PRELOAD_JS), true, "preload.js must be built before this test");
  const seen = new Set<string>();
  const queue = [PRELOAD_JS];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    for (const banned of FORBIDDEN_BASENAMES) {
      assert.equal(file.endsWith(banned), false, `preload graph must not load ${banned}`);
    }
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
      const spec = match[2];
      if (spec === undefined) {
        continue;
      }
      assert.equal(FORBIDDEN_MODULES.has(spec), false, `${file} requires forbidden ${spec}`);
      if (spec.startsWith(".") || spec.startsWith("/")) {
        let resolved = isAbsolute(spec) ? spec : resolve(dirname(file), spec);
        if (!resolved.endsWith(".js") && existsSync(`${resolved}.js`)) {
          resolved = `${resolved}.js`;
        }
        if (existsSync(resolved)) {
          queue.push(resolved);
        }
      } else {
        assert.equal(spec === "electron", true, `${file} may only require electron or relative modules, got ${spec}`);
      }
    }
  }
  assert.equal(seen.has(PRELOAD_JS), true);
  assert.equal(seen.size >= 2, true, "preload must require renderer-safe channel modules");
});
