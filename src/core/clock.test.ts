import { describe, expect, it } from 'vitest';
import { FixedClock } from './clock.js';

const clock = (overrides: Partial<{ tickHz: number; maxTicksPerFrame: number }> = {}): FixedClock =>
  new FixedClock({ tickHz: 120, maxTicksPerFrame: 8, ...overrides });

describe('FixedClock', () => {
  it('rejects nonsense configuration', () => {
    expect(() => new FixedClock({ tickHz: 0, maxTicksPerFrame: 8 })).toThrow();
    expect(() => new FixedClock({ tickHz: 120, maxTicksPerFrame: 0 })).toThrow();
  });

  it('runs exactly two 120 Hz ticks for a 60 FPS frame', () => {
    const step = clock().advance(1 / 60);
    expect(step.ticks).toBe(2);
    expect(step.droppedTicks).toBe(0);
    expect(step.alpha).toBeLessThan(1e-9);
  });

  it('carries the remainder across frames instead of losing it', () => {
    const c = clock();
    // 144 Hz frames do not divide evenly into 120 Hz ticks. Over 10 s the carried remainder
    // must keep the tick count within one tick of exact — that is the no-drift guarantee.
    let ticks = 0;
    for (let i = 0; i < 1440; i++) ticks += c.advance(1 / 144).ticks;
    expect(Math.abs(ticks - 1200)).toBeLessThanOrEqual(1);
    expect(c.pendingSeconds).toBeLessThan(c.dt);
    expect(Math.abs(c.elapsed - 10)).toBeLessThanOrEqual(c.dt);
  });

  it('reports alpha between the previous and current tick', () => {
    const c = clock();
    const step = c.advance(1 / 120 + 1 / 240);
    expect(step.ticks).toBe(1);
    expect(step.alpha).toBeCloseTo(0.5, 6);
  });

  it('accumulates identical sim time regardless of frame pacing', () => {
    const steady = clock();
    const jittery = clock();
    for (let i = 0; i < 600; i++) steady.advance(1 / 60);
    // Same 10 s of wall time, delivered unevenly.
    const jitter = [1 / 30, 1 / 120, 1 / 90, 1 / 45];
    let delivered = 0;
    let i = 0;
    while (delivered < 10) {
      const dt = jitter[i % jitter.length] as number;
      jittery.advance(dt);
      delivered += dt;
      i++;
    }
    expect(jittery.tick).toBeGreaterThanOrEqual(steady.tick - 1);
  });

  it('drops ticks past the per-frame cap so a stall cannot spiral', () => {
    const c = clock({ maxTicksPerFrame: 4 });
    const step = c.advance(1); // a one-second stall = 120 pending ticks
    expect(step.ticks).toBe(4);
    expect(step.droppedTicks).toBe(116);
    expect(c.pendingSeconds).toBeLessThan(c.dt);
  });

  it('ignores negative and non-finite frame times', () => {
    const c = clock();
    expect(c.advance(-1).ticks).toBe(0);
    expect(c.advance(Number.NaN).ticks).toBe(0);
    expect(c.tick).toBe(0);
  });

  it('resets to a clean state', () => {
    const c = clock();
    c.advance(0.5);
    c.reset();
    expect(c.tick).toBe(0);
    expect(c.elapsed).toBe(0);
    expect(c.pendingSeconds).toBe(0);
  });
});
