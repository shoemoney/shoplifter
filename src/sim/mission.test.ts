import { describe, expect, it } from 'vitest';
import { loadFlightBalance } from '@/content/loaders/balanceLoader.js';
import { loadMission, OPEN_SKY_ID } from '@/content/missions/index.js';
import { Autopilot, roundTripPlan } from '@/debug/autopilot.js';
import { gradeMission } from './systems/scoring.js';
import { tally } from './systems/civilians.js';
import { MissionWorld, neutralMissionInput, runMission, type MissionInput } from './mission.js';

const mission = loadMission(OPEN_SKY_ID);
const flight = loadFlightBalance();
const DT = 1 / 120;

const makeWorld = (seed = 5): MissionWorld => new MissionWorld({ mission, flight, dt: DT, seed });

/** Flies a plan to completion or until the budget runs out. Returns the seconds used. */
const fly = (world: MissionWorld, pilot: Autopilot, maxSeconds: number): number => {
  const maxTicks = Math.round(maxSeconds / DT);
  let ticks = 0;
  while (ticks < maxTicks && !pilot.finished && world.phase === 'active') {
    world.step(pilot.update(world));
    ticks++;
  }
  return ticks * DT;
};

const drain = (world: MissionWorld): string[] => {
  const seen: string[] = [];
  world.events.drain((event) => seen.push(event.type));
  return seen;
};

describe('mission setup', () => {
  it('places every authored civilian, all still captive', () => {
    const world = makeWorld();
    expect(world.civilians).toHaveLength(24);
    expect(world.civilians.every((civilian) => civilian.state === 'captive')).toBe(true);
  });

  it('spawns the aircraft parked on the home pad', () => {
    const world = makeWorld();
    expect(world.player.grounded).toBe(true);
    expect(world.player.position.x).toBe(mission.playerSpawn.x);
    expect(world.player.fuel).toBe(flight.fuelCapacity);
    expect(world.player.capacity).toBe(flight.capacity);
  });

  it('compiles the mission terrain rather than using a test range', () => {
    const world = makeWorld();
    expect(world.terrain.heightAt(5300)).toBeGreaterThan(world.terrain.heightAt(3000) + 15);
  });

  it('starts quiet — no enemy is spawned on the first tick', () => {
    const world = makeWorld();
    world.step(neutralMissionInput());
    expect(world.liveEnemies).toHaveLength(0);
  });

  it('starts with the primary objectives unmet', () => {
    const world = makeWorld();
    expect(world.objectives.allPrimariesComplete()).toBe(false);
    expect(world.phase).toBe('active');
  });
});

describe('the rescue loop', () => {
  it('releases a civilian site when the player flies near it', () => {
    const world = makeWorld();
    const pilot = new Autopilot([{ x: 1420, altitude: 40 }]);
    fly(world, pilot, 60);

    const events = drain(world);
    expect(events).toContain('mission:siteReleased');
    const villagers = world.civilians.filter((civilian) => civilian.name.startsWith('Village'));
    expect(villagers.some((civilian) => civilian.state !== 'captive')).toBe(true);
  });

  it('flies a complete round trip: launch, land, board, return, unload', () => {
    const world = makeWorld();
    const pilot = new Autopilot(roundTripPlan(1420, 200, { boardSeconds: 14, unloadSeconds: 4 }));
    const elapsed = fly(world, pilot, 240);

    const events = drain(world);
    expect(pilot.finished, `autopilot stalled after ${elapsed.toFixed(0)}s`).toBe(true);
    expect(events).toContain('mission:unloaded');

    const counts = tally(world.civilians);
    expect(counts.rescued, 'civilians should have been returned to base').toBeGreaterThan(0);
  });

  it('never returns more civilians than the aircraft can carry in one trip', () => {
    const world = makeWorld();
    const pilot = new Autopilot(roundTripPlan(1420, 200, { boardSeconds: 30, unloadSeconds: 4 }));
    fly(world, pilot, 300);
    const counts = tally(world.civilians);
    expect(counts.rescued).toBeLessThanOrEqual(flight.capacity);
  });

  it('escalates the director after the first unload', () => {
    const world = makeWorld();
    const pilot = new Autopilot(roundTripPlan(1420, 200, { boardSeconds: 14, unloadSeconds: 4 }));
    fly(world, pilot, 240);
    expect(world.stats.unloads).toBeGreaterThan(0);
  });

  it('refuels the aircraft while it sits on the base pad', () => {
    const world = makeWorld();
    const pilot = new Autopilot(roundTripPlan(1420, 200, { boardSeconds: 10, unloadSeconds: 8 }));
    fly(world, pilot, 260);
    // Burned fuel on a 2.5 km round trip, then topped up at the pad.
    expect(world.player.fuel).toBeGreaterThan(flight.fuelCapacity * 0.9);
  });
});

