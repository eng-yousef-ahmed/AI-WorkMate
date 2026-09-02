# Windows local transcription runtime (whisper.cpp)

AI WorkMate does **not** ship a Whisper model or the whisper.cpp binary in Git.

Install both **outside the repository**, on the Windows machine:

1. Build or download [whisper.cpp](https://github.com/ggerganov/whisper.cpp) `whisper-cli.exe`.
2. Copy it to `%LOCALAPPDATA%\AI-WorkMate\native\whisper-cli.exe`.
3. Download a ggml/gguf model such as `ggml-tiny.bin` (not committed here).
4. Copy it to `%LOCALAPPDATA%\AI-WorkMate\models\whisper\ggml-tiny.bin`.

Packaged Electron extraResources may also place `whisper-cli.exe` at `native/windows-transcription/whisper-cli.exe`. Models still live under LocalAppData so they are not baked into Git.

The TypeScript engine converts AIWPCM (including 48 kHz / 2 ch / 32-bit WASAPI PCM) to 16 kHz mono 16-bit WAV, then invokes whisper.cpp with a fixed argument list. Audio is not uploaded. Missing CLI or model fails with `TRANSCRIPTION_ENGINE_UNAVAILABLE`.
