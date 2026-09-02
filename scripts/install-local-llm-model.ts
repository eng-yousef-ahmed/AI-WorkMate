import { installLocalLlmModel } from "../src/ai/LocalLlmModelInstaller";
import { LOCAL_LLM_MODEL_CATALOG } from "../src/ai/LocalLlmRuntimeCatalog";

async function main(): Promise<void> {
  const requested = process.argv[2] ?? "qwen2.5-0.5b-instruct-q4_k_m.gguf";
  if (requested === "--help" || requested === "-h") {
    process.stdout.write(`Allowlisted models:\n${LOCAL_LLM_MODEL_CATALOG.map((entry) => `  ${entry.id}  ${entry.sha256}`).join("\n")}\n`);
    return;
  }
  const result = await installLocalLlmModel({ modelId: requested });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
