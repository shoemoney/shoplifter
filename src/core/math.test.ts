import { describe, expect, it } from 'vitest';
import {
  Hash32,
  approxEqual,
  clamp,
  damp,
  inverseLerp,
  lerp,
  lerpVec2,
  moveToward,
  vec2,
} from './math.js';

describe('math helpers', () => {
  it('clamps both ends', () => {
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it('lerps and inverse-lerps consistently', () => {
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    expect(inverseLerp(10, 20, 12.5)).toBe(0.25);
    expect(inverseLerp(5, 5, 5)).toBe(0);
  });

  it('damps frame-rate independently', () => {
    // 120 small steps must land in the same place as 60 larger ones.
    let fast = 0;
    for (let i = 0; i < 120; i++) fast = damp(fast, 1, 0.01, 1 / 120);
    let slow = 0;
    for (let i = 0; i < 60; i++) slow = damp(slow, 1, 0.01, 1 / 60);
    expect(approxEqual(fast, slow, 1e-9)).toBe(true);
  });

  it('moves toward a target without overshooting', () => {
    expect(moveToward(0, 1, 0.25)).toBe(0.25);
    expect(moveToward(0.9, 1, 0.25)).toBe(1);
    expect(moveToward(1, 0, 0.25)).toBe(0.75);
  });

  it('interpolates vectors into an output object without allocating', () => {
    const out = vec2();
    const result = lerpVec2(out, vec2(0, 0), vec2(10, -10), 0.5);
    expect(result).toBe(out);
    expect(out).toEqual({ x: 5, y: -5 });
  });
});

describe('Hash32', () => {
  it('is stable for identical input', () => {
    const a = new Hash32().writeFloat(1.5).writeUint32(7).writeBool(true);
    const b = new Hash32().writeFloat(1.5).writeUint32(7).writeBool(true);
    expect(a.hex()).toBe(b.hex());
  });

  it('changes when input changes', () => {
    const a = new Hash32().writeFloat(1.5).digest();
    const b = new Hash32().writeFloat(1.5001).digest();
    expect(a).not.toBe(b);
  });

  it('ignores float noise below simulation significance', () => {
    const a = new Hash32().writeFloat(1.500001).digest();
    const b = new Hash32().writeFloat(1.5000012).digest();
    expect(a).toBe(b);
  });

  it('renders 8 hex digits', () => {
    expect(new Hash32().writeUint32(0).hex()).toMatch(/^[0-9a-f]{8}$/);
  });
});
