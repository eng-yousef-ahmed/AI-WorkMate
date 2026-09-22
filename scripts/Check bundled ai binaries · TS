/**
 * Packaging-time guard, wired into `npm run package:win` right before
 * `electron-builder`. `whisper-cli.exe`/`llama-cli.exe` are official
 * third-party release binaries (whisper.cpp / llama.cpp) that this repo does
 * not build from source, so they cannot be fetched the way
 * `prepare-bundled-ai-assets.ts` fetches the small default models.
 *
 * Rather than silently shipping an installer with the models but no engine
 * to run them (the exact "works on the maintainer's machine but breaks for
 * the end user" gap this script exists to close), packaging FAILS here with
 * the exact official download link and expected file layout whenever a
 * binary is missing. Drop the extracted release contents into place once,
 * and every future `npm run package:win` picks them up automatically.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

// Compiled to dist/scripts/check-bundled-ai-binaries.js, so __dirname is
// <repo>/dist/scripts at runtime — go up two levels to reach the repo root
// (and therefore the real native/windows-* source directories, not dist/native).
const REPO_ROOT = join(__dirname, "..", "..");

interface RequiredBinary {
  /** Where WindowsLocalWhisperEngine / LocalLlmProvider look for it at runtime. */
  directory: string;
  /** Any one of these satisfies the check (whisper.cpp has renamed its CLI across releases). */
  acceptableNames: readonly string[];
  /** Files that must sit alongside the CLI for it to actually run. */
  requiredSiblings: readonly string[];
  releaseUrl: string;
  releaseAsset: string;
  humanName: string;
}

const REQUIRED_BINARIES: readonly RequiredBinary[] = [
  {
    directory: join(REPO_ROOT, "native", "windows-transcription"),
    acceptableNames: ["whisper-cli.exe", "whisper.exe", "main.exe"],
    requiredSiblings: ["ggml.dll", "whisper.dll"],
    releaseUrl: "https://github.com/ggml-org/whisper.cpp/releases",
    releaseAsset: "whisper-bin-x64.zip (or the CUDA/BLAS variant for the target GPU)",
    humanName: "whisper.cpp CLI (speech-to-text)",
  },
  {
    directory: join(REPO_ROOT, "native", "windows-llm"),
    acceptableNames: ["llama-cli.exe", "llama-completion.exe"],
    requiredSiblings: ["llama.dll", "ggml.dll"],
    releaseUrl: "https://github.com/ggml-org/llama.cpp/releases",
    releaseAsset: "llama-<version>-bin-win-*.zip matching the target CPU/GPU",
    humanName: "llama.cpp CLI (local meeting analysis)",
  },
];

function findPresentName(directory: string, acceptableNames: readonly string[]): string | undefined {
  return acceptableNames.find((name) => existsSync(join(directory, name)));
}

function main(): void {
  let missingCount = 0;
  for (const binary of REQUIRED_BINARIES) {
    const presentName = findPresentName(binary.directory, binary.acceptableNames);
    if (presentName === undefined) {
      missingCount += 1;
      process.stderr.write(
        `\n[MISSING] ${binary.humanName}\n` +
          `  Expected one of: ${binary.acceptableNames.join(", ")}\n` +
          `  In directory:    ${binary.directory}\n` +
          `  Get it from:      ${binary.releaseUrl}\n` +
          `  Asset to grab:    ${binary.releaseAsset}\n` +
          `  Then extract its contents (the .exe AND its .dll files) directly into the directory above.\n`,
      );
      continue;
    }
    const missingSiblings = binary.requiredSiblings.filter((sibling) => !existsSync(join(binary.directory, sibling)));
    if (missingSiblings.length > 0) {
      missingCount += 1;
      process.stderr.write(
        `\n[INCOMPLETE] ${binary.humanName}: found ${presentName} but missing required DLL(s): ${missingSiblings.join(", ")}\n` +
          `  Re-extract the full release archive from ${binary.releaseUrl} (asset: ${binary.releaseAsset}) into ${binary.directory}` +
          " so the CLI and its DLLs sit next to each other.\n",
      );
      continue;
    }
    process.stdout.write(`[OK] ${binary.humanName}: found ${presentName} with required DLLs in ${binary.directory}\n`);
  }
  if (missingCount > 0) {
    process.stderr.write(
      `\n${missingCount} native AI runtime binary set(s) missing or incomplete. Packaging stopped before ` +
        "producing an installer that would ship models with no engine to run them. Fix the item(s) above and re-run.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\nAll bundled native AI runtime binaries are present. Safe to package.\n");
}

main();
