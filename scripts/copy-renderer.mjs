import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Packaged Electron loads renderer JS as classic `file://` scripts
 * (`<script src="./storage-settings.js">`, not type=module — ES modules
 * fail CORS on file://). `tsc` with Node16/CommonJS emits
 * `Object.defineProperty(exports, "__esModule", …)` which throws
 * `exports is not defined` in that environment before any Storage IPC
 * runs, leaving Loading/Checking forever. Rewrite to a classic IIFE.
 */
export function toClassicRendererScript(source, fileName) {
  let body = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  body = body.replace(/^"use strict";\n/, "");
  body = body.replace(/^Object\.defineProperty\(exports, ["']__esModule["'], \{ value: true \}\);\n/, "");
  if (
    /\brequire\s*\(/.test(body) ||
    /\bmodule\.exports\b/.test(body) ||
    /\bexports\b/.test(body) ||
    /^\s*import\s/m.test(body) ||
    /^\s*export\s/m.test(body)
  ) {
    throw new Error(
      `${fileName} is not a browser classic script (contains CommonJS/ESM module syntax). Renderer TypeScript must use import type only so packaged file:// pages can run it.`,
    );
  }
  return `"use strict";\n(function () {\n${body}\n})();\n`;
}

const rendererDir = "dist/src/renderer";
await mkdir(rendererDir, { recursive: true });
await cp("src/renderer/storage-settings.html", join(rendererDir, "storage-settings.html"));
await cp("src/renderer/storage-settings.css", join(rendererDir, "storage-settings.css"));

const files = (await readdir(rendererDir)).filter((name) => name.endsWith(".js"));
if (files.length === 0) {
  throw new Error("No compiled renderer JavaScript found under dist/src/renderer.");
}
for (const name of files) {
  const path = join(rendererDir, name);
  const source = await readFile(path, "utf8");
  await writeFile(path, toClassicRendererScript(source, name));
}
