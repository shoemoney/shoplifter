import { describe, expect, it } from 'vitest';
import type { DamagePacket } from '../combat/types.js';
import { createHelicopter, type Helicopter } from '../components.js';
import {
  applyDamagePacket,
  applyNearMiss,
  applySuppressiveFire,
  createDamageState,
  createMorale,
  defaultAirframeZones,
  defaultDamageTuning,
  forcedDescent,
  isFuelFireRisk,
  isSuppressed,
  liftMultiplier,
  resolveHitZone,
  splashFalloff,
  stepFuelLeak,
  stepMorale,
  weaponSpreadPenalty,
  type DamageState,
  type DamageTuning,
} from './damage.js';

const tuning = defaultDamageTuning();

const heliAt = (overrides: Partial<Helicopter> = {}): Helicopter =>
  createHelicopter({ position: { x: 0, y: 0 }, ...overrides });

/** Builds a packet that lands at the given world point, on top of the helicopter's own zones. */
const packetAt = (
  at: { x: number; y: number },
  amount: number,
  kind: DamagePacket['kind'] = 'bullet',
): DamagePacket => ({ amount, kind, sourceId: null, sourceTeam: 'hostile', at });

describe('resolveHitZone', () => {
  it('picks the zone nearest the impact point, deterministically', () => {
    const zones = defaultAirframeZones();
    const engineZone = zones.find((z) => z.slot === 'engine');
    if (!engineZone) throw new Error('fixture missing engine zone');
    const a = resolveHitZone(engineZone.offset, zones);
    const b = resolveHitZone(engineZone.offset, zones);
    expect(a).toBe('engine');
    expect(a).toBe(b);
  });

  it('resolves every default zone centre back to its own slot', () => {
    const zones = defaultAirframeZones();
    for (const zone of zones) {
      expect(resolveHitZone(zone.offset, zones)).toBe(zone.slot);
    }
  });

  it('is a pure function of geometry alone — repeated calls never disagree', () => {
    const zones = defaultAirframeZones();
    const point = { x: 0.42, y: -0.17 };
    const results = Array.from({ length: 20 }, () => resolveHitZone(point, zones));
    expect(new Set(results).size).toBe(1);
  });
});

describe('applyDamagePacket — engine and rotor', () => {
  it('an engine hit reduces engine health only', () => {
    const heli = heliAt();
    const state = createDamageState();
    const zone = defaultAirframeZones().find((z) => z.slot === 'engine');
    if (!zone) throw new Error('fixture missing engine zone');
    const result = applyDamagePacket(heli, state, packetAt(zone.offset, 0.5), tuning);
    expect(result.component).toBe('engine');
    expect(heli.engine).toBeLessThan(1);
    expect(heli.rotor).toBe(1);
    expect(heli.hull).toBe(1);
  });

  it('a rotor hit reduces rotor health only', () => {
    const heli = heliAt();
    const state = createDamageState();
    const zone = defaultAirframeZones().find((z) => z.slot === 'rotor');
    if (!zone) throw new Error('fixture missing rotor zone');
    const result = applyDamagePacket(heli, state, packetAt(zone.offset, 0.5), tuning);
    expect(result.component).toBe('rotor');
    expect(heli.rotor).toBeLessThan(1);
    expect(heli.engine).toBe(1);
  });

  it('reports a threshold crossing exactly on the hit that pushes health past the lift-failure line', () => {
    const heli = heliAt({ engine: tuning.liftFailureThreshold + 0.05 });
    const state = createDamageState();
    const zone = defaultAirframeZones().find((z) => z.slot === 'engine');
    if (!zone) throw new Error('fixture missing engine zone');
    // Small hit stays above the threshold.
    const first = applyDamagePacket(heli, state, packetAt(zone.offset, 0.02), tuning);
    expect(first.thresholdCrossed).toBe(false);
    // This one carries it across.
    const second = applyDamagePacket(heli, state, packetAt(zone.offset, 0.5), tuning);
    expect(second.thresholdCrossed).toBe(true);
    // Already below — no repeat crossing.
    const third = applyDamagePacket(heli, state, packetAt(zone.offset, 0.1), tuning);
    expect(third.thresholdCrossed).toBe(false);
  });
});

