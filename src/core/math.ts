export interface Vec2 {
  x: number;
  y: number;
}

export const vec2 = (x = 0, y = 0): Vec2 => ({ x, y });

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const inverseLerp = (a: number, b: number, value: number): number =>
  a === b ? 0 : (value - a) / (b - a);

/** Frame-rate independent exponential approach. `smoothing` is the fraction left after 1s. */
export const damp = (current: number, target: number, smoothing: number, dt: number): number =>
  target + (current - target) * Math.pow(smoothing, dt);

export const moveToward = (current: number, target: number, maxDelta: number): number => {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
};

export const approxEqual = (a: number, b: number, epsilon = 1e-6): boolean =>
  Math.abs(a - b) <= epsilon;

export const degToRad = (deg: number): number => (deg * Math.PI) / 180;
export const radToDeg = (rad: number): number => (rad * 180) / Math.PI;

export const length2 = (v: Vec2): number => v.x * v.x + v.y * v.y;
export const length = (v: Vec2): number => Math.sqrt(length2(v));

export const addInPlace = (target: Vec2, v: Vec2, scale = 1): Vec2 => {
  target.x += v.x * scale;
  target.y += v.y * scale;
  return target;
};

export const copyInto = (target: Vec2, source: Vec2): Vec2 => {
  target.x = source.x;
  target.y = source.y;
  return target;
};

export const lerpVec2 = (out: Vec2, a: Vec2, b: Vec2, t: number): Vec2 => {
  out.x = lerp(a.x, b.x, t);
  out.y = lerp(a.y, b.y, t);
  return out;
};

/**
 * FNV-1a over 32-bit chunks. Used to hash simulation state for replay verification,
 * so it must stay stable — do not "improve" the constants.
 */
export class Hash32 {
  private value = 0x811c9dc5;

  writeUint32(n: number): this {
    let v = n >>> 0;
    for (let byte = 0; byte < 4; byte++) {
      this.value = Math.imul(this.value ^ (v & 0xff), 0x01000193) >>> 0;
      v >>>= 8;
    }
    return this;
  }

  /** Quantizes to 1e-4 so float jitter below simulation significance does not change the hash. */
  writeFloat(n: number): this {
    return this.writeUint32(Math.round(n * 10000) | 0);
  }

  writeBool(b: boolean): this {
    return this.writeUint32(b ? 1 : 0);
  }

  digest(): number {
    return this.value >>> 0;
  }

  hex(): string {
    return this.digest().toString(16).padStart(8, '0');
  }
}
