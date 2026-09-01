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
   ├── OS credential primitive (Electron safeStorage / Windows DPAPI)
   └── optional AIProvider (local or policy-approved cloud)
```

`DATA_ROOT` is not the installation folder and does not live in a cloud database. The app configuration outside the root contains the selected root, policy, and migration journal only, so changing the root does not lose the pointer to the new location. The renderer receives `{ type: "LOCAL", label, pathExposed: false }`, not the absolute root. Opening the folder is a controlled main-process operation.

## Electron trust model

The main process records the actual application BrowserWindow's `webContents.id` and exact trusted renderer file URL. Every storage IPC handler checks both the sender and sender frame before dispatching. The window is created with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. Non-trusted main/frame navigation and redirects are prevented, new windows are denied, and webview attachment is prevented. The renderer document additionally uses a self-only CSP.

The Linux-runnable tests exercise the pure security policy and IPC authorization harness. Electron/Chromium event delivery itself is not tested in the headless environment and remains Windows/Electron-unverified.

## Database/filesystem contract

SQLite indexes relationships, calendar associations, and metadata. Filesystem artifacts hold large media and portable user-visible formats. An artifact is complete only when:

1. a durable SQLite `artifact_operations` row is recorded as `STARTED` and then `WRITING`;
2. a same-directory temporary file has been written, flushed, and hash-verified;
3. it has been atomically renamed to its final meeting-ID filename;
4. the journal reaches `FINALIZING`; and
5. the artifact and relationship rows plus the journal reach `COMMITTED` in one SQLite transaction.

The journal also records `FAILED` and `INCOMPLETE`. On restart, pending operations are verified. A valid indexed file can be completed as `COMMITTED`; an ambiguous final or temporary file is retained, marked/reportable as incomplete or orphaned, and is not silently imported. If a user deletes or modifies a file, the next verification marks the row `MISSING` or `CORRUPTED`. Calendar discovery metadata is held in `calendar_event_associations` and keyed by `(provider, external_event_id)`, so a Microsoft Graph event maps to an internal meeting UUID without replacing that UUID.

A meeting still marked `RECORDING` when the application opens is safely changed to `INCOMPLETE`. Recovery reports known orphans, temporary recordings, unknown meeting-shaped folders, invalid manifests, missing databases, and missing/corrupt artifacts. Unknown data is preserved. Re-indexing is limited to orphaned files inside a folder whose meeting ID is already known in SQLite; no meeting record is invented from an unknown folder.

## Disk and path safety

Recording preflight requires the estimated write plus a configurable safety margin. A failed or unknown free-space query is treated as unsafe and blocks recording. During an active recording, the monitor treats unknown/critical space as a critical callback, marks the meeting incomplete through the store, and stops its timer even if the callback fails.

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

The local aggregate owns a strict state machine: `SCHEDULED → DETECTED → PREPARING → RECORDING → FINALIZING → PROCESSING → COMPLETED`, with explicit recoverable exits to `INCOMPLETE` or `FAILED` and cancellation where valid. SQLite enforces the allowed status vocabulary and the service rejects invalid transitions. A recording saved through the compatibility storage method advances through the recording/finalization states; capture engines should use `prepareRecording()` and `ingestRecording()` at the handoff boundary.

`ingestRecording()` accepts a real, already-materialized source file plus source type, MIME, original filename, timestamps, and optional size. It does not create bytes. `ingestTranscript()` accepts real plain text or structured JSON (and records requested VTT/SRT derivatives) and does not transcribe. `processTranscriptWithProvider()` invokes the existing `AIProvider`, validates meeting identity and analysis JSON, then calls `saveAnalysis()`; provider errors leave a non-success state.

The canonical per-meeting layout is `Meetings/YYYY/MM/YYYY-MM-DD_<slug>_<UUID>/` containing `Meeting.json`, `Recording/Original`, `Recording/Normalized`, `Audio`, `Transcript`, `Analysis`, `Attachments`, and `Exports`. Every indexed artifact path is under its owning folder and includes the UUID where a filename is generated. Microsoft calendar sync may add or update an association for the meeting, but it must not move meeting folders or reset progressed lifecycle state.
