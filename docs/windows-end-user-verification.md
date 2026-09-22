# Windows end-user verification (executable checklist)

**Status:** none of the items below are verified. This Linux sandbox and off-Windows CI cannot run NSIS, WASAPI, Windows Graphics Capture, whisper.cpp, or llama.cpp. Do **not** mark the product release-ready from this document. Tick a box only after you run that step on a real Windows 10/11 machine and record the observed result.

Use a clean Windows 10/11 x64 machine (or VM) with:

- Node.js 22.5+ and npm
- .NET 8 SDK (for `build:native:win`)
- Git
- A microphone
- Enough free disk for Qwen 7B (~5 GB under `%LOCALAPPDATA%\AI-WorkMate\models`) plus a user DATA_ROOT on a writable volume (not Program Files)

Clone the branch under test. Record the SHA:

```bat
git rev-parse HEAD
git ls-remote origin refs/heads/arena/01a0609d-ai-workmate
```

Expected remote SHA after the last non-Windows pass is printed in the engineering notes for this milestone. If they differ, stop and do not mix results.

---

## 0. Build the installer (Windows only)

```bat
npm ci
npm run lint
npm run typecheck
npm test
npm run package:win
```

Confirm `release\AI-WorkMate-Setup-0.1.0.exe` exists.

- [ ] `npm run lint` exits 0
- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 (record the printed test count)
- [ ] `npm run package:win` exits 0
- [ ] Installer filename is `AI-WorkMate-Setup-0.1.0.exe`

Inspect the payload (7-Zip or `dir`):

```bat
dir /s release
```

- [ ] The installer does **not** contain `ggml-tiny.bin`, `qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf`, or `qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf`
- [ ] Extra resources include `AIWorkMate.WindowsAudioCapture.exe` and `AIWorkMate.WindowsScreenCapture.exe`

---

## 1. Clean install

1. Copy the installer to a machine with **no** prior AI WorkMate install. Confirm these are absent:

```bat
dir "%LOCALAPPDATA%\AI-WorkMate"
dir "%APPDATA%\ai-workmate"
```

2. Run `AI-WorkMate-Setup-0.1.0.exe`.
- [ ] Setup is **not** one-click (Next / destination folder page appears)
- [ ] Destination folder can be changed
- [ ] Install to a **custom** directory (example: `C:\Tools\AI-WorkMate`), not the default

3. Launch the app once. Do not choose a DATA_ROOT yet if the picker appears — continue in section 3.

---

## 2. Upgrade over an existing install (second pass)

On a machine that already has meetings, a backup ZIP, calendar tokens, and models:

1. Install the new build over the old one (same custom directory).
- [ ] DATA_ROOT still opens with the previous meetings
- [ ] Calendar stays connected (or shows disconnected without inventing tokens)
- [ ] `%LOCALAPPDATA%\AI-WorkMate\models` is unchanged
- [ ] Existing backup ZIP files still restore

2. Downgrade check: take a workspace last opened by this build, install an older build that supports a lower schema, and open the same DATA_ROOT.
- [ ] Newer schema is refused (`schema version … is newer than supported`) rather than opened or wiped

---

## 3. First-run DATA_ROOT

On a machine with no `storage-config.json`:

- [ ] Launching the app **must** open a folder picker. There is no silent DATA_ROOT under Program Files or the install directory
- [ ] Cancel quits the app (no workspace is created)
- [ ] Choosing `C:\Program Files\…`, `C:\Windows\…`, or the install directory is rejected with a generic error (no raw path required in the UI copy)
- [ ] Choosing a writable user folder (example: `%USERPROFILE%\Documents\AI-WorkMate`) succeeds
- [ ] That folder now contains `Meetings`, `Database`, `Backups`, `Exports`, and `storage.json`
- [ ] `storage.json` does not need to expose the absolute path in the renderer; Settings snapshot `pathExposed` is `false` and the label is not `C:\…`
- [ ] Quit and relaunch: picker is skipped; the same DATA_ROOT reopens

---

## 4. Local AI runtime (Whisper + llama.cpp / Qwen 7B)

Open **Settings → Local AI runtime**.

