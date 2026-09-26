import { beforeEach, describe, expect, it } from 'vitest';
import { loadFlightBalance } from '@/content/loaders/balanceLoader.js';
import {
  createHelicopter,
  neutralInput,
  type FlightInput,
  type Helicopter,
} from '../components.js';
import { FlatTerrain } from '../terrain.js';
import { engineEfficiency, groundEffect, rotorNoise, stepFlight } from './flight.js';

const balance = loadFlightBalance();
const tuning = balance.flight;
const DT = 1 / 120;
const terrain = new FlatTerrain(0);

const fly = (
  helicopter: Helicopter,
  input: Partial<FlightInput>,
  seconds: number,
  startTick = 0,
): void => {
  const full = { ...neutralInput(), ...input };
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    stepFlight(helicopter, full, { tuning, terrain, dt: DT, tick: startTick + i });
  }
};

let heli: Helicopter;

beforeEach(() => {
  // Well clear of the ground so ground effect does not colour the numbers.
  heli = createHelicopter({ position: { x: 0, y: 120 }, fuel: 1000 });
});

describe('vertical handling', () => {
  it('hovers at about 55% vertical input on a healthy engine', () => {
    // gravity / verticalAcceleration = 14 / 26 = 0.538. The PRD calls this ~55%.
    fly(heli, { thrustY: 0.538 }, 6);
    expect(Math.abs(heli.velocity.y)).toBeLessThan(0.35);
  });

  it('descends on neutral input rather than holding altitude', () => {
    const startY = heli.position.y;
    fly(heli, {}, 2);
    expect(heli.position.y).toBeLessThan(startY);
    expect(heli.velocity.y).toBeLessThan(-1);
  });

  it('settles at the climb cap, not above it', () => {
    fly(heli, { thrustY: 1 }, 12);
    expect(heli.velocity.y).toBeGreaterThan(tuning.maxClimbSpeed * 0.9);
    expect(heli.velocity.y).toBeLessThan(tuning.maxClimbSpeed * 1.08);
  });

  it('settles at the descent cap in free fall', () => {
    fly(heli, { thrustY: -1 }, 14);
    expect(Math.abs(heli.velocity.y)).toBeGreaterThan(tuning.maxDescentSpeed * 0.9);
    expect(Math.abs(heli.velocity.y)).toBeLessThan(tuning.maxDescentSpeed * 1.1);
  });
});

describe('horizontal handling', () => {
  it('settles near the horizontal speed cap', () => {
    fly(heli, { thrustX: 1, thrustY: 0.538 }, 20);
    expect(heli.velocity.x).toBeGreaterThan(tuning.maxHorizontalSpeed * 0.9);
    expect(heli.velocity.x).toBeLessThan(tuning.maxHorizontalSpeed * 1.08);
  });

  it('boost raises the cap to about 1.38x', () => {
    fly(heli, { thrustX: 1, thrustY: 0.538, boost: true }, 20);
    const boosted = heli.velocity.x;
    const plain = createHelicopter({ position: { x: 0, y: 120 }, fuel: 1000 });
    fly(plain, { thrustX: 1, thrustY: 0.538 }, 20);
    expect(boosted / plain.velocity.x).toBeGreaterThan(1.25);
    expect(boosted).toBeLessThan(tuning.maxHorizontalSpeed * tuning.boostSpeedMultiplier * 1.05);
  });

  it('uses a soft limit — a value past the cap bleeds off instead of being clamped', () => {
    heli.velocity.x = 70;
    fly(heli, { thrustX: 1, thrustY: 0.538 }, 0.5);
    expect(heli.velocity.x).toBeLessThan(70);
    expect(heli.velocity.x).toBeGreaterThan(tuning.maxHorizontalSpeed);
  });

  it('requires braking momentum to reverse direction', () => {
    fly(heli, { thrustX: 1, thrustY: 0.538 }, 8);
    const cruising = heli.velocity.x;
    expect(cruising).toBeGreaterThan(20);

    // Full opposite input must not flip the velocity sign immediately.
    fly(heli, { thrustX: -1, thrustY: 0.538 }, 0.25);
    expect(heli.velocity.x).toBeGreaterThan(0);

    fly(heli, { thrustX: -1, thrustY: 0.538 }, 4);
    expect(heli.velocity.x).toBeLessThan(0);
  });
});

