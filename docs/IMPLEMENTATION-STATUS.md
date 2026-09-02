# AI WorkMate implementation status

Updated: 2026-09-02

This checkout hardens the existing local-first storage foundation, adds the Phase 4 Microsoft 365 calendar discovery integration layer, implements the Phase 5 local recording/capture boundary, adds the Phase 6A native Windows capture source boundary, implements Phase 6B Windows native audio provider code with real Windows helper verification, integrates that path into `StorageRuntime` (Phase 6C), adds Phase 7A local transcription of committed AIWPCM recordings, Phase 7B production wiring for local whisper.cpp, and Phase 7C Windows runtime/model install plus verification support. It does not
implement real Teams/Zoom/Google Meet/browser automation, screen/window capture, a Git-bundled Whisper binary/model, or the full AI pipeline. The persistent meeting store
remains local SQLite plus filesystem artifacts; that does **not** mean that an
explicitly approved cloud AI request is local.

## Status vocabulary

- **IMPLEMENTED** — the behavior is present in the production code.
- **TESTED** — an automated Linux-runnable test exercised the behavior.
- **CODE-VERIFIED** — the production wiring, static types, and configuration were reviewed and built, but the behavior was not exercised in a Windows GUI/installer environment.
- **NOT TESTED** — no automated or manual execution was available for the item.
- **WINDOWS-UNVERIFIED** — Windows-specific execution is required before this can be called tested; Linux tests only cover portable logic or Windows-style policy cases.
- **WINDOWS-VERIFIED** — the behavior was executed on a real Windows host with the real native implementation.
- **REMAINING GAP** — intentionally deferred work or a limitation of this phase.

## IMPLEMENTED

### Transcript → AI analysis pipeline

- **IMPLEMENTED / TESTED:** `LocalAnalysisService.analyzeCommittedTranscript()` loads a committed transcript by meeting UUID + recording UUID, enforces `AIProcessingPolicyEnforcer` **before** any provider receives content, then calls `LocalFirstStore.processTranscriptWithProvider()` → strict JSON/`AnalysisDocument` validation → `saveAnalysis()`.
- **IMPLEMENTED / TESTED:** `LOCAL_ONLY` blocks cloud providers without transmission. `ASK_EACH_TIME` requires `userApprovedForThisRequest`. `CLOUD_ALLOWED` may use an injected cloud transport. Production default is `LocalLlmProvider` (llama.cpp). Missing CLI/model fail closed and **does not invent** summaries/decisions/tasks. No API keys, no test network calls, no cloud database.
- **IMPLEMENTED / TESTED:** Analysis artifacts live under `DATA_ROOT/.../Analysis/` through the artifact journal (SHA-256, atomic write). SQLite indexes metadata and structured decision/task rows only. Invalid JSON, wrong meeting ID, schema-invalid tasks/decisions, and provider failure mark `FAILED` without claiming success. Interrupted `ANALYSIS_STARTED` recovers to `INCOMPLETE`.
- **IMPLEMENTED / TESTED:** `StorageRuntime.analyzeCommittedTranscript()` is main-process only. No renderer analysis IPC, paths, provider URLs, or secrets.
- **WINDOWS-VERIFIED: NO / REAL-AI-VERIFIED: NO** — Linux tests cover the pipeline and fail-closed verification. Real llama.cpp generation on Windows is pending.

### Local llama.cpp runtime

- **IMPLEMENTED / TEST-VERIFIED / CODE-VERIFIED:** `LocalLlmProvider` spawns `llama-cli.exe` with a fixed argv after discovering `%LOCALAPPDATA%\\AI-WorkMate\\native\\` and an allowlisted GGUF under `models\\llm\\`. HTTPS installer, checksum/size, truncated/invalid GGUF rejection, path traversal rejection, timeout/crash/cancel/malformed JSON fail closed.
- **IMPLEMENTED / TEST-VERIFIED:** `npm run install:local-llm-model` and `npm run verify:windows-local-analysis`. Linux verification sets `windowsVerified: false` and `realAiVerified: false` without fabricating summary text.
- **REAL-AI-VERIFIED: NO** — this Linux sandbox did not execute a real GGUF model.

### PHASE 7C Windows runtime/model installation and verification

