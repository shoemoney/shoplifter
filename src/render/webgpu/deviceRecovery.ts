import { GpuContext, type GpuContextOptions } from './context.js';

/**
 * A GPU device can vanish at any time (driver reset, tab backgrounded on some platforms,
 * TDR, OS sleep). Every GPU object dies with it. Recovery therefore requires a *description*
 * of each resource that outlives the device, which is why resources are registered as
 * factories rather than created ad hoc.
 */
export interface GpuResourceFactory<T> {
  label: string;
  build: (context: GpuContext) => T;
  dispose?: (resource: T) => void;
}

export interface ResourceHandle<T> {
  readonly label: string;
  /** Throws if read before the first build or during a loss window. */
  get: () => T;
}

export type RecoveryPhase = 'ready' | 'lost' | 'recovering' | 'failed';

export interface RecoveryEvent {
  phase: RecoveryPhase;
  attempt: number;
  reason?: string;
  message?: string;
}

interface Registration {
  factory: GpuResourceFactory<unknown>;
  resource: unknown;
  built: boolean;
}

export interface RenderHostOptions extends GpuContextOptions {
  maxRecoveryAttempts?: number;
  /** Delay before re-requesting a device, in ms. A driver reset needs a beat to settle. */
  recoveryDelayMs?: number;
  onRecovery?: (event: RecoveryEvent) => void;
  onUncapturedError?: (error: GPUError) => void;
}

export class RenderHost {
  private context: GpuContext;
  private readonly options: RenderHostOptions;
  private readonly registrations: Registration[] = [];
  private phase: RecoveryPhase = 'ready';
  private attempt = 0;
  private expectRecovery = false;
  private disposed = false;

  private constructor(context: GpuContext, options: RenderHostOptions) {
    this.context = context;
    this.options = options;
  }

  static async start(options: RenderHostOptions): Promise<RenderHost> {
    const context = await GpuContext.create(options);
    const host = new RenderHost(context, options);
    host.installDeviceHandlers();
    return host;
  }

  get gpu(): GpuContext {
    return this.context;
  }

  get currentPhase(): RecoveryPhase {
    return this.phase;
  }

  get recoveryAttempts(): number {
    return this.attempt;
  }

  /** Registers a resource and builds it immediately. Rebuilt automatically after a loss. */
  register<T>(factory: GpuResourceFactory<T>): ResourceHandle<T> {
    const registration: Registration = {
      factory: factory as GpuResourceFactory<unknown>,
      resource: undefined,
      built: false,
    };
    registration.resource = factory.build(this.context);
    registration.built = true;
    this.registrations.push(registration);
    return {
      label: factory.label,
      get: (): T => {
        if (!registration.built) {
          throw new Error(`GPU resource "${factory.label}" is unavailable (device ${this.phase}).`);
        }
        return registration.resource as T;
      },
    };
  }

  private installDeviceHandlers(): void {
    const device = this.context.device;
    device.onuncapturederror = (event: GPUUncapturedErrorEvent): void => {
      this.options.onUncapturedError?.(event.error);
    };
    void device.lost.then((info) => {
      if (this.disposed) return;
      // `destroyed` is us shutting down, unless a test explicitly asked for a recovery drill.
      if (info.reason === 'destroyed' && !this.expectRecovery) return;
      this.expectRecovery = false;
      this.handleLoss(info.reason, info.message);
    });
  }

  private handleLoss(reason: string, message: string): void {
    this.phase = 'lost';
    for (const registration of this.registrations) registration.built = false;
    this.emit({ phase: 'lost', attempt: this.attempt, reason, message });
    void this.recover();
  }

  private async recover(): Promise<void> {
    const maxAttempts = this.options.maxRecoveryAttempts ?? 5;
    const delay = this.options.recoveryDelayMs ?? 250;

    while (this.attempt < maxAttempts && !this.disposed) {
      this.attempt++;
      this.phase = 'recovering';
      this.emit({ phase: 'recovering', attempt: this.attempt });
      await new Promise((resolve) => setTimeout(resolve, delay * this.attempt));
      try {
        this.context = await GpuContext.create(this.options);
        this.installDeviceHandlers();
        for (const registration of this.registrations) {
          registration.resource = registration.factory.build(this.context);
          registration.built = true;
        }
        this.phase = 'ready';
        this.emit({ phase: 'ready', attempt: this.attempt });
        return;
      } catch (error) {
        this.emit({
          phase: 'recovering',
          attempt: this.attempt,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.phase = 'failed';
    this.emit({ phase: 'failed', attempt: this.attempt });
  }

  private emit(event: RecoveryEvent): void {
    this.options.onRecovery?.(event);
  }

  /** Test hook: drops the device on purpose and drives the full rebuild path. */
  simulateDeviceLoss(): void {
    this.expectRecovery = true;
    this.context.device.destroy();
  }

  dispose(): void {
    this.disposed = true;
    for (const registration of this.registrations) {
      if (registration.built) registration.factory.dispose?.(registration.resource);
      registration.built = false;
    }
    this.registrations.length = 0;
    this.context.destroy();
  }
}
