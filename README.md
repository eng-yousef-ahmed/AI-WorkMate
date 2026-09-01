# AI WorkMate

AI WorkMate is being built as a **local-first Windows desktop meeting workspace**. This checkout contains the hardened storage foundation, Phase 4 Microsoft 365 calendar discovery, and Phase 5 local recording/capture boundary required before real platform capture and transcription are added. Existing meeting data is owned by the desktop process:

```text
Windows desktop
   ├── Local SQLite index (DATA_ROOT/Database/ai-workmate.sqlite)
   ├── Local files (DATA_ROOT/Meetings/...)
   ├── OS-protected credentials (Electron userData, outside DATA_ROOT)
   ├── Microsoft Graph calendar adapter boundary (auth/provider injected)
   ├── LocalRecordingCaptureEngine (local chunk/stream boundary only)
   └── Optional provider adapters (local or cloud, policy-gated)
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

Every meeting has a UUID-backed folder. Artifact names also include the authoritative meeting ID, for example `meeting_<MEETING_ID>.mp4`, `audio_<MEETING_ID>.m4a`, and `transcript_<MEETING_ID>.json`. A title and date are never used as a unique key. Video and audio bytes remain files; SQLite schema version 5 stores metadata and relationships only, including safe recording metadata such as file UUID, container, timestamps, duration, byte size, SHA-256, relative path, capture source/adapter, and final status.

DATA_ROOT is actively rejected when it is inside the configured application installation directory or protected Windows locations such as `Program Files`, `Program Files (x86)`, `Windows`, `WindowsApps`, and `ProgramData`. The check is boundary-aware and case-insensitive on Windows.

## Writes, recovery, and disk safety

`LocalStorageService` writes artifacts to same-directory temporary files, flushes them, verifies them, and atomically renames them without overwriting an existing artifact. `LocalFirstStore` records each write in the durable SQLite `artifact_operations` journal with states `STARTED`, `WRITING`, `FINALIZING`, `COMMITTED`, `FAILED`, or `INCOMPLETE`. On restart, unfinished operations are inspected; ambiguous files are reported as incomplete/orphaned and are never silently imported or deleted.

A meeting left in `RECORDING` at restart is marked `INCOMPLETE`. Startup and on-demand integrity checks report missing/corrupt indexed artifacts, orphan files, unknown meeting folders, temporary recordings, invalid manifests, and a missing database. Repair re-indexes only files inside already-known meeting folders. It never invents meeting records or deletes unknown data.

Recording preflight requires free space plus a configurable safety margin. If free space is unknown, recording is blocked. The in-progress disk monitor treats unknown or critical space as a safe-stop condition and marks the meeting incomplete through the storage boundary.

## Local recording/capture boundary (Phase 5)

Phase 5 adds a production local capture boundary, not platform automation. `CaptureEngine` defines start/state/chunk/stream/finalize/abort operations by meeting UUID. `LocalRecordingCaptureEngine` accepts bytes from a real future capture source, enforces one active owner per meeting, rejects wrong-meeting writes, out-of-order chunk sequences, empty/non-binary chunks, duplicate finalization, late writes, and caller-supplied output paths. It never asks the renderer or caller for a filesystem destination.

The local adapter stages bytes through `LocalStorageService.beginStagedArtifactWrite()`, writes same-directory `.tmp-*` files with exclusive creation and per-chunk flush/sync, verifies SHA-256 before and after atomic rename, and calls `LocalFirstStore.commitRecordingCapture()` only after final file verification. The meeting lifecycle advances through `SCHEDULED → DETECTED → PREPARING → RECORDING → FINALIZING → PROCESSING`; aborts or safe-stop disk failures move to `INCOMPLETE`, while finalization failures move to `FAILED`. Incomplete restart recovery is preserved and does not silently index partial recordings.

**Important limit:** this is not a Teams, Zoom, Google Meet, browser, screen, microphone, or system-audio recorder. No transcription or AI processing is started by Phase 5. Windows capture-device behavior remains **WINDOWS-UNVERIFIED** because no Windows audio/video capture is implemented or tested.

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

Phase 4 adds Microsoft Graph calendar discovery, Teams meeting detection, idempotent local meeting associations, and renderer-safe sync IPC. Phase 5 adds only the local recording/capture boundary and local file-backed chunk/stream adapter. The application still does not supply actual Teams/Zoom/Google Meet/browser/screen/microphone/system-audio capture, a transcription engine, AI provider implementation, background scheduler, or live Microsoft sign-in UX; no fake content or fake production calendar data is used. Automatic transcription, provider invocation, and analysis persistence are future meeting-engine work.

## Scope of this change

This change deliberately implements only local recording boundary/storage control. It does **not** implement actual meeting platform recording, Windows audio/video capture, transcription, advanced AI, live OAuth sign-in UX, background calendar scheduling, Zoom/Google Meet-specific integrations, or cloud synchronization. Optional encrypted sync remains a future opt-in boundary. Windows Electron GUI, Microsoft MSAL/DPAPI/ACL, disk-full, signed installer, update, uninstall behavior, and live Microsoft Graph connectivity are Windows/environment-unverified because this checkout is validated in a Linux/headless sandbox. See [docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md) for exact implementation, test, and remaining-gap statuses.
