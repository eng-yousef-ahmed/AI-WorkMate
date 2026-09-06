#!/usr/bin/env python3
"""Generate tests/fixtures/meeting-processing-speech.wav deterministically.

The Phase 9 meeting-processing verifier plays this WAV through the real
Windows default output device during a real Phase 8 capture flow, so the
system-loopback (and, acoustically, the microphone) recording contains the
spoken vocabulary that the (unchanged) analysis quality evaluator expects.

The spoken text is read verbatim from tests/fixtures/meeting-processing-speech.txt.
Rendering is fully deterministic for a given espeak-ng build + parameters:

    voice  : en-us
    rate   : 150 words per minute
    gap    : 5 (word gap in 10 ms units)
    output : RIFF PCM, 22050 Hz, mono, 16-bit

The file is generated once and committed; it must not be regenerated per run.
Requires: pip install espeakng-loader (bundles libespeak-ng and voice data).

Usage: python3 scripts/generate-meeting-processing-fixture.py
"""

from ctypes import CFUNCTYPE, POINTER, c_int, c_short, c_void_p, c_size_t, c_uint
import ctypes
import wave
from pathlib import Path

import espeakng_loader

SAMPLE_RATE_HZ = 22050
SPEECH_RATE_WPM = 150
WORD_GAP = 5  # 10 ms units
ESPEAK_RATE = 1
ESPEAK_WORDGAP = 6
ESPEAK_INITIALIZE_SYNCHRONOUS = 2

REPO_ROOT = Path(__file__).resolve().parent.parent
TEXT_FIXTURE = REPO_ROOT / "tests" / "fixtures" / "meeting-processing-speech.txt"
WAV_FIXTURE = REPO_ROOT / "tests" / "fixtures" / "meeting-processing-speech.wav"


def main() -> None:
    text = TEXT_FIXTURE.read_text(encoding="utf-8").strip()
    if not text:
        raise SystemExit("Speech text fixture is empty.")

    lib = ctypes.CDLL(espeakng_loader.get_library_path())
    data_path = espeakng_loader.get_data_path().encode()

    samples: list[int] = []

    @CFUNCTYPE(c_int, POINTER(c_short), c_int, POINTER(c_void_p))
    def collect(wav, numsamples, _events):
        count = numsamples if isinstance(numsamples, int) else numsamples.value
        if wav and count > 0:
            samples.extend(wav[i] for i in range(count))
        return 0

    returned_rate = lib.espeak_Initialize(c_int(ESPEAK_INITIALIZE_SYNCHRONOUS), c_int(0), data_path, c_int(0))
    if returned_rate != SAMPLE_RATE_HZ:
        raise SystemExit(f"Unexpected espeak-ng sample rate: {returned_rate}")
    if lib.espeak_SetVoiceByName(b"en-us") != 0:
        raise SystemExit("Could not select the en-us voice.")
    lib.espeak_SetParameter(c_int(ESPEAK_RATE), c_int(SPEECH_RATE_WPM), c_int(0))
    lib.espeak_SetParameter(c_int(ESPEAK_WORDGAP), c_int(WORD_GAP), c_int(0))
    lib.espeak_SetSynthCallback(collect)

    payload = text.encode("utf-8")
    rc = lib.espeak_Synth(
        payload,
        c_size_t(len(payload) + 1),
        c_uint(0),
        c_int(0),
        c_int(0),
        c_int(0),
        None,
        None,
    )
    lib.espeak_Synchronize()
    if rc != 0 or not samples:
        raise SystemExit(f"espeak-ng synthesis failed (rc={rc}, samples={len(samples)}).")

    with wave.open(str(WAV_FIXTURE), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE_HZ)
        wav_file.writeframes(b"".join(int(s).to_bytes(2, "little", signed=True) for s in samples))

    duration_s = len(samples) / SAMPLE_RATE_HZ
    print(f"Wrote {WAV_FIXTURE.name}: {len(samples)} samples, {duration_s:.2f}s, "
          f"{WAV_FIXTURE.stat().st_size} bytes.")


if __name__ == "__main__":
    main()
