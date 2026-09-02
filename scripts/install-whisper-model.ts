import { installWhisperModel } from "../src/transcription/WhisperModelInstaller";
import { WHISPER_MODEL_CATALOG } from "../src/transcription/WhisperRuntimeCatalog";

async function main(): Promise<void> {
  const requested = process.argv[2] ?? "ggml-tiny.bin";
  if (requested === "--help" || requested === "-h") {
    process.stdout.write(`Allowlisted models:\n${WHISPER_MODEL_CATALOG.map((entry) => `  ${entry.id}  ${entry.sha256}`).join("\n")}\n`);
    return;
  }
  const result = await installWhisperModel({ modelId: requested });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