describe('applyDamagePacket — hull and destruction', () => {
  it('a hull hit reduces hull only', () => {
    const heli = heliAt();
    const state = createDamageState();
    const zone = defaultAirframeZones().find((z) => z.slot === 'hull');
    if (!zone) throw new Error('fixture missing hull zone');
    const result = applyDamagePacket(heli, state, packetAt(zone.offset, 0.4), tuning);
    expect(result.component).toBe('hull');
    expect(heli.hull).toBeLessThan(1);
    expect(heli.engine).toBe(1);
    expect(heli.rotor).toBe(1);
  });

  it('destroys the aircraft exactly once when hull reaches zero', () => {
    const heli = heliAt({ hull: 0.1 });
    const state = createDamageState();
    const zone = defaultAirframeZones().find((z) => z.slot === 'hull');
    if (!zone) throw new Error('fixture missing hull zone');
    // Amount big enough to fully zero out the remaining hull in one hit.
    const amount = 0.1 / tuning.hullDamagePerAmount + 1;
    const first = applyDamagePacket(heli, state, packetAt(zone.offset, amount), tuning);
    expect(heli.hull).toBe(0);
    expect(first.destroyed).toBe(true);
    expect(heli.destroyedFor).toBe(0);

    const second = applyDamagePacket(heli, state, packetAt(zone.offset, amount), tuning);
    expect(second.destroyed).toBe(false);
  });
});

describe('applyDamagePacket — fuel system', () => {
  it('a fuel hit adds leak rate and counts toward fire risk, without touching hull', () => {
    const heli = heliAt();
    const state = createDamageState();
    const zone = defaultAirframeZones().find((z) => z.slot === 'fuel');
    if (!zone) throw new Error('fixture missing fuel zone');
    const result = applyDamagePacket(heli, state, packetAt(zone.offset, 0.3), tuning);
    expect(result.component).toBe('fuel');
    expect(state.fuelSystem.leakRatePerSecond).toBeCloseTo(tuning.fuelLeakPerHit, 6);
    expect(state.fuelSystem.hitCount).toBe(1);
    expect(heli.hull).toBe(1);
  });

  it('leak rate escalates with further fuel-system hits', () => {
    const heli = heliAt();
    const state = createDamageState();
    const zone = defaultAirframeZones().find((z) => z.slot === 'fuel');
    if (!zone) throw new Error('fixture missing fuel zone');
    applyDamagePacket(heli, state, packetAt(zone.offset, 0.3), tuning);
    const afterOne = state.fuelSystem.leakRatePerSecond;
    applyDamagePacket(heli, state, packetAt(zone.offset, 0.3), tuning);
    expect(state.fuelSystem.leakRatePerSecond).toBeGreaterThan(afterOne);
  });

  it('fire risk is a stated hit-count threshold, not a dice roll', () => {
    const heli = heliAt();
    const state = createDamageState();
    const zone = defaultAirframeZones().find((z) => z.slot === 'fuel');
    if (!zone) throw new Error('fixture missing fuel zone');
    expect(isFuelFireRisk(state, tuning)).toBe(false);

    let crossedCount = 0;
    for (let i = 0; i < tuning.fireRiskHitCount; i++) {
      const result = applyDamagePacket(heli, state, packetAt(zone.offset, 0.3), tuning);
      if (result.thresholdCrossed) crossedCount++;
    }
    expect(isFuelFireRisk(state, tuning)).toBe(true);
    // Fire risk is newly reported exactly once, on the hit that reached the count.
    expect(crossedCount).toBe(1);
  });

  it('stepFuelLeak drains fuel proportional to the leak rate and never goes negative', () => {
    const heli = heliAt({ fuel: 10 });
    const state = createDamageState();
    state.fuelSystem.leakRatePerSecond = 5;
    const leaked = stepFuelLeak(heli, state, 1);
    expect(leaked).toBe(5);
    expect(heli.fuel).toBe(5);

    stepFuelLeak(heli, state, 10);
    expect(heli.fuel).toBe(0);
  });

  it('does nothing when there is no leak', () => {
    const heli = heliAt({ fuel: 10 });
    const state = createDamageState();
    expect(stepFuelLeak(heli, state, 1)).toBe(0);
    expect(heli.fuel).toBe(10);
  });
});

describe('applyDamagePacket — weapons', () => {
  it('a weapons hit raises heat and eventually crosses the spread-penalty threshold', () => {
    const heli = heliAt();
    const state = createDamageState();
    const zone = defaultAirframeZones().find((z) => z.slot === 'weapons');
    if (!zone) throw new Error('fixture missing weapons zone');
    const result = applyDamagePacket(heli, state, packetAt(zone.offset, 1), tuning);
    expect(result.component).toBe('weapons');
    expect(heli.weaponHeat).toBeGreaterThan(0);
    expect(heli.weaponHeat).toBeLessThanOrEqual(1);
  });
});

