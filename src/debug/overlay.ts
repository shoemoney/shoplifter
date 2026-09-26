/**
 * Frame-time ring buffer + DOM overlay. Percentiles matter more than an average here: the PRD
 * budget is a *stable* 60 FPS, and a 3 ms mean with a 40 ms p99 is a stutter the average hides.
 */
export class FrameTimeline {
  private readonly samples: Float32Array;
  private index = 0;
  private filled = 0;

  constructor(capacity = 240) {
    this.samples = new Float32Array(capacity);
  }

  push(milliseconds: number): void {
    this.samples[this.index] = milliseconds;
    this.index = (this.index + 1) % this.samples.length;
    if (this.filled < this.samples.length) this.filled++;
  }

  get count(): number {
    return this.filled;
  }

  mean(): number {
    if (this.filled === 0) return 0;
    let total = 0;
    for (let i = 0; i < this.filled; i++) total += this.samples[i] as number;
    return total / this.filled;
  }

  /** `q` in [0, 1]. Sorts a copy; called at overlay refresh rate, not per frame. */
  percentile(q: number): number {
    if (this.filled === 0) return 0;
    const copy = Array.from(this.samples.subarray(0, this.filled)).sort((a, b) => a - b);
    const rank = Math.min(copy.length - 1, Math.max(0, Math.round(q * (copy.length - 1))));
    return copy[rank] as number;
  }

  fps(): number {
    const mean = this.mean();
    return mean > 0 ? 1000 / mean : 0;
  }
}

export interface OverlayMetrics {
  frame: FrameTimeline;
  simMs: number;
  renderPrepMs: number;
  tick: number;
  droppedTicks: number;
  sprites: number;
  draws: number;
  resolution: string;
  devicePixelRatio: number;
  adapter: string;
  recoveryPhase: string;
  recoveryAttempts: number;
  gamepad: string;
  placeholderAssets: boolean;
  thrust: { x: number; y: number };
}

export class DebugOverlay {
  private readonly element: HTMLElement;
  private visible = false;
  private lastPaint = 0;
  private readonly detach: () => void;

  constructor(element: HTMLElement) {
    this.element = element;
    const onKey = (event: KeyboardEvent): void => {
      // Backquote is out of the way of every gameplay binding.
      if (event.code === 'Backquote') this.toggle();
    };
    window.addEventListener('keydown', onKey);
    this.detach = () => window.removeEventListener('keydown', onKey);
  }

  toggle(force?: boolean): void {
    this.visible = force ?? !this.visible;
    this.element.hidden = !this.visible;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Repaints at 8 Hz; a per-frame DOM write would itself show up in the numbers. */
  update(metrics: OverlayMetrics, nowMs: number): void {
    if (!this.visible || nowMs - this.lastPaint < 125) return;
    this.lastPaint = nowMs;

    const frame = metrics.frame;
    const rows: Array<[string, string]> = [
      ['fps', `${frame.fps().toFixed(1)} (${frame.mean().toFixed(2)} ms)`],
      [
        'frame p95 / p99',
        `${frame.percentile(0.95).toFixed(2)} / ${frame.percentile(0.99).toFixed(2)} ms`,
      ],
      ['sim / prep', `${metrics.simMs.toFixed(2)} / ${metrics.renderPrepMs.toFixed(2)} ms`],
      [
        'tick',
        `${metrics.tick}${metrics.droppedTicks > 0 ? ` (dropped ${metrics.droppedTicks})` : ''}`,
      ],
      ['sprites / draws', `${metrics.sprites} / ${metrics.draws}`],
      ['resolution', `${metrics.resolution} @ ${metrics.devicePixelRatio.toFixed(2)}x`],
      ['adapter', metrics.adapter],
      [
        'device',
        `${metrics.recoveryPhase}${metrics.recoveryAttempts > 0 ? ` (retries ${metrics.recoveryAttempts})` : ''}`,
      ],
      ['gamepad', metrics.gamepad],
      ['thrust', `${metrics.thrust.x.toFixed(2)}, ${metrics.thrust.y.toFixed(2)}`],
    ];
    if (metrics.placeholderAssets) rows.push(['assets', 'PLACEHOLDER — atlas failed to load']);

    this.element.textContent = rows.map(([key, value]) => `${key.padEnd(17)}${value}`).join('\n');
  }

  dispose(): void {
    this.detach();
  }
}
