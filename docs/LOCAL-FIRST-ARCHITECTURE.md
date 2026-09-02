# Local-first architecture

## Ownership boundary

The desktop main process owns the local data root. The renderer can request named operations through the preload bridge, but cannot read a directory, construct an arbitrary path, open a file, or invoke `ipcRenderer` directly.

```text
Renderer
   │  allow-listed storage API; safe metadata only
   ▼
Preload (contextBridge, context isolation, sandbox, no nodeIntegration)
   │  named IPC channels; native dialogs choose paths
   ▼
Electron main process
   ├── exact active-webContents/renderer-URL authorization
   ├── navigation, redirect, frame, window-open, and webview restrictions
   ├── StorageRuntime / StorageConfigService
   ├── LocalFirstStore
   │     ├── LocalDatabase  ── DATA_ROOT/Database/ai-workmate.sqlite
   │     ├── LocalStorageService ── DATA_ROOT/Meetings + metadata
   │     ├── StorageIntegrityService / RecoveryScanner
   │     ├── BackupService / ExportService
   │     └── local audit and artifact-operation journals
   ├── CalendarSyncService
   │     └── MicrosoftGraphCalendarProvider / MicrosoftGraphClient (auth + transport injected)
   ├── LocalRecordingCaptureEngine
   │     └── LocalStorageService staged writes + LocalFirstStore journal commit
   ├── NativeCaptureCoordinator / WindowsCaptureAdapter
   │     └── capability discovery + policy + real native-provider handoff
   ├── WindowsNativeAudioProvider
   │     └── .NET/NAudio helper using CoreAudio/WASAPI microphone + loopback APIs
   ├── StorageRuntime native capture API (main process only; no renderer capture IPC)
   ├── LocalTranscriptionService / TranscriptionEngine (AIWPCM → local engine → transcript artifacts)
   ├── WindowsLocalWhisperEngine + WhisperModelInstaller (allowlisted HTTPS models in LocalAppData)
   ├── OS credential primitive (Electron safeStorage / Windows DPAPI)
   └── optional AIProvider (local or policy-approved cloud)
```

`DATA_ROOT` is not the installation folder and does not live in a cloud database. The app configuration outside the root contains the selected root, policy, and migration journal only, so changing the root does not lose the pointer to the new location. The renderer receives `{ type: "LOCAL", label, pathExposed: false }`, not the absolute root. Opening the folder is a controlled main-process operation.

## Electron trust model

The main process records the actual application BrowserWindow's `webContents.id` and exact trusted renderer file URL. Every storage IPC handler checks both the sender and sender frame before dispatching. The window is created with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. Non-trusted main/frame navigation and redirects are prevented, new windows are denied, and webview attachment is prevented. The renderer document additionally uses a self-only CSP.

The Linux-runnable tests exercise the pure security policy and IPC authorization harness. Electron/Chromium event delivery itself is not tested in the headless environment and remains Windows/Electron-unverified.

## Database/filesystem contract

SQLite indexes relationships, calendar associations, recording metadata, and artifact metadata. Filesystem artifacts hold large media and portable user-visible formats. An artifact is complete only when:

1. a durable SQLite `artifact_operations` row is recorded as `STARTED` and then `WRITING`;
2. a same-directory temporary file has been written, flushed, and hash-verified;
3. it has been atomically renamed to its final meeting-ID filename;
4. the journal reaches `FINALIZING`; and
5. the artifact and relationship rows plus the journal reach `COMMITTED` in one SQLite transaction.

The journal also records `FAILED` and `INCOMPLETE`. SQLite schema version 6 records safe committed-recording metadata and transcript-to-recording/engine indexes without storing recording or transcript bytes. On restart, pending operations are verified. A valid indexed file can be completed as `COMMITTED`; an ambiguous final or temporary file is retained, marked/reportable as incomplete or orphaned, and is not silently imported. If a user deletes or modifies a file, the next verification marks the row `MISSING` or `CORRUPTED`. Calendar discovery metadata is held in `calendar_event_associations` and keyed by `(provider, external_event_id)`, so a Microsoft Graph event maps to an internal meeting UUID without replacing that UUID.