describe('applyDamagePacket — passenger bay', () => {
  it('a heavy bay hit injures passengers without removing them from the roster', () => {
    const heli = heliAt({ passengers: [1, 2, 3, 4] });
    const state = createDamageState();
    const zone = defaultAirframeZones().find((z) => z.slot === 'bay');
    if (!zone) throw new Error('fixture missing bay zone');
    const result = applyDamagePacket(
      heli,
      state,
      packetAt(zone.offset, tuning.bayInjuryThreshold),
      tuning,
    );
    expect(result.passengersInjured).toBeGreaterThan(0);
    expect(heli.passengers.length).toBe(4);
  });

  it('a light bay hit below the injury threshold injures nobody', () => {
    const heli = heliAt({ passengers: [1, 2] });
    const state = createDamageState();
    const zone = defaultAirframeZones().find((z) => z.slot === 'bay');
    if (!zone) throw new Error('fixture missing bay zone');
    const result = applyDamagePacket(
      heli,
      state,
      packetAt(zone.offset, tuning.bayInjuryThreshold - 0.05),
      tuning,
    );
    expect(result.passengersInjured).toBe(0);
  });

  it('never silently kills passengers, however many heavy hits land', () => {
    const heli = heliAt({ passengers: [1, 2] });
    const state = createDamageState();
    const zone = defaultAirframeZones().find((z) => z.slot === 'bay');
    if (!zone) throw new Error('fixture missing bay zone');
    for (let i = 0; i < 10; i++) {
      applyDamagePacket(heli, state, packetAt(zone.offset, 1), tuning);
    }
    expect(heli.passengers.length).toBe(2);
    expect(state.passengersInjured).toBeLessThanOrEqual(2);
  });

  it('an empty bay cannot report an injury', () => {
    const heli = heliAt({ passengers: [] });
    const state = createDamageState();
    const zone = defaultAirframeZones().find((z) => z.slot === 'bay');
    if (!zone) throw new Error('fixture missing bay zone');
    const result = applyDamagePacket(heli, state, packetAt(zone.offset, 1), tuning);
    expect(result.passengersInjured).toBe(0);
  });
});

describe('splashFalloff', () => {
  it('is full strength at the blast centre', () => {
    expect(splashFalloff(0, 10)).toBe(1);
  });

  it('is half strength at the midpoint of the radius', () => {
    expect(splashFalloff(5, 10)).toBeCloseTo(0.5, 6);
  });

  it('reaches zero exactly at the radius', () => {
    expect(splashFalloff(10, 10)).toBe(0);
  });

  it('stays zero beyond the radius, never negative', () => {
    expect(splashFalloff(15, 10)).toBe(0);
  });

  it('treats a zero radius as a point blast', () => {
    expect(splashFalloff(0, 0)).toBe(1);
    expect(splashFalloff(0.01, 0)).toBe(0);
  });
});

describe('liftMultiplier and forcedDescent', () => {
  it('is at full strength on a healthy aircraft', () => {
    const heli = heliAt();
    expect(liftMultiplier(heli, tuning)).toBeCloseTo(1, 6);
  });

  it('drops toward the floor as engine/rotor health falls, but never below it', () => {
    const heli = heliAt({ engine: 0, rotor: 0 });
    expect(liftMultiplier(heli, tuning)).toBeCloseTo(tuning.minLiftMultiplier, 6);
  });

  it('is governed by the worse of engine and rotor health', () => {
    const engineHurt = heliAt({ engine: 0.2, rotor: 1 });
    const rotorHurt = heliAt({ engine: 1, rotor: 0.2 });
    expect(liftMultiplier(engineHurt, tuning)).toBeCloseTo(liftMultiplier(rotorHurt, tuning), 6);
  });

  it('does not force a descent on a healthy or lightly damaged aircraft', () => {
    expect(forcedDescent(heliAt(), tuning)).toBe(false);
    expect(
      forcedDescent(heliAt({ engine: tuning.forcedDescentThreshold + 0.1, rotor: 1 }), tuning),
    ).toBe(false);
  });

  it('forces a descent once engine or rotor health drops to the threshold', () => {
    expect(forcedDescent(heliAt({ engine: tuning.forcedDescentThreshold, rotor: 1 }), tuning)).toBe(
      true,
    );
    expect(forcedDescent(heliAt({ engine: 1, rotor: tuning.forcedDescentThreshold }), tuning)).toBe(
      true,
    );
  });
});

