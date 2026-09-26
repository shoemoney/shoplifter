import { clamp, radToDeg } from '@/core/math.js';

/**
 * Ground the helicopter can land on. Sampled rather than collided: a side-scrolling heightfield
 * is enough for skid contact and slope tolerance, and it keeps landing deterministic — a
 * general physics solver would not reproduce the same touchdown twice.
 */
export interface Terrain {
  readonly minX: number;
  readonly maxX: number;
  heightAt(x: number): number;
  /** Ground angle in radians; positive means rising to the right. */
  slopeAt(x: number): number;
  slopeDegreesAt(x: number): number;
}

export interface HeightfieldOptions {
  /** Ground height samples, metres, evenly spaced. */
  samples: readonly number[] | Float32Array;
  originX: number;
  /** Metres between samples. */
  spacing: number;
}

export class Heightfield implements Terrain {
  private readonly samples: Float32Array;
  readonly originX: number;
  readonly spacing: number;

  constructor(options: HeightfieldOptions) {
    if (options.spacing <= 0) throw new Error('Heightfield: spacing must be positive');
    if (options.samples.length < 2) throw new Error('Heightfield: need at least two samples');
    this.samples = Float32Array.from(options.samples);
    this.originX = options.originX;
    this.spacing = options.spacing;
  }

  get minX(): number {
    return this.originX;
  }

  get maxX(): number {
    return this.originX + (this.samples.length - 1) * this.spacing;
  }

  /** Linear interpolation between samples; clamps past the ends rather than extrapolating. */
  heightAt(x: number): number {
    const position = (x - this.originX) / this.spacing;
    if (position <= 0) return this.samples[0] as number;
    const last = this.samples.length - 1;
    if (position >= last) return this.samples[last] as number;
    const index = Math.floor(position);
    const t = position - index;
    const a = this.samples[index] as number;
    const b = this.samples[index + 1] as number;
    return a + (b - a) * t;
  }

  /**
   * Central difference over one sample spacing. Sampling closer than the spacing would just
   * re-read the same linear segment and report the segment slope as if it were exact.
   */
  slopeAt(x: number): number {
    const half = this.spacing * 0.5;
    const left = this.heightAt(clamp(x - half, this.minX, this.maxX));
    const right = this.heightAt(clamp(x + half, this.minX, this.maxX));
    return Math.atan2(right - left, half * 2);
  }

  slopeDegreesAt(x: number): number {
    return radToDeg(this.slopeAt(x));
  }
}

/** Flat ground. Used by tests that care about landing rules rather than terrain. */
export class FlatTerrain implements Terrain {
  constructor(
    readonly height = 0,
    readonly minX = -Infinity,
    readonly maxX = Infinity,
  ) {}

  heightAt(): number {
    return this.height;
  }

  slopeAt(): number {
    return 0;
  }

  slopeDegreesAt(): number {
    return 0;
  }
}

export interface TestRangeOptions {
  spacing?: number;
  length?: number;
}

/**
 * The Milestone 1 test range: a flat home pad, a landable 5-degree ramp, an unlandable
 * 12-degree ramp, and rolling ground. Every landing tolerance in the PRD has somewhere to be
 * tested by hand, not only in unit tests.
 */
export const createTestRange = ({
  spacing = 8,
  length = 2400,
}: TestRangeOptions = {}): Heightfield => {
  const count = Math.ceil(length / spacing) + 1;
  const samples = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const x = i * spacing;
    let height = 0;
    if (x < 220) {
      height = 0; // home pad, dead flat
    } else if (x < 420) {
      height = (x - 220) * Math.tan((5 * Math.PI) / 180); // 5 degrees: inside tolerance
    } else if (x < 640) {
      height = 200 * Math.tan((5 * Math.PI) / 180);
    } else if (x < 860) {
      height = 200 * Math.tan((5 * Math.PI) / 180) + (x - 640) * Math.tan((12 * Math.PI) / 180); // 12 degrees: refused
    } else {
      const base = 200 * Math.tan((5 * Math.PI) / 180) + 220 * Math.tan((12 * Math.PI) / 180);
      // Deterministic rolling ground — no RNG, so the range is identical every run.
      height =
        base +
        Math.sin((x - 860) * 0.012) * 6 +
        Math.sin((x - 860) * 0.031) * 2.5 -
        (x - 860) * 0.02;
    }
    samples[i] = height;
  }

  return new Heightfield({ samples, originX: 0, spacing });
};
