import { describe, expect, it } from 'vitest';
import { Rng } from '@/core/rng.js';
import {
  acquireRocketLock,
  createWeaponsState,
  defaultWeaponTuning,
  deployFlare,
  doorGunDamageAtRange,
  fireDoorGun,
  fireRocket,
  stepDoorGun,
  stepFlareRecharge,
} from './weapons.js';

const DT = 1 / 120;

describe('door gun heat', () => {
  it('accumulates heat at the documented rate while firing', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);
    stepDoorGun(state, tuning, true, DT);
    expect(state.heat).toBeCloseTo(tuning.doorGunHeatPerSecond * DT, 6);
  });

  it('overheats exactly once at the 1.0 threshold and locks the gun out', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);
    const stepsToOverheat = Math.ceil(1 / tuning.doorGunHeatPerSecond / DT) + 5;

    let overheatCount = 0;
    for (let i = 0; i < stepsToOverheat; i++) {
      const result = stepDoorGun(state, tuning, true, DT);
      if (result.justOverheated) overheatCount++;
    }

    expect(overheatCount).toBe(1);
    expect(state.heat).toBe(tuning.doorGunOverheatThreshold);
    expect(state.overheated).toBe(true);
  });

  it('refuses to fire through lockout until heat falls back to 0.55, then recovers exactly once', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);
    for (let i = 0; i < 1000 && !state.overheated; i++) stepDoorGun(state, tuning, true, DT);
    expect(state.overheated).toBe(true);

    let recovered = false;
    let recoverCount = 0;
    for (let i = 0; i < 2000 && !recovered; i++) {
      const result = stepDoorGun(state, tuning, true, DT);
      expect(result.firing).toBe(false);
      if (result.justRecovered) {
        recovered = true;
        recoverCount++;
      }
    }

    expect(recovered).toBe(true);
    expect(recoverCount).toBe(1);
    // Cooling happens in fixed dt steps, so the exact recovery tick can undershoot the
    // threshold by at most one step's worth of cooling rather than landing on it precisely.
    expect(state.heat).toBeLessThanOrEqual(tuning.doorGunLockoutRecoverThreshold);
    expect(state.heat).toBeGreaterThan(
      tuning.doorGunLockoutRecoverThreshold - tuning.doorGunCoolingPerSecond * DT,
    );
    expect(state.overheated).toBe(false);
  });

  it('does not begin cooling until the 0.25s post-release delay has elapsed', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);
    for (let i = 0; i < 60; i++) stepDoorGun(state, tuning, true, DT);
    const heatAtRelease = state.heat;

    const delaySteps = Math.round(tuning.doorGunCoolingDelaySeconds / DT);
    for (let i = 0; i < delaySteps - 1; i++) stepDoorGun(state, tuning, false, DT);
    expect(state.heat).toBeCloseTo(heatAtRelease, 6);

    // Crossing the delay boundary, then a few more ticks, must show real cooling.
    for (let i = 0; i < 11; i++) stepDoorGun(state, tuning, false, DT);
    expect(state.heat).toBeLessThan(heatAtRelease);
  });

  it('keeps heat flat during a firing pause shorter than the cooling delay', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);
    for (let i = 0; i < 60; i++) stepDoorGun(state, tuning, true, DT);
    const heatAtRelease = state.heat;
    stepDoorGun(state, tuning, false, DT);
    stepDoorGun(state, tuning, true, DT);
    expect(state.heat).toBeGreaterThanOrEqual(heatAtRelease);
  });
});

describe('door gun burst accuracy', () => {
  it('stays at base spread for the accurate window, then grows to max over the ramp', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);

    const accurateSteps = Math.floor(tuning.doorGunAccurateSeconds / DT);
    for (let i = 0; i < accurateSteps; i++) {
      const result = stepDoorGun(state, tuning, true, DT);
      expect(result.spreadRadians).toBeCloseTo(tuning.doorGunBaseSpreadRadians, 6);
    }

    let last = stepDoorGun(state, tuning, true, DT);
    const rampSteps = Math.ceil(tuning.doorGunSpreadRampSeconds / DT) + 10;
    for (let i = 0; i < rampSteps; i++) {
      last = stepDoorGun(state, tuning, true, DT);
      expect(last.spreadRadians).toBeGreaterThanOrEqual(tuning.doorGunBaseSpreadRadians);
      expect(last.spreadRadians).toBeLessThanOrEqual(tuning.doorGunMaxSpreadRadians + 1e-9);
    }
    expect(last.spreadRadians).toBeCloseTo(tuning.doorGunMaxSpreadRadians, 3);
  });

  it('resets the burst timer, and so the spread, once the trigger is released', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);
    for (let i = 0; i < Math.ceil((tuning.doorGunAccurateSeconds + 0.3) / DT); i++) {
      stepDoorGun(state, tuning, true, DT);
    }
    stepDoorGun(state, tuning, false, DT);
    const afterRelease = stepDoorGun(state, tuning, true, DT);
    expect(afterRelease.spreadRadians).toBeCloseTo(tuning.doorGunBaseSpreadRadians, 6);
  });
});

