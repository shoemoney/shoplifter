import { describe, expect, it } from 'vitest';
import { degToRad } from '@/core/math.js';
import { loadFlightBalance } from '@/content/loaders/balanceLoader.js';
import { createHelicopter, type Helicopter } from '../components.js';
import { FlatTerrain, Heightfield, type Terrain } from '../terrain.js';
import { assessTouchdown, probeSkids, stepLanding } from './landing.js';

const balance = loadFlightBalance();
const tuning = balance.landing;
const DT = 1 / 120;

const assess = (
  vertical: number,
  horizontal = 0,
  slope = 0,
  pitchDegrees = 0,
): ReturnType<typeof assessTouchdown> =>
  assessTouchdown(vertical, horizontal, slope, pitchDegrees, tuning);

/** A ramp of the given angle, so slope tolerance can be tested against real geometry. */
const ramp = (degrees: number): Heightfield => {
  const spacing = 2;
  const slope = Math.tan(degToRad(degrees));
  const samples = Array.from({ length: 64 }, (_, i) => i * spacing * slope);
  return new Heightfield({ samples, originX: -32, spacing });
};

const descending = (speed: number, y: number, overrides: Partial<Helicopter> = {}): Helicopter =>
  createHelicopter({ position: { x: 0, y }, velocity: { x: 0, y: -speed }, ...overrides });

describe('assessTouchdown', () => {
  it('accepts a set-down inside every tolerance', () => {
    const result = assess(-3.0, 2.0, 5, 4);
    expect(result.quality).toBe('safe');
    expect(result.hullDamage).toBe(0);
  });

  it('treats the safe vertical threshold as inclusive', () => {
    expect(assess(-tuning.safeVerticalSpeed).quality).toBe('safe');
    expect(assess(-(tuning.safeVerticalSpeed + 0.01)).quality).toBe('hard');
  });

  it('crashes past the crash threshold and scales damage with the excess', () => {
    expect(assess(-tuning.crashVerticalSpeed).quality).toBe('hard');
    const justOver = assess(-(tuning.crashVerticalSpeed + 0.1));
    const wayOver = assess(-(tuning.crashVerticalSpeed * 2));
    expect(justOver.quality).toBe('crash');
    expect(wayOver.hullDamage).toBeGreaterThan(justOver.hullDamage);
    expect(wayOver.hullDamage).toBeLessThanOrEqual(1);
  });

  it('refuses a slope past 7 degrees however gently it is flown', () => {
    expect(assess(-0.1, 0, 7).quality).toBe('safe');
    const steep = assess(-0.1, 0, 9);
    expect(steep.quality).toBe('hard');
    expect(steep.reason).toBe('slope');
    expect(assess(-0.1, 0, 20).quality).toBe('crash');
  });

  it('punishes lateral speed — a skid that scrubs is not a landing', () => {
    expect(assess(-1, tuning.safeHorizontalSpeed).quality).toBe('safe');
    expect(assess(-1, tuning.safeHorizontalSpeed + 2).quality).toBe('hard');
  });

  it('punishes a tilted arrival, the PRD improperly-tilted case', () => {
    const tilted = assess(-1, 0, 0, tuning.safePitchDegrees + 3);
    expect(tilted.quality).toBe('hard');
    expect(tilted.reason).toBe('pitch');
    expect(assess(-1, 0, 0, -(tuning.safePitchDegrees + 3)).quality).toBe('hard');
  });

  it('ignores upward velocity — climbing through the resting height is not an impact', () => {
    expect(assess(5).quality).toBe('safe');
  });
});

describe('probeSkids', () => {
  it('reads flat ground as zero slope under both skids', () => {
    const probe = probeSkids(createHelicopter(), new FlatTerrain(12), tuning);
    expect(probe.slopeDegrees).toBeCloseTo(0, 6);
    expect(probe.supportHeight).toBe(12);
  });

  it('measures the slope between the skids, not at the centre point', () => {
    const probe = probeSkids(createHelicopter(), ramp(10), tuning);
    expect(probe.slopeDegrees).toBeCloseTo(10, 1);
    expect(probe.supportHeight).toBeGreaterThan(probe.leftGround);
  });
});

