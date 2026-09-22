import { runWindowsRuntimeCaptureVerification } from "../src/capture/WindowsRuntimeCaptureVerification";

async function main(): Promise<void> {
  const keepWorkspace = process.argv.includes("--keep-workspace");
  const durationArg = process.argv.find((arg) => arg.startsWith("--duration-ms="));
  const durationMs = durationArg === undefined ? undefined : Number(durationArg.slice("--duration-ms=".length));
  const result = await runWindowsRuntimeCaptureVerification({
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
    keepWorkspace,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.success ? 0 : 1;
}

void main();
