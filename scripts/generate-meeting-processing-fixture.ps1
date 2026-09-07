# scripts/generate-meeting-processing-fixture.ps1
#
# Generates tests/fixtures/meeting-processing-speech.wav using natural Windows
# SAPI5 concatenative speech (System.Speech.SpeechSynthesizer), then validates
# the WAV with the REAL installed whisper.cpp tiny model (direct file
# transcription, -l en) against the normalized Phase 9 quality corpus.
#
# The Phase 9 meeting-processing verifier plays the committed WAV through the
# real Windows default output device during a real Phase 8 capture flow; this
# generator is the ONLY step that creates the fixture. It never injects
# transcript text into the processing pipeline - the pipeline always hears the
# WAV through real playback, real WASAPI loopback/microphone capture, real
# Whisper, and real Qwen.
#
# Usage (Windows, from the repository root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\generate-meeting-processing-fixture.ps1
#   add -SkipWhisperValidation to synthesize only (validation still required
#   before the fixture is accepted for verification).
#
# The spoken text is read verbatim from tests/fixtures/meeting-processing-speech.txt
# (the canonical corpus). Spoken-form substitutions below change ONLY how the
# synthesizer pronounces identifier tokens ("DATA_ROOT" -> "DATA ROOT"); the
# .txt corpus itself is unchanged.

param(
  [switch]$SkipWhisperValidation
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$repoRoot = Split-Path -Parent $PSScriptRoot
$txtPath = Join-Path $repoRoot "tests\fixtures\meeting-processing-speech.txt"
$wavPath = Join-Path $repoRoot "tests\fixtures\meeting-processing-speech.wav"

# --- 1. Corpus integrity: the committed script must contain the evaluator vocabulary. ---
$scriptText = (Get-Content -Raw -LiteralPath $txtPath).Trim()
$requiredTokens = @(
  "AI WorkMate",
  "DATA_ROOT",
  "LOCAL_ONLY",
  "Windows real-AI verification",
  "llama.cpp install",
  "encryption of transcripts",
  "fail-closed tests",
  "Omar",
  "Nadia",
  "Samir",
  "12 September 2026",
  "10 September 2026"
)
$missingTokens = @($requiredTokens | Where-Object { -not $scriptText.Contains($_) })
if ($missingTokens.Count -gt 0) {
  throw "Speech script is missing required corpus tokens: $($missingTokens -join ', ')"
}

# --- 2. Synthesis text: pronounceable spoken forms of the identifier tokens. ---
$speak = $scriptText -creplace "_", " "
$speak = $speak -creplace "llama\.cpp", "llama C P P"
$speak = $speak -creplace "real-AI", "real A I"
$speak = $speak -creplace "fail-closed", "fail closed"

# --- 3. Natural SAPI5 speech -> committed WAV (22 kHz 16-bit mono PCM). ---
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
# SpeechSynthesizer has no VoiceName property; the current voice is exposed
# via the Voice property (System.Speech.Synthesis.VoiceInfo). Diagnostic only.
try { $voiceName = $synth.Voice.Name } catch { $voiceName = "unknown" }
try {
  $synth.Rate = 0
  $synth.Volume = 100
  $synth.SetOutputToWaveFile($wavPath)
  $synth.Speak($speak)
  $synth.SetOutputToNull()
} finally {
  $synth.Dispose()
}
$wavItem = Get-Item -LiteralPath $wavPath
Write-Output "Synthesized $wavPath ($($wavItem.Length) bytes) from $txtPath with SAPI5 voice '$voiceName'."

# --- 4. Direct whisper-cli validation with the REAL installed tiny model. ---
function Normalize-CorpusText([string]$Text) {
  $lower = $Text.ToLowerInvariant()
  $spaced = $lower -creplace "[^a-z0-9]+", " "
  return ($spaced.Trim() -creplace "\s+", " ")
}

$cliCandidates = @(
  (Join-Path $env:LOCALAPPDATA "AI-WorkMate\native\whisper-cli.exe"),
  (Join-Path $env:LOCALAPPDATA "AI-WorkMate\native\whisper.exe")
)
$whisperCli = @($cliCandidates | Where-Object { Test-Path -LiteralPath $_ }) | Select-Object -First 1
$modelDir = Join-Path $env:LOCALAPPDATA "AI-WorkMate\models\whisper"
$whisperModel = $null
if (Test-Path -LiteralPath $modelDir) {
  $whisperModel = Get-ChildItem -LiteralPath $modelDir -Filter "ggml-*.bin" -ErrorAction SilentlyContinue |
    Sort-Object Length | Select-Object -First 1
}

if (-not $whisperCli -or -not $whisperModel) {
  $message = "whisper-cli.exe or a ggml model was not found under %LOCALAPPDATA%\AI-WorkMate\. The fixture MUST be validated with the real model before it is accepted."
  if ($SkipWhisperValidation) {
    Write-Warning $message
    Write-Warning "Skipped validation explicitly; the fixture is NOT yet accepted."
    exit 0
  }
  throw $message
}

$tempBase = Join-Path ([System.IO.Path]::GetTempPath()) ("ai-workmate-fixture-check-" + [System.Guid]::NewGuid().ToString("N"))
& $whisperCli -m $whisperModel.FullName -f $wavPath -l en -oj -of $tempBase --no-prints | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "whisper-cli exited with code $LASTEXITCODE while validating the fixture."
}
$whisperJsonPath = "$tempBase.json"
$parsed = Get-Content -Raw -LiteralPath $whisperJsonPath | ConvertFrom-Json

