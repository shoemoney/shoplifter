import { describe, expect, it } from 'vitest';
import { loadFlightBalance } from '@/content/loaders/balanceLoader.js';
import { neutralInput, type FlightInput } from './components.js';
import { FlatTerrain, createTestRange } from './terrain.js';
import { World, runFor } from './world.js';

const balance = loadFlightBalance();
const DT = 1 / 120;

const makeWorld = (seed = 1): World =>
  new World({ balance, terrain: new FlatTerrain(0), dt: DT, seed, spawn: { x: 40 } });

const collect = (world: World): string[] => {
  const seen: string[] = [];
  world.events.drain((event) => seen.push(event.type));
  return seen;
};

describe('World', () => {
  it('spawns grounded on the pad, not falling onto it', () => {
    const world = makeWorld();
    expect(world.player.grounded).toBe(true);
    expect(world.player.landingContactCount).toBe(2);
    expect(world.player.position.y).toBeCloseTo(balance.landing.skidDrop, 6);
  });

  it('starts with the configured capacity and a full tank', () => {
    const world = makeWorld();
    expect(world.player.capacity).toBe(balance.capacity);
    expect(world.player.fuel).toBe(balance.fuelCapacity);
  });

  it('takes off, climbs, and reports lift-off exactly once', () => {
    const world = makeWorld();
    runFor(world, 1.5, { ...neutralInput(), thrustY: 1 });
    const events = collect(world);
    expect(world.player.grounded).toBe(false);
    expect(world.player.position.y).toBeGreaterThan(3);
    expect(events.filter((e) => e === 'flight:liftoff')).toHaveLength(1);
  });

  it('emits a touchdown event with the landing quality', () => {
    const world = makeWorld();
    runFor(world, 2, { ...neutralInput(), thrustY: 1 });
    collect(world);
    runFor(world, 6, neutralInput());

    let touchdown: Record<string, unknown> | null = null;
    world.events.drain((event) => {
      if (event.type === 'flight:touchdown') touchdown = event.payload;
    });
    expect(touchdown).not.toBeNull();
    expect(['safe', 'hard', 'crash']).toContain(
      (touchdown as unknown as { quality: string }).quality,
    );
  });

  it('destroys the aircraft once its hull is gone, and says so once', () => {
    const world = makeWorld();
    world.player.hull = 0.01;
    runFor(world, 3, { ...neutralInput(), thrustY: 1 });
    collect(world);
    world.player.position.y = 90;
    world.player.velocity.y = 0;
    world.player.grounded = false;
    // Free fall from 90 m reaches terminal descent well before impact — a guaranteed crash.
    runFor(world, 8, neutralInput());
    expect(world.player.grounded).toBe(true);
    const events = collect(world);
    expect(events.filter((e) => e === 'flight:destroyed')).toHaveLength(1);
    expect(world.player.destroyedFor).toBeGreaterThan(0);
  });

  it('advances the tick counter and simulated clock together', () => {
    const world = makeWorld();
    runFor(world, 1, neutralInput());
    expect(world.tick).toBe(120);
    expect(world.elapsed).toBeCloseTo(1, 6);
  });
});

describe('determinism', () => {
  const script: FlightInput[] = Array.from({ length: 900 }, (_, i) => ({
    thrustX: Math.sin(i * 0.037),
    thrustY: i % 90 < 45 ? 1 : 0.2,
    boost: i % 210 < 60,
    yawLeft: i % 300 === 0,
    yawRight: i % 437 === 0,
  }));

  const play = (seed: number): World => {
    const world = new World({
      balance,
      terrain: createTestRange(),
      dt: DT,
      seed,
      spawn: { x: 40 },
    });
    for (const input of script) world.step(input);
    return world;
  };

  it('two runs of the same script produce the same state hash', () => {
    expect(play(7).hash()).toBe(play(7).hash());
  });

  it('the hash actually tracks state — a different script diverges', () => {
    const base = play(7);
    const other = new World({
      balance,
      terrain: createTestRange(),
      dt: DT,
      seed: 7,
      spawn: { x: 40 },
    });
    for (const input of script) other.step({ ...input, thrustX: input.thrustX * 0.5 });
    expect(other.hash()).not.toBe(base.hash());
  });

  it('is unaffected by how many steps are run per rendered frame', () => {
    // The whole point of the fixed timestep: 1 step per frame and 4 steps per frame must
    // produce identical simulations at 60, 120 and 144 Hz rendering.
    const single = play(3);
    const batched = new World({
      balance,
      terrain: createTestRange(),
      dt: DT,
      seed: 3,
      spawn: { x: 40 },
    });
    for (let i = 0; i < script.length; i += 4) {
      for (let j = i; j < Math.min(i + 4, script.length); j++) {
        batched.step(script[j] as FlightInput);
      }
    }
    expect(batched.hash()).toBe(single.hash());
  });

  it('never produces a non-finite value across a long flight', () => {
    const world = play(11);
    for (const value of [
      world.player.position.x,
      world.player.position.y,
      world.player.velocity.x,
      world.player.velocity.y,
      world.player.pitch,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});
