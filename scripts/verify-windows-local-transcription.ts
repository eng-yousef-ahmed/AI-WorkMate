import { runWindowsLocalTranscriptionVerification } from "../src/transcription/WindowsLocalTranscriptionVerification";

async function main(): Promise<void> {
  const result = await runWindowsLocalTranscriptionVerification({
    keepWorkspace: process.argv.includes("--keep-workspace"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.success ? 0 : 1;
}

void main();