describe('stepLanding', () => {
  const context = (terrain: Terrain = new FlatTerrain(0)) => ({ tuning, terrain, dt: DT });

  it('stays airborne well above the ground', () => {
    const heli = descending(2, 40);
    const result = stepLanding(heli, context());
    expect(result.touchdown).toBeNull();
    expect(heli.grounded).toBe(false);
    expect(heli.landingContactCount).toBe(0);
  });

  it('settles the aircraft on its skids and kills the downward velocity', () => {
    const heli = descending(2, tuning.skidDrop - 0.2);
    const result = stepLanding(heli, context());
    expect(result.touchdown?.quality).toBe('safe');
    expect(heli.grounded).toBe(true);
    expect(heli.position.y).toBeCloseTo(tuning.skidDrop, 6);
    expect(heli.velocity.y).toBe(0);
  });

  it('reports a touchdown once, not every tick it stays landed', () => {
    const heli = descending(1, tuning.skidDrop - 0.1);
    expect(stepLanding(heli, context()).touchdown).not.toBeNull();
    expect(stepLanding(heli, context()).touchdown).toBeNull();
    expect(stepLanding(heli, context()).touchdown).toBeNull();
  });

  it('applies hull damage on a hard arrival', () => {
    const heli = descending(4.5, tuning.skidDrop - 0.1);
    const result = stepLanding(heli, context());
    expect(result.touchdown?.quality).toBe('hard');
    expect(heli.hull).toBeLessThan(1);
    expect(heli.hull).toBeGreaterThan(0);
  });

  it('takes most of the hull on a crash', () => {
    const heli = descending(12, tuning.skidDrop - 0.1);
    stepLanding(heli, context());
    expect(heli.hull).toBeLessThan(0.5);
  });

  it('counts two skids on the flat and one on a slope', () => {
    const flat = descending(1, tuning.skidDrop - 0.1);
    stepLanding(flat, context());
    expect(flat.landingContactCount).toBe(2);

    const steep = ramp(10);
    const tilted = createHelicopter({
      position: { x: 0, y: steep.heightAt(0) + tuning.skidDrop - 0.1 },
      velocity: { x: 0, y: -1 },
    });
    stepLanding(tilted, context(steep));
    expect(tilted.landingContactCount).toBe(1);
  });

  it('scrubs off lateral speed through skid friction', () => {
    const heli = createHelicopter({
      position: { x: 0, y: tuning.skidDrop - 0.1 },
      velocity: { x: 6, y: -1 },
    });
    stepLanding(heli, context());
    const first = Math.abs(heli.velocity.x);
    // One second of skid friction should bring a 6 m/s slide to a dead stop.
    for (let i = 0; i < 120; i++) stepLanding(heli, context());
    expect(Math.abs(heli.velocity.x)).toBeLessThan(first);
    expect(heli.velocity.x).toBe(0);
  });

  it('reports lift-off when the aircraft leaves the ground', () => {
    const heli = descending(1, tuning.skidDrop - 0.1);
    stepLanding(heli, context());
    heli.position.y = tuning.skidDrop + 3;
    const result = stepLanding(heli, context());
    expect(result.liftoff).toBe(true);
    expect(heli.grounded).toBe(false);
  });

  it('rests on the higher skid, so the hull never sinks into a slope', () => {
    const slope = ramp(6);
    const heli = createHelicopter({
      position: { x: 0, y: slope.heightAt(0) - 5 },
      velocity: { x: 0, y: -1 },
    });
    stepLanding(heli, { tuning, terrain: slope, dt: DT });
    const probe = probeSkids(heli, slope, tuning);
    expect(heli.position.y).toBeCloseTo(probe.supportHeight + tuning.skidDrop, 6);
    expect(heli.position.y).toBeGreaterThan(Math.max(probe.leftGround, probe.rightGround));
  });
});
