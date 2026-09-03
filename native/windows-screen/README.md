# AI WorkMate Windows screen/window capture helper

Windows-only `.NET 8` helper used by `WindowsNativeScreenProvider`.

## Technology

- **Display capture:** DXGI Desktop Duplication (`IDXGIOutputDuplication`) of a selected monitor. This is the production Windows API for exclusive display capture; it does not include other monitors.
- **Window capture:** Windows Graphics Capture (`Windows.Graphics.Capture`) of a selected HWND. Requires Windows 10 1809 (build 17763) or later.
- **Encoding:** Motion-JPEG frames in JSON Lines (`aiwvid` / `application/x-ai-workmate-video-jsonl`). JPEG is used so frames stay small enough to journal as files; pixels are never stored as SQLite BLOBs.

## Commands

```text
AIWorkMate.WindowsScreenCapture.exe capabilities --json
AIWorkMate.WindowsScreenCapture.exe capture --kind screen --format aiwvid-jsonl [--source-id display:DISPLAY1]
AIWorkMate.WindowsScreenCapture.exe capture --kind window --format aiwvid-jsonl --source-id hwnd:000000000012ABCD
```

Stdin `stop` or `abort …` ends capture. No output path is accepted.

## Limitations

- Not a Teams/Zoom/browser recorder.
- Protected / DRM content, UAC secure desktop, and some GPU-exclusive fullscreen games may be black or fail (`NATIVE_DEVICE_UNAVAILABLE`).
- Cloaked, tool, and invisible windows are omitted from enumeration.
- Minimized windows may emit no frames until restored.
- Display mode changes and target disappearance fail closed rather than inventing frames.
- Cursor capture is included when the OS provides it; mixed audio is out of scope.
