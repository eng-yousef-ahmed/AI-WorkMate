export interface WhisperModelCatalogEntry {
  id: string;
  filename: string;
  url: string;
  sha256: string;
  bytes: number;
}

/** Fixed HTTPS allowlist. Renderer cannot supply URLs. Models are not in Git. */
export const WHISPER_MODEL_CATALOG: readonly WhisperModelCatalogEntry[] = [
  {
    id: "ggml-tiny.bin",
    filename: "ggml-tiny.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
    sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    bytes: 77_691_713,
  },
];

export function getWhisperModelCatalogEntry(id: string): WhisperModelCatalogEntry | undefined {
  return WHISPER_MODEL_CATALOG.find((entry) => entry.id === id || entry.filename === id);
}
