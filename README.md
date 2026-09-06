# AI WorkMate

AI WorkMate is being built as a **local-first Windows desktop meeting workspace**. This checkout contains the hardened storage foundation, Phase 4 Microsoft 365 calendar discovery, Phase 5–6C native Windows capture, Phase 7A local transcription pipeline, Phase 7B real local whisper.cpp speech-to-text (when installed), and Phase 8 unified meeting capture orchestration: one real meeting capture lifecycle (start/run/stop/abort/recover/commit) coordinating MICROPHONE, SYSTEM_LOOPBACK, SCREEN, and WINDOW as independent sources under a single meeting at the storage/main-process level. Existing meeting data is owned by the desktop process:

```text
Windows desktop
   ├── Local SQLite index (DATA_ROOT/Database/ai-workmate.sqlite)
   ├── Local files (DATA_ROOT/Meetings/...)
   ├── OS-protected credentials (Electron userData, outside DATA_ROOT)
   ├── Microsoft Graph calendar adapter boundary (auth/provider injected)
   ├── LocalRecordingCaptureEngine (local chunk/stream boundary only)
   ├── NativeCaptureAdapter / WindowsCaptureAdapter boundary (capability discovery, fail-closed without provider)
   ├── WindowsNativeAudioProvider + Windows helper (WASAPI microphone/loopback; Windows-verified)
   ├── WindowsNativeScreenProvider + Windows helper (DXGI Desktop Duplication / Windows Graphics Capture; Linux tests only)
   ├── StorageRuntime native capture coordinator (main-process only)
   ├── MeetingCaptureOrchestrator (Phase 8 unified flow: independent sources under one meeting; main-process only)
   ├── Local transcription pipeline (Phase 7A)
   ├── WindowsLocalWhisperEngine (Phase 7B whisper.cpp)
   ├── Whisper model installer / discovery (Phase 7C, LocalAppData, not Git)
   ├── Local llama.cpp analysis provider (GGUF instruct model, LocalAppData, not Git)
   └── Optional cloud provider adapters (policy-gated; not required for local analysis)
```

There is no cloud database dependency in the storage foundation. Cloud AI, when explicitly enabled, is a transient processing integration and is not the persistent meeting-data store. AI WorkMate does not claim that cloud AI processing is 100% local.

## Development

The repository uses TypeScript, Electron IPC contracts, Node's embedded SQLite API (`node:sqlite`), and standard ZIP archives.

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run test:storage
npm run build
```

The current runtime requires Node 22.5 or newer because the typed SQLite implementation uses `node:sqlite`. The Electron shell uses `contextIsolation: true`, `nodeIntegration: false`, and sandboxed renderer preferences. Only the main process can open native dialogs or perform storage operations.

To launch the desktop shell in an Electron-capable environment:

```bash
npm run desktop
```

## Local data root

First run asks:

> Choose where AI WorkMate should store your data.

The selected absolute path becomes `DATA_ROOT`. It is separate from the installation directory and contains:

```text
DATA_ROOT/
  Meetings/
    YYYY/
      MM/
        YYYY-MM-DD_Meeting-slug_UUID/
          Meeting.json
          Recording/
            Original/
            Normalized/
          Audio/
          Transcript/
          Analysis/
          Attachments/
          Exports/
          Meeting.json
  Database/
    ai-workmate.sqlite
  Backups/
  Exports/
  storage.json
