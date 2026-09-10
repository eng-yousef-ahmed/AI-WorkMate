import {
  capabilityUnavailableError,
  NATIVE_CAPTURE_KINDS,
  NativeCaptureError,
  type NativeCaptureAdapter,
  type NativeCaptureCapabilities,
  type NativeCaptureCapability,
  type NativeCaptureErrorInfo,
  type NativeCaptureKind,
  type NativeCaptureSession,
  type NativeCaptureStartRequest,
  unavailableCapability,
} from "./NativeCaptureAdapter";
import { WindowsCompositeNativeCaptureProvider } from "./WindowsCompositeNativeCaptureProvider";

export interface WindowsNativeCaptureProvider {
  discoverCapabilities(): Promise<NativeCaptureCapabilities>;
  startCapture(request: NativeCaptureStartRequest): Promise<NativeCaptureSession>;
}

export interface WindowsCaptureAdapterOptions {
  platform?: NodeJS.Platform | string;
  provider?: WindowsNativeCaptureProvider;
  clock?: () => Date;
  /** When set, both audio and screen helpers use this path (tests isolate a missing helper). */
  helperPath?: string;
  audioHelperPath?: string;
  screenHelperPath?: string;
}

/**
 * Windows-native capture boundary. This class deliberately does not generate
 * media itself and does not fall back to generated capture. A real native provider
 * must be registered by the desktop/native layer before any capability can be
 * reported as available or started.
 */
export class WindowsCaptureAdapter implements NativeCaptureAdapter {
  public readonly adapterId = "windows-native-capture";
  private readonly platform: NodeJS.Platform | string;
  private readonly provider: WindowsNativeCaptureProvider | undefined;
  private readonly clock: () => Date;

  public constructor(options: WindowsCaptureAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.provider = options.provider;
    this.clock = options.clock ?? (() => new Date());
  }

  public async discoverCapabilities(): Promise<NativeCaptureCapabilities> {
    if (this.platform !== "win32") {
      return unsupportedCapabilities(this.adapterId, this.platform, this.clock());
    }
    if (this.provider === undefined) {
      return providerMissingCapabilities(this.adapterId, this.platform, this.clock());
    }
    const capabilities = await this.provider.discoverCapabilities();
    return normalizeCapabilities(capabilities, this.adapterId, this.platform, this.clock());
  }

  public async startCapture(request: NativeCaptureStartRequest): Promise<NativeCaptureSession> {
    if (this.platform !== "win32") {
      throw capabilityUnavailableError(
        request.capability,
        `Native Windows capture is unsupported on platform ${this.platform}.`,
        "NATIVE_PLATFORM_UNSUPPORTED",
        false,
      );
    }
    if (this.provider === undefined) {
      throw capabilityUnavailableError(
        request.capability,
        "No Windows native capture provider has been registered.",
        "NATIVE_PROVIDER_NOT_CONFIGURED",
        false,
      );
    }
    return this.provider.startCapture(request);
  }
}

export interface UnsupportedNativeCaptureAdapterOptions {
  platform?: NodeJS.Platform | string;
  clock?: () => Date;
}

/** Fail-closed adapter for platforms without a registered native capture implementation. */
export class UnsupportedNativeCaptureAdapter implements NativeCaptureAdapter {
  public readonly adapterId = "unsupported-native-capture";
  private readonly platform: NodeJS.Platform | string;
  private readonly clock: () => Date;

  public constructor(options: UnsupportedNativeCaptureAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.clock = options.clock ?? (() => new Date());
  }

  public async discoverCapabilities(): Promise<NativeCaptureCapabilities> {
    return unsupportedCapabilities(this.adapterId, this.platform, this.clock());
  }

  public async startCapture(request: NativeCaptureStartRequest): Promise<NativeCaptureSession> {
    throw capabilityUnavailableError(
      request.capability,
      `Native capture is unsupported on platform ${this.platform}.`,
      "NATIVE_PLATFORM_UNSUPPORTED",
      false,
    );
  }
}

export type CreateNativeCaptureAdapterOptions = WindowsCaptureAdapterOptions;

export function createNativeCaptureAdapter(options: CreateNativeCaptureAdapterOptions = {}): NativeCaptureAdapter {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return new WindowsCaptureAdapter({
      ...options,
      platform,
      provider: options.provider ?? new WindowsCompositeNativeCaptureProvider({
        platform,
        clock: options.clock,
        ...(options.helperPath === undefined ? {} : { audioHelperPath: options.helperPath }),
      }),
    });
  }
  return new UnsupportedNativeCaptureAdapter({ platform, clock: options.clock });
}

function unsupportedCapabilities(adapterId: string, platform: NodeJS.Platform | string, checkedAt: Date): NativeCaptureCapabilities {
  const capabilities = {} as Record<NativeCaptureKind, NativeCaptureCapability>;
  for (const kind of NATIVE_CAPTURE_KINDS) {
    capabilities[kind] = unavailableCapability(kind, "UNSUPPORTED", {
      code: "NATIVE_PLATFORM_UNSUPPORTED",
      message: `Native capture is unsupported on platform ${platform}.`,
      capability: kind,
      retryable: false,
    });
  }
  return {
    platform,
    adapterId,
    checkedAt: checkedAt.toISOString(),
    supported: false,
    capabilities,
  };
}

