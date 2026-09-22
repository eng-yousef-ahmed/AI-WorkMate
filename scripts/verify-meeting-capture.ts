import { runMeetingCaptureVerification } from "../src/capture/MeetingCaptureVerification";

async function main(): Promise<void> {
  const keepWorkspace = process.argv.includes("--keep-workspace");
  const includeWindow = process.argv.includes("--include-window");
  const durationArg = process.argv.find((arg) => arg.startsWith("--duration-ms="));
  const windowSourceArg = process.argv.find((arg) => arg.startsWith("--window-source-id="));
  const durationMs = durationArg === undefined ? undefined : Number(durationArg.slice("--duration-ms=".length));
  const windowSourceId = windowSourceArg === undefined ? undefined : windowSourceArg.slice("--window-source-id=".length);
  const result = await runMeetingCaptureVerification({
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
    keepWorkspace,
    includeWindow,
    ...(windowSourceId === undefined ? {} : { windowSourceId }),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.success ? 0 : 1;
}

void main();