A meeting still marked `RECORDING` when the application opens is safely changed to `INCOMPLETE`. Recovery reports known orphans, temporary recordings, unknown meeting-shaped folders, invalid manifests, missing databases, and missing/corrupt artifacts. Unknown data is preserved. Re-indexing is limited to orphaned files inside a folder whose meeting ID is already known in SQLite; no meeting record is invented from an unknown folder.

## Local recording/capture boundary (Phase 5)

`CaptureEngine` is the Phase 5 abstraction for local recording ownership. It starts capture by internal meeting UUID, exposes state/error snapshots, accepts controlled binary chunks or async/iterable streams, finalizes once, and aborts safely. The interface does not accept caller output paths. `LocalRecordingCaptureEngine` is the local Windows-suitable file-backed adapter for bytes supplied by a future real capture source; it does not automate Teams, Zoom, Google Meet, browsers, microphones, speakers, or screen capture.

The adapter enforces exactly one active capture per meeting and rejects wrong-meeting writes/finalization, duplicate finalization, writes after finalization, empty or non-binary chunks, unsafe container extensions/MIME types, and out-of-order explicit chunk sequences. It keeps absolute temp/final paths inside `LocalStorageService` and returns only safe metadata such as meeting UUID, capture ID, state, byte/chunk counts, relative path, SHA-256, and journaled error information.

Capture writes use the same storage guarantees as other artifacts: same-directory `.tmp-*` files, exclusive temp creation, per-chunk file sync, pre-rename SHA-256 verification, atomic rename, directory sync, post-rename SHA-256 verification, and SQLite indexing only after finalization succeeds. Successful capture commit moves the meeting through `FINALIZING` to `PROCESSING`. Abort, insufficient/unknown disk space, and monitor critical-space safe-stop mark the capture and meeting `INCOMPLETE`; finalization/storage failures mark them `FAILED`. Restart recovery leaves interrupted captures incomplete/reportable and never silently completes partial `.tmp-*` recordings.

## Native capture source boundary (Phase 6A)

`NativeCaptureAdapter` is the production-facing source boundary above the local capture engine. It reports structured capabilities for microphone audio, system audio, screen capture, and window capture with explicit `AVAILABLE`, `UNAVAILABLE`, `UNSUPPORTED`, or `PERMISSION_DENIED` status and typed errors. Capability source descriptors contain safe source IDs/labels only and no filesystem paths.

`WindowsCaptureAdapter` does not capture by itself and does not fabricate media. On non-Windows platforms, `createNativeCaptureAdapter()` returns an unsupported adapter. On Windows, the factory wires `WindowsNativeAudioProvider`; a missing helper reports `NATIVE_PROVIDER_NOT_CONFIGURED`. `NativeCaptureCoordinator` feeds real native chunks into `LocalRecordingCaptureEngine` in sequence so the same SHA-256, atomic write, journal, metadata, lifecycle, recovery, and disk-space rules apply.

Native capture policy is default-deny at the coordinator. `StorageRuntime` allow-lists microphone and system audio on Windows only; screen and window remain denied. The coordinator rejects denied or unavailable capabilities before creating a local recording, keys active ownership by the internal meeting UUID, rejects wrong-meeting stop/abort calls, and rejects caller-supplied output paths. No native capture IPC exists, so renderer filesystem/capture isolation remains unchanged. Linux/headless tests use injected adapter/helper doubles to verify orchestration. Real Windows microphone and WASAPI loopback helper capture is **WINDOWS-VERIFIED**. Screen/window capture remains a **REMAINING GAP**.

## Windows native audio provider (Phase 6B)

