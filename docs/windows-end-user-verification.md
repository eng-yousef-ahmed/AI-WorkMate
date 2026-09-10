# Windows end-user verification (blocker)

Off-Linux CI and this Linux sandbox cannot execute NSIS, WASAPI, whisper.cpp, or llama.cpp. Treat the items below as the remaining **Windows-only** release blockers. Do not mark the product release-ready until each row is checked on a real Windows 10/11 machine.

## Installer (NSIS)

1. Build with `npm run package:win` on Windows after `build:native:win` succeeds.
2. Confirm the installer is not one-click: destination folder can be changed.
3. Install to a custom directory (not the default) and launch.
4. Uninstall: application binaries are removed; `%LOCALAPPDATA%\AI-WorkMate` user data, DATA_ROOT, models, and credential vault remain (`deleteAppDataOnUninstall: false`).
5. Confirm the installer payload does **not** contain Whisper/Qwen model files. Models install separately via first-run / Settings into `%LOCALAPPDATA%\AI-WorkMate\models\…`.

## First run

1. On a machine with no `storage-config.json`, launching the app **must** open a folder picker. Cancel quits; there is no silent DATA_ROOT under Program Files.
2. Choosing a folder under `C:\Program Files`, `C:\Windows`, or the install directory is rejected.
3. Choosing a writable user folder (e.g. `Documents\AI-WorkMate`) creates `Meetings`, `Database`, `Backups`, `Exports`, and `storage.json`.
4. Subsequent launches skip the picker and reopen the same DATA_ROOT.

## Credentials and calendar

1. Connect Microsoft 365 (public desktop PKCE, no client secret) and confirm tokens are not in SQLite; they live in OS `safeStorage` / credential vault under userData.
2. Disconnect removes the vault entries. Restart does not restore tokens from the database.
3. Repeat for Google Calendar if configured.
4. Renderer DevTools: no access token, refresh token, DATA_ROOT, or absolute artifact path in IPC payloads.

## Backup / restore on NTFS

1. Create a backup to another folder (or another volume). Confirm the ZIP `BackupManifest.json` `sourceDataRoot` is `LOCAL` and `storage.json` `dataRootLabel` is `LOCAL`.
2. Tamper one file inside the ZIP and restore: restore fails, destination is empty, active DATA_ROOT is unchanged.
3. Kill the process during restore: leftover `.ai-workmate-restore-*` is removed on the next restore; DATA_ROOT is unchanged.
4. Restore to a volume with insufficient free space: fail closed with a generic disk-space error (no path).
5. Restore a valid backup into an empty folder, then open that folder as DATA_ROOT after switching location.

## Capture, transcription, analysis

1. Native audio (`AIWorkMate.WindowsAudioCapture.exe`) and screen helpers start from extraResources.
2. Whisper CLI / model missing: UI explains local install; no cloud fallback.
3. llama.cpp / Qwen missing: grounded chat and analysis refuse rather than calling a cloud API.
4. Low-disk during recording: capture stops INCOMPLETE; no truncated file is marked COMPLETED.

## Update / migration

1. Change DATA_ROOT to a new empty folder with “migrate”. Source is preserved until verification succeeds.
2. Force-fail mid-copy (unplug destination): app still opens the original DATA_ROOT.
3. After a version upgrade, existing v11 SQLite opens without recreating meetings.

## Privacy smoke

1. Storage Settings snapshot label is not an absolute path (`pathExposed: false`).
2. Backup, export, Office export, and restore IPC errors never include `C:\…`.
