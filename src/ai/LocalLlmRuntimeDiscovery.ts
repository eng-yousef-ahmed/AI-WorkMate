import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { basename } from "node:path";

import { isGgufModelMagic } from "./LocalLlmModelFormat";
import { assertUsableLocalLlmModelFile, hashLocalLlmFile, resolveWindowsLlamaCliPath, resolveWindowsLlamaModelPath } from "./LocalLlmProvider";
import { getLocalLlmModelCatalogEntry } from "./LocalLlmRuntimeCatalog";

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
  selectedModelId?: string;
  splitGguf?: boolean;
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
    const catalog = getLocalLlmModelCatalogEntry(basename(modelPath));
    const header = Buffer.alloc(4);
    const handle = await open(modelPath, "r");
    try {
      await handle.read(header, 0, 4, 0);
    } finally {
      await handle.close();
    }
    discovery.modelFound = true;
    discovery.modelName = basename(modelPath);
    discovery.relativeModelLocation = `%LOCALAPPDATA%\\AI-WorkMate\\models\\llm\\${basename(modelPath)}`;
    discovery.splitGguf = catalog?.splitGguf === true;
    discovery.selectedModelId = catalog?.id;
    if (!isGgufModelMagic(header)) {
      discovery.modelFound = false;
      discovery.failureCode = "ANALYSIS_ENGINE_UNAVAILABLE";
      discovery.failureMessage = "Located model is not a GGUF file.";
    } else if (catalog !== undefined) {
      try {
        const verified = await assertUsableLocalLlmModelFile(modelPath);
        discovery.modelSha256 = verified.sha256;
        discovery.modelBytes = verified.bytes;
        discovery.modelChecksumOk = true;
      } catch {
        const hashed = await hashLocalLlmFile(modelPath);
        discovery.modelSha256 = hashed.sha256;
        discovery.modelBytes = hashed.bytes;
        discovery.modelChecksumOk = false;
      }
    } else {
      const hashed = await hashLocalLlmFile(modelPath);
      discovery.modelSha256 = hashed.sha256;
      discovery.modelBytes = hashed.bytes;
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