`WindowsNativeAudioProvider` is the first concrete native provider path; the default Windows native adapter factory wires it and reports `NATIVE_PROVIDER_NOT_CONFIGURED` instead of falling back if the helper is absent. It delegates to `native/windows-audio/AIWorkMate.WindowsAudioCapture`, a Windows-only .NET 8 helper that uses NAudio/CoreAudio/WASAPI. Microphone capture enumerates and opens Windows capture endpoints. System audio capture enumerates render endpoints and uses WASAPI loopback. The helper emits safe JSON capability data: active device IDs, human-readable labels, default flags, and typed errors; it does not expose filesystem paths and does not accept output paths.

The capture stream format is `aiwpcm` with MIME `application/x-ai-workmate-pcm-jsonl`. It is a lossless intermediate JSON Lines format:

1. a `format` record with source, source ID, source label, capture start timestamp, and the WASAPI-reported PCM format;
2. one `chunk` record per captured audio frame with source, source ID, sequence number, capture timestamp, PCM format, byte length, SHA-256 of the PCM payload, and base64 PCM bytes.

The TypeScript provider validates helper records before the coordinator writes them: chunk sequence must be contiguous, timestamps must parse, source/source ID/format must remain stable, byte length must match the decoded PCM payload, and per-chunk SHA-256 must match. The coordinator then writes through `LocalRecordingCaptureEngine`, preserving the existing local journal, atomic file writes, whole-file SHA-256, recording metadata, disk-space checks, and lifecycle transitions.

The helper build is separate from the Linux TypeScript build: `npm run build:native:win` publishes the Windows executable and `npm run package:win` includes it as an Electron extra resource. Real Windows verification built the helper, enumerated Jack Mic (Realtek Audio) and Speakers / Headphones (Realtek Audio), captured 977-line microphone JSONL and 2229-line loopback JSONL with no error records, and used the real NAudio implementation. Status for helper capture: **WINDOWS-VERIFIED**. Microphone and loopback streams are independently sequenced; cross-source synchronization, mixing, and echo cancellation are explicitly not solved yet.

## Windows runtime verification command (Phase 6C)

The production path is verified on a real Windows host with:

```bat
cd /d C:\AI-WorkMate
git checkout arena/01a0609d-ai-workmate
git pull
npm install
npm run build:native:win
npm run verify:windows-native-capture
```

That command builds TypeScript, publishes the real `.NET` helper, then runs `StorageRuntime.startNativeCapture()` against the real WASAPI helper for a short isolated capture (3 seconds each) of the default microphone and default loopback endpoint. It also aborts one capture to confirm incomplete journal behavior. It uses a temporary DATA_ROOT and config outside any existing user workspace, then deletes that workspace unless `--keep-workspace` is passed.

Optional:

```bat
npm run verify:windows-native-capture -- --duration-ms=5000
node dist/scripts/verify-windows-native-capture.js --keep-workspace
```

Success criteria: JSON `success: true`, `windowsVerified: true`, abort `INCOMPLETE` with zero SQLite recordings, and each capture `COMMITTED` with `chunkCount > 0`, `firstSequence: 0`, matching SHA-256, meeting UUID ownership, and a non-empty final artifact. Linux/headless runs fail closed with `NATIVE_PLATFORM_UNSUPPORTED` and must not be labeled WINDOWS-VERIFIED.

## Application integration (Phase 6C)

`StorageRuntime` constructs the capture stack whenever a store is attached: native adapter, `LocalRecordingCaptureEngine`, and `NativeCaptureCoordinator`. Callers in the main process start/stop/abort by meeting UUID. Closing the runtime aborts active native sessions. DATA_ROOT, absolute paths, helper process handles, and device paths are not returned to the renderer; no capture IPC channels exist. Native chunks that pass provider validation are appended through `LocalRecordingCaptureEngine` and committed only via the existing artifact journal. Real Windows microphone and loopback persistence through this path is **WINDOWS-VERIFIED**.