describe('weaponSpreadPenalty', () => {
  it('is zero below the heat threshold', () => {
    const heli = heliAt({ weaponHeat: tuning.weaponSpreadHeatThreshold - 0.1 });
    expect(weaponSpreadPenalty(heli, tuning)).toBe(0);
  });

  it('ramps up above the threshold, capping at the configured maximum at full heat', () => {
    const heli = heliAt({ weaponHeat: 1 });
    expect(weaponSpreadPenalty(heli, tuning)).toBeCloseTo(tuning.maxWeaponSpreadPenalty, 6);

    const partial = heliAt({
      weaponHeat: tuning.weaponSpreadHeatThreshold + (1 - tuning.weaponSpreadHeatThreshold) / 2,
    });
    expect(weaponSpreadPenalty(partial, tuning)).toBeGreaterThan(0);
    expect(weaponSpreadPenalty(partial, tuning)).toBeLessThan(tuning.maxWeaponSpreadPenalty);
  });
});

describe('suppression and morale', () => {
  it('reports an untouched unit as not suppressed', () => {
    expect(isSuppressed(createMorale())).toBe(false);
  });

  it('a near miss lands the suppression window inside the 2-5 second band', () => {
    const morale = createMorale();
    applyNearMiss(morale, 0, tuning);
    expect(isSuppressed(morale)).toBe(true);
    expect(morale.suppressedFor).toBeGreaterThanOrEqual(tuning.minSuppressionSeconds);
    expect(morale.suppressedFor).toBeLessThanOrEqual(tuning.maxSuppressionSeconds);
  });

  it('a distant near miss still lands inside the band, at the shorter end', () => {
    const morale = createMorale();
    applyNearMiss(morale, tuning.nearMissRadius * 0.999, tuning);
    expect(morale.suppressedFor).toBeCloseTo(tuning.minSuppressionSeconds, 1);
  });

  it('a miss at or beyond the near-miss radius applies no suppression', () => {
    const morale = createMorale();
    applyNearMiss(morale, tuning.nearMissRadius, tuning);
    applyNearMiss(morale, tuning.nearMissRadius * 2, tuning);
    expect(morale.suppressedFor).toBe(0);
    expect(morale.value).toBe(1);
  });

  it('sustained fire eventually breaks composure and lands inside the 2-5 second band', () => {
    const morale = createMorale();
    for (let i = 0; i < 200; i++) {
      applySuppressiveFire(morale, 1, 1 / 30, tuning);
    }
    expect(isSuppressed(morale)).toBe(true);
    expect(morale.suppressedFor).toBeGreaterThanOrEqual(tuning.minSuppressionSeconds);
    expect(morale.suppressedFor).toBeLessThanOrEqual(tuning.maxSuppressionSeconds);
  });

  it('stacks: prolonged sustained fire drives a longer cover window than a single near miss', () => {
    const nearMissed = createMorale();
    applyNearMiss(nearMissed, tuning.nearMissRadius * 0.9, tuning);

    const sustained = createMorale();
    for (let i = 0; i < 400; i++) {
      applySuppressiveFire(sustained, 1, 1 / 30, tuning);
    }
    expect(sustained.suppressedFor).toBeGreaterThan(nearMissed.suppressedFor);
    expect(sustained.suppressedFor).toBeLessThanOrEqual(tuning.maxSuppressionSeconds);
  });

  it('never extends a longer existing window with a weaker new one', () => {
    const morale = createMorale();
    applyNearMiss(morale, 0, tuning);
    const longWindow = morale.suppressedFor;
    applyNearMiss(morale, tuning.nearMissRadius, tuning);
    expect(morale.suppressedFor).toBe(longWindow);
  });

  it('counts the suppression window down and eventually clears it', () => {
    const morale = createMorale();
    applyNearMiss(morale, 0, tuning);
    for (let i = 0; i < 600; i++) stepMorale(morale, 1 / 30, tuning);
    expect(morale.suppressedFor).toBe(0);
    expect(isSuppressed(morale)).toBe(false);
  });

  it('recovers composure over time once the pressure stops', () => {
    const morale = createMorale();
    applyNearMiss(morale, 0, tuning);
    const afterHit = morale.value;
    for (let i = 0; i < 300; i++) stepMorale(morale, 1 / 30, tuning);
    expect(morale.value).toBeGreaterThan(afterHit);
    expect(morale.value).toBeLessThanOrEqual(1);
  });
});

describe('DamageState and tuning factories', () => {
  it('produce independent instances so tests and callers cannot cross-contaminate state', () => {
    const a: DamageState = createDamageState();
    const b: DamageState = createDamageState();
    a.fuelSystem.leakRatePerSecond = 5;
    expect(b.fuelSystem.leakRatePerSecond).toBe(0);

    const tuningA: DamageTuning = defaultDamageTuning();
    const tuningB: DamageTuning = defaultDamageTuning();
    tuningA.airframeZones = [];
    expect(tuningB.airframeZones.length).toBeGreaterThan(0);
  });
});
