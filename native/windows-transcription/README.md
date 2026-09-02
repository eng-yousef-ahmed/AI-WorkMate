# Windows local transcription runtime (whisper.cpp)

AI WorkMate does **not** ship a Whisper model or `whisper-cli.exe` in Git. They must be installed on the Windows machine.

## Install whisper-cli.exe (manual)

1. Build [whisper.cpp](https://github.com/ggerganov/whisper.cpp) for Windows, or copy a trusted `whisper-cli.exe`.
2. Place it at `%LOCALAPPDATA%\AI-WorkMate\native\whisper-cli.exe`.
3. Packaged Electron extraResources may also use `native/windows-transcription/whisper-cli.exe`.

Do not pass a helper path from the renderer.

## Install the model (allowlisted HTTPS)

From a developer/admin shell (main process only):

```bat
npm run install:whisper-model -- ggml-tiny.bin
```

That downloads **only** `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin`, writes it atomically under `%LOCALAPPDATA%\AI-WorkMate\models\whisper\`, and verifies SHA-256 `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21`. Mismatch or interrupt deletes the temp file.

Manual copy of the same file to that folder is also valid if the checksum matches.

## Verify on Windows

```bat
npm run verify:windows-local-transcription
```

`windowsVerified` is true only when a real Windows host finds the CLI + model, transcribes the spoken fixture (`tests/fixtures/whisper-speech.wav` rebuilt as 48 kHz / 2 ch / 32-bit AIWPCM), and commits a transcript with recognizable text. Linux fail-closes and is never WINDOWS-VERIFIED.
