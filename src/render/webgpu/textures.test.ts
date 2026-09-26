import { describe, expect, it } from 'vitest';
import { placeholderPixels, regionToUv } from './textures.js';

describe('regionToUv', () => {
  it('maps a region to normalized coordinates with a half-texel inset', () => {
    const uv = regionToUv({ x: 0, y: 0, width: 32, height: 32 }, 128, 128);
    expect(uv.u0).toBeCloseTo(0.5 / 128, 6);
    expect(uv.u1).toBeCloseTo(31.5 / 128, 6);
  });

  it('insets to stop a neighbouring sprite bleeding in', () => {
    const tight = regionToUv({ x: 64, y: 0, width: 32, height: 24 }, 128, 128, 0);
    const inset = regionToUv({ x: 64, y: 0, width: 32, height: 24 }, 128, 128, 0.5);
    expect(inset.u0).toBeGreaterThan(tight.u0);
    expect(inset.u1).toBeLessThan(tight.u1);
  });

  it('keeps every coordinate inside [0, 1]', () => {
    const uv = regionToUv({ x: 96, y: 96, width: 32, height: 32 }, 128, 128);
    for (const value of [uv.u0, uv.v0, uv.u1, uv.v1]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('placeholderPixels', () => {
  it('produces an opaque RGBA buffer of the requested size', () => {
    const size = 32;
    const pixels = placeholderPixels(size);
    expect(pixels).toHaveLength(size * size * 4);
    for (let i = 3; i < pixels.length; i += 4) expect(pixels[i]).toBe(255);
  });

  it('is visibly wrong rather than invisible', () => {
    const pixels = placeholderPixels(16);
    // Magenta somewhere: a missing asset must read as an error, not as a working empty sprite.
    let magenta = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] === 255 && pixels[i + 1] === 0 && pixels[i + 2] === 255) magenta++;
    }
    expect(magenta).toBeGreaterThan(0);
  });
});
