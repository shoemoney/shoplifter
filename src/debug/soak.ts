import type { MissionWorld, MissionInput } from '@/sim/mission.js';
import { tally } from '@/sim/systems/civilians.js';

/**
 * Headless soak harness. The PRD asks for a one-hour run with no growth in GPU buffers or the
 * JS heap; this covers the simulation half of that, which is where unbounded growth actually
 * comes from — a pool that never releases, an entity list that only ever appends, an event
 * queue nobody drains.
 *
 * It samples counts over time rather than measuring memory, because a count that grows without
 * bound IS the leak, and a count is comparable across machines while heap size is not.
 */
export interface SoakSample {
  tick: number;
  seconds: number;
  liveProjectiles: number;
  liveEnemies: number;
  /** Civilians not yet resolved one way or the other. */
  unresolvedCivilians: number;
  pendingEvents: number;
  /** Wall-clock milliseconds spent simulating since the previous sample. */
  simMs: number;
}

export interface SoakReport {
  samples: SoakSample[];
  totalTicks: number;
  simulatedSeconds: number;
  wallClockMs: number;
  /** Simulated seconds per wall-clock second. Above 1 means faster than real time. */
  speedFactor: number;
  peak: { projectiles: number; enemies: number; events: number };
  /** Difference between the last and first sample, for each tracked count. */
  drift: { projectiles: number; enemies: number; events: number };
  nonFiniteFound: boolean;
}

export interface SoakOptions {
  /** Simulated seconds to run. */
  seconds: number;
  /** Simulated seconds between samples. */
  sampleEvery?: number;
  /** Produces the input for a tick. Defaults to a deterministic workout. */
  input?: (tick: number) => MissionInput;
  now?: () => number;
}

/**
 * A deterministic workout that keeps every subsystem busy: constantly manoeuvring, firing,
 * yawing and interacting. Idle input would soak nothing — the pools would never fill.
 */
export const soakInput = (tick: number): MissionInput => ({
  thrustX: Math.sin(tick * 0.009),
  thrustY: 0.55 + Math.sin(tick * 0.004) * 0.35,
  boost: tick % 420 < 70,
  yawLeft: tick % 530 === 0,
  yawRight: tick % 737 === 0,
  firePrimary: tick % 260 < 130,
  fireSecondary: tick % 900 === 0,
  deployFlare: tick % 1500 === 0,
  interact: tick % 200 === 0,
  aimAngle: Math.sin(tick * 0.002) * Math.PI,
});

const isNonFinite = (world: MissionWorld): boolean => {
  const p = world.player;
  if (
    !Number.isFinite(p.position.x) ||
    !Number.isFinite(p.position.y) ||
    !Number.isFinite(p.velocity.x) ||
    !Number.isFinite(p.velocity.y) ||
    !Number.isFinite(p.hull) ||
    !Number.isFinite(p.fuel)
  ) {
    return true;
  }
  for (const civilian of world.civilians) {
    if (!Number.isFinite(civilian.position.x) || !Number.isFinite(civilian.health)) return true;
  }
  return false;
};

export const runSoak = (world: MissionWorld, options: SoakOptions): SoakReport => {
  const now = options.now ?? (() => performance.now());
  const input = options.input ?? soakInput;
  const totalTicks = Math.round(options.seconds / world.dt);
  const sampleTicks = Math.max(1, Math.round((options.sampleEvery ?? 30) / world.dt));

  const samples: SoakSample[] = [];
  const startedAt = now();
  let sampleStart = startedAt;
  let nonFiniteFound = false;

  for (let tick = 0; tick < totalTicks; tick++) {
    world.step(input(tick));
    // The presentation layer normally drains this every frame; a soak that never drains would
    // show growth that is an artefact of the harness rather than a real leak.
    world.events.drain();

    if ((tick + 1) % sampleTicks !== 0) continue;
    const at = now();
    const counts = tally(world.civilians);
    samples.push({
      tick: tick + 1,
      seconds: (tick + 1) * world.dt,
      liveProjectiles: world.projectiles.liveCount,
      liveEnemies: world.liveEnemies.length,
      unresolvedCivilians: counts.total - counts.rescued - counts.dead,
      pendingEvents: world.events.size,
      simMs: at - sampleStart,
    });
    sampleStart = at;
    if (!nonFiniteFound && isNonFinite(world)) nonFiniteFound = true;
  }

  const wallClockMs = now() - startedAt;
  const first = samples[0];
  const last = samples[samples.length - 1];

  return {
    samples,
    totalTicks,
    simulatedSeconds: totalTicks * world.dt,
    wallClockMs,
    speedFactor: wallClockMs > 0 ? (totalTicks * world.dt) / (wallClockMs / 1000) : Infinity,
    peak: {
      projectiles: samples.reduce((max, s) => Math.max(max, s.liveProjectiles), 0),
      enemies: samples.reduce((max, s) => Math.max(max, s.liveEnemies), 0),
      events: samples.reduce((max, s) => Math.max(max, s.pendingEvents), 0),
    },
    drift: {
      projectiles: (last?.liveProjectiles ?? 0) - (first?.liveProjectiles ?? 0),
      enemies: (last?.liveEnemies ?? 0) - (first?.liveEnemies ?? 0),
      events: (last?.pendingEvents ?? 0) - (first?.pendingEvents ?? 0),
    },
    nonFiniteFound,
  };
};

export const formatSoakReport = (report: SoakReport): string =>
  [
    `soak: ${report.simulatedSeconds.toFixed(0)}s simulated in ${(report.wallClockMs / 1000).toFixed(1)}s wall (${report.speedFactor.toFixed(0)}x real time)`,
    `peak  projectiles=${report.peak.projectiles} enemies=${report.peak.enemies} events=${report.peak.events}`,
    `drift projectiles=${report.drift.projectiles} enemies=${report.drift.enemies} events=${report.drift.events}`,
    `non-finite values: ${report.nonFiniteFound ? 'YES' : 'none'}`,
  ].join('\n');
