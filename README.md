# AI WorkMate

AI WorkMate is being built as a **local-first Windows desktop meeting workspace**. This checkout contains the hardened storage foundation required before a full meeting engine is added. Existing meeting data is owned by the desktop process:

```text
Windows desktop
   ├── Local SQLite index (DATA_ROOT/Database/ai-workmate.sqlite)
   ├── Local files (DATA_ROOT/Meetings/...)
   ├── OS-protected credentials (Electron userData, outside DATA_ROOT)
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

Every meeting has a UUID-backed folder. Artifact names also include the authoritative meeting ID, for example `meeting_<MEETING_ID>.mp4`, `audio_<MEETING_ID>.m4a`, and `transcript_<MEETING_ID>.json`. A title and date are never used as a unique key. Video and audio bytes remain files; SQLite stores metadata and relationships only.

DATA_ROOT is actively rejected when it is inside the configured application installation directory or protected Windows locations such as `Program Files`, `Program Files (x86)`, `Windows`, `WindowsApps`, and `ProgramData`. The check is boundary-aware and case-insensitive on Windows.

## Writes, recovery, and disk safety

`LocalStorageService` writes artifacts to same-directory temporary files, flushes them, verifies them, and atomically renames them without overwriting an existing artifact. `LocalFirstStore` records each write in the durable SQLite `artifact_operations` journal with states `STARTED`, `WRITING`, `FINALIZING`, `COMMITTED`, `FAILED`, or `INCOMPLETE`. On restart, unfinished operations are inspected; ambiguous files are reported as incomplete/orphaned and are never silently imported or deleted.

A meeting left in `RECORDING` at restart is marked `INCOMPLETE`. Startup and on-demand integrity checks report missing/corrupt indexed artifacts, orphan files, unknown meeting folders, temporary recordings, invalid manifests, and a missing database. Repair re-indexes only files inside already-known meeting folders. It never invents meeting records or deletes unknown data.

Recording preflight requires free space plus a configurable safety margin. If free space is unknown, recording is blocked. The in-progress disk monitor treats unknown or critical space as a safe-stop condition and marks the meeting incomplete through the storage boundary.

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

## Storage services

`LocalStorageService` is the filesystem boundary. It owns directory creation, safe relative paths, meeting folders, artifact naming, streaming writes, SHA-256 hashing, disk-space checks, stats, migration, and recovery-safe file operations. `LocalDatabase` owns the local SQLite index and its durable artifact-operation state. `StorageIntegrityService` and `RecoveryScanner` report inconsistencies without deleting user data.

`BackupService` creates a user-triggered, standard ZIP containing a consistent SQLite snapshot, local files, hashes, and `BackupManifest.json`. `ExportService` creates a portable per-meeting ZIP with `Meeting.json`, media, transcript formats, analysis, and relationship metadata. Backup retention deletion requires explicit confirmation. Backup, restore, migration confirmation, and export IPC responses expose sizes/statuses only; they do not return absolute filesystem paths to the renderer.

## Privacy and AI policy

The desktop renderer receives an allow-listed preload API, not `fs`, `path`, `ipcRenderer`, or `DATA_ROOT` access. IPC handlers authorize only the active application `webContents` and exact trusted renderer URL. Main-process navigation/redirect/frame policy rejects untrusted URLs, new windows are denied, and webview attachment is blocked. Storage settings displays safe location metadata such as `Local workspace (path hidden)` and uses a controlled main-process operation to open the selected folder.

Credentials are represented by an OS-encrypted vault adapter using Electron `safeStorage`/Windows DPAPI semantics and are never placed in meeting folders or DATA_ROOT backups. The AI abstraction supports local and injected cloud adapters. `LOCAL_ONLY`, `CLOUD_ALLOWED`, and `ASK_EACH_TIME` are checked before content is handed to a provider.

Phase 3 adds strict meeting lifecycle transitions, real recording/transcript ingestion boundaries, and a provider-to-validated-analysis pipeline. The application still does not supply a capture engine, transcription engine, or AI provider; no fake content or external service is used. Automatic transcription, provider invocation, and analysis persistence are future meeting-engine work.

## Scope of this change

This change deliberately does **not** implement Teams, Zoom, Google Meet attendance, calendar ingestion, browser/live recording, advanced AI, or cloud synchronization. Optional encrypted sync remains a future opt-in boundary. Windows Electron GUI, DPAPI/ACL, disk-full, signed installer, update, and uninstall behavior are Windows-unverified because this checkout is validated in a Linux/headless sandbox. See [docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md) for exact implementation, test, and remaining-gap statuses.
