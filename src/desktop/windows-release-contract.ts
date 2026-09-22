/**
 * Installer and first-run invariants that must stay aligned with `package.json`
 * `build.nsis` / `build.extraResources`. Tests compare this contract to the
 * packaged metadata so a silent NSIS regression cannot land unnoticed.
 *
 * Whisper's `ggml-tiny.bin` and the Qwen2.5-0.5B-Instruct smoke-test model
 * ARE NSIS payload: `npm run prepare:bundled-ai-models` stages them (via the
 * same verified, allowlisted installers users get, re-verified after
 * copying) into native/windows-transcription/ and native/windows-llm/, and
 * `npm run check:bundled-ai-binaries` fails the build if the matching
 * whisper-cli.exe/llama-cli.exe are not already staged alongside them — see
 * scripts/prepare-bundled-ai-assets.ts and scripts/check-bundled-ai-binaries.ts.
 * This exists so transcription and a first pass at meeting analysis work on
 * a fresh install with no manual step. The production 7B analysis model
 * stays an explicit post-install upgrade (`npm run install:local-llm-model`)
 * because of its size, not because of this same "never ship models"
 * constraint — it is a UX/size tradeoff, not a security one.
 */
export const WINDOWS_RELEASE_CONTRACT = {
  nsisOneClick: false,
  allowToChangeInstallationDirectory: true,
  deleteAppDataOnUninstall: false,
  runAfterFinish: true,
  extraResourcesIncludeAudioHelper: true,
  extraResourcesIncludeScreenHelper: true,
  extraResourcesIncludeWhisperRuntime: true,
  extraResourcesIncludeWhisperModels: true,
  extraResourcesIncludeLlmRuntime: true,
  extraResourcesIncludeLlmModels: true,
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
