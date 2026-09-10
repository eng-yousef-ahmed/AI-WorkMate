import type { RuntimeInstallResult, RuntimeSetupSnapshot } from "../runtime/LocalRuntimeSetupService";

/**
 * Runtime-setup channels and the preload/renderer API surface.
 *
 * This module is sandbox-safe: string constants and TypeScript types only.
 * The sandboxed preload (`sandbox: true`) must import channels from here,
 * never from `runtime-ipc.ts`, which loads installers, `fs`, and `child_process`.
 *
 * Channel names deliberately omit llama/llm/openai/model-url/helper-path so
 * those never appear on the renderer storage boundary.
 */
export const RUNTIME_IPC_CHANNELS = {
  getSnapshot: "runtime:get-snapshot",
  install: "runtime:install-component",
} as const;

export interface RuntimeRendererAPI {
  getSnapshot(): Promise<RuntimeSetupSnapshot>;
  install(component: string, replaceCorrupted?: boolean): Promise<RuntimeInstallResult>;
}