- **IMPLEMENTED / TESTED:** Allowlisted model install (`npm run install:whisper-model`) downloads only `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin`, writes atomically under `%LOCALAPPDATA%\AI-WorkMate\models\whisper\`, and fail-closes on SHA-256/size mismatch or interrupt. No renderer URL. CLI install remains a documented manual copy of `whisper-cli.exe`.
- **IMPLEMENTED / TESTED:** `discoverWhisperRuntime()` and `npm run verify:windows-local-transcription` report helper/model presence, checksum, spoken-fixture transcription, journal/SQLite/lifecycle, and `cloudServiceUsed: false`. Linux fail-closes with `windowsVerified: false`.
- **WINDOWS-VERIFIED:** After commit `b43172f0` (little-endian `GGML_FILE_MAGIC`), a real Windows host ran `npm run verify:windows-local-transcription` with whisper.cpp 1.9.3: `success` true, `windowsVerified` true, `platform` `win32`, `helperFound` true (`whisper-cli.exe`), `modelFound` true (`ggml-tiny.bin`), `engineVersion` `whisper.cpp version: 1.9.3`, `transcriptionStarted`/`transcriptionCompleted` true, `recognizedText` `AI Workmate records meetings locally. This spoken fixture is for Windows Whisper Verification only.`, `sqliteStatus`/`journalStatus` `COMMITTED`, `meetingStatus` `COMPLETED`, `cloudServiceUsed` false, `isolatedWorkspace` true, `userDataUntouched` true. Linux runs of the same command remain fail-closed and are not a Windows claim.

### PHASE 7B real local whisper.cpp engine

- **IMPLEMENTED / TESTED:** `WindowsLocalWhisperEngine` is the production `TranscriptionEngine`. It locates `whisper-cli.exe` and a ggml/gguf model from controlled paths (`%LOCALAPPDATA%\AI-WorkMate\...` or packaged extraResources), converts capture PCM to 16 kHz mono 16-bit WAV, and spawns whisper.cpp with a fixed argument list. No renderer-supplied executable or extra argv. Audio stays local.
- **IMPLEMENTED / TESTED:** Missing CLI/model → `TRANSCRIPTION_ENGINE_UNAVAILABLE`. Invalid model magic/size, malformed JSON, process crash, timeout, cancellation, empty PCM, and path traversal fail closed. Tests inject helper doubles only; production still calls the real spawn path.
- **IMPLEMENTED / TESTED / WINDOWS-VERIFIED:** `npm run verify:windows-local-transcription` fail-closes on non-Windows (`windowsVerified: false`). On a real Windows host after `b43172f0` it completed with real whisper.cpp 1.9.3 output (see Phase 7C).
- **REMAINING GAP:** whisper.cpp CLI and ggml models are not committed or packaged by default. Speaker diarization is not implemented.

### PHASE 7A local transcription of committed recordings

- **IMPLEMENTED / TESTED:** `LocalTranscriptionService` loads a committed recording by meeting UUID + recording UUID, validates AIWPCM JSONL (types, format metadata, sequence, per-chunk SHA-256, emptiness), reconstructs PCM/WAV in memory, calls an injected local `TranscriptionEngine`, and persists transcript artifacts under `DATA_ROOT/Meetings/.../Transcript/` through journaled `saveTranscript()`.
- **IMPLEMENTED / TESTED:** SQLite schema version 6 indexes transcript metadata only (`recording_id`, `engine_id`, artifact IDs, language). Transcript bytes are files, not BLOBs. `COMPLETED` is set only after verified artifacts + metadata. Non-retryable failures mark `FAILED`; retryable/interrupted work marks `INCOMPLETE`. Restart recovery of an in-flight transcription marks `INCOMPLETE`.
- **IMPLEMENTED / TESTED:** `StorageRuntime.transcribeRecording()` uses `WindowsLocalWhisperEngine` by default. Tests may inject doubles. `UnconfiguredTranscriptionEngine` remains available and never invents text.

### PHASE 6C application integration of Windows native capture

- **IMPLEMENTED / TESTED / CODE-VERIFIED / WINDOWS-VERIFIED:** `StorageRuntime` attaches `NativeCaptureCoordinator` + `LocalRecordingCaptureEngine` to the live `LocalFirstStore`. On Windows the factory uses `WindowsNativeAudioProvider`; non-Windows remains fail-closed. Main-process APIs are `discoverNativeCaptureCapabilities`, `startNativeCapture`, `stopNativeCapture`, `abortNativeCapture`, and `getNativeCaptureState`.
- **IMPLEMENTED / TESTED / WINDOWS-VERIFIED:** Native chunks that pass provider validation are appended through `LocalRecordingCaptureEngine` and committed through the existing artifact journal, SHA-256, atomic write, recording metadata, and meeting UUID lifecycle path.
- **IMPLEMENTED / TESTED / WINDOWS-VERIFIED:** Stop, abort, malformed native records, permission denial, and runtime close abort remaining sessions without fabricating media. Screen/window stay policy-denied.
- **IMPLEMENTED / TESTED:** No capture IPC, DATA_ROOT, absolute paths, device paths, or native process controls are exposed to the renderer.
- **WINDOWS-VERIFIED:** Real Windows `npm run verify:windows-native-capture` (`durationMs`: 10000, `platform`: `win32`, `helperFound`: true, `isolatedWorkspace`: true, `userDataUntouched`: true, `success`: true, `windowsVerified`: true) used helper `C:\AI-WorkMate\native\windows-audio\bin\Release\net8.0-windows\win-x64\publish\AIWorkMate.WindowsAudioCapture.exe`.
  - Abort: `success` true, `meetingStatus` `INCOMPLETE`, `artifactJournalState` `INCOMPLETE`, `sqliteRecordingCount` 0.
  - Microphone (`Jack Mic (Realtek Audio)`, default, 48000 Hz, 2 ch, 32-bit): `chunkCount` 154, sequences 0–153, `totalBytes`/`finalArtifactSize` 5313806, SHA-256 `1cd89fa503322140872b2e685f822a4ebc60cdfb037a75451473644c17c3a02d`, `recordingId` `74c4bcdd-f5b9-44bb-a0ae-050eeabe2125`, `meetingId` `432d7cad-17d6-4d8e-a4d3-6c661c2bd24a`, `captureId` `05e0a945-a573-4ade-8fdd-ece5feeb15bd`, `meetingStatus` `PROCESSING`, journal `COMMITTED`, SQLite `COMMITTED`, `finalArtifactExists` true, format `aiwpcm` / `application/x-ai-workmate-pcm-jsonl`.
  - Loopback (`Speakers / Headphones (Realtek Audio)`, default, 48000 Hz, 2 ch, 32-bit): `chunkCount` 156, sequences 0–155, `totalBytes`/`finalArtifactSize` 5998897, SHA-256 `2309c82d9c7f7ffb5c570d5244735c5a15f2808fc849c002bd7c496418789273`, `recordingId` `264dd851-eac8-40e0-b062-fd2486c60297`, `meetingId` `a4450f06-9fb5-4f19-ab16-1b9eee305d15`, `captureId` `4d201281-771a-48b3-b19e-24e790ec2a59`, `meetingStatus` `PROCESSING`, journal `COMMITTED`, SQLite `COMMITTED`, `finalArtifactExists` true, same format.
- **REMAINING GAP:** Capture UI, mixed microphone+loopback sessions, screen/window providers, and Teams/Zoom automation.

### PHASE 6B real Windows native audio provider code

- **IMPLEMENTED / CODE-VERIFIED / WINDOWS-VERIFIED:** `WindowsNativeAudioProvider` is a production provider that shells out to the packaged Windows audio helper instead of generating media. The helper source lives in `native/windows-audio/` and uses .NET 8 plus NAudio/CoreAudio/WASAPI APIs for microphone capture endpoints and WASAPI loopback over render endpoints for system audio. Real Windows verification: `npm run build:native:win` succeeded; capabilities listed Microphone `Jack Mic (Realtek Audio)` (default) and system audio `Speakers / Headphones (Realtek Audio)` (default); `mic-test.jsonl` = 977 lines (format + 976 audio chunks, no error records); `loopback-test.jsonl` = 2229 lines (format + audio chunks, no error records). The helper used the real Windows NAudio implementation; no mock/fake production capture was used.
- **IMPLEMENTED / TESTED:** Capability discovery maps helper-reported microphone devices, default microphone, render/loopback devices, default render endpoint, safe device IDs, and human-readable labels into the existing `NativeCaptureCapabilities` model. Non-Windows, missing helper, unavailable device, permission denied, and initialization failure states are explicit typed failures.
- **IMPLEMENTED / TESTED:** The provider rejects screen/window capture and unsupported output formats. It supports only the documented lossless intermediate `aiwpcm` / `application/x-ai-workmate-pcm-jsonl` stream for audio. The format stores JSON Lines containing a capture format record and PCM chunk records with source, sequence, capture timestamp, WASAPI-reported sample rate/channels/bits-per-sample/block alignment/average bytes per second, byte length, per-chunk SHA-256, and base64 PCM payload.
- **IMPLEMENTED / TESTED:** Provider-side stream validation rejects invalid timestamps, out-of-order helper chunk sequence, changed source IDs, changed format, empty/invalid byte lengths, and SHA-256 mismatch before the data can be committed. The coordinator still adds its own ordered write into `LocalRecordingCaptureEngine`.
- **IMPLEMENTED / TESTED:** Windows microphone and system-audio/loopback sessions integrate with `NativeCaptureCoordinator` and the existing Phase 5 local capture/storage path. Tests cover lifecycle to `PROCESSING`, artifact journal commit, recording metadata, duplicate ownership, wrong meeting UUIDs, unavailable selected devices, native stream failure, disk-space preflight failure, and incomplete abort behavior using injected helper-process doubles.
- **IMPLEMENTED / CODE-VERIFIED:** `package.json` now includes `build:native:win` for `dotnet publish native/windows-audio/AIWorkMate.WindowsAudioCapture.csproj -c Release -r win-x64 --self-contained true`, and `package:win` runs the native publish before Electron packaging. The packaged helper is configured as an Electron `extraResources` payload.
- **REMAINING GAP:** Microphone/system-audio synchronization, mixing, echo cancellation, device-change UI, signed helper distribution validation, and screen/window capture providers remain future work.

### PHASE 6A native Windows capture source boundary

- **IMPLEMENTED / TESTED:** `NativeCaptureAdapter` defines explicit structured capability discovery for `MICROPHONE_AUDIO`, `SYSTEM_AUDIO`, `SCREEN`, and `WINDOW`, including availability status, safe source descriptors, permission requirements, adapter/platform identity, and typed native error metadata. Capabilities expose safe IDs/labels only, not filesystem paths.
- **IMPLEMENTED / TESTED:** `WindowsCaptureAdapter` and `createNativeCaptureAdapter()` fail closed. Non-Windows/headless platforms report `UNSUPPORTED`; the Windows factory now wires the real audio provider by default, and a direct adapter without a provider or a missing packaged helper reports `NATIVE_PROVIDER_NOT_CONFIGURED` and rejects capture start. No production mock, fixture, or fake-byte fallback is registered.
- **IMPLEMENTED / TESTED:** `NativeCaptureCoordinator` bridges a real native adapter session into `LocalRecordingCaptureEngine`. It checks capability availability before local recording creation, enforces an explicit capture policy that denies microphone/system-audio/screen/window by default, rejects duplicate active meeting ownership, rejects wrong meeting IDs, and rejects caller-supplied output/source/relative paths.
- **IMPLEMENTED / TESTED:** When an injected native adapter produces actual chunks, the coordinator passes them through the existing local capture/storage pipeline in sequence. Existing chunk validation, SHA-256 verification, atomic staged writes, artifact journal transitions, recording metadata, lifecycle to `PROCESSING`, and disk-space fail-closed behavior remain the authority.
- **IMPLEMENTED / TESTED:** Native startup failure does not create a local recording or mark a meeting completed. Native safe-stop/abort marks the local capture `INCOMPLETE`; native stream failures mark the partial local recording `INCOMPLETE`, while finalization/storage failure marks `FAILED`; unsupported or unavailable capabilities never create fake recordings.
- **IMPLEMENTED / TESTED / CODE-VERIFIED:** No capture IPC was added. Existing Electron guarantees remain intact: context isolation, disabled node integration, sandboxed renderer, trusted sender/frame checks, preload-only allow-listed channels, and no renderer filesystem path exposure.
- **WINDOWS-VERIFIED / REMAINING GAP:** Phase 6B microphone and loopback helper capture was executed on a real Windows host. Screen/window native providers remain unimplemented.

### PHASE 5 local recording/capture boundary

- **IMPLEMENTED / TESTED:** `CaptureEngine` and `LocalRecordingCaptureEngine` provide a local capture boundary with `startCapture()`, `getCaptureState()`, `appendChunk()`, `appendStream()`, `finalizeCapture()`, and `abortCapture()` operations keyed by the internal meeting UUID. They expose state and structured error metadata without exposing absolute filesystem paths.
- **IMPLEMENTED / TESTED:** The local adapter enforces exactly one active capture owner per meeting, rejects wrong-meeting writes/finalization/abort, rejects duplicate finalization and writes after finalization, rejects empty or non-binary chunks, rejects unsafe format/MIME values, rejects out-of-order explicit chunk sequences, and rejects caller-supplied `outputPath`/`sourcePath`/`relativePath` values.
- **IMPLEMENTED / TESTED:** Recording capture bytes are staged only through `LocalStorageService` and committed only through `LocalFirstStore`. Staged writes use same-directory `.tmp-*` files, exclusive creation, per-chunk file sync where supported, SHA-256 verification before and after rename, atomic rename, directory sync, and SQLite indexing only after successful finalization. No renderer or capture caller writes directly into `DATA_ROOT`.
- **IMPLEMENTED / TESTED:** Capture lifecycle advances through the existing meeting state machine: scheduled/detected meetings move through `DETECTED`, `PREPARING`, `RECORDING`, `FINALIZING`, and successful capture commit moves to `PROCESSING` for later transcription/AI work. Invalid capture starts from progressed states are rejected by the service/lifecycle boundary. Abort, safe-stop, or disk-space write failure marks `INCOMPLETE`; finalization/storage failure marks `FAILED`.
- **IMPLEMENTED / TESTED:** The durable `artifact_operations` journal is used for capture with states `STARTED`, `WRITING`, `FINALIZING`, `COMMITTED`, `FAILED`, and `INCOMPLETE`. Restart recovery preserves existing behavior: interrupted capture temp files and pending operations are reported/marked incomplete and are not silently completed, imported, or deleted.
- **IMPLEMENTED / TESTED:** SQLite schema version 5 expands `recordings` metadata with safe committed-recording fields: recording/file UUIDs, meeting UUID, variant, container/format, capture start/end/duration, byte size, SHA-256, relative path, capture source/adapter, and final status. Recording binaries remain filesystem files and are not stored as SQLite BLOBs. Incomplete captures without a verified final file remain journal/recovery records rather than indexed recording rows.
- **IMPLEMENTED / TESTED:** Existing disk-space protection is reused. Unknown free space fails closed at preflight; insufficient preflight space marks the meeting `FAILED`; insufficient/critical/unknown space during active capture stops safely as `INCOMPLETE` through the storage boundary.
- **IMPLEMENTED / TESTED / CODE-VERIFIED:** No new capture IPC was exposed. Existing Electron security remains intact: context isolation, disabled node integration, sandboxed renderer, trusted sender/frame checks, preload-only allow-listed channels, and renderer-safe path-free responses. A regression test asserts there are no renderer capture/output-path IPC channels.
- **CODE-VERIFIED / WINDOWS-VERIFIED / REMAINING GAP:** The local adapter is a file-backed chunk/stream boundary. Phase 6C StorageRuntime persistence of real WASAPI microphone and loopback bytes is **WINDOWS-VERIFIED**. It still does not capture Teams, Zoom, Google Meet, browser tabs, or screen/window video.

## PHASE 4 Microsoft 365 / Outlook Calendar discovery

- **IMPLEMENTED / TESTED:** Microsoft Graph access is isolated behind `MicrosoftGraphClient`, `MicrosoftGraphCalendarProvider`, and injected `MicrosoftGraphTransport`/`MicrosoftGraphAuthProvider` boundaries. Pagination, event lookup, cancellation checks, and structured Graph errors are covered with fake transports at the test boundary only; tests do **not** call Microsoft Graph.
- **IMPLEMENTED / TESTED / WINDOWS-UNVERIFIED:** Microsoft credential handling now has a `CredentialBackedMicrosoftTokenCache` for an opaque MSAL-style token cache stored through the existing Electron safeStorage credential adapter outside `DATA_ROOT`. Access tokens, refresh tokens, and client secrets are not stored in SQLite or exposed through renderer-facing sync responses. Actual Windows DPAPI/MSAL execution was not run in this Linux sandbox.
- **IMPLEMENTED / TESTED:** Graph events are normalized into internal calendar models capturing external event ID, subject, start/end, organizer, attendees, location, online meeting details, web URL, cancellation state, and last modified time. Raw Graph responses are not persisted by the sync layer.
- **IMPLEMENTED / TESTED:** Deterministic Teams detection stores `meetingPlatform` as `TEAMS`, `OTHER_ONLINE`, or `NONE`. Teams classification uses Microsoft Graph online meeting provider values and Teams join/location signals; non-Teams online meetings such as Skype/Zoom-like online events are not classified as Teams.
- **IMPLEMENTED / TESTED:** `calendar_event_associations` links `(provider, external_event_id)` to the authoritative internal meeting UUID in the current local schema. Repeated syncs are idempotent, duplicate external events do not create duplicate meetings, and the old internal UUID remains authoritative.
- **IMPLEMENTED / TESTED:** `CalendarSyncService` retrieves events for a requested range, normalizes/platform-classifies them, upserts associations through `LocalFirstStore`, reports created/updated/unchanged/cancelled/error counts, handles cancelled events safely, and preserves progressed meeting lifecycle status. Calendar discovery creates future meetings as `SCHEDULED` only.
- **IMPLEMENTED / TESTED:** A minimal Electron IPC/preload method exposes safe Microsoft calendar sync counts and sanitized error metadata. It does not return access tokens, refresh tokens, client secrets, raw credential objects, raw Graph responses, or absolute filesystem paths.
- **CODE-VERIFIED / NOT TESTED:** The production Graph adapter uses real HTTP `fetch` and requires a real OAuth/MSAL auth provider. No fake production calendar data or mock production provider is wired. A live OAuth sign-in flow, tenant configuration, and live Microsoft Graph connectivity are not implemented or verified in this environment.

## PHASE 3 meeting lifecycle and ingestion boundary

- **IMPLEMENTED / TESTED:** Meeting statuses are `SCHEDULED`, `DETECTED`, `PREPARING`, `RECORDING`, `FINALIZING`, `PROCESSING`, `COMPLETED`, `INCOMPLETE`, `FAILED`, and `CANCELLED`. `LocalDatabase.updateMeetingStatus()` rejects transitions not in the explicit transition table. Restart recovery changes an active recording to `INCOMPLETE`; failed writes remain journaled.
- **IMPLEMENTED / TESTED:** Meeting IDs are UUIDs and remain the sole internal identity. Title/date are presentation and partitioning data only; identical titles create independent folders and artifact paths.
- **IMPLEMENTED / TESTED:** Real recording handoff is exposed by `LocalFirstStore.ingestRecording()`. It accepts verified source-file metadata and persists through the existing journaled storage boundary. A stream adapter is intentionally not fabricated; callers must materialize and verify a stream before handing it off.
- **IMPLEMENTED / TESTED:** Transcript handoff is exposed by `ingestTranscript()` for plain text and structured JSON, with VTT/SRT format flags. No transcript content is generated by the application.
- **IMPLEMENTED / TESTED:** `processTranscriptWithProvider()` is the provider-to-validated-analysis boundary. Provider output must be schema-valid JSON for the requested meeting and is persisted only through `saveAnalysis()`. Provider failure or invalid output marks processing `FAILED`; no success is claimed. Production supplies no live network transport.

### Local-first storage and artifact contract

- `LocalStorageService` remains the only filesystem boundary for `DATA_ROOT`. The renderer cannot read directories, construct paths, or call filesystem APIs.
- First-run storage is selected through a native directory dialog. The selected root is stored in the application configuration under Electron `userData`, outside the meeting data root.
- `DATA_ROOT` contains `Meetings`, `Database`, `Backups`, `Exports`, and `storage.json`. SQLite is `Database/ai-workmate.sqlite`; large audio/video bytes are never stored in SQLite.
- Meeting folders and deterministic artifact names contain the authoritative UUID meeting ID. Original recordings remain separate from normalized recordings. Artifact metadata retains file ID, meeting ID, relative path, type, MIME type, size, timestamps, SHA-256, and status.
- Transcript JSON preserves timestamps and speaker data; timestamp-preserving TXT, VTT, and SRT artifacts are supported. Analysis artifacts and decision/task relationships are stored locally.
- The current SQLite schema version is 6. It retains the durable `artifact_operations` table, calendar associations, recording metadata, and transcript-to-recording/engine indexes without storing media or transcript BLOBs.

### Electron security and IPC

- The production `BrowserWindow` retains `contextIsolation: true`, `nodeIntegration: false`, and now uses `sandbox: true`.
- Storage IPC is allow-listed and accepts only the active application `BrowserWindow.webContents.id` with the exact trusted renderer URL. Unauthorized renderer/frame senders are rejected.
- Main-process window policy blocks non-application main/frame navigation and redirects, denies new windows, and prevents webview attachment. The renderer document also has a restrictive self-only CSP.
- Native dialogs are the only source of user-selected filesystem locations. `openDataFolder` is a controlled main-process operation against the already-authorized root.

### DATA_ROOT privacy

- Renderer-facing snapshots expose only safe location metadata: `{ type: "LOCAL", label, pathExposed: false }`.
- `StorageStats` has no `dataRoot` field. Migration confirmation, backup creation, backup restore, and meeting export IPC results return status/size/count metadata only; absolute paths stay in the main process.
- Internal configuration and storage manifests may retain the selected path because the main process needs it. Those internal records are not sent through the renderer API.

### Durable artifact-write journal and crash safety

- Each application artifact write records `STARTED`, `WRITING`, `FINALIZING`, `COMMITTED`, `FAILED`, or `INCOMPLETE` in SQLite with meeting ID, relative path, expected/actual hash, file ID, size, timestamps, and error details where available.
- Writes use same-directory temporary files, exclusive creation, flush/sync, post-write verification, and atomic rename. The journal is finalized in the SQLite transaction that indexes the artifact and its relationship rows.
- Startup inspects unfinished operations. A verified file plus a valid committed index can be recovered as `COMMITTED`; an ambiguous file is marked `INCOMPLETE` and reported as an orphan. Unknown data is preserved and never silently imported or deleted.
- A meeting left in `RECORDING` at restart is explicitly marked `INCOMPLETE` and reported. Temporary recordings, orphan files, unknown meeting-shaped folders, invalid manifests, missing database files, and missing/corrupt indexed artifacts are reported without inventing meeting records.

### Disk space and protected locations

- Recording preflight requires available space plus a configurable safety margin. Unknown or failed free-space queries fail closed and block recording.
- `RecordingDiskMonitor` treats unknown/critical space as critical, marks the meeting incomplete through the store boundary, invokes the capture owner callback, and stops its timer even if the callback fails.
- DATA_ROOT is rejected when it is inside the configured installation directory, `Program Files`, `Program Files (x86)`, `Windows`, `WindowsApps`, `ProgramData`, common program-file roots, or other environment-derived protected Windows roots. Checks are boundary-aware and case-insensitive on Windows.

### Durable DATA_ROOT migration journal

- Migration configuration is atomically journaled outside DATA_ROOT with `STARTED`, `COPYING`, `VERIFIED`, `ACTIVATING`, `ACTIVATED`, `RUNTIME_SWITCHED`, `CONFIGURATION_UPDATED`, `FAILED`, and `INCOMPLETE` states.
- Migration copies to a staging directory, verifies file counts/sizes/SHA-256 and meeting-ID relationships, activates only after verification, switches the running store, updates configuration, and clears the journal only after the configuration update succeeds.
- The source root is retained. An empty destination is moved aside rather than silently deleted. On restart, a verified destination may be activated for an interruption after activation; otherwise the source remains active and the journal is marked `INCOMPLETE`.

### Packaging, updates, uninstall, backups, and credentials

- `package.json` keeps `deleteAppDataOnUninstall: false`. The packaged application, Electron `userData` configuration, credential vault, and user-selected DATA_ROOT are separate locations by design.
- Backups preserve the SQLite snapshot, metadata, media, transcripts, analysis, tasks, projects, relationships, and hashes. Existing backups are never silently pruned. Restore and export use staging/verification and path-safe archive handling.
- Credentials use the existing Electron `safeStorage` adapter and are stored outside DATA_ROOT. They are not included in meeting folders or DATA_ROOT backups.

## TESTED

The following commands completed successfully in the Linux sandbox after the Phase 7C install/verification work:

- `npm run lint` — **PASSED**, ESLint with zero warnings.
- `npm run typecheck` — **PASSED**.
- `npm test` — **PASSED: 143/143 tests**; its nested build also passed. Whisper.cpp ggml models are validated with little-endian `GGML_FILE_MAGIC` (`0x67676d6c` on disk as `lmgg`), not ASCII `"ggml"`. Phase 7C Windows local transcription is **WINDOWS-VERIFIED** on a separate Windows host (see Phase 7C). Committed-transcript analysis is **TESTED** on Linux.
- `npm run test:storage` — **PASSED: 26/26 storage tests** for the complete `storage*.test.js` suite; its nested build also passed.
- `npm run build` — **PASSED** (TypeScript output and renderer asset copy).

Automated coverage includes Windows native audio provider platform detection, missing-helper fail-closed behavior, microphone and loopback capability mapping, unavailable device and permission-denied mapping, helper initialization failure, provider chunk timestamp/sequence/SHA validation, provider stop control, unsupported screen/window/format rejection, selected-device rejection before native start, native audio duplicate ownership and wrong meeting UUID rejection, native audio lifecycle to `PROCESSING`, native audio artifact journal interaction, native audio stream-failure-to-incomplete handling, native audio stop failure, native audio disk-space failure, no production fallback behavior, process-interruption incomplete behavior, native capture capability discovery, supported vs unsupported platform behavior, Windows factory audio-provider wiring, Windows-provider-not-configured fail-closed behavior, unavailable/permission-denied native capabilities, microphone/system-audio/screen/window capture policy, duplicate active native ownership, wrong meeting ID rejection, native lifecycle to `PROCESSING`, native startup failure, native safe-stop, native finalization failure, native-to-artifact-journal interaction, native disk-space preflight failure, native stream-failure handling, renderer non-exposure of native capture IPC, local capture start/state/chunk/stream/finalize/abort behavior, exact meeting ownership, duplicate-finalize/late-write rejection, empty/invalid/out-of-order chunk rejection, caller output-path rejection, SHA-256 verification, safe recording metadata persistence, capture lifecycle to `PROCESSING`, capture journal `COMMITTED`/`FAILED`/`INCOMPLETE` states, critical and unknown disk-space safe-stop behavior, interrupted-capture restart recovery, Graph event normalization, Microsoft Graph pagination through injected transport, event lookup, Teams/other-online/normal event detection, duplicate and idempotent calendar synchronization, cancellation handling, Graph error reporting, external event uniqueness, lifecycle preservation, renderer-safe sync results, credential redaction, active-webContents/exact-URL IPC authorization, sandbox policy, remote-navigation/new-window policy, path-free IPC results, safe snapshots/statistics, failed and interrupted artifact operations, orphan/unknown-folder preservation, missing database detection, protected Windows-style paths, migration phase fault injection, migration source preservation, backup/restore, export, transcript formats, duplicate identities, and local database integrity.

## CODE-VERIFIED

- The Electron main process supplies the real active BrowserWindow webContents ID and trusted renderer file URL to the IPC authorization boundary.
- `StorageRuntime` wires the installation directory from `dirname(app.getPath("exe"))`; no DATA_ROOT default is derived from the installation directory or Program Files.
- The `StorageConfigService` uses a separate atomically replaced, file-synced configuration file. SQLite uses WAL with `synchronous = FULL`; artifact and migration state is durable in those stores.
- The NSIS configuration is present and keeps application data by default. DATA_ROOT remains outside packaged files when selected through the runtime.
- Static type checking, linting, and the production build verify the Linux-buildable Electron, storage, local capture, native capture boundary, Windows native audio provider TypeScript, calendar, and Graph adapter code paths. The .NET Windows helper source is code-reviewed but not built in the Linux verification commands.
- The Microsoft Graph HTTP adapter is production code and has no fake data source; it requires an injected OAuth/MSAL-compatible auth provider before live Graph access can occur.

## NOT TESTED

- No end-to-end Electron GUI test was run in the headless Linux test command. The pure window-policy tests do not prove Chromium/Electron event delivery.
- No signed installer artifact, update cycle, uninstall wizard, or real Windows drive/ACL exercise was run.
- No physical power-loss or forced-process termination test was run; crash handling is covered by durable-state, restart-recovery, and fault-injection tests rather than an actual crash harness.
- No screen or window capture API was executed. Linux native capture tests still use injected boundary/helper doubles. Real Windows microphone and WASAPI loopback helper capture was verified on a separate Windows host (Phase 6B) and is not re-executed in this Linux sandbox.
- No live Microsoft OAuth/MSAL sign-in, tenant consent, token acquisition, or live Microsoft Graph calendar request was executed.

## WINDOWS-UNVERIFIED

- Actual Windows `Program Files`/ACL behavior, junction/symlink semantics, Windows path parsing under the running Electron app, Windows-specific `statfs`/disk-full behavior, and screen/window capture APIs require a Windows host. Microphone/loopback helper capture and Phase 6C StorageRuntime persistence are **WINDOWS-VERIFIED**.
- Electron GUI navigation/webview behavior, `safeStorage`/DPAPI, Windows credential protection, Microsoft MSAL desktop redirect/broker behavior, NSIS update/uninstall behavior, and preservation of user-selected DATA_ROOT across installer operations were not executable in this Linux sandbox.
- The Linux tests do include Windows-style path policy cases and verify the code's boundary/case rules, but those results are not a Windows execution claim.

## REMAINING GAP

- **No platform meeting recorder:** Microsoft calendar discovery, Teams identification, the local capture/storage boundary, native source abstraction/policy/coordinator, Windows native audio provider, and runtime integration are implemented. Real Windows microphone/loopback helper capture and Phase 6C StorageRuntime persistence are **WINDOWS-VERIFIED**. Teams/Zoom/Google Meet/browser automation and screen/window capture providers remain out of scope.
- **Local llama.cpp is wired but not REAL-AI-VERIFIED here:** Production defaults to `LocalLlmProvider`. CLI/GGUF are not in Git. No live OpenAI transport/API key. Injected helper doubles are for tests only.
- **Whisper runtime is not bundled:** Phase 7B/7C wire whisper.cpp but do not commit `whisper-cli.exe` or ggml models. Install under `%LOCALAPPDATA%\AI-WorkMate`. Linux verification fail-closes. Real Windows local transcription of the spoken fixture is **WINDOWS-VERIFIED**.
- Migration recovery can safely activate a fully copied destination or mark an interrupted copy incomplete; resumable copying/progress/cancellation UI is not implemented.
- A signed production installer, a user-facing Keep/Delete uninstall choice, full Microsoft OAuth/MSAL sign-in UX, ordinary meeting-file encryption-at-rest, and automated backup retention are not implemented.
- The polished screen is currently Storage Settings; the complete meetings/projects/tasks dashboard remains future work. Optional cloud sync and cloud database persistence remain deliberately excluded.

## Requirement status matrix

| Requirement | Status | Evidence / limitation |
|---|---|---|
| Local SQLite plus filesystem is the primary store | IMPLEMENTED / TESTED | Real `DatabaseSync` and filesystem artifacts are exercised by the storage suite. |
| No large media BLOBs in SQLite | IMPLEMENTED / TESTED | Schema test confirms media is indexed by metadata/path, not a BLOB. |
| Meeting-ID-based folders and filenames | IMPLEMENTED / TESTED | 100 identical-title meetings and artifact relationship checks pass. |
| Atomic artifact writes and durable states | IMPLEMENTED / TESTED | `artifact_operations` state coverage, failed writes, restart recovery, temp-file checks. |
| Incomplete recordings and unknown data recovery | IMPLEMENTED / TESTED | Restart status transition plus orphan/unknown-folder/temp-file tests; no silent import/delete. |
| Fail-closed disk checks | IMPLEMENTED / TESTED | Unknown free space blocks preflight and monitor transitions safely. |
| Protected Windows installation paths | IMPLEMENTED / TESTED / WINDOWS-UNVERIFIED | Linux-runnable Windows-style cases pass; actual Windows ACL/path execution is unverified. |
| Exact renderer IPC authorization | IMPLEMENTED / TESTED | Active ID and exact frame URL rejection tests pass. |
| Navigation, redirect, frame, window-open, and webview restrictions | IMPLEMENTED / TESTED / CODE-VERIFIED | Pure policy tests and source wiring pass review; Electron GUI event delivery is not tested. |
| No absolute DATA_ROOT in renderer responses | IMPLEMENTED / TESTED | Snapshot, stats, migration, backup, restore, and export response tests contain no paths. |
| Durable migration journal and runtime switch | IMPLEMENTED / TESTED | Phase callback/fault-injection and runtime migration tests pass; source is preserved. |
| Backup/update/uninstall data safety | IMPLEMENTED / CODE-VERIFIED / WINDOWS-UNVERIFIED | Backup tests and NSIS/config code review pass; installer/update/uninstall execution is unverified. |
| Credential storage outside meeting data | IMPLEMENTED / TESTED / WINDOWS-UNVERIFIED | Encrypted-vault boundary test passes; actual Windows DPAPI is unverified. |
| Microsoft Graph adapter boundary | IMPLEMENTED / TESTED / CODE-VERIFIED | Real HTTP adapter plus injected auth/transport; tests use fake transport only and never call Graph. |
| Microsoft credential/token boundary | IMPLEMENTED / TESTED / WINDOWS-UNVERIFIED | Opaque MSAL-style cache uses encrypted credential store outside DATA_ROOT; actual DPAPI/MSAL execution is unverified. |
| Graph event normalization and pagination | IMPLEMENTED / TESTED | Normalized model captures required fields; pagination and lookup covered with injected transport. |
| Teams vs other-online vs normal detection | IMPLEMENTED / TESTED | Platform is stored as `TEAMS`, `OTHER_ONLINE`, or `NONE`; non-Teams online meetings are not classified as Teams. |
| Calendar association idempotency | IMPLEMENTED / TESTED | `calendar_event_associations` links provider/external ID to internal UUID with uniqueness and lifecycle preservation. |
| Renderer-safe calendar sync IPC | IMPLEMENTED / TESTED | Sync IPC returns counts and sanitized error codes only; no credentials/raw Graph/path data. |
| Local capture boundary | IMPLEMENTED / TESTED / CODE-VERIFIED | `CaptureEngine` + `LocalRecordingCaptureEngine` control local chunk/stream writes, ownership, journal, SHA-256, disk-space safe-stop, and recovery. Screen/window providers remain unimplemented. |
| Native Windows capture source boundary | IMPLEMENTED / TESTED / CODE-VERIFIED | `NativeCaptureAdapter`, `WindowsCaptureAdapter`, and `NativeCaptureCoordinator` define capability discovery, default-deny policy, ownership, source-to-local pipeline orchestration, typed errors, and fail-closed unsupported/provider-missing behavior. |
| Windows microphone audio helper (Phase 6B) | IMPLEMENTED / TESTED / CODE-VERIFIED / WINDOWS-VERIFIED | Prior real-Windows helper run: `mic-test.jsonl` 977 lines, Jack Mic (Realtek Audio), no error records. Not re-executed on this Linux host. |
| Windows system-audio loopback helper (Phase 6B) | IMPLEMENTED / TESTED / CODE-VERIFIED / WINDOWS-VERIFIED | Prior real-Windows helper run: `loopback-test.jsonl` 2229 lines, Speakers / Headphones (Realtek Audio), no error records. Not re-executed on this Linux host. |
| Phase 6C runtime path with real Windows devices | IMPLEMENTED / TESTED / CODE-VERIFIED / WINDOWS-VERIFIED | Real Windows verify JSON: `success` true, abort INCOMPLETE with 0 recordings; mic 154 chunks / 5313806 bytes / SHA-256 `1cd89fa503322140872b2e685f822a4ebc60cdfb037a75451473644c17c3a02d` COMMITTED; loopback 156 chunks / 5998897 bytes / SHA-256 `2309c82d9c7f7ffb5c570d5244735c5a15f2808fc849c002bd7c496418789273` COMMITTED. |
| No fake production capture fallback | IMPLEMENTED / TESTED | Production factory/provider reports unsupported/provider-not-configured instead of creating mock bytes; helper doubles are confined to tests. |
| Local transcription of AIWPCM recordings (Phase 7A) | IMPLEMENTED / TESTED | Validate/reconstruct/journal/lifecycle covered. |
| Local whisper.cpp engine (Phase 7B) | IMPLEMENTED / TESTED / WINDOWS-VERIFIED | Real spawn/protocol and resampling; CLI/model installed on Windows. Spoken-fixture STT committed locally after `b43172f0`. |
| Whisper model install + Windows verify (Phase 7C) | IMPLEMENTED / TESTED / WINDOWS-VERIFIED | Allowlisted HTTPS install + spoken fixture. Real Windows: `windowsVerified` true, `recognizedText` present, SQLite/journal `COMMITTED`, `cloudServiceUsed` false. |
| Bundled whisper.cpp + ggml model | REMAINING GAP | Not committed to Git. |
| Transcript → AI analysis pipeline | IMPLEMENTED / TESTED / CODE-VERIFIED | Committed transcript, policy gate, strict JSON, journaled `saveAnalysis()`. |
| Local llama.cpp provider | IMPLEMENTED / TESTED / CODE-VERIFIED | Real spawn path; missing runtime fail-closed. **not REAL-AI-VERIFIED**. |
| Bundled llama.cpp + GGUF | REMAINING GAP | Not committed to Git. |

## Final verification boundary

Linux results are reported as Linux results. They do not certify Windows Electron GUI behavior, Windows ACL/DPAPI, installer signing, update/uninstall behavior, or physical disk/power-loss semantics. Those items remain explicitly **WINDOWS-UNVERIFIED** or **NOT TESTED**, not success claims.