```

Every meeting has a UUID-backed folder. Artifact names also include the authoritative meeting ID, for example `meeting_<MEETING_ID>.mp4`, `audio_<MEETING_ID>.m4a`, and `transcript_<MEETING_ID>.json`. A title and date are never used as a unique key. Video and audio bytes remain files; SQLite schema version 6 stores metadata and relationships only, including recording metadata and transcript-to-recording/engine indexes. Transcript text is never stored as a SQLite BLOB.

DATA_ROOT is actively rejected when it is inside the configured application installation directory or protected Windows locations such as `Program Files`, `Program Files (x86)`, `Windows`, `WindowsApps`, and `ProgramData`. The check is boundary-aware and case-insensitive on Windows.

## Writes, recovery, and disk safety

`LocalStorageService` writes artifacts to same-directory temporary files, flushes them, verifies them, and atomically renames them without overwriting an existing artifact. `LocalFirstStore` records each write in the durable SQLite `artifact_operations` journal with states `STARTED`, `WRITING`, `FINALIZING`, `COMMITTED`, `FAILED`, or `INCOMPLETE`. On restart, unfinished operations are inspected; ambiguous files are reported as incomplete/orphaned and are never silently imported or deleted.

A meeting left in `RECORDING` at restart is marked `INCOMPLETE`. Startup and on-demand integrity checks report missing/corrupt indexed artifacts, orphan files, unknown meeting folders, temporary recordings, invalid manifests, and a missing database. Repair re-indexes only files inside already-known meeting folders. It never invents meeting records or deletes unknown data.

Recording preflight requires free space plus a configurable safety margin. If free space is unknown, recording is blocked. The in-progress disk monitor treats unknown or critical space as a safe-stop condition and marks the meeting incomplete through the storage boundary.

## Local recording/capture boundary (Phase 5)

Phase 5 adds a production local capture boundary, not platform automation. `CaptureEngine` defines start/state/chunk/stream/finalize/abort operations by meeting UUID. `LocalRecordingCaptureEngine` accepts bytes from a real future capture source, enforces one active owner per meeting, rejects wrong-meeting writes, out-of-order chunk sequences, empty/non-binary chunks, duplicate finalization, late writes, and caller-supplied output paths. It never asks the renderer or caller for a filesystem destination.

The local adapter stages bytes through `LocalStorageService.beginStagedArtifactWrite()`, writes same-directory `.tmp-*` files with exclusive creation and per-chunk flush/sync, verifies SHA-256 before and after atomic rename, and calls `LocalFirstStore.commitRecordingCapture()` only after final file verification. The meeting lifecycle advances through `SCHEDULED → DETECTED → PREPARING → RECORDING → FINALIZING → PROCESSING`; aborts or safe-stop disk failures move to `INCOMPLETE`, while finalization failures move to `FAILED`. Incomplete restart recovery is preserved and does not silently index partial recordings.

**Important limit:** this is not a Teams, Zoom, Google Meet, browser, or screen/window recorder. Phase 5 remains the local file/journal boundary. Real Windows microphone and WASAPI loopback capture are provided by Phase 6B/6C, not by this adapter inventing bytes.

## Native Windows capture source boundary (Phase 6A)

Phase 6A adds the production native-source boundary above the Phase 5 local capture engine. `NativeCaptureAdapter` describes structured capability discovery for microphone audio, system audio, screen capture, and window capture. `WindowsCaptureAdapter` is fail-closed: on non-Windows platforms it reports `UNSUPPORTED`, and on Windows without a registered real native provider it reports `NATIVE_PROVIDER_NOT_CONFIGURED` rather than fabricating capture support.

`NativeCaptureCoordinator` applies explicit capture policy, rejects denied/unavailable capabilities before creating a local recording, owns duplicate active capture checks by internal meeting UUID, rejects wrong-meeting stop/abort calls, passes real native chunks into `LocalRecordingCaptureEngine` in sequence, and preserves the existing local storage, SHA-256, artifact journal, lifecycle, and disk-space semantics. No capture IPC was added, so the renderer still receives no filesystem path or direct capture controls.

**Verification limit:** Linux/headless tests use injected adapter doubles at the boundary to verify orchestration and failure behavior. The DXGI screen helper runtime verification was executed on a real Windows host (`npm run verify:windows-native-screen-capture -- --duration-ms=10000`). Windows Graphics Capture (WGC) window helper runtime verification is implemented (`npm run verify:windows-native-window-capture`) but was not executed in this Linux sandbox. Microphone and WASAPI loopback helper execution was **WINDOWS-VERIFIED** on a real Windows host in Phase 6B.

## Windows native audio provider (Phase 6B)

Phase 6B adds production code for the first real native provider path: `WindowsNativeAudioProvider` plus a Windows-only `.NET 8` helper project in `native/windows-audio/`; `createNativeCaptureAdapter()` wires this audio provider by default on Windows and still fails closed if the helper is missing. The helper uses NAudio/CoreAudio/WASAPI APIs: capture endpoints for microphones and render endpoints via WASAPI loopback for system audio. It enumerates active devices, marks defaults, and emits explicit typed errors for unavailable devices, permission failures, initialization failures, stream failures, and stop failures.

The provider does not write files and does not choose output paths. It starts the helper, validates the helper's real PCM records, and feeds them into `NativeCaptureCoordinator` / `LocalRecordingCaptureEngine`. The intermediate persisted format is `aiwpcm` with MIME `application/x-ai-workmate-pcm-jsonl`: JSON Lines containing a format record and captured PCM chunk records. Each audio chunk carries source, sequence, capture timestamp, sample rate, channels, bits per sample, byte length, SHA-256 of the PCM payload, and base64 PCM bytes. The sample format is whatever WASAPI reports for the selected endpoint; the helper records that format per capture.

Packaging includes a Windows helper build step: `npm run build:native:win`, and `npm run package:win` runs it before Electron packaging. Real Windows verification confirmed: `npm run build:native:win` succeeded; `capabilities` enumerated Jack Mic (Realtek Audio) and Speakers / Headphones (Realtek Audio); microphone capture produced `mic-test.jsonl` (977 lines: format + 976 audio chunks, no errors); WASAPI loopback produced `loopback-test.jsonl` (2229 lines: format + audio chunks, no errors). That helper used the real NAudio implementation with no mock production capture. Status: **IMPLEMENTED / TESTED / CODE-VERIFIED / WINDOWS-VERIFIED** for microphone and loopback helper capture. The DXGI screen helper runtime verification is **WINDOWS-VERIFIED**; the WGC window helper runtime verification is implemented but **not WINDOWS-VERIFIED** yet. Microphone/system-audio synchronization/mixing is not solved; each stream remains independently owned and sequenced.

## Windows runtime verification (Phase 6C)

Do this on the Windows machine that already has Node, npm, and .NET:

```bat
cd /d C:\AI-WorkMate
git checkout arena/01a0609d-ai-workmate
git pull
npm install
npm run build:native:win
npm run verify:windows-native-capture
```

The command uses the real helper (no mocks) through `StorageRuntime.startNativeCapture()`. A real Windows run (`durationMs` 10000) produced `success: true`, `windowsVerified: true`, `platform: "win32"`, `helperFound: true`. Abort: `INCOMPLETE` journal, `sqliteRecordingCount` 0. Microphone (`Jack Mic (Realtek Audio)`, default): 154 chunks, sequences 0–153, 5313806 bytes, SHA-256 `1cd89fa503322140872b2e685f822a4ebc60cdfb037a75451473644c17c3a02d`, journal/SQLite `COMMITTED`. Loopback (`Speakers / Headphones (Realtek Audio)`, default): 156 chunks, sequences 0–155, 5998897 bytes, SHA-256 `2309c82d9c7f7ffb5c570d5244735c5a15f2808fc849c002bd7c496418789273`, journal/SQLite `COMMITTED`. Isolated temp storage was used (`isolatedWorkspace` true, `userDataUntouched` true). Status: **IMPLEMENTED / TESTED / CODE-VERIFIED / WINDOWS-VERIFIED**. Linux output of this command is still fail-closed and is not a Windows claim.

## Application integration of Windows native capture (Phase 6C)

`StorageRuntime` now owns the production capture stack: `createNativeCaptureAdapter()` → `WindowsCompositeNativeCaptureProvider` on Windows → `NativeCaptureCoordinator` → `LocalRecordingCaptureEngine` → `LocalFirstStore`. On Windows, microphone, system-audio, screen, and window policy is allow-listed in the main process only. A missing screen helper does not disable audio. Capture remains fail-closed when the helper is missing, the platform is unsupported, a device is unavailable, permission is denied, records are malformed, or the native process fails. Native capture is **not** exposed as renderer IPC: no DATA_ROOT, absolute paths, device paths, or native process controls leave the main process. Tests cover the runtime integration boundary with helper doubles confined to test code.

## Windows native screen/window capture

Production code for display and window capture lives in `WindowsNativeScreenProvider` plus `native/windows-screen/` (.NET 8, Windows 10 19041+ / Windows 11). Display capture uses DXGI Desktop Duplication (`DuplicateOutput`) for a selected `display:` source. Window capture uses Windows Graphics Capture (`CreateForWindow`) for a selected `hwnd:` source. The helper never chooses an output path. It emits JSON Lines (`aiwvid` / `application/x-ai-workmate-video-jsonl`) with JPEG frames, sequence, timestamps, byte length, and SHA-256. The TypeScript provider validates JPEG SOI (`FF D8`) and hashes before feeding `NativeCaptureCoordinator`.

Limits: DXGI Desktop Duplication typically requires a desktop session (not a disconnected RDP session). Windows Graphics Capture cannot capture protected content and may fail for minimized/UWP windows. Frames are scaled to a max width of 1280 at ~5 fps JPEG. This is an intermediate capture format, not H.264. Mixed audio+video sessions are not implemented.

On a **real Windows** machine after `npm run build:native:win`:

```bat
npm run verify:windows-native-screen-capture
npm run verify:windows-native-window-capture
```

The screen command was executed on a real Windows host (`--duration-ms=10000`): `success: true`, `windowsVerified: true`, isolated temp DATA_ROOT, real DXGI Desktop Duplication frames committed through the artifact journal (SQLite `COMMITTED`). The window command captures a real enumerated HWND through Windows Graphics Capture for the requested duration, commits the `aiwvid` JSONL artifact through the same StorageRuntime/journal pipeline, and verifies sequence ordering, JPEG framing, SHA-256, SQLite `COMMITTED` status, and the final artifact. Window selection is deterministic: the helper's enumeration already excludes invisible/cloaked/tool/untitled windows, and the verifier prefers ordinary application windows over the shell desktop (`Program Manager`), ordering candidates by numeric HWND. If WGC produces no frames for the selected window (for example it is minimized, protected/DRM content, or otherwise ineligible), verification **fails clearly** and never silently falls back to SCREEN capture.

Linux fail-closes with `windowsVerified: false`. The DXGI screen runtime verification is **WINDOWS-VERIFIED** (real Windows host run); the WGC window runtime verification is implemented and Linux-tested but was **not** executed in this Linux sandbox. Three real Windows WGC failures were observed and are addressed by four commits (`bb25d29`, `434ecfe`, `106cc65`, and the current zero-frame fix). First run: "Marshaling directives are invalid." — the ComImport interface passed a projected WinRT type (`[MarshalAs(UnmanagedType.IInspectable)] out GraphicsCaptureItem`), which the CLR cannot marshal against CsWinRT projections on .NET Core+. That declaration was corrected to the ABI pattern (`IntPtr` return + `GraphicsCaptureItem.FromAbi`). Second run advanced past the item interop and then failed with `NATIVE_WINDOWS_API_INITIALIZATION_FAILED` / "Specified cast is not valid." — CsWinRT surfaces a failed COM `QueryInterface` (`E_NOINTERFACE`, 0x80004002) as an `InvalidCastException` with that bare message. That fix keeps the canonical interop shapes and makes init self-describing: the WinRT D3D device is created with the documented `MarshalInterface<IDirect3DDevice>.FromAbi(...)` conversion, the item interop uses the canonical `IGraphicsCaptureItem` IID constant, and `ApiInformation` pre-flights WGC/`CreateFreeThreaded`/`StartCapture`/`IsSupported` so old builds and RDP/basic-adapter sessions fail with the real reason instead of a cast exception or silent silence. Third run (after the second fix, hwnd 40364/Excel and hwnd 10678/LinkedIn): StartCapture succeeded but **zero frames arrived** over 10 s — a silent pipeline failure with no exception, so the init-stage tags could not fire. The third fix removes the silent-failure surface: minimized windows are excluded from enumeration (`IsIconic`; WGC never delivers frames for them), the D3D11 device is created on the DXGI adapter of the window's monitor (`MonitorFromWindow`/`GetMonitorInfo` output match, mirroring the verified SCREEN path — a default-adapter device on multi-GPU machines captures nothing), the whole session graph (item/pool/session/device) is held in process-lifetime roots so GC cannot race asynchronous `FrameArrived`, every delivery stage (FrameArrived, TryGetNextFrame, surface readback, JPEG encode) is counted instead of silently swallowed, and a zero-frame session now fails closed with `NATIVE_CAPTURE_STREAM_FAILED` naming the exact stage (`[stage:frame-arrival]`, `try-get-next-frame`, `surface-readback`, or `jpeg-encode`) plus a structured `state` record (startCaptureSucceeded, frameArrivedCount, tryGetNextFrameCount, tryGetNextFrameNullCount, frameAcquiredCount, readbackCount, jpegEncodedCount, encodeFailureCount, first/last frame timestamps, monitor) that the verifier reports as `nativeCaptureState`. The real Windows re-run of the window command is still pending.

## Unified meeting capture lifecycle (Phase 8)

Phase 8 adds one orchestrated meeting capture lifecycle at the storage/main-process level. `MeetingCaptureOrchestrator` coordinates MICROPHONE, SYSTEM_LOOPBACK, SCREEN, and WINDOW as **independent sources under one meeting** on top of the existing Phase 5/6 stack (`LocalFirstStore` + `LocalRecordingCaptureEngine` + `NativeCaptureCoordinator` + the real native adapters). No GUI, installer, cloud, muxing, or renderer capture IPC was added, and the verified native WASAPI/DXGI/WGC implementations are unchanged.

- **Typed config:** `{ microphone, systemLoopback, screen, window? }` where each capability enables that source. `""` for `window` means deterministic validated default selection; path-like or control-character values are rejected, and an empty config throws before any meeting is created. No renderer filesystem paths enter the flow.
- **Transactional start:** capability/policy/disk validation happens before the meeting is created; any source that fails to start rolls back the whole meeting so a partial failure never leaves a half-open meeting.
- **Independent artifacts:** every source gets its own artifact (sequence numbers, SHA-256, atomic finalization) under flow-unique on-disk paths (`meeting_<meetingId>_<discriminator>.<ext>` for flow-managed recordings; single non-flow capture paths stay byte-identical). MEETING_MANIFEST remains `Meeting.json`.
- **Lifecycle guarantees:** stop → finalize → verify → only-then `COMPLETED`; abort never claims `COMPLETED` and stays recoverable; crash recovery covers `STARTING`/`RECORDING`/`STOPPING`; concurrent sources never deadlock on partial failure.
- **20 Linux-safe interface-double scenarios** in `tests/meeting-capture-orchestrator.test.ts` cover the lifecycle, rollback, crash recovery, commit ordering, abort, session occupancy, and config validation. Linux tests inject adapter/engine doubles; they never simulate native capture.
- **Windows runtime verification (real native helpers, no mocks):**

```bat
npm run build:native:win
npm run verify:meeting-capture
npm run verify:meeting-capture -- --include-window
```

The verifier (`src/capture/MeetingCaptureVerification.ts`, exported as `runMeetingCaptureVerification()`) runs one real meeting for ~4 s in an isolated temp DATA_ROOT — real WASAPI microphone + system loopback + DXGI screen, plus WGC WINDOW when `--include-window` is passed (or `--window-source-id=<hwnd>` selects explicitly) — then reports per-source artifact existence and SHA-256, journal and SQLite commit state, snapshot isolation (no absolute DATA_ROOT, no recording bytes in SQLite), and renderer security preferences. Extra flags: `--duration-ms=<ms>`, `--keep-workspace`. On non-Windows it fail-closes into the same structured JSON (`success: false`, `windowsRuntimeVerified: false`, `nativeRuntime: "none"`, `failureCode: MEETING_CAPTURE_VERIFY_PLATFORM_UNSUPPORTED`) and never claims Windows verification. The real Windows run of this command is still pending.

## Local transcription (Phase 7)

Phase 7 transcribes a committed meeting recording already stored under `DATA_ROOT`. The pipeline:

1. load the recording by meeting UUID + recording UUID;
2. reject paths that leave `DATA_ROOT`/`Meetings`;
3. validate AIWPCM JSONL (record types, format metadata, monotonic sequence, per-chunk SHA-256, non-empty PCM);
4. reconstruct PCM and a WAV wrapper in memory for an engine;
5. call a **local** `TranscriptionEngine`;
6. persist transcript JSON/text under the meeting `Transcript/` folder through the existing atomic, SHA-256, journaled `saveTranscript()` path;
7. index SQLite metadata only (`recording_id`, `engine_id`, artifact IDs, language).

Lifecycle: `PROCESSING` while work is in progress; `COMPLETED` only after the transcript artifact and SQLite row exist; `FAILED` for non-retryable validation/engine-not-configured errors; `INCOMPLETE` for retryable interruption. Restart recovery marks an in-flight transcription `INCOMPLETE`.

Phase 7A does **not** invent transcript text. Tests may inject engine doubles.

## Local whisper.cpp speech-to-text (Phase 7B)

Production `StorageRuntime` now defaults to `WindowsLocalWhisperEngine`. It converts AIWPCM (including 48 kHz / 2 ch / 32-bit WASAPI PCM) to 16 kHz mono 16-bit WAV and runs **whisper.cpp** (`whisper-cli.exe`) on the Windows machine. Audio is not uploaded.

The CLI and ggml/gguf model are **not** in Git. Install:

- `%LOCALAPPDATA%\AI-WorkMate\native\whisper-cli.exe`
- `%LOCALAPPDATA%\AI-WorkMate\models\whisper\ggml-tiny.bin`

Missing runtime/model fails with `TRANSCRIPTION_ENGINE_UNAVAILABLE`. Speaker diarization is not implemented. Tests inject helper doubles only.

## Windows runtime/model install and verification (Phase 7C)

Install the CLI manually:

```bat
copy whisper-cli.exe %LOCALAPPDATA%\AI-WorkMate\native\whisper-cli.exe
```

Install the allowlisted model (HTTPS + SHA-256, atomic, no renderer URL):

```bat
npm run install:whisper-model -- ggml-tiny.bin
```

Then on a **real Windows** machine:

```bat
npm run verify:windows-local-transcription
```

`windowsVerified` is true only if whisper.cpp actually transcribes the spoken fixture (`tests/fixtures/whisper-speech.wav`, rebuilt as 48 kHz / 2 ch / 32-bit AIWPCM). Linux fail-closes and is not a Windows claim.

**WINDOWS-VERIFIED:** After `b43172f0`, a real Windows run produced `success: true`, `windowsVerified: true`, `platform: "win32"`, `helperFound: true` (`whisper-cli.exe`), `modelFound: true` (`ggml-tiny.bin`), `engineVersion: "whisper.cpp version: 1.9.3"`, `transcriptionCompleted: true`, `recognizedText: "AI Workmate records meetings locally. This spoken fixture is for Windows Whisper Verification only."`, `sqliteStatus`/`journalStatus` `COMMITTED`, `meetingStatus` `COMPLETED`, `cloudServiceUsed: false`, `isolatedWorkspace: true`, `userDataUntouched: true`.

## Local llama.cpp analysis

Production `StorageRuntime` defaults to `LocalLlmProvider`. It loads a committed transcript, enforces `AIProcessingPolicyEnforcer`, spawns **llama.cpp** (`llama-cli.exe`) with a fixed argv, validates `AnalysisDocument` JSON, and calls `saveAnalysis()`. Transcript content is not uploaded.

The CLI and GGUF model are **not** in Git:

```bat
mkdir %LOCALAPPDATA%\AI-WorkMate\native
copy llama-cli.exe %LOCALAPPDATA%\AI-WorkMate\native\llama-cli.exe
npm run install:local-llm-model -- qwen2.5-7b-instruct-q4_k_m
set AI_WORKMATE_LOCAL_LLM_MODEL_ID=qwen2.5-7b-instruct-q4_k_m
npm run verify:windows-local-analysis
```

- **Qwen2.5-0.5B-Instruct Q4_K_M** is a **smoke-test / runtime** model (`npm run install:local-llm-model -- qwen2.5-0.5b-instruct-q4_k_m.gguf`). It can prove llama.cpp runs. It is **not** production-quality meeting analysis.
- **Qwen2.5-7B-Instruct Q4_K_M** (official split GGUF, two shards) is the **intended production** local analysis model. Default `AI_WORKMATE_LOCAL_LLM_MODEL_ID` is `qwen2.5-7b-instruct-q4_k_m`.
- `windowsVerified` / `realAiVerified` mean the CLI produced schema-valid JSON that was journaled. **REAL-AI-QUALITY-VERIFIED** is true only after a real Windows run with the **7B** model yields an informative summary and multiple real decisions/tasks from the fixture. Linux fail-closes. This sandbox is **not REAL-AI-QUALITY-VERIFIED**.

## Location migration

Changing the location is an explicit migration:

1. validate the destination and writability;
2. check free space plus a safety margin;
3. show the file/meeting/byte migration plan;
4. copy into a staging directory;
5. hash-verify every copied file and verify meeting IDs/relationships;
6. activate the destination and switch the running store;
7. update the separate application configuration;
8. clear the durable migration journal only after the configuration update succeeds.

The configuration journal records `STARTED`, `COPYING`, `VERIFIED`, `ACTIVATING`, `ACTIVATED`, `RUNTIME_SWITCHED`, `CONFIGURATION_UPDATED`, `FAILED`, and `INCOMPLETE`. The source data root is retained. An existing empty destination is moved aside rather than silently deleted. If a process stops during migration, startup either activates a fully verified destination or keeps the verified source active and records an incomplete migration for explicit follow-up.

## Microsoft 365 calendar discovery (Phase 4)

The Microsoft 365 layer is implemented as a provider boundary, not scattered Graph calls. `MicrosoftGraphClient` accepts an injected OAuth/MSAL-style auth provider and transport, `MicrosoftGraphCalendarProvider` retrieves `calendarView` events with pagination and event lookup, and `CalendarSyncService` normalizes events before writing only local meeting associations. Tests inject fake transports at the boundary and never call Microsoft Graph. Production code does not ship fake calendar data.

Normalized calendar events capture the Microsoft Graph event ID, subject, start/end time, organizer, attendees, location, online meeting details, Outlook web URL, cancellation state, and last modified timestamp. Teams detection is deterministic and stores the platform as `TEAMS`, `OTHER_ONLINE`, or `NONE`; it does not treat every online meeting as Teams.

Discovered meetings are associated through `calendar_event_associations` in the current SQLite schema, keyed by `(provider, external_event_id)` and linked back to the authoritative AI WorkMate meeting UUID. The external Microsoft event ID never replaces the internal UUID. Repeated synchronization is idempotent and preserves existing recordings, transcripts, analysis, and progressed lifecycle states. Calendar discovery creates new future meetings as `SCHEDULED` only; it never implies recording has started.

The Microsoft credential boundary uses the existing Electron `safeStorage`-backed credential store for an opaque MSAL-style token cache outside `DATA_ROOT`. Access tokens, refresh tokens, client secrets, and raw credential objects are not stored in SQLite and are not exposed to the renderer. The renderer-facing sync IPC returns only safe counts and sanitized error codes.

**Environment note:** live Microsoft OAuth/MSAL sign-in, tenant consent, Windows DPAPI execution, and live Microsoft Graph connectivity were not executed in this Linux/headless sandbox. They remain documented as **NOT TESTED** or **WINDOWS-UNVERIFIED** rather than claimed as verified.

## Storage services

`LocalStorageService` is the filesystem boundary. It owns directory creation, safe relative paths, meeting folders, artifact naming, streaming writes, SHA-256 hashing, disk-space checks, stats, migration, and recovery-safe file operations. `LocalDatabase` owns the local SQLite index and its durable artifact-operation state. `StorageIntegrityService` and `RecoveryScanner` report inconsistencies without deleting user data.

`BackupService` creates a user-triggered, standard ZIP containing a consistent SQLite snapshot, local files, hashes, and `BackupManifest.json`. `ExportService` creates a portable per-meeting ZIP with `Meeting.json`, media, transcript formats, analysis, and relationship metadata. Backup retention deletion requires explicit confirmation. Backup, restore, migration confirmation, and export IPC responses expose sizes/statuses only; they do not return absolute filesystem paths to the renderer.

## Privacy and AI policy

The desktop renderer receives an allow-listed preload API, not `fs`, `path`, `ipcRenderer`, or `DATA_ROOT` access. IPC handlers authorize only the active application `webContents` and exact trusted renderer URL. Main-process navigation/redirect/frame policy rejects untrusted URLs, new windows are denied, and webview attachment is blocked. Storage settings displays safe location metadata such as `Local workspace (path hidden)` and uses a controlled main-process operation to open the selected folder.

Credentials are represented by an OS-encrypted vault adapter using Electron `safeStorage`/Windows DPAPI semantics and are never placed in meeting folders or DATA_ROOT backups. The AI abstraction supports local and injected cloud adapters. `LOCAL_ONLY`, `CLOUD_ALLOWED`, and `ASK_EACH_TIME` are checked before content is handed to a provider.

Phase 4 adds Microsoft Graph calendar discovery, Teams meeting detection, idempotent local meeting associations, and renderer-safe sync IPC. Phase 5 adds only the local recording/capture boundary and local file-backed chunk/stream adapter. Phase 6A adds the native-source capability/policy/coordinator boundary without adding a fake capture provider. Phase 6B adds Windows microphone and system-audio/loopback provider code and is **WINDOWS-VERIFIED** for real helper capture. Phase 6C wires that provider through `StorageRuntime` into the existing local-first journal path without capture IPC and is **WINDOWS-VERIFIED** for real microphone and WASAPI loopback persistence. Phase 8 adds the unified meeting capture orchestrator at the storage/main-process level (typed per-source config, transactional start with rollback, per-source artifacts with sequence/SHA-256/atomic finalization under flow-unique paths, stop → finalize → verify → `COMPLETED`, recoverable abort, crash recovery over `STARTING`/`RECORDING`/`STOPPING`) with 20 Linux-safe interface-double scenarios and a fail-closed Windows verifier (`npm run verify:meeting-capture`); its real WASAPI/DXGI/WGC run is pending a real Windows host. The application still does not supply actual Teams/Zoom/Google Meet/browser/screen capture, a bundled speech-to-text runtime, AI provider implementation, background scheduler, or live Microsoft sign-in UX; no fake content or fake production calendar data is used. Committed-transcript analysis (`LocalAnalysisService`) enforces AI policy then persists validated JSON through `saveAnalysis()`. Production default is `LocalLlmProvider` (llama.cpp + allowlisted GGUF). Missing runtime/model fail closed. There is no live OpenAI key and no invented analysis text. **REAL-AI-VERIFIED** is not claimed until `npm run verify:windows-local-analysis` succeeds on Windows.

## Scope of this change

This change adds a production local llama.cpp analysis provider, allowlisted GGUF installer, discovery, and Windows verification harness on top of the existing analysis pipeline. Real Windows microphone/loopback capture and spoken-fixture Whisper transcription remain **WINDOWS-VERIFIED**. Real local LLM execution is **not REAL-AI-VERIFIED** in this Linux sandbox. It does **not** implement Teams/Zoom/Google Meet/browser/screen/window recording, Git-bundled Whisper/llama binaries, live OAuth sign-in UX, background calendar scheduling, or cloud synchronization. Optional encrypted sync remains a future opt-in boundary. Windows Electron GUI, Microsoft MSAL/DPAPI/ACL, disk-full, signed installer, update, uninstall behavior, and live Microsoft Graph connectivity remain **WINDOWS-UNVERIFIED**. See [docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md) for exact implementation, test, and remaining-gap statuses.
