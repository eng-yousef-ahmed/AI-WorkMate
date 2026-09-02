import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { isGgufModelMagic } from "./LocalLlmModelFormat";
import { getLocalLlmModelCatalogEntry } from "./LocalLlmRuntimeCatalog";
import { resolveWindowsLlamaCliPath, resolveWindowsLlamaModelPath } from "./LocalLlmProvider";

export interface LocalLlmRuntimeDiscovery {
  platform: NodeJS.Platform | string;
  helperFound: boolean;
  helperName?: string;
  modelFound: boolean;
  modelName?: string;
  modelSha256?: string;
  modelBytes?: number;
  modelChecksumOk?: boolean;
  engineVersion?: string;
  relativeHelperLocation?: string;
  relativeModelLocation?: string;
  failureCode?: string;
  failureMessage?: string;
}

export async function discoverLocalLlmRuntime(options: {
  platform?: NodeJS.Platform | string;
  localAppData?: string;
} = {}): Promise<LocalLlmRuntimeDiscovery> {
  const platform = options.platform ?? process.platform;
  const helperPath = await resolveWindowsLlamaCliPath(undefined, options.localAppData);
  const modelPath = await resolveWindowsLlamaModelPath(undefined, options.localAppData);
  const discovery: LocalLlmRuntimeDiscovery = {
    platform,
    helperFound: helperPath !== undefined,
    modelFound: false,
  };
  if (helperPath !== undefined) {
    discovery.helperName = basename(helperPath);
    discovery.relativeHelperLocation = `%LOCALAPPDATA%\\AI-WorkMate\\native\\${basename(helperPath)}`;
    if (platform === "win32") {
      discovery.engineVersion = await readLlamaVersion(helperPath);
    }
  }
  if (modelPath !== undefined) {
    const contents = await readFile(modelPath);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    const catalog = getLocalLlmModelCatalogEntry(basename(modelPath));
    discovery.modelFound = true;
    discovery.modelName = basename(modelPath);
    discovery.modelSha256 = sha256;
    discovery.modelBytes = contents.byteLength;
    discovery.relativeModelLocation = `%LOCALAPPDATA%\\AI-WorkMate\\models\\llm\\${basename(modelPath)}`;
    if (catalog !== undefined) {
      discovery.modelChecksumOk = catalog.sha256 === sha256 && catalog.bytes === contents.byteLength;
    }
    if (!isGgufModelMagic(contents)) {
      discovery.modelFound = false;
      discovery.failureCode = "ANALYSIS_ENGINE_UNAVAILABLE";
      discovery.failureMessage = "Located model is not a GGUF file.";
    }
  }
  if (platform !== "win32") {
    discovery.failureCode = "ANALYSIS_ENGINE_UNAVAILABLE";
    discovery.failureMessage = `Local llama.cpp verification requires win32, not ${platform}.`;
  } else if (!discovery.helperFound || !discovery.modelFound) {
    discovery.failureCode = "ANALYSIS_ENGINE_UNAVAILABLE";
    discovery.failureMessage = "llama-cli.exe or a GGUF instruct model was not found under the managed LocalAppData locations.";
  }
  return discovery;
}

async function readLlamaVersion(helperPath: string): Promise<string | undefined> {
  try {
    const child = spawn(helperPath, ["--version"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    const code = await new Promise<number | null>((resolveExit) => {
      child.once("exit", (exitCode) => resolveExit(exitCode));
      child.once("error", () => resolveExit(null));
    });
    if (code !== 0 && code !== 1) {
      return undefined;
    }
    const text = Buffer.concat(stdout).toString("utf8").trim();
    return text.length > 0 ? text.split(/\r?\n/)[0] : undefined;
  } catch {
    return undefined;
  }
}