## Local transcription (Phase 7)

Committed AIWPCM recordings are transcribed locally. `LocalTranscriptionService` validates JSONL types, PCM format metadata, monotonic chunk sequence, and per-chunk SHA-256, reconstructs PCM, and calls `TranscriptionEngine`. Phase 7B production default is `WindowsLocalWhisperEngine`: 16 kHz mono WAV in a temp directory, then whisper.cpp with a fixed argv. Models live in `%LOCALAPPDATA%\AI-WorkMate\models\whisper\`, not Git. Missing CLI/model is `TRANSCRIPTION_ENGINE_UNAVAILABLE`. Tests may inject helper doubles; production still uses the real spawn path. No speaker diarization. Transcript JSON/text are journaled under `Transcript/`. SQLite stores metadata only. Lifecycle is `PROCESSING` → `COMPLETED` after verified artifacts and index rows, or `FAILED`/`INCOMPLETE`. Real Windows spoken-fixture transcription through this path is **WINDOWS-VERIFIED** (Phase 7C).

## Disk and path safety

Recording/capture preflight, including Windows native audio capture, requires the estimated write plus a configurable safety margin. A failed or unknown free-space query is treated as unsafe and blocks recording. During active capture, each chunk is checked through the same disk-space boundary before append. The monitor treats unknown/critical space as a critical callback, marks the meeting incomplete through the store, and stops its timer even if the callback fails.

The data-root policy rejects the application installation directory and boundary-aware Windows protected roots including `Program Files`, `Program Files (x86)`, `Windows`, `WindowsApps`, `ProgramData`, common program-file roots, and environment-derived system roots. Windows-style policy cases run on Linux; actual Windows ACL, path, and disk behavior still requires a Windows host.

## Location migration

Location changes are copy-then-verify operations. The destination must be outside the current root and empty or new. A durable configuration journal records:

`STARTED → COPYING → VERIFIED → ACTIVATING → ACTIVATED → RUNTIME_SWITCHED → CONFIGURATION_UPDATED`

with `FAILED`/`INCOMPLETE` recovery states. A staging directory is populated, file counts/sizes/hashes and meeting ID relationships are compared, the destination is activated only after verification, the running store switches, and the separate application configuration is updated. The journal is cleared last. The source root is never removed; an existing empty destination is moved aside rather than deleted. On restart, an activation-stage journal is accepted only after the destination and all user/database files (apart from the intentionally updated manifest label) verify against the source. Otherwise the source remains active and the migration is explicitly incomplete.

Migration preview and confirmation return counts, bytes, explanations, and safe status metadata to the renderer; source and destination paths remain main-process data.

## Backup and export

Backups are standard ZIP files with a consistent SQLite snapshot, storage metadata, all non-backup local files, and a hash manifest. They are written atomically to a user-selected location outside `DATA_ROOT`; old backup archives are not silently pruned. Restore uses a separate staging root and verifies the archive before activation. Meeting exports contain `Meeting.json`, ID-based artifacts, `MeetingMetadata.json`, and relationship metadata. IPC returns size/status data rather than archive paths.

## Microsoft 365 calendar discovery boundary (Phase 4)

Calendar discovery is a main-process/service-layer operation. Graph HTTP calls are isolated in `MicrosoftGraphClient`; calendar-specific retrieval and event lookup live in `MicrosoftGraphCalendarProvider`; sync orchestration lives in `CalendarSyncService`; persistence still goes through `LocalFirstStore` and `LocalDatabase`. The renderer can request synchronization only through an allow-listed IPC method that returns counts and sanitized error codes. It never receives access tokens, refresh tokens, client secrets, raw credential objects, raw Graph responses, or absolute paths.

```text
Future scheduler or authorized renderer action
   │  start/end range only
   ▼
