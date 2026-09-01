# AI WorkMate

AI WorkMate is being built as a **local-first Windows desktop meeting workspace**. This checkout now contains the storage foundation required before a meeting engine is added. Existing meeting data is owned by the desktop process:

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
npm run build
```

The current runtime requires Node 22.5 or newer because the typed SQLite implementation uses `node:sqlite`. The Electron shell is configured with `contextIsolation: true` and `nodeIntegration: false`; only the main process can open native dialogs or perform storage operations.

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

Every meeting has a UUID-backed folder. Artifact names also include the authoritative meeting ID, for example `meeting_<MEETING_ID>.mp4`, `audio_<MEETING_ID>.m4a`, and `transcript_<MEETING_ID>.json`. A title and date are never used as a unique key.

Changing the location is an explicit migration:

1. validate the destination and writability;
2. check free space plus a safety margin;
3. show the file/meeting/byte migration plan;
4. copy into a staging directory;
5. hash-verify every copied file and verify meeting IDs/relationships;
6. update the manifest and local configuration;
7. switch the running SQLite connection only after verification.

The source data root is retained. An existing empty destination is moved aside rather than silently deleted.

## Storage services

`LocalStorageService` is the filesystem boundary. It owns directory creation, safe relative paths, meeting folders, artifact naming, streaming writes, SHA-256 hashing, disk-space checks, stats, migration, and recovery-safe file operations. Files are written to same-directory temporary names, flushed, verified, and atomically renamed. Large media is not stored in SQLite.

`LocalDatabase` owns the local SQLite index. It contains tables and indexes for meetings, participants, artifacts/files, recordings, transcripts, analysis records, projects, decisions, tasks, and the local audit log. Artifact rows contain file ID, meeting ID, stable relative path, type, MIME type, size, timestamps, SHA-256, and status (`AVAILABLE`, `MISSING`, `CORRUPTED`, `PROCESSING`, or `DELETED`).

`StorageIntegrityService` checks indexed files, detects missing/corrupted files, reports orphaned files, unknown meeting folders, incomplete temporary recordings, invalid manifests, and a missing database. Repair only re-indexes files inside an already indexed meeting; unknown data is never automatically deleted.

`BackupService` creates a user-triggered, standard ZIP containing a consistent SQLite snapshot, local files, hashes, and `BackupManifest.json`. `ExportService` creates a portable per-meeting ZIP with `Meeting.json`, media, transcript formats, analysis, and relationship metadata. Backup retention deletion requires explicit confirmation.

## Privacy and AI policy

The desktop renderer receives an allow-listed preload API, not `fs`, `path`, `ipcRenderer`, or `DATA_ROOT` access. Storage settings invokes controlled main-process operations. Credentials are represented by an OS-encrypted vault adapter using Electron `safeStorage`/Windows DPAPI semantics and are never placed in meeting folders or DATA_ROOT backups.

The AI abstraction supports `LocalAIProvider` and an injected `OpenAIProvider` transport. `LOCAL_ONLY`, `CLOUD_ALLOWED`, and `ASK_EACH_TIME` are checked before content is handed to a provider. Provider results are marked transient; persistence is performed by the local storage facade, not by a cloud provider.

## Scope of this change

This change deliberately does **not** implement Teams, Zoom, Google Meet attendance, calendar ingestion, or cloud synchronization. Optional encrypted sync remains a future opt-in boundary. See [docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md) for the implementation matrix, limitations, and Windows packaging status.
