import test from "node:test";
import assert from "node:assert";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runMeetingProcessingVerification, MEETING_PROCESSING_SPEECH_FIXTURE_RELATIVE, MEETING_PROCESSING_SPEECH_SCRIPT_FIXTURE_RELATIVE } from "../src/processing/MeetingProcessingVerification";
import {
  buildSoundPlayerCommand,
  playWavThroughDefaultOutput,
  readWavPcmDuration,
  VERIFY_WAV_ENV,
  VerificationPlaybackError,
} from "../src/processing/VerifySpeechPlayback";
import { ANALYSIS_QUALITY_MARKERS } from "../src/ai/AnalysisQuality";

/**
 * Linux-safe verifier tests. The full pipeline only runs on Windows; these
 * tests pin the fail-closed behavior, the honest reporting contract, the
 * playback helper's Windows-only boundary, and the deterministic speech
 * fixture's integrity and vocabulary coverage for the unchanged quality
 * evaluator.
 */

const NON_WINDOWS_PLATFORM = process.platform === "win32" ? "linux" : process.platform;

test("meeting processing verifier fail-closes off Windows with honest runtime reporting", async () => {
  const result = await runMeetingProcessingVerification({ platform: NON_WINDOWS_PLATFORM });

  assert.equal(result.success, false);
  assert.equal(result.windowsVerified, false);
  assert.equal(result.failureCode, "MEETING_PROCESSING_VERIFY_PLATFORM_UNSUPPORTED");
  assert.equal(result.stage, "platform-gate");
  assert.equal(result.nativeRuntime, "none");
  assert.equal(result.cloudServiceUsed, false);
  assert.equal(result.isolatedWorkspace, true);
  assert.equal(result.userDataUntouched, true);
  assert.equal(result.playback.started, false);
  assert.equal(result.playback.completed, false);
  assert.equal(result.workspace, undefined);

  // Honest flags: discovery actually ran and found nothing on this platform.
  assert.equal(result.realEngineFound, false);
  assert.equal(result.realModelFound, false);
  assert.equal(result.llmEngineFound, false);
  assert.equal(result.llmModelFound, false);
  assert.equal(result.runtime.whisper.helperFound, false);
  assert.equal(result.runtime.llm.helperFound, false);
  assert.equal(
    result.failureMessage?.includes("fail-closes") === true || result.failureMessage?.includes("fail-closed") === true,
    true,
    `failureMessage should explain fail-closed behavior: ${result.failureMessage}`,
  );
});

test("verifier never leaks absolute workspace or repository paths in its report", async () => {
  const result = await runMeetingProcessingVerification({ platform: NON_WINDOWS_PLATFORM });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(tmpdir()), false, "report must not embed the temp directory");
  assert.equal(serialized.includes(process.cwd()), false, "report must not embed the repository path");
  assert.equal(/[A-Za-z]:\\[Uu]sers/.test(serialized), false, "report must not embed Windows user profile paths");
});

test("windows WAV playback helper fail-closes off Windows without spawning a process", async () => {
  await assert.rejects(
    playWavThroughDefaultOutput({
      wavPath: join(process.cwd(), MEETING_PROCESSING_SPEECH_FIXTURE_RELATIVE),
      timeoutMs: 2_000,
      platform: NON_WINDOWS_PLATFORM,
    }),
    (error: unknown) => {
      assert.ok(error instanceof VerificationPlaybackError);
      assert.equal(error.code, "MEETING_PROCESSING_VERIFY_PLAYBACK_UNSUPPORTED");
      return true;
    },
  );
});

test("sound player command keeps the WAV path off the command line", () => {
  const command = buildSoundPlayerCommand();
  assert.equal(command.file, "powershell.exe");
  assert.deepEqual(command.args.slice(0, 5), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
  const script = command.args[command.args.length - 1] ?? "";
  assert.equal(script.includes(process.cwd()), false);
  assert.equal(script.includes(".wav"), false);
  assert.equal(script.includes(`$env:${VERIFY_WAV_ENV}`), true);
});

test("speech fixture WAV, once generated on Windows, is valid PCM WAV of the scripted meeting length", async () => {
  const wavPath = join(process.cwd(), MEETING_PROCESSING_SPEECH_FIXTURE_RELATIVE);
  if (!existsSync(wavPath)) {
    // The SAPI5 fixture is generated on the Windows host by
    // scripts/generate-meeting-processing-fixture.ps1 (which also runs the
    // direct whisper-cli validation gate). Until then the verifier fail-closes
    // with MEETING_PROCESSING_VERIFY_SPEECH_FIXTURE_UNAVAILABLE.
    assert.equal(
      existsSync(join(process.cwd(), "scripts/generate-meeting-processing-fixture.ps1")),
      true,
      "the SAPI5 fixture generator must exist while the WAV is not yet generated",
    );
    return;
  }
  const wav = await readWavPcmDuration(wavPath);
  assert.equal(wav.channels, 1);
  assert.equal(wav.bitsPerSample, 16);
  assert.ok(wav.durationMs > 30_000, `fixture speech is unexpectedly short: ${wav.durationMs}ms`);
  assert.ok(wav.durationMs < 180_000, `fixture speech is unexpectedly long: ${wav.durationMs}ms`);
});

test("committed speech script contains the unchanged quality evaluator vocabulary", async () => {
  const script = await readFile(join(process.cwd(), MEETING_PROCESSING_SPEECH_SCRIPT_FIXTURE_RELATIVE), "utf8");
  for (const marker of ANALYSIS_QUALITY_MARKERS.decisions) {
    assert.ok(script.includes(marker), `speech script must mention decision marker "${marker}"`);
  }
  for (const marker of ANALYSIS_QUALITY_MARKERS.tasks) {
    assert.ok(script.includes(marker), `speech script must mention task marker "${marker}"`);
  }
  assert.ok(/AI WorkMate/.test(script));
  assert.ok(/DATA_ROOT/.test(script));
  assert.ok(/llama\.cpp/.test(script));
  for (const assignee of ANALYSIS_QUALITY_MARKERS.assignees) {
    assert.ok(script.includes(assignee), `speech script must mention assignee "${assignee}"`);
  }
  for (const date of ANALYSIS_QUALITY_MARKERS.dates) {
    assert.ok(script.includes(date), `speech script must mention date "${date}"`);
  }
});