function providerMissingCapabilities(adapterId: string, platform: NodeJS.Platform | string, checkedAt: Date): NativeCaptureCapabilities {
  const capabilities = {} as Record<NativeCaptureKind, NativeCaptureCapability>;
  for (const kind of NATIVE_CAPTURE_KINDS) {
    capabilities[kind] = unavailableCapability(kind, "UNAVAILABLE", {
      code: "NATIVE_PROVIDER_NOT_CONFIGURED",
      message: "No Windows native capture provider has been registered.",
      capability: kind,
      retryable: false,
    });
  }
  return {
    platform,
    adapterId,
    checkedAt: checkedAt.toISOString(),
    supported: true,
    capabilities,
  };
}

function normalizeCapabilities(
  capabilities: NativeCaptureCapabilities,
  adapterId: string,
  platform: NodeJS.Platform | string,
  checkedAt: Date,
): NativeCaptureCapabilities {
  const normalized = {} as Record<NativeCaptureKind, NativeCaptureCapability>;
  for (const kind of NATIVE_CAPTURE_KINDS) {
    normalized[kind] = normalizeCapability(kind, capabilities.capabilities[kind]);
  }
  return {
    platform: capabilities.platform || platform,
    adapterId: capabilities.adapterId || adapterId,
    checkedAt: capabilities.checkedAt || checkedAt.toISOString(),
    supported: capabilities.supported,
    capabilities: normalized,
  };
}

function normalizeCapability(kind: NativeCaptureKind, capability: NativeCaptureCapability | undefined): NativeCaptureCapability {
  if (capability === undefined) {
    return unavailableCapability(kind, "UNAVAILABLE", {
      code: "NATIVE_CAPABILITY_UNAVAILABLE",
      message: `Native capture capability is not reported by the provider: ${kind}.`,
      capability: kind,
      retryable: true,
    });
  }
  if (capability.kind !== kind) {
    throw new NativeCaptureError({
      code: "NATIVE_CAPTURE_START_FAILED",
      message: `Native capture provider returned capability ${capability.kind} for ${kind}.`,
      capability: kind,
      retryable: false,
    });
  }
  if (capability.available && capability.status !== "AVAILABLE") {
    throw new NativeCaptureError({
      code: "NATIVE_CAPTURE_START_FAILED",
      message: `Native capture provider marked ${kind} available with status ${capability.status}.`,
      capability: kind,
      retryable: false,
    });
  }
  if (!capability.available && capability.status === "AVAILABLE") {
    throw new NativeCaptureError({
      code: "NATIVE_CAPTURE_START_FAILED",
      message: `Native capture provider marked ${kind} unavailable with AVAILABLE status.`,
      capability: kind,
      retryable: false,
    });
  }
  const sourceIds = new Set<string>();
  for (const source of capability.sources ?? []) {
    if (!source.sourceId.trim()) {
      throw malformedCapabilityError(kind, "Native capture source IDs cannot be empty.");
    }
    if (source.kind !== kind) {
      throw malformedCapabilityError(kind, `Native capture source ${source.sourceId} is ${source.kind}, expected ${kind}.`);
    }
    if (sourceIds.has(source.sourceId)) {
      throw malformedCapabilityError(kind, `Native capture source ID is duplicated: ${source.sourceId}.`);
    }
    sourceIds.add(source.sourceId);
  }
  if (!capability.available && capability.error === undefined) {
    return {
      ...capability,
      error: unavailableErrorForStatus(kind, capability.status),
    };
  }
  return capability;
}

function malformedCapabilityError(kind: NativeCaptureKind, message: string): NativeCaptureError {
  return new NativeCaptureError({
    code: "NATIVE_CAPTURE_START_FAILED",
    message,
    capability: kind,
    retryable: false,
  });
}

function unavailableErrorForStatus(kind: NativeCaptureKind, status: NativeCaptureCapability["status"]): NativeCaptureErrorInfo {
  switch (status) {
    case "PERMISSION_DENIED":
      return {
        code: "NATIVE_PERMISSION_DENIED",
        message: `Native capture permission is denied for ${kind}.`,
        capability: kind,
        retryable: true,
      };
    case "UNSUPPORTED":
      return {
        code: "NATIVE_PLATFORM_UNSUPPORTED",
        message: `Native capture capability is unsupported: ${kind}.`,
        capability: kind,
        retryable: false,
      };
    case "UNAVAILABLE":
    case "AVAILABLE":
      return {
        code: "NATIVE_CAPABILITY_UNAVAILABLE",
        message: `Native capture capability is unavailable: ${kind}.`,
        capability: kind,
        retryable: true,
      };
  }
}
