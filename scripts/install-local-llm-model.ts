import { installLocalLlmModel } from "../src/ai/LocalLlmModelInstaller";
import { LOCAL_LLM_MODEL_CATALOG, PRODUCTION_LOCAL_LLM_MODEL_ID } from "../src/ai/LocalLlmRuntimeCatalog";

async function main(): Promise<void> {
  const requested = process.argv[2] ?? PRODUCTION_LOCAL_LLM_MODEL_ID;
  if (requested === "--help" || requested === "-h") {
    process.stdout.write(
      `Allowlisted models:\n${LOCAL_LLM_MODEL_CATALOG.map((entry) => `  ${entry.id}  (${entry.role}${entry.splitGguf ? ", split GGUF" : ""})\n    ${entry.files.map((file) => `${file.filename}  ${file.sha256}  ${file.bytes}`).join("\n    ")}`).join("\n")}\n`,
    );
    return;
  }
  const result = await installLocalLlmModel({ modelId: requested });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
