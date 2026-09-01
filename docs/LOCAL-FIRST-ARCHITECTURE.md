# Local-first architecture

## Ownership boundary

The Windows desktop main process owns the local data root. The renderer can request named operations through the preload bridge, but cannot read a directory, construct an arbitrary path, open a file, or invoke `ipcRenderer` directly.

```text
Renderer
   │  allow-listed storage API
   ▼
Preload (contextBridge, no nodeIntegration)
   │  named IPC channels; native dialogs choose paths
   ▼
Electron main process
   ├── StorageRuntime / StorageConfigService
   ├── LocalFirstStore
   │     ├── LocalDatabase  ── DATA_ROOT/Database/ai-workmate.sqlite
   │     ├── LocalStorageService ── DATA_ROOT/Meetings + metadata
   │     ├── StorageIntegrityService / RecoveryScanner
   │     ├── BackupService / ExportService
   │     └── local audit log
   ├── OS credential primitive (Electron safeStorage / Windows DPAPI)
   └── optional AIProvider (local or policy-approved cloud)
```

`DATA_ROOT` is not the installation folder and does not live in a cloud database. The app configuration outside the root contains the selected root and policy only, so changing the root does not lose the pointer to the new location.

## Database/filesystem contract

SQLite indexes relationships and metadata. Filesystem artifacts hold large media and portable user-visible formats. An artifact is complete only when:

1. a temporary file has been written in the destination directory;
2. the file has been flushed and hash-verified;
3. it has been atomically renamed to its final meeting-ID filename; and
4. its artifact row has been committed in SQLite.

If step 4 is interrupted, the recovery scan reports the final file as an orphan rather than silently losing it. If a user deletes or modifies a file, the next verification marks the row `MISSING` or `CORRUPTED`.

The reverse failure (a database row without a file) is detected by the same scan. Unknown files are never automatically deleted. Re-indexing is limited to orphaned files inside a folder whose meeting ID is already known in SQLite.

## Location migration

Location changes are copy-then-verify operations. The destination must be outside the current root and empty or new. A staging directory is populated, file counts/sizes/hashes are compared, and the meeting ID set is compared after opening the copied database. The source root is never removed. The app configuration is updated only after the new database opens successfully.

## Cloud processing boundary

`AIProvider` is a transient processing interface. `LocalAIProvider` and `OpenAIProvider` share the same contract, but `AIProcessingPolicyEnforcer` runs before any provider receives content:

- `LOCAL_ONLY`: cloud providers are rejected.
- `CLOUD_ALLOWED`: a configured cloud integration may process content.
- `ASK_EACH_TIME`: a cloud request requires explicit approval.

Provider responses are written through the local store when the application chooses to persist them. No provider is allowed to become the primary database.

## Backup and export

Backups are standard ZIP files with a SQLite backup snapshot, storage metadata, all non-backup local files, and a hash manifest. They are written atomically to a user-selected location outside `DATA_ROOT`; old backup archives are not silently pruned.

Meeting exports are smaller, portable ZIPs containing `Meeting.json`, ID-based artifacts, `MeetingMetadata.json`, and a relationship manifest. They use JSON, TXT, VTT, SRT, Markdown, and original standard media formats where available.