describe('damage and load', () => {
  it('passengers slow the climb without grounding the aircraft', () => {
    const loaded = createHelicopter({ position: { x: 0, y: 120 }, fuel: 1000 });
    loaded.passengers = Array.from({ length: 8 }, (_, i) => i + 1);
    fly(loaded, { thrustY: 1 }, 6);
    fly(heli, { thrustY: 1 }, 6);
    expect(loaded.velocity.y).toBeLessThan(heli.velocity.y);
    expect(loaded.velocity.y).toBeGreaterThan(5);
  });

  it('engine damage reduces available lift', () => {
    const damaged = createHelicopter({ position: { x: 0, y: 120 }, fuel: 1000, engine: 0.3 });
    expect(engineEfficiency(damaged, tuning)).toBeLessThan(engineEfficiency(heli, tuning));
    fly(damaged, { thrustY: 1 }, 6);
    fly(heli, { thrustY: 1 }, 6);
    expect(damaged.velocity.y).toBeLessThan(heli.velocity.y);
  });

  it('an empty tank kills thrust but the model keeps running', () => {
    const dry = createHelicopter({ position: { x: 0, y: 120 }, fuel: 0 });
    expect(engineEfficiency(dry, tuning)).toBe(0);
    fly(dry, { thrustY: 1 }, 2);
    expect(dry.velocity.y).toBeLessThan(0);
    expect(Number.isFinite(dry.position.y)).toBe(true);
  });

  it('reports fuel exhaustion exactly once', () => {
    const nearlyDry = createHelicopter({ position: { x: 0, y: 120 }, fuel: 0.05 });
    let emptied = 0;
    for (let i = 0; i < 240; i++) {
      const result = stepFlight(
        nearlyDry,
        { ...neutralInput(), thrustY: 1 },
        {
          tuning,
          terrain,
          dt: DT,
          tick: i,
        },
      );
      if (result.fuelJustEmptied) emptied++;
    }
    expect(emptied).toBe(1);
  });

  it('burns fuel faster under boost, at the documented multiplier', () => {
    const cruise = createHelicopter({ position: { x: 0, y: 120 }, fuel: 100 });
    const boosted = createHelicopter({ position: { x: 0, y: 120 }, fuel: 100 });
    fly(cruise, { thrustY: 0.538 }, 10);
    fly(boosted, { thrustY: 0.538, boost: true }, 10);
    const ratio = (100 - boosted.fuel) / (100 - cruise.fuel);
    expect(ratio).toBeCloseTo(tuning.boostFuelMultiplier, 1);
  });

  it('rotor damage wanders the aircraft but never fails instantly', () => {
    const rough = createHelicopter({ position: { x: 0, y: 120 }, fuel: 1000, rotor: 0.2 });
    expect(rotorNoise(rough, tuning, 0.4)).not.toBe(0);
    expect(Math.abs(rotorNoise(rough, tuning, 0.4))).toBeLessThan(tuning.rotorNoise);
    fly(rough, { thrustY: 0.538 }, 4);
    expect(Math.abs(rough.velocity.x)).toBeGreaterThan(0);
    expect(rough.hull).toBe(1);
  });

  it('rotor noise is deterministic, so two identical runs drift identically', () => {
    const a = createHelicopter({ position: { x: 0, y: 120 }, fuel: 1000, rotor: 0.2 });
    const b = createHelicopter({ position: { x: 0, y: 120 }, fuel: 1000, rotor: 0.2 });
    fly(a, { thrustY: 0.538 }, 5);
    fly(b, { thrustY: 0.538 }, 5);
    expect(a.position.x).toBe(b.position.x);
  });

  it('an undamaged rotor contributes no noise at all', () => {
    expect(rotorNoise(heli, tuning, 1.7)).toBe(0);
  });
});

describe('ground effect', () => {
  it('adds lift close to the ground and fades out by one rotor diameter', () => {
    expect(groundEffect(0, tuning)).toBeCloseTo(tuning.groundEffectLift, 6);
    expect(groundEffect(tuning.groundEffectHeight / 2, tuning)).toBeCloseTo(
      tuning.groundEffectLift / 2,
      6,
    );
    expect(groundEffect(tuning.groundEffectHeight, tuning)).toBe(0);
    expect(groundEffect(200, tuning)).toBe(0);
  });

  it('stays inside the 5-8% band the PRD allows', () => {
    expect(tuning.groundEffectLift).toBeGreaterThanOrEqual(0.05);
    expect(tuning.groundEffectLift).toBeLessThanOrEqual(0.08);
  });
});