CalendarSyncService
   ├── CalendarEventProvider.listEvents(range)
   ├── deterministic Teams detector
   └── LocalFirstStore.upsertCalendarMeeting(normalized event)
          ├── meetings UUID remains authoritative
          └── calendar_event_associations(provider, external_event_id) is unique
```

`MicrosoftGraphClient` requires an injected `MicrosoftGraphAuthProvider` and `MicrosoftGraphTransport`. The production transport uses real `fetch`; tests provide fake transports at the boundary and do not call Microsoft Graph. The auth boundary is compatible with OAuth/MSAL-style access-token acquisition and includes an encrypted, credential-store-backed opaque token cache outside `DATA_ROOT`; this phase does not implement or fake a live sign-in flow.

Graph events are normalized before persistence. The stored association captures the external event ID, subject, start/end time, organizer, attendees, location, online meeting information, Outlook web URL, cancellation state, last modified timestamp, detected platform (`TEAMS`, `OTHER_ONLINE`, or `NONE`), and a deterministic fingerprint. Raw Graph JSON is not persisted unnecessarily.

Calendar synchronization is idempotent. Discovering the same event repeatedly updates the existing association or reports it unchanged, and preserves recordings, transcripts, analysis, and any lifecycle state that has progressed beyond scheduling. A future calendar event creates a `SCHEDULED` meeting only; discovery alone never implies `DETECTED`, `PREPARING`, `RECORDING`, `PROCESSING`, or `COMPLETED`. Cancelled events are counted and update only safe local cancellation metadata/status for scheduled meetings.

## Cloud processing boundary and current AI gap

`AIProvider` is a transient processing interface. `LocalAIProvider` and `OpenAIProvider` share the same contract, but `AIProcessingPolicyEnforcer` runs before any provider receives content:

- `LOCAL_ONLY`: cloud providers are rejected.
- `CLOUD_ALLOWED`: a configured cloud integration may process content.
- `ASK_EACH_TIME`: a cloud request requires explicit approval.

Provider responses are written through the local store when the application chooses to persist them. **`Transcript → AI Provider → saveAnalysis()` is not wired end-to-end in this phase.** Automatic transcription, provider invocation, and analysis persistence are deliberately deferred; no provider is allowed to become the primary database. The Microsoft calendar provider is for discovery only and does not record, transcribe, or process meetings.

## Meeting lifecycle contract (Phase 3)

The local aggregate owns a strict state machine: `SCHEDULED → DETECTED → PREPARING → RECORDING → FINALIZING → PROCESSING → COMPLETED`, with explicit recoverable exits to `INCOMPLETE` or `FAILED` and cancellation where valid. SQLite enforces the allowed status vocabulary and the service rejects invalid transitions. The Phase 5 local capture adapter, Phase 6A native coordinator, and Phase 6B Windows audio provider path start from scheduled/detected meetings through the recording path and commit completed local captures to `PROCESSING`. Phase 7 may then transcribe that recording and move the meeting to `COMPLETED` only after a verified transcript artifact exists. The older compatibility `ingestRecording()` path still accepts a real already-materialized file and does not create bytes.

`ingestRecording()` accepts a real, already-materialized source file plus source type, MIME, original filename, timestamps, and optional size. It does not create bytes. `ingestTranscript()` accepts real plain text or structured JSON (and records requested VTT/SRT derivatives) and does not transcribe. `processTranscriptWithProvider()` invokes the existing `AIProvider`, validates meeting identity and analysis JSON, then calls `saveAnalysis()`; provider errors leave a non-success state.

The canonical per-meeting layout is `Meetings/YYYY/MM/YYYY-MM-DD_<slug>_<UUID>/` containing `Meeting.json`, `Recording/Original`, `Recording/Normalized`, `Audio`, `Transcript`, `Analysis`, `Attachments`, and `Exports`. Every indexed artifact path is under its owning folder and includes the UUID where a filename is generated. Microsoft calendar sync may add or update an association for the meeting, but it must not move meeting folders or reset progressed lifecycle state.