describe('door gun damage falloff', () => {
  it('deals full damage up to the falloff start and floors out past the falloff range', () => {
    const tuning = defaultWeaponTuning();
    expect(doorGunDamageAtRange(0, tuning)).toBe(tuning.doorGunDamage);
    expect(doorGunDamageAtRange(tuning.doorGunFalloffStartMetres, tuning)).toBe(
      tuning.doorGunDamage,
    );

    const mid = doorGunDamageAtRange(
      tuning.doorGunFalloffStartMetres + tuning.doorGunFalloffRangeMetres / 2,
      tuning,
    );
    expect(mid).toBeLessThan(tuning.doorGunDamage);
    expect(mid).toBeGreaterThan(tuning.doorGunDamage * tuning.doorGunFalloffMinMultiplier);

    const far = doorGunDamageAtRange(
      tuning.doorGunFalloffStartMetres + tuning.doorGunFalloffRangeMetres + 50,
      tuning,
    );
    expect(far).toBeCloseTo(tuning.doorGunDamage * tuning.doorGunFalloffMinMultiplier, 5);
  });

  it('derives the falloff start from 70% of the default camera world width (60m)', () => {
    const tuning = defaultWeaponTuning();
    expect(tuning.doorGunFalloffStartMetres).toBeCloseTo(60 * 0.7, 5);
  });
});

describe('fireDoorGun', () => {
  it('produces no spawn while released or overheated, and a bullet while firing', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);
    const rng = new Rng(1);

    const released = fireDoorGun(state, tuning, { x: 0, y: 0 }, 0, false, DT, rng, 1);
    expect(released.spawnParams).toBeNull();

    const firing = fireDoorGun(state, tuning, { x: 0, y: 0 }, 0, true, DT, rng, 1);
    expect(firing.spawnParams).not.toBeNull();
    expect(firing.spawnParams?.kind).toBe('bullet');
    expect(firing.spawnParams?.team).toBe('player');
    expect(firing.spawnParams?.sourceId).toBe(1);

    const angle = Math.atan2(firing.spawnParams!.velocity.y, firing.spawnParams!.velocity.x);
    expect(Math.abs(angle)).toBeLessThanOrEqual(tuning.doorGunBaseSpreadRadians + 1e-9);
  });

  it('never fires once overheated, even with the trigger held', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);
    const rng = new Rng(2);
    for (let i = 0; i < 1000 && !state.overheated; i++) {
      fireDoorGun(state, tuning, { x: 0, y: 0 }, 0, true, DT, rng, 1);
    }
    expect(state.overheated).toBe(true);
    const outcome = fireDoorGun(state, tuning, { x: 0, y: 0 }, 0, true, DT, rng, 1);
    expect(outcome.spawnParams).toBeNull();
  });
});

describe('fireRocket', () => {
  it('consumes one rocket per shot and refuses once the rack is empty', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);

    for (let i = 0; i < tuning.rocketsInitial; i++) {
      const outcome = fireRocket(state, tuning, { x: 0, y: 0 }, 0, 1);
      expect(outcome.fired).toBe(true);
      expect(outcome.spawnParams?.kind).toBe('rocket');
      expect(outcome.spawnParams?.splashRadius).toBe(tuning.rocketSplashRadiusMetres);
    }

    expect(state.rockets).toBe(0);
    const dry = fireRocket(state, tuning, { x: 0, y: 0 }, 0, 1);
    expect(dry.fired).toBe(false);
    expect(dry.spawnParams).toBeNull();
  });
});

