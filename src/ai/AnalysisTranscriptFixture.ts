import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { TranscriptDocument } from "../domain/models";

export const ANALYSIS_TRANSCRIPT_FIXTURE_RELATIVE = "tests/fixtures/meeting-analysis-transcript.json";

export async function loadAnalysisTranscriptFixture(repoRoot = process.cwd()): Promise<TranscriptDocument> {
  const parsed = JSON.parse(await readFile(join(repoRoot, ANALYSIS_TRANSCRIPT_FIXTURE_RELATIVE), "utf8")) as TranscriptDocument;
  if (!Array.isArray(parsed.segments) || parsed.segments.length === 0) {
    throw new Error("Analysis transcript fixture has no segments.");
  }
  return parsed;
}
