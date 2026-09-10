import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { WINDOWS_RELEASE_CONTRACT } from "../src/desktop/windows-release-contract";
import { getDataRootProtectionError } from "../src/storage/LocalStorageService";

interface PackageJson {
  build?: {
    nsis?: {
      oneClick?: boolean;
      allowToChangeInstallationDirectory?: boolean;
      deleteAppDataOnUninstall?: boolean;
      runAfterFinish?: boolean;
    };
    extraResources?: Array<{ from?: string; to?: string }>;
  };
}

test("NSIS packaging contract matches package.json and never ships models", async () => {
  const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as PackageJson;
  const nsis = pkg.build?.nsis;
  assert.equal(nsis?.oneClick, WINDOWS_RELEASE_CONTRACT.nsisOneClick);
  assert.equal(nsis?.allowToChangeInstallationDirectory, WINDOWS_RELEASE_CONTRACT.allowToChangeInstallationDirectory);
  assert.equal(nsis?.deleteAppDataOnUninstall, WINDOWS_RELEASE_CONTRACT.deleteAppDataOnUninstall);
  assert.equal(nsis?.runAfterFinish, WINDOWS_RELEASE_CONTRACT.runAfterFinish);

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
  assert.equal(destinations.some((to) => /whisper/i.test(to)), WINDOWS_RELEASE_CONTRACT.extraResourcesIncludeWhisperRuntime);
  assert.equal(destinations.some((to) => /llm|llama|qwen/i.test(to)), WINDOWS_RELEASE_CONTRACT.extraResourcesIncludeLlmRuntime);
  const sources = extras.map((entry) => `${entry.from ?? ""} ${entry.to ?? ""}`).join("\n").toLowerCase();
  assert.equal(sources.includes("models"), WINDOWS_RELEASE_CONTRACT.extraResourcesIncludeWhisperModels);
  assert.equal(WINDOWS_RELEASE_CONTRACT.firstRunRequiresUserDataRootSelection, true);
  assert.equal(WINDOWS_RELEASE_CONTRACT.credentialStoreUsesOsSafeStorage, true);
  assert.equal(WINDOWS_RELEASE_CONTRACT.uninstallPreservesUserData, true);
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
