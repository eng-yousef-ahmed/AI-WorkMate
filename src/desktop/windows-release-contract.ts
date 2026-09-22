/**
 * Installer and first-run invariants that must stay aligned with `package.json`
 * `build.nsis` / `build.extraResources`. Tests compare this contract to the
 * packaged metadata so a silent NSIS or model-in-installer regression cannot
 * land unnoticed. Whisper and llama.cpp models are user-installed under the
 * OS local app data directory — they are never NSIS payload.
 */
export const WINDOWS_RELEASE_CONTRACT = {
  nsisOneClick: false,
  allowToChangeInstallationDirectory: true,
  deleteAppDataOnUninstall: false,
  runAfterFinish: true,
  extraResourcesIncludeAudioHelper: true,
  extraResourcesIncludeScreenHelper: true,
  extraResourcesIncludeWhisperRuntime: false,
  extraResourcesIncludeWhisperModels: false,
  extraResourcesIncludeLlmRuntime: false,
  extraResourcesIncludeLlmModels: false,
  firstRunRequiresUserDataRootSelection: true,
  dataRootCannotBeProgramFiles: true,
  credentialStoreUsesOsSafeStorage: true,
  uninstallPreservesUserData: true,
  nsisInclude: "installer/nsis.nsh",
  nsisDoesNotDeleteDataRootOnUninstall: true,
  installerHasAuthor: true,
  installerHasIcon: true,
} as const;

export type WindowsReleaseContract = typeof WINDOWS_RELEASE_CONTRACT;