describe('yaw', () => {
  it('steps left and right through the foreground plane', () => {
    heli.grounded = false;
    stepFlight(heli, { ...neutralInput(), yawLeft: true }, { tuning, terrain, dt: DT, tick: 0 });
    expect(heli.yawTarget).toBe(0);
    fly(heli, {}, tuning.yawDurationSeconds + 0.02);
    expect(heli.facing).toBe(0);

    stepFlight(heli, { ...neutralInput(), yawLeft: true }, { tuning, terrain, dt: DT, tick: 0 });
    fly(heli, {}, tuning.yawDurationSeconds + 0.02);
    expect(heli.facing).toBe(-1);
  });

  it('takes between 180 and 260 ms', () => {
    expect(tuning.yawDurationSeconds).toBeGreaterThanOrEqual(0.18);
    expect(tuning.yawDurationSeconds).toBeLessThanOrEqual(0.26);
  });

  it('cannot begin while grounded — the skids are planted', () => {
    heli.grounded = true;
    stepFlight(heli, { ...neutralInput(), yawLeft: true }, { tuning, terrain, dt: DT, tick: 0 });
    expect(heli.yawTarget).toBeNull();
    expect(heli.facing).toBe(1);
  });

  it('does not change velocity — the 1982 rule that movement is independent of facing', () => {
    heli.grounded = false;
    fly(heli, { thrustX: 1, thrustY: 0.538 }, 6);
    const before = { ...heli.velocity };
    const result = stepFlight(
      heli,
      { ...neutralInput(), thrustY: 0.538, yawLeft: true },
      {
        tuning,
        terrain,
        dt: DT,
        tick: 0,
      },
    );
    expect(result.yawStarted).toEqual({ from: 1, to: 0 });
    // Velocity keeps evolving under drag, but the yaw itself must not perturb it.
    expect(Math.sign(heli.velocity.x)).toBe(Math.sign(before.x));
    expect(Math.abs(heli.velocity.x - before.x)).toBeLessThan(0.6);
  });

  it('lets the aircraft translate opposite its facing', () => {
    heli.grounded = false;
    heli.facing = -1;
    fly(heli, { thrustX: 1, thrustY: 0.538 }, 5);
    expect(heli.velocity.x).toBeGreaterThan(5);
    expect(heli.facing).toBe(-1);
  });

  it('ignores further yaw input while a transition is in flight', () => {
    heli.grounded = false;
    stepFlight(heli, { ...neutralInput(), yawLeft: true }, { tuning, terrain, dt: DT, tick: 0 });
    stepFlight(heli, { ...neutralInput(), yawRight: true }, { tuning, terrain, dt: DT, tick: 1 });
    expect(heli.yawTarget).toBe(0);
  });

  it('clamps at the outer facings', () => {
    heli.grounded = false;
    heli.facing = 1;
    stepFlight(heli, { ...neutralInput(), yawRight: true }, { tuning, terrain, dt: DT, tick: 0 });
    expect(heli.yawTarget).toBeNull();
  });
});

describe('pitch', () => {
  it('leans into acceleration and settles back', () => {
    heli.grounded = false;
    fly(heli, { thrustX: 1, thrustY: 0.538 }, 0.4);
    expect(heli.pitch).toBeLessThan(0);
    expect(Math.abs(heli.pitch)).toBeLessThanOrEqual(tuning.maxPitch + 1e-6);

    fly(heli, { thrustY: 0.538 }, 6);
    expect(Math.abs(heli.pitch)).toBeLessThan(0.08);
  });

  it('never exceeds the configured maximum', () => {
    heli.grounded = false;
    for (let i = 0; i < 600; i++) {
      const input = { ...neutralInput(), thrustX: i % 40 < 20 ? 1 : -1, thrustY: 0.538 };
      stepFlight(heli, input, { tuning, terrain, dt: DT, tick: i });
      expect(Math.abs(heli.pitch)).toBeLessThan(tuning.maxPitch * 2);
    }
  });
});
