import { clamp, damp, lerp } from '@/core/math.js';

/**
 * Side-view orthographic camera. Every tuning number here answers a documented complaint about
 * later Choplifter entries: the framing was too tight, so attacks had to be memorised rather
 * than seen. Look-ahead and threat-aware zoom exist to make off-screen death unnecessary.
 */
export interface CameraTuning {
  /** Visible world width at rest, metres. */
  baseWorldWidth: number;
  /** Fraction of the viewport the camera leads the player by at top speed. */
  lookAheadFraction: number;
  /** Player's resting screen height, 0 = bottom, 1 = top. */
  verticalBias: number;
  /** Extra width fraction when fast or threatened. */
  maxZoomOut: number;
  /** Speed treated as "fast" for look-ahead and zoom, m/s. */
  referenceSpeed: number;
  /** Fraction of error left after one second. Lower = snappier. */
  positionSmoothing: number;
  zoomSmoothing: number;
}

export const defaultCameraTuning = (): CameraTuning => ({
  baseWorldWidth: 60,
  lookAheadFraction: 0.28,
  verticalBias: 0.6,
  maxZoomOut: 0.12,
  referenceSpeed: 42,
  positionSmoothing: 0.0008,
  zoomSmoothing: 0.02,
});

export interface CameraTarget {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  /** 0 = calm, 1 = multi-threat or missile pursuit. Drives zoom-out. */
  threat?: number;
}

export interface WorldBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface CameraView {
  centerX: number;
  centerY: number;
  halfWidth: number;
  halfHeight: number;
}

export class Camera {
  tuning: CameraTuning;
  bounds: WorldBounds | null = null;

  private centerX = 0;
  private centerY = 0;
  private worldWidth: number;
  private aspect = 16 / 9;
  private shake = 0;

  constructor(tuning: CameraTuning = defaultCameraTuning()) {
    this.tuning = tuning;
    this.worldWidth = tuning.baseWorldWidth;
  }

  setAspect(aspect: number): void {
    this.aspect = aspect > 0 ? aspect : 16 / 9;
  }

  get halfWidth(): number {
    return this.worldWidth / 2;
  }

  get halfHeight(): number {
    return this.worldWidth / this.aspect / 2;
  }

  /** Snaps directly to the framing for `target`, skipping smoothing. Used on mission start. */
  snapTo(target: CameraTarget): void {
    this.worldWidth = this.desiredWidth(target);
    const desired = this.desiredCenter(target);
    this.centerX = desired.x;
    this.centerY = desired.y;
    this.clampToBounds();
  }

  update(target: CameraTarget, dt: number): void {
    this.worldWidth = damp(
      this.worldWidth,
      this.desiredWidth(target),
      this.tuning.zoomSmoothing,
      dt,
    );
    const desired = this.desiredCenter(target);
    this.centerX = damp(this.centerX, desired.x, this.tuning.positionSmoothing, dt);
    this.centerY = damp(this.centerY, desired.y, this.tuning.positionSmoothing, dt);
    this.clampToBounds();
  }

  /** Layered, capped shake. Accessibility settings scale this at the call site. */
  addShake(amount: number): void {
    this.shake = clamp(this.shake + amount, 0, 1);
  }

  decayShake(dt: number): void {
    this.shake = damp(this.shake, 0, 0.0001, dt);
  }

  get shakeAmount(): number {
    return this.shake;
  }

  view(): CameraView {
    return {
      centerX: this.centerX,
      centerY: this.centerY,
      halfWidth: this.halfWidth,
      halfHeight: this.halfHeight,
    };
  }

  /** True when a world-space circle touches the view; callers cull with this. */
  isVisible(x: number, y: number, radius: number, margin = 0): boolean {
    return (
      Math.abs(x - this.centerX) <= this.halfWidth + radius + margin &&
      Math.abs(y - this.centerY) <= this.halfHeight + radius + margin
    );
  }

  private desiredWidth(target: CameraTarget): number {
    const speed = Math.hypot(target.velocityX, target.velocityY);
    const speedFactor = clamp(speed / this.tuning.referenceSpeed, 0, 1);
    const threat = clamp(target.threat ?? 0, 0, 1);
    const zoom = 1 + this.tuning.maxZoomOut * Math.max(speedFactor, threat);
    return this.tuning.baseWorldWidth * zoom;
  }

  private desiredCenter(target: CameraTarget): { x: number; y: number } {
    const lead = clamp(target.velocityX / this.tuning.referenceSpeed, -1, 1);
    const leadX = lead * this.tuning.lookAheadFraction * this.halfWidth * 2;
    // verticalBias 0.6 means the aircraft sits above centre, so the ground stays visible.
    const biasY = lerp(this.halfHeight, -this.halfHeight, this.tuning.verticalBias);
    return { x: target.x + leadX, y: target.y + biasY };
  }

  private clampToBounds(): void {
    const bounds = this.bounds;
    if (!bounds) return;
    const halfW = this.halfWidth;
    const halfH = this.halfHeight;
    // A map narrower than the viewport should centre, not jitter between two clamps.
    this.centerX =
      bounds.maxX - bounds.minX <= halfW * 2
        ? (bounds.minX + bounds.maxX) / 2
        : clamp(this.centerX, bounds.minX + halfW, bounds.maxX - halfW);
    this.centerY =
      bounds.maxY - bounds.minY <= halfH * 2
        ? (bounds.minY + bounds.maxY) / 2
        : clamp(this.centerY, bounds.minY + halfH, bounds.maxY - halfH);
  }
}
