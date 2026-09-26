import { describe, expect, it } from 'vitest';
import { FlatTerrain, Heightfield, createTestRange } from './terrain.js';

describe('Heightfield', () => {
  const field = new Heightfield({ samples: [0, 10, 10, 0], originX: 0, spacing: 10 });

  it('rejects unusable configuration', () => {
    expect(() => new Heightfield({ samples: [0], originX: 0, spacing: 10 })).toThrow();
    expect(() => new Heightfield({ samples: [0, 1], originX: 0, spacing: 0 })).toThrow();
  });

  it('returns the sample values at the sample points', () => {
    expect(field.heightAt(0)).toBe(0);
    expect(field.heightAt(10)).toBe(10);
    expect(field.heightAt(30)).toBe(0);
  });

  it('interpolates linearly between samples', () => {
    expect(field.heightAt(5)).toBeCloseTo(5, 6);
    expect(field.heightAt(15)).toBeCloseTo(10, 6);
  });

  it('clamps past the ends instead of extrapolating into the sky', () => {
    expect(field.heightAt(-500)).toBe(0);
    expect(field.heightAt(5000)).toBe(0);
  });

  it('reports its extent', () => {
    expect(field.minX).toBe(0);
    expect(field.maxX).toBe(30);
  });

  it('measures slope with the right sign', () => {
    expect(field.slopeDegreesAt(5)).toBeCloseTo(45, 0);
    expect(field.slopeDegreesAt(25)).toBeCloseTo(-45, 0);
    expect(field.slopeDegreesAt(15)).toBeCloseTo(0, 6);
  });
});

describe('FlatTerrain', () => {
  it('is flat everywhere', () => {
    const flat = new FlatTerrain(7);
    expect(flat.heightAt()).toBe(7);
    expect(flat.slopeAt()).toBe(0);
    expect(flat.slopeDegreesAt()).toBe(0);
  });
});

describe('createTestRange', () => {
  const range = createTestRange();

  it('starts with a dead-flat home pad', () => {
    expect(range.heightAt(0)).toBe(0);
    expect(range.heightAt(120)).toBe(0);
    expect(Math.abs(range.slopeDegreesAt(100))).toBeLessThan(0.01);
  });

  it('includes a landable 5-degree ramp', () => {
    expect(range.slopeDegreesAt(320)).toBeGreaterThan(4);
    expect(range.slopeDegreesAt(320)).toBeLessThan(7);
  });

  it('includes an unlandable 12-degree ramp', () => {
    expect(range.slopeDegreesAt(750)).toBeGreaterThan(7);
  });

  it('is identical on every build — no RNG in the terrain', () => {
    const a = createTestRange();
    const b = createTestRange();
    for (const x of [0, 137, 512, 901, 1600, 2399]) {
      expect(a.heightAt(x)).toBe(b.heightAt(x));
    }
  });

  it('covers the requested length', () => {
    expect(range.maxX).toBeGreaterThanOrEqual(2400);
  });
});
