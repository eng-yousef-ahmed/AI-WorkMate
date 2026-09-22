import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { WINDOWS_RELEASE_CONTRACT } from "../src/desktop/windows-release-contract";
import { getDataRootProtectionError } from "../src/storage/LocalStorageService";

interface PackageJson {
  author?: string;
  build?: {
    icon?: string;
    copyright?: string;
    nsis?: {
      oneClick?: boolean;
      allowToChangeInstallationDirectory?: boolean;
      deleteAppDataOnUninstall?: boolean;
      runAfterFinish?: boolean;
      include?: string;
    };
    extraResources?: Array<{ from?: string; to?: string }>;
  };
}

test("NSIS packaging contract matches package.json and ships only the declared default AI models", async () => {
  const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as PackageJson;
  assert.equal(typeof pkg.author, "string");
  assert.ok((pkg.author ?? "").length > 0);
  assert.equal(pkg.build?.icon, "build/icon.png");
  assert.ok((pkg.build?.copyright ?? "").includes("AI WorkMate"));
  const nsis = pkg.build?.nsis;
  assert.equal(nsis?.oneClick, WINDOWS_RELEASE_CONTRACT.nsisOneClick);
  assert.equal(nsis?.allowToChangeInstallationDirectory, WINDOWS_RELEASE_CONTRACT.allowToChangeInstallationDirectory);
  assert.equal(nsis?.deleteAppDataOnUninstall, WINDOWS_RELEASE_CONTRACT.deleteAppDataOnUninstall);
  assert.equal(nsis?.runAfterFinish, WINDOWS_RELEASE_CONTRACT.runAfterFinish);
  assert.equal(nsis?.include, WINDOWS_RELEASE_CONTRACT.nsisInclude);

  const extras = pkg.build?.extraResources ?? [];
  const destinations = extras.map((entry) => entry.to ?? "");
  assert.equal(
    destinations.some((to) => to.includes("windows-audio")),
    WINDOWS_RELEASE_CONTRACT.extraResourcesIncludeAudioHelper,
  );
  assert.equal(
    destinations.some((to) => to.includes("windows-screen")),
    WINDOWS_RELEASE_CONTRACT.extraResourcesIncludeScreenHelper,
  );
  // WindowsLocalWhisperEngine/LocalLlmProvider resolve bundled binaries and
  // models under process.resourcesPath + "native/windows-transcription" and
  // "native/windows-llm" (see src/transcription/WindowsLocalWhisperEngine.ts
  // and src/ai/LocalLlmProvider.ts) — check against those real folder names,
  // not a guessed-at "whisper"/"models" naming that predates this feature.
  assert.equal(
    destinations.some((to) => to.includes("windows-transcription")),
    WINDOWS_RELEASE_CONTRACT.extraResourcesIncludeWhisperRuntime,
  );
  assert.equal(destinations.some((to) => /llm|llama|qwen/i.test(to)), WINDOWS_RELEASE_CONTRACT.extraResourcesIncludeLlmRuntime);
  assert.equal(
    destinations.some((to) => to.includes("windows-transcription/models")),
    WINDOWS_RELEASE_CONTRACT.extraResourcesIncludeWhisperModels,
  );
  assert.equal(
    destinations.some((to) => to.includes("windows-llm/models")),
    WINDOWS_RELEASE_CONTRACT.extraResourcesIncludeLlmModels,
  );
  assert.equal(WINDOWS_RELEASE_CONTRACT.firstRunRequiresUserDataRootSelection, true);
  assert.equal(WINDOWS_RELEASE_CONTRACT.credentialStoreUsesOsSafeStorage, true);
  assert.equal(WINDOWS_RELEASE_CONTRACT.uninstallPreservesUserData, true);
  assert.equal(WINDOWS_RELEASE_CONTRACT.installerHasAuthor, true);
  assert.equal(WINDOWS_RELEASE_CONTRACT.installerHasIcon, true);
});

test("DATA_ROOT cannot be a Windows Program Files or installation directory", () => {
  assert.match(
    getDataRootProtectionError("C:\\Program Files\\AI-WorkMate\\data", "C:\\Program Files\\AI-WorkMate", "win32") ?? "",
    /installation directory|Program Files/,
  );
  assert.match(
    getDataRootProtectionError("C:\\Windows\\System32\\data", undefined, "win32") ?? "",
    /protected Windows/,
  );
  assert.equal(
    getDataRootProtectionError("C:\\Users\\ada\\AI-WorkMate", "C:\\Program Files\\AI-WorkMate", "win32"),
    undefined,
  );
  assert.equal(WINDOWS_RELEASE_CONTRACT.dataRootCannotBeProgramFiles, true);
});