- [ ] Snapshot shows catalog ids only (`transcription-tiny`, `analysis-production`) — no filenames, URLs, or `%LOCALAPPDATA%` paths
- [ ] Cloud fallback is off and stays off
- [ ] Installing Whisper downloads `ggml-tiny.bin` into `%LOCALAPPDATA%\AI-WorkMate\models\whisper\` (not DATA_ROOT)
- [ ] A second install of an already-verified model does **not** silently replace it
- [ ] Installing analysis downloads both Qwen 7B shards into `%LOCALAPPDATA%\AI-WorkMate\models\llm\`
- [ ] Missing CLI: install `whisper-cli.exe` / `llama-completion.exe` (or `llama-cli.exe`) under `%LOCALAPPDATA%\AI-WorkMate\native\`
- [ ] With helpers + verified models, both components report ready
- [ ] Tamper one shard (change one byte) then refresh: analysis is not ready; the app does not call a cloud API

Optional CLI (same machine):

```bat
npm run install:whisper-model
npm run install:local-llm-model
npm run verify:windows-local-transcription
npm run verify:windows-local-analysis
```

- [ ] Both verify scripts report Windows-local success with **no** cloud provider

---

## 5. Microphone, WASAPI loopback, WGC screen/window

```bat
npm run verify:windows-native-capture
npm run verify:windows-native-screen-capture
npm run verify:windows-native-window-capture
```

- [ ] Microphone capture starts and produces PCM
- [ ] WASAPI loopback captures system audio
- [ ] Windows Graphics Capture captures a screen
- [ ] Windows Graphics Capture captures a window
- [ ] In the app: start a meeting capture with mic + loopback; stop; meeting status is COMPLETED with a recording artifact
- [ ] Deny microphone permission: capture fails closed (INCOMPLETE/FAILED), no truncated file marked COMPLETED

---

## 6. Microsoft and Google OAuth

Microsoft (public desktop PKCE, **no client secret**):

- [ ] Connect Microsoft 365 from Settings
- [ ] Browser sign-in completes; calendar status is connected
- [ ] Tokens are **not** in SQLite (`Database\*.sqlite` has no `access_token` / `refresh_token` columns or values)
- [ ] Tokens live in the OS credential vault / Electron `safeStorage` under the app userData directory (not DATA_ROOT)
- [ ] Disconnect removes vault entries; restart does not restore tokens from the database
- [ ] Renderer DevTools (Application / Network / console): no access token, refresh token, or DATA_ROOT path in IPC payloads

Google Calendar (if a client id is configured):

- [ ] Repeat connect / disconnect / restart
- [ ] Same vault-not-SQLite rule
- [ ] Renderer never displays the client secret after save

---

## 7. Recording → transcription → analysis → chat → tasks

- [ ] Record a short meeting (mic + loopback)
- [ ] Process meeting: local Whisper produces a transcript; no cloud STT
- [ ] Local llama.cpp produces an analysis document; no cloud LLM
- [ ] Grounded Chat answers only from local transcripts with `[meeting · …]` citations, or refuses
- [ ] Tasks list shows analysis tasks with meeting provenance
- [ ] Manual task create from the UI cannot attach a forged `sourceArtifactId`
- [ ] Follow-up convert creates one task and is idempotent on a second convert

---

## 8. Notifications, automation, Assisted Join, Office

- [ ] Notification center lists items after processing; mark read / mark all read persist across restart
- [ ] Automation tick / “run now” inserts idempotent rows (no duplicates for the same event)
- [ ] Assisted Join for a Teams/Meet/Zoom-linked event shows a plan **without** dumping the join URL into a copy-paste exploit surface beyond the explicit Open action
- [ ] Open join URL uses the **persisted** calendar URL only (renderer cannot supply an arbitrary link)
- [ ] Office export Word / Excel / PowerPoint writes **outside** DATA_ROOT
- [ ] Office export into DATA_ROOT is rejected

---

## 9. Backup / restore / crash / disk-space

- [ ] Create a backup to another folder (or another volume)
- [ ] ZIP `BackupManifest.json` `sourceDataRoot` is `LOCAL`; `storage.json` `dataLocation` label is not an absolute path
- [ ] Tamper one file inside the ZIP and restore: restore fails, destination is empty, active DATA_ROOT is unchanged
- [ ] Kill the process during restore: leftover `.ai-workmate-restore-*` is removed on the next restore; DATA_ROOT is unchanged
- [ ] Restore to a volume with insufficient free space: fail closed; error copy has no `C:\…`
- [ ] Restore a valid backup into an empty folder, then switch DATA_ROOT to that folder
- [ ] Low-disk during recording: capture stops INCOMPLETE; no truncated file is marked COMPLETED

---

## 10. Crash, journal, migration

- [ ] Force-quit during a meeting write; relaunch recovers incomplete artifact operations without deleting other meetings
- [ ] Change DATA_ROOT to a new empty folder with “migrate”. Source is preserved until verification succeeds
- [ ] Unplug / fail the destination mid-copy: app still opens the original DATA_ROOT
- [ ] After this version upgrade, existing v11 SQLite opens without recreating meetings

---

## 11. Renderer / IPC

With DevTools open on the real app:

- [ ] `contextIsolation` is true, `nodeIntegration` is false, `sandbox` is true (dump `webPreferences` if you have a debug build)
- [ ] IPC payloads for snapshot, lifecycle, hub overview/detail, tasks, notifications, calendar status, runtime snapshot contain **no** `C:\`, `%LOCALAPPDATA%`, DATA_ROOT, access_token, or refresh_token
- [ ] Processing-job errors that originally contained a path show a generic withheld message

---

## 12. Uninstall (must not delete user data)

1. Note these paths before uninstall:

```bat
echo DATA_ROOT is the folder you picked in first-run
dir "%LOCALAPPDATA%\AI-WorkMate"
dir "%APPDATA%\ai-workmate"
```

2. Uninstall from Apps & features / the NSIS uninstaller.
- [ ] Application binaries under the install directory are removed
- [ ] `%LOCALAPPDATA%\AI-WorkMate` **remains** (models, native helpers)
- [ ] DATA_ROOT **remains** (Meetings, Database, Backups, Exports)
- [ ] Backup ZIP files and Office export files **remain**
- [ ] Credential vault / userData is **not** wiped (`deleteAppDataOnUninstall: false`; `installer\nsis.nsh` `customUnInstall` does not `RMDir /r` user data)

3. Reinstall and point at the same DATA_ROOT.
- [ ] Meetings, tasks, and transcripts are still there

---

## Result log (fill on Windows)

| Item | Pass / Fail | Notes / SHA |
| --- | --- | --- |
| Installer build |  |  |
| Clean install |  |  |
| Upgrade |  |  |
| Uninstall preserves DATA_ROOT |  |  |
| First-run picker |  |  |
| Whisper |  |  |
| llama.cpp / Qwen 7B |  |  |
| Microphone |  |  |
| WASAPI |  |  |
| WGC screen / window |  |  |
| Microsoft OAuth |  |  |
| Google OAuth |  |  |
| Record / transcribe / analyze |  |  |
| Chat / tasks |  |  |
| Notifications / automation |  |  |
| Assisted Join |  |  |
| Office export |  |  |
| Backup / restore |  |  |
| Crash / disk-space |  |  |
| Renderer / IPC |  |  |

Do not claim release-ready until every row is Pass on Windows.
