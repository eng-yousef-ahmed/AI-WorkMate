import { runMeetingProcessingVerification } from "../src/processing/MeetingProcessingVerification";

async function main(): Promise<void> {
  const result = await runMeetingProcessingVerification({
    keepWorkspace: process.argv.includes("--keep-workspace"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.success ? 0 : 1;
}

void main();
