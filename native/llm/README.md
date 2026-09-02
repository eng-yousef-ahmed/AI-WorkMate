# Local llama.cpp runtime (not in Git)

AI WorkMate's production analysis path uses a **llama.cpp-compatible** CLI and a GGUF instruct model. Neither the executable nor the model is committed.

## Windows layout

```text
%LOCALAPPDATA%\AI-WorkMate\native\llama-cli.exe
%LOCALAPPDATA%\AI-WorkMate\models\llm\qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf
%LOCALAPPDATA%\AI-WorkMate\models\llm\qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf
```

Optional smoke-test model (not production quality):

```text
%LOCALAPPDATA%\AI-WorkMate\models\llm\qwen2.5-0.5b-instruct-q4_k_m.gguf
```

Copy a Windows `llama-cli.exe` / `llama-completion.exe` (CPU build is enough) into the native folder.

## Models

| Role | Catalog id | Official files |
| --- | --- | --- |
| Production analysis | `qwen2.5-7b-instruct-q4_k_m` | Official Qwen split Q4_K_M (2 GGUF shards). llama.cpp `-m` the `00001-of-00002` file; the second shard must sit beside it. |
| Smoke-test / runtime only | `qwen2.5-0.5b-instruct-q4_k_m.gguf` | Single official Qwen 0.5B Q4_K_M GGUF. |

Install (HTTPS allowlist, atomic download, SHA-256/size per shard). Renderer cannot supply URLs.

```bat
npm run install:local-llm-model -- qwen2.5-7b-instruct-q4_k_m
```

Select the model without changing the analysis pipeline:

```bat
set AI_WORKMATE_LOCAL_LLM_MODEL_ID=qwen2.5-7b-instruct-q4_k_m
```

`0.5B` remains available as `AI_WORKMATE_LOCAL_LLM_MODEL_ID=qwen2.5-0.5b-instruct-q4_k_m.gguf`.

## Verification

```bat
npm run verify:windows-local-analysis
```

`windowsVerified` and `realAiVerified` are true only when the real CLI and model produce a validated `AnalysisDocument` persisted through `saveAnalysis()`. **REAL-AI-QUALITY-VERIFIED** still requires a real Windows run of the **7B** model with a meaningful summary and extracted decisions/tasks. Linux fail-closes.

## Status

This directory documents the external runtime. It does not contain binaries.