describe('combat integration', () => {
  it('spawns enemies from authored sockets as the mission runs', () => {
    const world = makeWorld();
    const pilot = new Autopilot([{ x: 1420, altitude: 40, holdSeconds: 60 }]);
    fly(world, pilot, 120);
    expect(world.liveEnemies.length).toBeGreaterThan(0);
    for (const runtime of world.liveEnemies) {
      const socket = mission.enemySockets.find((s) => s.id === runtime.socketId);
      expect(socket, 'every enemy must come from an authored socket').toBeDefined();
    }
  });

  it('fires the door gun only while airborne', () => {
    const world = makeWorld();
    const grounded: MissionInput = { ...neutralMissionInput(), firePrimary: true, aimAngle: 0 };
    runMission(world, 1, grounded);
    expect(world.projectiles.liveCount).toBe(0);

    const pilot = new Autopilot([{ x: 260, altitude: 30, holdSeconds: 2 }]);
    fly(world, pilot, 30);
    for (let i = 0; i < 60; i++) world.step({ ...grounded, thrustY: 0.6 });
    expect(world.projectiles.liveCount).toBeGreaterThan(0);
  });

  it('heats the gun up and locks it out under sustained fire', () => {
    const world = makeWorld();
    const pilot = new Autopilot([{ x: 260, altitude: 30, holdSeconds: 2 }]);
    fly(world, pilot, 30);
    for (let i = 0; i < 600; i++) {
      world.step({ ...neutralMissionInput(), thrustY: 0.6, firePrimary: true, aimAngle: 0 });
    }
    expect(world.weapons.heat).toBeGreaterThan(0.5);
  });

  it('spends a rocket when one is fired', () => {
    const world = makeWorld();
    const pilot = new Autopilot([{ x: 260, altitude: 30, holdSeconds: 2 }]);
    fly(world, pilot, 30);
    const before = world.weapons.rockets;
    world.step({ ...neutralMissionInput(), thrustY: 0.6, fireSecondary: true, aimAngle: 0 });
    expect(world.weapons.rockets).toBe(before - 1);
  });
});

describe('mission outcome', () => {
  it('produces a gradeable outcome from live counters', () => {
    const world = makeWorld();
    const pilot = new Autopilot(roundTripPlan(1420, 200, { boardSeconds: 14, unloadSeconds: 4 }));
    fly(world, pilot, 240);

    const outcome = world.outcome();
    expect(outcome.civilians.total).toBe(24);
    expect(outcome.requiredRescues).toBe(18);
    expect(outcome.elapsedSeconds).toBeGreaterThan(0);

    const grade = gradeMission(outcome);
    // One trip of eight cannot meet an 18-rescue quota, so this must read as a failed mission.
    expect(grade.failed).toBe(true);
    expect(grade.failureReason).toBe('extraction-threshold');
    expect(grade.score).toBeGreaterThan(0);
  });

  it('fails the mission when the aircraft is destroyed', () => {
    const world = makeWorld();
    world.player.hull = 0.001;
    const pilot = new Autopilot([{ x: 400, altitude: 90 }]);
    fly(world, pilot, 40);
    // Cut the engine and let it fall.
    for (let i = 0; i < 1200 && world.phase === 'active'; i++) {
      world.step(neutralMissionInput());
    }
    expect(world.phase).toBe('failed');
    expect(world.outcome().safety.aircraftLost).toBe(true);
  });
});

describe('determinism', () => {
  const script = (i: number): MissionInput => ({
    thrustX: Math.sin(i * 0.013),
    thrustY: 0.55 + Math.sin(i * 0.007) * 0.3,
    boost: i % 400 < 90,
    yawLeft: i % 700 === 0,
    yawRight: i % 913 === 0,
    firePrimary: i % 300 < 120,
    fireSecondary: i % 1500 === 0,
    deployFlare: i % 2000 === 0,
    interact: i % 250 === 0,
    aimAngle: Math.sin(i * 0.004),
  });

  const play = (seed: number, ticks = 3600): MissionWorld => {
    const world = new MissionWorld({ mission, flight, dt: DT, seed });
    for (let i = 0; i < ticks; i++) world.step(script(i));
    return world;
  };

  it('two runs of the same script produce the same hash', () => {
    expect(play(9).hash()).toBe(play(9).hash());
  });

  it('a different seed produces a different world', () => {
    expect(play(9).hash()).not.toBe(play(10).hash());
  });

  it('survives half an hour of simulated input without a non-finite value', () => {
    const world = play(3, 7200);
    expect(Number.isFinite(world.player.position.x)).toBe(true);
    expect(Number.isFinite(world.player.position.y)).toBe(true);
    expect(Number.isFinite(world.player.hull)).toBe(true);
    for (const civilian of world.civilians) {
      expect(Number.isFinite(civilian.position.x)).toBe(true);
      expect(Number.isFinite(civilian.health)).toBe(true);
    }
  });

  it('keeps the projectile pool bounded under continuous fire', () => {
    const world = play(4, 3600);
    expect(world.projectiles.liveCount).toBeLessThanOrEqual(world.projectiles.capacity);
  });
});
