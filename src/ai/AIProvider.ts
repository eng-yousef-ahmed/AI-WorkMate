import type { AIProcessingPolicy } from "../domain/models";
import { StorageError } from "../storage/errors";

export type AIProviderKind = "LOCAL" | "CLOUD";

export interface AIProviderDescriptor {
  id: string;
  displayName: string;
  kind: AIProviderKind;
  dataTransmission: string;
}

export interface AIProcessRequest {
  meetingId: string;
  purpose: "TRANSCRIPTION" | "SUMMARY" | "DECISIONS" | "TASKS" | "GROUNDED_QA";
  content: string | Uint8Array;
  language?: string;
}

export interface AIProcessResult {
  providerId: string;
  output: string;
  processedAt: string;
  persistedByProvider: false;
}

export interface AIProvider {
  readonly descriptor: AIProviderDescriptor;
  process(request: AIProcessRequest): Promise<AIProcessResult>;
}

export type AITransport = (request: AIProcessRequest, provider: AIProviderDescriptor) => Promise<string>;

/** Policy gate used before any content can leave the desktop process. */
export class AIProcessingPolicyEnforcer {
  public assertAllowed(
    policy: AIProcessingPolicy,
    provider: AIProviderDescriptor,
    userApprovedForThisRequest = false,
  ): void {
    if (policy === "LOCAL_ONLY" && provider.kind !== "LOCAL") {
      throw new StorageError("LOCAL_ONLY policy blocks cloud AI processing.");
    }
    if (policy === "ASK_EACH_TIME" && provider.kind === "CLOUD" && !userApprovedForThisRequest) {
      throw new StorageError("This request requires explicit approval before content is sent to a cloud AI provider.");
    }
  }
}

export class PolicyAwareAIService {
  private readonly enforcer = new AIProcessingPolicyEnforcer();

  public constructor(
    private readonly provider: AIProvider,
    private readonly policy: AIProcessingPolicy,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async process(request: AIProcessRequest, userApprovedForThisRequest = false): Promise<AIProcessResult> {
    this.enforcer.assertAllowed(this.policy, this.provider.descriptor, userApprovedForThisRequest);
    const result = await this.provider.process(request);
    return { ...result, processedAt: result.processedAt || this.clock().toISOString(), persistedByProvider: false };
  }
}

/** Adapter point for a future local model; it receives no cloud transport. */
export class LocalAIProvider implements AIProvider {
  public readonly descriptor: AIProviderDescriptor = {
    id: "local",
    displayName: "Local model",
    kind: "LOCAL",
    dataTransmission: "Content stays in the desktop process and DATA_ROOT.",
  };

  public constructor(private readonly transport: AITransport) {}

  public async process(request: AIProcessRequest): Promise<AIProcessResult> {
    const output = await this.transport(request, this.descriptor);
    return { providerId: this.descriptor.id, output, processedAt: new Date().toISOString(), persistedByProvider: false };
  }
}

/**
 * Cloud provider adapter. The transport is injected by the integration layer;
 * meeting business logic never imports an SDK and never persists cloud data.
 */
export class OpenAIProvider implements AIProvider {
  public readonly descriptor: AIProviderDescriptor = {
    id: "openai",
    displayName: "OpenAI",
    kind: "CLOUD",
    dataTransmission: "The selected audio, transcript, or meeting content is sent transiently to OpenAI for processing when policy permits.",
  };

  public constructor(private readonly transport: AITransport) {}

  public async process(request: AIProcessRequest): Promise<AIProcessResult> {
    const output = await this.transport(request, this.descriptor);
    return { providerId: this.descriptor.id, output, processedAt: new Date().toISOString(), persistedByProvider: false };
  }
}
