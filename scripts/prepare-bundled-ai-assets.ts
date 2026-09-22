/**
 * Packaging-time step (run on the Windows build machine before
 * `electron-builder`, wired into `npm run package:win`). It does NOT weaken
 * or bypass the production installers' security boundary: it calls the same
 * `installWhisperModel()` / `installLocalLlmModel()` functions end users get
 * (fixed HTTPS allowlist, hardcoded SHA-256, atomic write) so the download is
 * verified exactly once, then copies the already-verified file into the
 * `extraResources` staging directories declared in package.json's `build`
 * config, and independently re-hashes the copy before trusting it.
 *
 * This intentionally bundles only the SMALL default models so a first launch
 * can transcribe and analyze immediately with no manual step:
 *   - Whisper `ggml-tiny.bin` (~78 MB) for local speech-to-text.
 *   - Qwen2.5-0.5B-Instruct Q4_K_M (~491 MB), the documented "smoke-test"
 *     analysis model — proves llama.cpp runs, but is explicitly NOT the
 *     production-quality model. `npm run install:local-llm-model --
 *     qwen2.5-7b-instruct-q4_k_m` remains the documented one-command upgrade
 *     to the ~4.7 GB production model; that size makes it a deliberate
 *     opt-in rather than something bundled into every installer.
 *
 * This script stages MODELS only. `whisper-cli.exe`/`llama-cli.exe` and
 * their runtime DLLs are official third-party release binaries this repo
 * does not build, so they are not fetched here — see
 * `scripts/check-bundled-ai-binaries.ts`, which fails the build loudly with
 * exact instructions if they are not already staged next to the models.
 */
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

import { installWhisperModel, whisperManagedModelDirectory } from "../src/transcription/WhisperModelInstaller";
import { WHISPER_TINY_MODEL_ID } from "../src/transcription/WhisperRuntimeCatalog";
import { installLocalLlmModel, localLlmManagedModelDirectory } from "../src/ai/LocalLlmModelInstaller";
import { SMOKE_TEST_LOCAL_LLM_MODEL_ID } from "../src/ai/LocalLlmRuntimeCatalog";

// Compiled to dist/scripts/prepare-bundled-ai-assets.js, so __dirname is
// <repo>/dist/scripts at runtime — go up two levels to reach the repo root
// (and therefore the real native/windows-* staging directories, not dist/native).
const REPO_ROOT = join(__dirname, "..", "..");
const WHISPER_STAGE_DIR = join(REPO_ROOT, "native", "windows-transcription", "models");
const LLM_STAGE_DIR = join(REPO_ROOT, "native", "windows-llm", "models");

async function sha256OfFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function copyAndVerify(sourcePath: string, destDir: string, filename: string, expectedSha256: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const destPath = join(destDir, filename);
  await copyFile(sourcePath, destPath);
  const actualSha256 = await sha256OfFile(destPath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Staged copy of ${filename} failed integrity re-check (expected ${expectedSha256}, got ${actualSha256}). ` +
        "Refusing to bundle an unverified file.",
    );
  }
  process.stdout.write(`  staged ${filename} -> ${destPath} (sha256 verified)\n`);
}

/**
 * The production installers deliberately only accept a destination inside
 * `%LOCALAPPDATA%\AI-WorkMate\...` (see `assertManagedDestination` /
 * `assertManagedLocalLlmDestination`). Rather than loosening that guard for
 * packaging convenience, this script points `localAppData` at a disposable
 * staging folder for the duration of the download, then copies the verified
 * result into the real `extraResources` bundle directory.
 */
function stagingLocalAppData(): string {
  return process.env.AI_WORKMATE_PACKAGE_LOCALAPPDATA ?? mkdtempSync(join(tmpdir(), "ai-workmate-package-localappdata-"));
}

async function stageWhisperModel(localAppData: string): Promise<void> {
  process.stdout.write(`Fetching Whisper model "${WHISPER_TINY_MODEL_ID}" (verified download)...\n`);
  const result = await installWhisperModel({ modelId: WHISPER_TINY_MODEL_ID, localAppData });
  const sourcePath = join(whisperManagedModelDirectory(localAppData), result.filename);
  await copyAndVerify(sourcePath, WHISPER_STAGE_DIR, result.filename, result.sha256);
}

async function stageLocalLlmModel(localAppData: string): Promise<void> {
  process.stdout.write(`Fetching local LLM model "${SMOKE_TEST_LOCAL_LLM_MODEL_ID}" (verified download)...\n`);
  const result = await installLocalLlmModel({ modelId: SMOKE_TEST_LOCAL_LLM_MODEL_ID, localAppData });
  const sourceDir = localLlmManagedModelDirectory(localAppData);
  for (const file of result.files) {
    await copyAndVerify(join(sourceDir, file.filename), LLM_STAGE_DIR, file.filename, file.sha256);
  }
}

async function main(): Promise<void> {
  if (process.platform !== "win32" && process.env.AI_WORKMATE_ALLOW_NON_WINDOWS_PACKAGING !== "1") {
    throw new Error(
      "prepare-bundled-ai-assets is a Windows packaging step (it stages Windows-only runtime assets). " +
        "Run it on the Windows build machine, or set AI_WORKMATE_ALLOW_NON_WINDOWS_PACKAGING=1 to force it " +
        "(only useful for exercising the staging/copy/verify logic itself, e.g. in CI).",
    );
  }
  const localAppData = stagingLocalAppData();
  process.stdout.write(`Staging LOCALAPPDATA for this run: ${localAppData}\n`);
  await stageWhisperModel(localAppData);
  await stageLocalLlmModel(localAppData);
  process.stdout.write(
    "\nDefault models staged. Run `npm run check:bundled-ai-binaries` (also wired into `npm run package:win`) " +
      "before packaging: it fails loudly if whisper-cli.exe/llama-cli.exe and their DLLs are not already " +
      "sitting next to the staged models.\n",
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
