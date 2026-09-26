/**
 * WebGPU acquisition and canvas sizing. Every failure mode here is a *normal* outcome, not an
 * exception to swallow: WebGPU needs a secure context, is not in every browser, and an adapter
 * can refuse a device. The app must show a useful screen instead of a blank canvas.
 */
export type UnsupportedReason =
  'no-navigator-gpu' | 'insecure-context' | 'no-adapter' | 'no-device' | 'no-canvas-context';

export interface SupportProbe {
  supported: boolean;
  reason?: UnsupportedReason;
  detail?: string;
}

/** Synchronous pre-flight check. Does not request an adapter. */
export const probeWebGpuSupport = (): SupportProbe => {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
    return {
      supported: false,
      reason: 'no-navigator-gpu',
      detail: 'This browser does not expose navigator.gpu.',
    };
  }
  // WebGPU is gated on a secure context; on http:// the property exists but requests fail.
  if (typeof isSecureContext === 'boolean' && !isSecureContext) {
    return {
      supported: false,
      reason: 'insecure-context',
      detail: 'WebGPU requires HTTPS or localhost.',
    };
  }
  return { supported: true };
};

export class WebGpuUnsupportedError extends Error {
  constructor(
    readonly reason: UnsupportedReason,
    detail: string,
  ) {
    super(detail);
    this.name = 'WebGpuUnsupportedError';
  }
}

export interface GpuContextOptions {
  canvas: HTMLCanvasElement;
  /** Extra limits/features to request; missing optional features must never be assumed present. */
  optionalFeatures?: GPUFeatureName[];
  powerPreference?: GPUPowerPreference;
  /** Device pixel ratio ceiling. DPR 3 at 1440p costs more fill than the art can use. */
  maxDevicePixelRatio?: number;
}

export interface CanvasSize {
  cssWidth: number;
  cssHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  devicePixelRatio: number;
}

export class GpuContext {
  readonly canvas: HTMLCanvasElement;
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
  readonly adapterInfo: string;
  readonly grantedFeatures: ReadonlySet<string>;

  private readonly maxDpr: number;
  private size: CanvasSize;

  private constructor(args: {
    canvas: HTMLCanvasElement;
    device: GPUDevice;
    context: GPUCanvasContext;
    format: GPUTextureFormat;
    adapterInfo: string;
    maxDpr: number;
  }) {
    this.canvas = args.canvas;
    this.device = args.device;
    this.context = args.context;
    this.format = args.format;
    this.adapterInfo = args.adapterInfo;
    this.maxDpr = args.maxDpr;
    this.grantedFeatures = new Set(args.device.features);
    this.size = { cssWidth: 0, cssHeight: 0, pixelWidth: 1, pixelHeight: 1, devicePixelRatio: 1 };
  }

  static async create(options: GpuContextOptions): Promise<GpuContext> {
    const probe = probeWebGpuSupport();
    if (!probe.supported) {
      throw new WebGpuUnsupportedError(
        probe.reason ?? 'no-navigator-gpu',
        probe.detail ?? 'WebGPU unavailable',
      );
    }

    const gpu = navigator.gpu;
    const adapter = await gpu.requestAdapter({
      powerPreference: options.powerPreference ?? 'high-performance',
    });
    if (!adapter) {
      throw new WebGpuUnsupportedError(
        'no-adapter',
        'No WebGPU adapter is available. The GPU may be blocklisted or unavailable in this session.',
      );
    }

    // Only request optional features the adapter actually advertises.
    const requested = (options.optionalFeatures ?? []).filter((feature) =>
      adapter.features.has(feature),
    );

    let device: GPUDevice;
    try {
      device = await adapter.requestDevice({ requiredFeatures: requested });
    } catch (error) {
      throw new WebGpuUnsupportedError(
        'no-device',
        `requestDevice failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const context = options.canvas.getContext('webgpu');
    if (!context) {
      throw new WebGpuUnsupportedError('no-canvas-context', 'Canvas refused a webgpu context.');
    }

    const format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });

    const info: GPUAdapterInfo | undefined = adapter.info;
    const adapterInfo = info
      ? [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ')
      : 'unknown adapter';

    const ctx = new GpuContext({
      canvas: options.canvas,
      device,
      context,
      format,
      adapterInfo: adapterInfo || 'unknown adapter',
      maxDpr: options.maxDevicePixelRatio ?? 2,
    });
    ctx.resizeToDisplay();
    return ctx;
  }

  get currentSize(): CanvasSize {
    return this.size;
  }

  get aspect(): number {
    return this.size.pixelWidth / Math.max(1, this.size.pixelHeight);
  }

  /**
   * Sizes the backing store from the CSS box. Returns true when the size changed, so callers
   * can rebuild size-dependent render targets without doing it every frame.
   */
  resizeToDisplay(): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.floor(rect.width) || this.canvas.clientWidth || 1);
    const cssHeight = Math.max(1, Math.floor(rect.height) || this.canvas.clientHeight || 1);
    const dpr = Math.min(
      this.maxDpr,
      typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1,
    );

    const limit = this.device.limits.maxTextureDimension2D;
    const pixelWidth = Math.min(limit, Math.max(1, Math.round(cssWidth * dpr)));
    const pixelHeight = Math.min(limit, Math.max(1, Math.round(cssHeight * dpr)));

    if (pixelWidth === this.size.pixelWidth && pixelHeight === this.size.pixelHeight) {
      this.size = { ...this.size, cssWidth, cssHeight, devicePixelRatio: dpr };
      return false;
    }

    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    this.size = { cssWidth, cssHeight, pixelWidth, pixelHeight, devicePixelRatio: dpr };
    return true;
  }

  /** Reconfigures the canvas after a device loss produced a new device. */
  reconfigure(device: GPUDevice): void {
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' });
  }

  destroy(): void {
    this.context.unconfigure();
    this.device.destroy();
  }
}
