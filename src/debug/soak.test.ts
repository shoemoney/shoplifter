import { describe, expect, it } from 'vitest';
import { loadFlightBalance } from '@/content/loaders/balanceLoader.js';
import { loadMission, OPEN_SKY_ID } from '@/content/missions/index.js';
import { MissionWorld } from '@/sim/mission.js';
import { runSoak, soakInput } from './soak.js';

const mission = loadMission(OPEN_SKY_ID);
const flight = loadFlightBalance();
const DT = 1 / 120;

const world = (seed = 31): MissionWorld => new MissionWorld({ mission, flight, dt: DT, seed });

describe('soak harness', () => {
  // Ten simulated minutes under a constant workout. The PRD asks for an hour; ten minutes runs
  // in well under a second headless and catches unbounded growth just as well, because a leak
  // that is flat over 600 seconds is not a leak.
  const report = runSoak(world(), { seconds: 600, sampleEvery: 30 });

  it('samples the whole run', () => {
    expect(report.samples).toHaveLength(20);
    expect(report.simulatedSeconds).toBeCloseTo(600, 0);
  });

  it('runs far faster than real time, so a one-hour soak is practical in CI', () => {
    expect(report.speedFactor).toBeGreaterThan(20);
  });

  it('never produces a non-finite value', () => {
    expect(report.nonFiniteFound).toBe(false);
  });

  it('keeps the projectile pool bounded', () => {
    expect(report.peak.projectiles).toBeLessThanOrEqual(512);
    // Sustained fire for ten minutes must not leave the pool permanently fuller than it began.
    expect(Math.abs(report.drift.projectiles)).toBeLessThan(200);
  });

  it('keeps live enemies inside the director budget rather than piling up', () => {
    expect(report.peak.enemies).toBeLessThanOrEqual(12);
    expect(report.drift.enemies).toBeLessThanOrEqual(6);
  });

  it('leaves no events queued once the frame drains them', () => {
    expect(report.peak.events).toBe(0);
    expect(report.drift.events).toBe(0);
  });

  it('does not slow down as it runs — no quadratic growth in the step cost', () => {
    const early = report.samples.slice(0, 4).reduce((sum, s) => sum + s.simMs, 0) / 4;
    const late = report.samples.slice(-4).reduce((sum, s) => sum + s.simMs, 0) / 4;
    // A system that scans an ever-growing list shows up here as a rising per-sample cost.
    expect(late).toBeLessThan(Math.max(early * 4, early + 40));
  });

  it('is deterministic — the same seed soaks identically', () => {
    const a = runSoak(world(7), { seconds: 60, sampleEvery: 20 });
    const b = runSoak(world(7), { seconds: 60, sampleEvery: 20 });
    expect(a.samples.map((s) => s.liveProjectiles)).toEqual(
      b.samples.map((s) => s.liveProjectiles),
    );
    expect(a.peak).toEqual(b.peak);
  });

  it('exposes a repeatable workout rather than idle input', () => {
    // Idle input would soak nothing: the pools would never fill and the test would prove little.
    expect(soakInput(0)).toEqual(soakInput(0));
    const busy = Array.from({ length: 500 }, (_, i) => soakInput(i)).filter((i) => i.firePrimary);
    expect(busy.length).toBeGreaterThan(100);
  });
});
