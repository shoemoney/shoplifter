import { describe, expect, it } from 'vitest';
import { Rng } from './rng.js';

describe('Rng', () => {
  it('is reproducible for a seed', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    const left = Array.from({ length: 64 }, () => a.next());
    const right = Array.from({ length: 64 }, () => b.next());
    expect(left).toEqual(right);
  });

  it('diverges for neighbouring seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('stays in [0, 1)', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 20000; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('round-trips state so a replay can resume mid-mission', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 50; i++) rng.next();
    const snapshot = rng.getState();
    const expected = Array.from({ length: 20 }, () => rng.next());

    const resumed = new Rng(0);
    resumed.setState(snapshot);
    expect(Array.from({ length: 20 }, () => resumed.next())).toEqual(expected);
  });

  it('clones without sharing state', () => {
    const rng = new Rng(4242);
    const clone = rng.clone();
    expect(clone.next()).toBe(rng.next());
    clone.next();
    expect(clone.next()).not.toBe(rng.next());
  });

  it('produces integers within the inclusive range', () => {
    const rng = new Rng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const value = rng.int(3, 7);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
      seen.add(value);
    }
    expect(seen.size).toBe(5);
  });

  it('shuffles deterministically and keeps every element', () => {
    const source = Array.from({ length: 24 }, (_, i) => i);
    const a = new Rng(88).shuffle([...source]);
    const b = new Rng(88).shuffle([...source]);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual(source);
  });

  it('distributes bool() near the requested chance', () => {
    const rng = new Rng(555);
    let hits = 0;
    const trials = 40000;
    for (let i = 0; i < trials; i++) if (rng.bool(0.25)) hits++;
    expect(hits / trials).toBeCloseTo(0.25, 2);
  });

  it('throws rather than returning undefined from an empty pick', () => {
    expect(() => new Rng(1).pick([])).toThrow();
  });
});
