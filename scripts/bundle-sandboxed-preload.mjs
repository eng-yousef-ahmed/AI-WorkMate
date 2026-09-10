import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Electron 20+ sandboxed preload (`sandbox: true`) polyfills `require` so it
 * can load `electron` only — not `./storage-api`. Relative requires throw
 * before `contextBridge.exposeInMainWorld`, so `window.aiWorkMate` is missing
 * and Storage shows Unavailable. Inline renderer-safe CJS siblings into one
 * preload file that requires only `electron`.
 */
const PRELOAD = "dist/src/desktop/preload.js";

function resolveJs(fromFile, spec) {
  const base = join(dirname(fromFile), spec);
  const candidates = spec.endsWith(".js") ? [base] : [base, `${base}.js`];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`sandboxed preload bundle cannot resolve ${spec} from ${fromFile}`);
}

function loadAsCjsExpression(file, seen) {
  if (seen.has(file)) {
    throw new Error(`circular require while bundling sandboxed preload: ${file}`);
  }
  seen.add(file);
  const source = inlineRelativeRequires(readFileSync(file, "utf8"), file, seen);
  return `(function () {\nconst exports = {};\nconst module = { exports };\n${source}\nreturn module.exports;\n})()`;
}

function inlineRelativeRequires(source, fromFile, seen) {
  return source.replace(/require\((['"])([^'"]+)\1\)/g, (match, _quote, spec) => {
    if (spec === "electron") {
      return match;
    }
    if (spec.startsWith(".")) {
      return loadAsCjsExpression(resolveJs(fromFile, spec), seen);
    }
    throw new Error(`${fromFile} requires ${spec}; sandboxed preload may only require electron`);
  });
}

const bundled = inlineRelativeRequires(readFileSync(PRELOAD, "utf8"), PRELOAD, new Set());
if (/require\((['"])\./.test(bundled)) {
  throw new Error("bundled preload still contains a relative require");
}
writeFileSync(PRELOAD, bundled);
