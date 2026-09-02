# Local llama.cpp runtime (not in Git)

AI WorkMate's production analysis path uses a **llama.cpp-compatible** CLI and a GGUF instruct model. Neither the executable nor the model is committed.

## Windows layout

```text
%LOCALAPPDATA%\AI-WorkMate\native\llama-cli.exe
%LOCALAPPDATA%\AI-WorkMate\models\llm\qwen2.5-0.5b-instruct-q4_k_m.gguf
```

Copy a Windows `llama-cli.exe` (CPU build is enough) into the native folder. Install the allowlisted model with:

```bat
npm run install:local-llm-model -- qwen2.5-0.5b-instruct-q4_k_m.gguf
```

The installer uses HTTPS only, an allowlisted Hugging Face URL, atomic download, and SHA-256/size checks. Renderer code cannot supply URLs, executable paths, or argv.

## Verification

```bat
npm run verify:windows-local-analysis
```

`windowsVerified` and `realAiVerified` are true only when the real CLI and model produce a validated `AnalysisDocument` that is persisted through `saveAnalysis()`. Linux fail-closes.

## Status

This directory documents the external runtime. It does not contain binaries.
