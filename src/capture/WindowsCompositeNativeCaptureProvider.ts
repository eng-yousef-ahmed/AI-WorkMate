import {
  NATIVE_CAPTURE_KINDS,
  type NativeCaptureAdapter,
  type NativeCaptureCapabilities,
  type NativeCaptureCapability,
  type NativeCaptureKind,
  type NativeCaptureSession,
  type NativeCaptureStartRequest,
} from "./NativeCaptureAdapter";
import type { WindowsNativeCaptureProvider } from "./WindowsCaptureAdapter";
import { WindowsNativeAudioProvider } from "./WindowsNativeAudioProvider";
import { WindowsNativeScreenProvider } from "./WindowsNativeScreenProvider";

const AUDIO_KINDS = new Set<NativeCaptureKind>(["MICROPHONE_AUDIO", "SYSTEM_AUDIO"]);
const VIDEO_KINDS = new Set<NativeCaptureKind>(["SCREEN", "WINDOW"]);
const PROVIDER_ID = "windows-native-capture-composite";

export interface WindowsCompositeNativeCaptureProviderOptions {
  platform?: NodeJS.Platform | string;
  audio?: WindowsNativeCaptureProvider;
  screen?: WindowsNativeCaptureProvider;
  clock?: () => Date;
  audioHelperPath?: string;
  screenHelperPath?: string;
}

/**
 * Routes microphone/loopback to the WASAPI helper and screen/window to the
 * DXGI / Windows Graphics Capture helper. A missing screen helper must not
 * disable verified audio capture.
 */
export class WindowsCompositeNativeCaptureProvider implements WindowsNativeCaptureProvider, NativeCaptureAdapter {
  public readonly adapterId = PROVIDER_ID;
  private readonly audio: WindowsNativeCaptureProvider;
  private readonly screen: WindowsNativeCaptureProvider;
  private readonly clock: () => Date;

  public constructor(options: WindowsCompositeNativeCaptureProviderOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.clock = options.clock ?? (() => new Date());
    this.audio = options.audio ?? new WindowsNativeAudioProvider({
      platform,
      clock: this.clock,
      ...(options.audioHelperPath === undefined ? {} : { helperPath: options.audioHelperPath }),
    });
    this.screen = options.screen ?? new WindowsNativeScreenProvider({
      platform,
      clock: this.clock,
      ...(options.screenHelperPath === undefined ? {} : { helperPath: options.screenHelperPath }),
    });
  }

  public async discoverCapabilities(): Promise<NativeCaptureCapabilities> {
    const [audio, screen] = await Promise.all([this.audio.discoverCapabilities(), this.screen.discoverCapabilities()]);
    const capabilities = {} as Record<NativeCaptureKind, NativeCaptureCapability>;
    for (const kind of NATIVE_CAPTURE_KINDS) {
      capabilities[kind] = AUDIO_KINDS.has(kind) ? audio.capabilities[kind] : screen.capabilities[kind];
    }
    return {
      platform: audio.platform || screen.platform,
      adapterId: PROVIDER_ID,
      checkedAt: this.clock().toISOString(),
      supported: audio.supported || screen.supported,
      capabilities,
    };
  }

  public startCapture(request: NativeCaptureStartRequest): Promise<NativeCaptureSession> {
    if (AUDIO_KINDS.has(request.capability)) {
      return this.audio.startCapture(request);
    }
    if (VIDEO_KINDS.has(request.capability)) {
      return this.screen.startCapture(request);
    }
    return this.screen.startCapture(request);
  }
}