describe('acquireRocketLock', () => {
  const tuning = defaultWeaponTuning();
  const origin = { x: 0, y: 0 };

  it('accepts a candidate inside the soft-lock cone', () => {
    const result = acquireRocketLock(origin, 0, [{ id: 5, position: { x: 10, y: 1 } }], [], tuning);
    expect(result.targetId).toBe(5);
    expect(result.angleRadians).not.toBeNull();
  });

  it('rejects a candidate outside the soft-lock cone', () => {
    const result = acquireRocketLock(origin, 0, [{ id: 5, position: { x: 0, y: 10 } }], [], tuning);
    expect(result.targetId).toBeNull();
    expect(result.angleRadians).toBeNull();
  });

  it('prefers whichever qualifying candidate sits closest to boresight', () => {
    const candidates = [
      { id: 1, position: { x: 10, y: 2 } },
      { id: 2, position: { x: 10, y: 0.2 } },
    ];
    const result = acquireRocketLock(origin, 0, candidates, [], tuning);
    expect(result.targetId).toBe(2);
  });

  it('refuses a lock whose line to the target passes through a civilian', () => {
    const candidates = [{ id: 5, position: { x: 10, y: 0 } }];
    const civilians = [{ x: 5, y: 0 }];
    const result = acquireRocketLock(origin, 0, candidates, civilians, tuning);
    expect(result.targetId).toBeNull();
  });

  it('still locks when a civilian is well clear of the line of fire', () => {
    const candidates = [{ id: 5, position: { x: 10, y: 0 } }];
    const civilians = [{ x: 5, y: 50 }];
    const result = acquireRocketLock(origin, 0, candidates, civilians, tuning);
    expect(result.targetId).toBe(5);
  });
});

describe('flares', () => {
  it('breaks the lock when deployed inside the correct timing window', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);
    const result = deployFlare(state, tuning, { timeToImpactSeconds: 0.9 });
    expect(result.fired).toBe(true);
    expect(result.lockBreak).toEqual({ outcome: 'broken', accuracyPenalty: 1 });
    expect(state.flares).toBe(tuning.flareCharges - 1);
  });

  it('degrades incoming accuracy rather than guaranteeing a miss on poor timing', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);
    const result = deployFlare(state, tuning, { timeToImpactSeconds: 0.2 });
    expect(result.lockBreak?.outcome).toBe('degraded');
    expect(result.lockBreak?.accuracyPenalty).toBeGreaterThan(0);
    expect(result.lockBreak?.accuracyPenalty).toBeLessThan(1);
  });

  it('has no effect when deployed far outside any useful window', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);
    const result = deployFlare(state, tuning, { timeToImpactSeconds: 10 });
    expect(result.lockBreak).toEqual({ outcome: 'missed-window', accuracyPenalty: 0 });
  });

  it('still spends a charge when popped with nothing locked on, and reports missed-window', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);
    const result = deployFlare(state, tuning, null);
    expect(result.fired).toBe(true);
    expect(result.lockBreak).toEqual({ outcome: 'missed-window', accuracyPenalty: 0 });
    expect(state.flares).toBe(tuning.flareCharges - 1);
  });

  it('refuses to fire once every charge is spent', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);
    state.flares = 0;
    const result = deployFlare(state, tuning, { timeToImpactSeconds: 0.9 });
    expect(result.fired).toBe(false);
    expect(result.lockBreak).toBeNull();
  });

  it('regenerates one charge after the full recharge time when no lock is active', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);
    state.flares = 0;

    const steps = Math.round(tuning.flareRechargeSeconds / DT);
    for (let i = 0; i < steps - 1; i++) stepFlareRecharge(state, tuning, DT, false);
    expect(state.flares).toBe(0);

    stepFlareRecharge(state, tuning, DT, false);
    expect(state.flares).toBe(1);
  });

  it('pauses recharge entirely while a missile lock is active', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);
    state.flares = 0;

    const steps = Math.round(tuning.flareRechargeSeconds / DT) + 5;
    for (let i = 0; i < steps; i++) stepFlareRecharge(state, tuning, DT, true);

    expect(state.flares).toBe(0);
    expect(state.flareRechargeElapsed).toBe(0);
  });

  it('resumes accumulating recharge time as soon as the lock clears', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);
    state.flares = 0;

    for (let i = 0; i < 200; i++) stepFlareRecharge(state, tuning, DT, true);
    expect(state.flareRechargeElapsed).toBe(0);

    const steps = Math.round(tuning.flareRechargeSeconds / DT);
    for (let i = 0; i < steps; i++) stepFlareRecharge(state, tuning, DT, false);
    expect(state.flares).toBe(1);
  });

  it('never recharges past the maximum number of charges', () => {
    const tuning = defaultWeaponTuning();
    const state = createWeaponsState(tuning);
    state.flares = 0;

    stepFlareRecharge(
      state,
      tuning,
      tuning.flareRechargeSeconds * (tuning.flareCharges + 5),
      false,
    );
    expect(state.flares).toBe(tuning.flareCharges);
    expect(state.flareRechargeElapsed).toBe(0);
  });
});
