export type LocalLlmModelRole = "smoke-test" | "production-analysis";

export interface LocalLlmModelFile {
  filename: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface LocalLlmModelCatalogEntry {
  id: string;
  filename: string;
  url: string;
  sha256: string;
  bytes: number;
  files: readonly LocalLlmModelFile[];
  format: "GGUF";
  family: string;
  instructionTuned: true;
  intendedUse: "offline-meeting-analysis";
  role: LocalLlmModelRole;
  splitGguf: boolean;
}

export const SMOKE_TEST_LOCAL_LLM_MODEL_ID = "qwen2.5-0.5b-instruct-q4_k_m.gguf";
export const PRODUCTION_LOCAL_LLM_MODEL_ID = "qwen2.5-7b-instruct-q4_k_m";

const QWEN_05B_PREFIX = "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/";
const QWEN_7B_PREFIX = "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/";

/** Fixed HTTPS allowlist. Renderer cannot supply URLs. Models are not in Git. */
export const LOCAL_LLM_MODEL_URL_ALLOWLIST_PREFIXES = [QWEN_05B_PREFIX, QWEN_7B_PREFIX] as const;

/** @deprecated Use LOCAL_LLM_MODEL_URL_ALLOWLIST_PREFIXES. Kept for the 0.5B smoke-test repo. */
export const LOCAL_LLM_MODEL_URL_ALLOWLIST_PREFIX = QWEN_05B_PREFIX;

const SMOKE_TEST_FILE: LocalLlmModelFile = {
  filename: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
  url: `${QWEN_05B_PREFIX}resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf`,
  sha256: "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db",
  bytes: 491_400_032,
};

const PRODUCTION_SHARD_1: LocalLlmModelFile = {
  filename: "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
  url: `${QWEN_7B_PREFIX}resolve/main/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf`,
  sha256: "dfce12e3862a5283ccfb88221b48480e58745165de856439950d0f22590580db",
  bytes: 3_993_201_344,
};

const PRODUCTION_SHARD_2: LocalLlmModelFile = {
  filename: "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf",
  url: `${QWEN_7B_PREFIX}resolve/main/qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf`,
  sha256: "539cf93f78e887edea1c04e2d7d8cdaca9d01dae9c9025bcb8accbe29df3d72a",
  bytes: 689_872_288,
};

export const LOCAL_LLM_MODEL_CATALOG: readonly LocalLlmModelCatalogEntry[] = [
  {
    id: SMOKE_TEST_LOCAL_LLM_MODEL_ID,
    filename: SMOKE_TEST_FILE.filename,
    url: SMOKE_TEST_FILE.url,
    sha256: SMOKE_TEST_FILE.sha256,
    bytes: SMOKE_TEST_FILE.bytes,
    files: [SMOKE_TEST_FILE],
    format: "GGUF",
    family: "Qwen2.5-0.5B-Instruct",
    instructionTuned: true,
    intendedUse: "offline-meeting-analysis",
    role: "smoke-test",
    splitGguf: false,
  },
  {
    id: PRODUCTION_LOCAL_LLM_MODEL_ID,
    filename: PRODUCTION_SHARD_1.filename,
    url: PRODUCTION_SHARD_1.url,
    sha256: PRODUCTION_SHARD_1.sha256,
    bytes: PRODUCTION_SHARD_1.bytes,
    files: [PRODUCTION_SHARD_1, PRODUCTION_SHARD_2],
    format: "GGUF",
    family: "Qwen2.5-7B-Instruct",
    instructionTuned: true,
    intendedUse: "offline-meeting-analysis",
    role: "production-analysis",
    splitGguf: true,
  },
];

export function isAllowlistedLocalLlmModelUrl(url: string): boolean {
  return url.startsWith("https://") && LOCAL_LLM_MODEL_URL_ALLOWLIST_PREFIXES.some((prefix) => url.startsWith(prefix));
}

export function getLocalLlmModelCatalogEntry(id: string): LocalLlmModelCatalogEntry | undefined {
  return LOCAL_LLM_MODEL_CATALOG.find(
    (entry) => entry.id === id || entry.filename === id || entry.files.some((file) => file.filename === id),
  );
}

export function catalogLocalLlmPrimaryFilenames(): string[] {
  return LOCAL_LLM_MODEL_CATALOG.map((entry) => entry.filename);
}

/**
 * Production default is the 7B Q4_K_M split GGUF. Override with
 * AI_WORKMATE_LOCAL_LLM_MODEL_ID (catalog id or filename).
 */
export function resolveSelectedLocalLlmModelId(envValue = process.env.AI_WORKMATE_LOCAL_LLM_MODEL_ID): string {
  const requested = envValue?.trim();
  if (requested === undefined || requested.length === 0) {
    return PRODUCTION_LOCAL_LLM_MODEL_ID;
  }
  const entry = getLocalLlmModelCatalogEntry(requested);
  if (entry === undefined) {
    return PRODUCTION_LOCAL_LLM_MODEL_ID;
  }
  return entry.id;
}

export function getSelectedLocalLlmModelCatalogEntry(envValue = process.env.AI_WORKMATE_LOCAL_LLM_MODEL_ID): LocalLlmModelCatalogEntry {
  const entry = getLocalLlmModelCatalogEntry(resolveSelectedLocalLlmModelId(envValue));
  if (entry === undefined) {
    return LOCAL_LLM_MODEL_CATALOG.find((item) => item.role === "production-analysis") ?? LOCAL_LLM_MODEL_CATALOG[0]!;
  }
  return entry;
}
