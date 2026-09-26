/**
 * Fixed-step accumulator clock. The simulation always advances in whole 1/120 s ticks;
 * rendering interpolates with the leftover `alpha`. Variable-dt physics would make the
 * flight model feel different at 60 vs 144 Hz and break replay determinism.
 */
export interface ClockOptions {
  /** Simulation ticks per second. */
  tickHz: number;
  /**
   * Hard cap on ticks consumed per frame. Without it, a long stall (tab restore, GC pause)
   * queues hundreds of ticks, which take longer to simulate than real time and spiral.
   */
  maxTicksPerFrame: number;
}

export interface ClockStep {
  /** Whole simulation ticks to run this frame. */
  ticks: number;
  /** Interpolation factor in [0, 1) between the previous and current sim state. */
  alpha: number;
  /** Ticks discarded because `maxTicksPerFrame` was hit. */
  droppedTicks: number;
}

export class FixedClock {
  readonly tickHz: number;
  readonly dt: number;
  readonly maxTicksPerFrame: number;

  private accumulator = 0;
  private tickCount = 0;
  private simSeconds = 0;

  constructor(options: ClockOptions) {
    if (options.tickHz <= 0) throw new Error('FixedClock: tickHz must be positive');
    if (options.maxTicksPerFrame < 1) throw new Error('FixedClock: maxTicksPerFrame must be >= 1');
    this.tickHz = options.tickHz;
    this.dt = 1 / options.tickHz;
    this.maxTicksPerFrame = options.maxTicksPerFrame;
  }

  get tick(): number {
    return this.tickCount;
  }

  /** Simulated seconds elapsed — never wall-clock seconds. */
  get elapsed(): number {
    return this.simSeconds;
  }

  get pendingSeconds(): number {
    return this.accumulator;
  }

  /** Feeds real frame time in seconds and reports how much simulation to run. */
  advance(frameSeconds: number): ClockStep {
    if (!Number.isFinite(frameSeconds) || frameSeconds < 0) frameSeconds = 0;
    this.accumulator += frameSeconds;

    let ticks = Math.floor(this.accumulator / this.dt);
    let droppedTicks = 0;
    if (ticks > this.maxTicksPerFrame) {
      droppedTicks = ticks - this.maxTicksPerFrame;
      ticks = this.maxTicksPerFrame;
      this.accumulator -= droppedTicks * this.dt;
    }

    this.accumulator -= ticks * this.dt;
    this.tickCount += ticks;
    this.simSeconds += ticks * this.dt;

    return { ticks, alpha: this.accumulator / this.dt, droppedTicks };
  }

  reset(): void {
    this.accumulator = 0;
    this.tickCount = 0;
    this.simSeconds = 0;
  }
}
