export interface LocalLlmModelCatalogEntry {
  id: string;
  filename: string;
  url: string;
  sha256: string;
  bytes: number;
  format: "GGUF";
  family: string;
  instructionTuned: true;
  intendedUse: "offline-meeting-analysis";
}

/** Fixed HTTPS allowlist. Renderer cannot supply URLs. Models are not in Git. */
export const LOCAL_LLM_MODEL_CATALOG: readonly LocalLlmModelCatalogEntry[] = [
  {
    id: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
    filename: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
    url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
    sha256: "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db",
    bytes: 491_400_032,
    format: "GGUF",
    family: "Qwen2.5-0.5B-Instruct",
    instructionTuned: true,
    intendedUse: "offline-meeting-analysis",
  },
];

export const LOCAL_LLM_MODEL_URL_ALLOWLIST_PREFIX = "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/";

export function getLocalLlmModelCatalogEntry(id: string): LocalLlmModelCatalogEntry | undefined {
  return LOCAL_LLM_MODEL_CATALOG.find((entry) => entry.id === id || entry.filename === id);
}
