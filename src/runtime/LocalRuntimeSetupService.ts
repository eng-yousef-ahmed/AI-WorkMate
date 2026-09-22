import { PRODUCTION_LOCAL_LLM_MODEL_ID } from "../ai/LocalLlmRuntimeCatalog";
import { installLocalLlmModel, type LocalLlmDownloadTransport, type LocalLlmModelInstallResult } from "../ai/LocalLlmModelInstaller";
import { discoverLocalLlmRuntime } from "../ai/LocalLlmRuntimeDiscovery";
import { StorageError } from "../storage/errors";
import { WHISPER_TINY_MODEL_ID } from "../transcription/WhisperRuntimeCatalog";
import { installWhisperModel, type WhisperDownloadTransport, type WhisperModelInstallResult } from "../transcription/WhisperModelInstaller";
import { discoverWhisperRuntime } from "../transcription/WhisperRuntimeDiscovery";

/** Renderer-safe catalog ids. Never filenames, URLs, or filesystem paths. */
export const RUNTIME_COMPONENT_IDS = ["transcription-tiny", "analysis-production"] as const;
export type RuntimeComponentId = (typeof RUNTIME_COMPONENT_IDS)[number];

export interface RuntimeComponentSnapshot {
  id: RuntimeComponentId;
  displayName: string;
  helperReady: boolean;
  modelPresent: boolean;
  checksumVerified: boolean;
  ready: boolean;
  installRequired: boolean;
}

export interface RuntimeSetupSnapshot {
  transcription: RuntimeComponentSnapshot;
  analysis: RuntimeComponentSnapshot;
  modelsOutsideDataRoot: true;
  cloudFallbackEnabled: false;
  busy: boolean;
}

export interface RuntimeInstallRequest {
  component: RuntimeComponentId;
  replaceCorrupted?: boolean;
}

export interface RuntimeInstallResult {
  id: RuntimeComponentId;
  alreadyVerified: boolean;
  checksumVerified: true;
}

export interface LocalRuntimeSetupOptions {
  localAppData: string;
  platform?: NodeJS.Platform | string;
  whisperTransport?: WhisperDownloadTransport;
  llmTransport?: LocalLlmDownloadTransport;
  installWhisper?: (options: {
    modelId: string;
    localAppData: string;
    replaceCorrupted?: boolean;
    transport?: WhisperDownloadTransport;
  }) => Promise<WhisperModelInstallResult>;
  installLlm?: (options: {
    modelId: string;
    localAppData: string;
    replaceCorrupted?: boolean;
    transport?: LocalLlmDownloadTransport;
  }) => Promise<LocalLlmModelInstallResult>;
}

export function isRuntimeComponentId(value: unknown): value is RuntimeComponentId {
  return value === "transcription-tiny" || value === "analysis-production";
}

/**
 * Main-process-only Whisper + llama.cpp/Qwen install. Models live under
 * LOCALAPPDATA, never DATA_ROOT. Renderer sees catalog ids and booleans only.
 */
export class LocalRuntimeSetupService {
  private busy = false;
  private readonly localAppData: string;
  private readonly platform: NodeJS.Platform | string;
  private readonly whisperTransport: WhisperDownloadTransport | undefined;
  private readonly llmTransport: LocalLlmDownloadTransport | undefined;
  private readonly installWhisper: NonNullable<LocalRuntimeSetupOptions["installWhisper"]>;
  private readonly installLlm: NonNullable<LocalRuntimeSetupOptions["installLlm"]>;

  public constructor(options: LocalRuntimeSetupOptions) {
    this.localAppData = options.localAppData;
    this.platform = options.platform ?? process.platform;
    this.whisperTransport = options.whisperTransport;
    this.llmTransport = options.llmTransport;
    this.installWhisper = options.installWhisper ?? installWhisperModel;
    this.installLlm = options.installLlm ?? installLocalLlmModel;
  }

  public async getSnapshot(): Promise<RuntimeSetupSnapshot> {
    const [whisper, llm] = await Promise.all([
      discoverWhisperRuntime({ platform: this.platform, localAppData: this.localAppData }),
      discoverLocalLlmRuntime({ platform: this.platform, localAppData: this.localAppData }),
    ]);
    // checksumVerified here is catalog size + magic (snapshot must not hash
    // multi-GB Qwen shards). SHA-256 remains the install closer.
    const transcriptionReady = whisper.helperFound && whisper.modelFound === true && whisper.modelChecksumOk === true;
    const analysisReady = llm.helperFound && llm.modelFound === true && llm.modelChecksumOk === true;
    return {
      transcription: {
        id: "transcription-tiny",
        displayName: "Local transcription model",
        helperReady: whisper.helperFound,
        modelPresent: whisper.modelFound,
        checksumVerified: whisper.modelChecksumOk === true,
        ready: transcriptionReady,
        installRequired: !transcriptionReady,
      },
      analysis: {
        id: "analysis-production",
        displayName: "Local analysis model",
        helperReady: llm.helperFound,
        modelPresent: llm.modelFound,
        checksumVerified: llm.modelChecksumOk === true,
        ready: analysisReady,
        installRequired: !analysisReady,
      },
      modelsOutsideDataRoot: true,
      cloudFallbackEnabled: false,
      busy: this.busy,
    };
  }

  public async install(request: RuntimeInstallRequest): Promise<RuntimeInstallResult> {
    if (!isRuntimeComponentId(request.component)) {
      throw new StorageError("Unknown local runtime component.");
    }
    if (this.busy) {
      throw new StorageError("A local model install is already running.");
    }
    this.busy = true;
    try {
      if (request.component === "transcription-tiny") {
        const installed = await this.installWhisper({
          modelId: WHISPER_TINY_MODEL_ID,
          localAppData: this.localAppData,
          ...(request.replaceCorrupted === true ? { replaceCorrupted: true } : {}),
          ...(this.whisperTransport === undefined ? {} : { transport: this.whisperTransport }),
        });
        return {
          id: "transcription-tiny",
          alreadyVerified: installed.alreadyVerified === true,
          checksumVerified: true,
        };
      }
      const installed = await this.installLlm({
        modelId: PRODUCTION_LOCAL_LLM_MODEL_ID,
        localAppData: this.localAppData,
        ...(request.replaceCorrupted === true ? { replaceCorrupted: true } : {}),
        ...(this.llmTransport === undefined ? {} : { transport: this.llmTransport }),
      });
      return {
        id: "analysis-production",
        alreadyVerified: installed.alreadyVerified === true,
        checksumVerified: true,
      };
    } finally {
      this.busy = false;
    }
  }
}