# whisper-cli -oj writes:
#   { systeminfo, model, params, result: { language }, transcription: [ { timestamps, offsets, text } ] }
# There is no top-level "segments" member, and Set-StrictMode makes a direct
# $parsed.segments access throw PropertyNotFoundStrict. Probe PSObject
# properties instead of touching possibly-missing members directly.
function Get-JsonProperty($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

Write-Output ("whisper-cli JSON top-level properties: " + (($parsed.PSObject.Properties.Name | Select-Object -First 12) -join ", "))

$segmentItems = $null
foreach ($container in @($parsed, (Get-JsonProperty $parsed "result"))) {
  if ($null -eq $container) { continue }
  foreach ($listName in @("transcription", "segments")) {
    $candidate = Get-JsonProperty $container $listName
    if ($candidate -is [System.Array] -and $candidate.Length -gt 0) {
      $segmentItems = $candidate
      break
    }
  }
  if ($null -ne $segmentItems) { break }
}

$recognizedParts = @()
if ($null -ne $segmentItems) {
  foreach ($item in $segmentItems) {
    $itemText = Get-JsonProperty $item "text"
    if ($null -ne $itemText -and "$itemText".Trim().Length -gt 0) {
      $recognizedParts += "$itemText".Trim()
    }
  }
}
if ($recognizedParts.Count -eq 0) {
  # Diagnostics-only fallback: some builds emit an aggregate text field.
  foreach ($container in @((Get-JsonProperty $parsed "result"), $parsed)) {
    $aggregate = Get-JsonProperty $container "text"
    if ($null -ne $aggregate -and "$aggregate".Trim().Length -gt 0) {
      $recognizedParts += "$aggregate".Trim()
      break
    }
  }
}
$recognized = $recognizedParts -join " "
Remove-Item -LiteralPath $whisperJsonPath -Force -ErrorAction SilentlyContinue

$normalized = Normalize-CorpusText $recognized
Write-Output "Whisper recognized (normalized): $normalized"

$decisionMarkers = @("local only", "data root", "windows real ai verification")
$taskMarkers = @("llama cpp install", "encryption of transcripts", "fail closed tests")
$summaryMarkers = @("ai workmate", "data root", "llama cpp")
$nameMarkers = @("omar", "nadia", "samir")
$dateMarkers = @("12 september 2026", "10 september 2026")

# Match results MUST be wrapped in a call-site array subexpression: a function
# returning @(pipeline) unrolls its elements on the way out, so 0 matches
# become $null and 1 match becomes a scalar String - both make .Count throw
# under Set-StrictMode -Version 2.0. @(pipeline) at the assignment always
# yields a true Object[] for 0, 1, or N matches.
$decisionsFound = @($decisionMarkers | Where-Object { $normalized.Contains($_) })
$tasksFound = @($taskMarkers | Where-Object { $normalized.Contains($_) })
$summaryFound = @($summaryMarkers | Where-Object { $normalized.Contains($_) })
$namesFound = @($nameMarkers | Where-Object { $normalized.Contains($_) })
$dateFound = @($dateMarkers | Where-Object { $normalized.Contains($_) })

Write-Output ("Decisions matched: {0} ({1})" -f $decisionsFound.Count, ($decisionsFound -join ", "))
Write-Output ("Tasks matched: {0} ({1})" -f $tasksFound.Count, ($tasksFound -join ", "))
Write-Output ("Summary markers matched: {0} ({1})" -f $summaryFound.Count, ($summaryFound -join ", "))
Write-Output ("Names matched: {0} ({1})" -f $namesFound.Count, ($namesFound -join ", "))
Write-Output ("Dates matched: {0} ({1})" -f $dateFound.Count, ($dateFound -join ", "))

# The unchanged quality gate needs >=2 decisions, >=2 tasks, and a summary
# marker, all grounded in the real transcript of this audio.
$passed = ($decisionsFound.Count -ge 2) -and ($tasksFound.Count -ge 2) -and ($summaryFound.Count -ge 1)
if ($passed) {
  Write-Output "FIXTURE VALIDATION PASSED: the corpus vocabulary survives real whisper.cpp transcription."
  exit 0
}
Write-Output "FIXTURE VALIDATION FAILED: adjust the speech script wording or synthesis settings and regenerate. The fixture is NOT accepted."
exit 1
