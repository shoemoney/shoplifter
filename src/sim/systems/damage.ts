import { clamp, inverseLerp, lerp } from '@/core/math.js';
import type { Vec2 } from '@/core/math.js';
import type { ComponentSlot, DamagePacket } from '../combat/types.js';
import type { Helicopter } from '../components.js';

/**
 * Named hitboxes on the player airframe. A packet's landing spot is compared against every
 * zone centre and the nearest one takes the hit — see `resolveHitZone`. Offsets are metres
 * relative to `helicopter.position`, in a world-aligned frame rather than one that flips with
 * `facing`: facing does not change the flight model (see flight.ts), so it should not change
 * which subsystem a shell finds either. A facing-aware mirror can be layered on later without
 * touching this function's signature.
 */
export interface AirframeZone {
  slot: ComponentSlot;
  offset: Vec2;
  /** Used only as a visual/documentation hint; the resolver ranks by distance, not containment. */
  radius: number;
}

export const defaultAirframeZones = (): AirframeZone[] => [
  { slot: 'rotor', offset: { x: 0, y: 1.2 }, radius: 0.9 },
  { slot: 'engine', offset: { x: 1.0, y: 0.3 }, radius: 0.8 },
  { slot: 'weapons', offset: { x: 0.6, y: -0.7 }, radius: 0.5 },
  { slot: 'bay', offset: { x: -0.1, y: -0.2 }, radius: 1.1 },
  { slot: 'fuel', offset: { x: -1.1, y: -0.3 }, radius: 0.8 },
  { slot: 'hull', offset: { x: 0, y: 0 }, radius: 1.3 },
];

/**
 * Every tunable number the damage and suppression model uses. Kept as one interface + factory,
 * not scattered inline constants, so a later milestone can replace `defaultDamageTuning()` with
 * a loaded balance JSON (see content/schemas/flight.ts for the pattern) without touching call
 * sites — this mirrors the TODO already called out for flight tuning.
 */
export interface DamageTuning {
  airframeZones: AirframeZone[];

  /** Health removed per unit of `DamagePacket.amount` landed on the engine zone. */
  engineDamagePerHit: number;
  rotorDamagePerHit: number;
  /** Engine or rotor health at/below this starts eating into available lift. */
  liftFailureThreshold: number;
  /** Lift multiplier floor at zero engine/rotor health — never a fully dead stick. */
  minLiftMultiplier: number;
  /** The worse of engine/rotor health at/below this forces a descent regardless of input. */
  forcedDescentThreshold: number;

  /** Litres/second of leak added per fuel-system hit. Leaks stack, they do not replace. */
  fuelLeakPerHit: number;
  /** Fuel-system hits at/after this count put the tank into fire risk — a count, not a roll. */
  fireRiskHitCount: number;

  weaponHeatPerHit: number;
  /** Heat at/above this starts widening spread, ramping to `maxWeaponSpreadPenalty` at heat 1. */
  weaponSpreadHeatThreshold: number;
  maxWeaponSpreadPenalty: number;

  /** A bay hit at/above this raw amount injures rather than just rattling the cabin. */
  bayInjuryThreshold: number;
  /** Passengers injured per qualifying hit, capped by how many are actually aboard. */
  passengersInjuredPerHit: number;

  hullDamagePerAmount: number;
  /** Hull health at/below this crosses into the HUD's critical-damage state. */
  hullCriticalThreshold: number;

  /** Distance at/inside which a miss counts as "near" for suppression purposes. */
  nearMissRadius: number;
  /** Morale lost from a near miss at zero distance; scales down toward the radius. */
  nearMissMoraleLoss: number;
  /** Morale lost per second of sustained fire at full intensity. */
  sustainedFireMoraleLossPerSecond: number;
  /** Morale at/below this sends the unit to cover. */
  suppressionMoraleThreshold: number;
  minSuppressionSeconds: number;
  maxSuppressionSeconds: number;
  moraleRecoveryPerSecond: number;
}

export const defaultDamageTuning = (): DamageTuning => ({
  airframeZones: defaultAirframeZones(),

  engineDamagePerHit: 0.35,
  rotorDamagePerHit: 0.35,
  liftFailureThreshold: 0.4,
  minLiftMultiplier: 0.35,
  forcedDescentThreshold: 0.2,

  // Litres/second added per fuel-system hit. At 1.5 a single hit emptied a full tank in ~65 s,
  // which is not a leak the player can respond to — it is a delayed kill. At 0.35 one hit is
  // roughly double the cruise burn: a real emergency with time to divert to a pad.
  fuelLeakPerHit: 0.35,
  fireRiskHitCount: 3,

  weaponHeatPerHit: 0.3,
  weaponSpreadHeatThreshold: 0.6,
  maxWeaponSpreadPenalty: 0.5,

  bayInjuryThreshold: 0.4,
  passengersInjuredPerHit: 1,

  hullDamagePerAmount: 0.3,
  hullCriticalThreshold: 0.25,

  nearMissRadius: 6,
  nearMissMoraleLoss: 0.4,
  sustainedFireMoraleLossPerSecond: 0.3,
  suppressionMoraleThreshold: 0.5,
  minSuppressionSeconds: 2,
  maxSuppressionSeconds: 5,
  moraleRecoveryPerSecond: 0.15,
});

/**
 * Picks the airframe zone nearest an impact point. This is the entire anti-hidden-crit
 * guarantee: which component takes a hit is a pure function of where the hit landed, so the
 * same shot fired at the same spot always damages the same system. There is no roll anywhere
 * in this file — the PRD explicitly forbids hidden random critical hits, and geometry is the
 * only input the resolver is given.
 */
export const resolveHitZone = (localPoint: Vec2, zones: readonly AirframeZone[]): ComponentSlot => {
  let nearest: AirframeZone | null = null;
  let nearestDistanceSq = Infinity;
  for (const zone of zones) {
    const dx = localPoint.x - zone.offset.x;
    const dy = localPoint.y - zone.offset.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < nearestDistanceSq) {
      nearestDistanceSq = distanceSq;
      nearest = zone;
    }
  }
  if (nearest === null) throw new Error('resolveHitZone requires at least one airframe zone');
  return nearest.slot;
};

/** Accumulated fuel-system damage. Lives outside `Helicopter` because a leak rate is a rate of
 * change, not a health value, and fits alongside it as companion damage state instead. */
export interface FuelSystemState {
  leakRatePerSecond: number;
  hitCount: number;
}

/** Companion damage bookkeeping the `Helicopter` component does not have room for. */
export interface DamageState {
  fuelSystem: FuelSystemState;
  /** Passengers injured so far, capped at the current passenger count. Never a kill count. */
  passengersInjured: number;
}

export const createDamageState = (): DamageState => ({
  fuelSystem: { leakRatePerSecond: 0, hitCount: 0 },
  passengersInjured: 0,
});

export const isFuelFireRisk = (state: DamageState, tuning: DamageTuning): boolean =>
  state.fuelSystem.hitCount >= tuning.fireRiskHitCount;

/** Everything a HUD, audio cue, or feedback layer needs to react to one damage application. */
export interface DamageApplicationResult {
  component: ComponentSlot;
  amountApplied: number;
  /** True the tick a component newly crossed a named threshold (lift failure, fire risk, ...). */
  thresholdCrossed: boolean;
  /** Passengers injured by this specific hit, 0 for anything but a qualifying bay hit. */
  passengersInjured: number;
  destroyed: boolean;
}

/**
 * Applies one `DamagePacket` to the player helicopter. The hit lands on exactly one airframe
 * zone (see `resolveHitZone`) and only that zone's resource changes — a shell that strikes the
 * tail rotor does not also chip the hull, because the hull is itself just another named zone,
 * not a universal damage sink layered under every other system.
 */
export const applyDamagePacket = (
  helicopter: Helicopter,
  state: DamageState,
  packet: DamagePacket,
  tuning: DamageTuning,
): DamageApplicationResult => {
  const localPoint: Vec2 = {
    x: packet.at.x - helicopter.position.x,
    y: packet.at.y - helicopter.position.y,
  };
  const component = resolveHitZone(localPoint, tuning.airframeZones);

  const result: DamageApplicationResult = {
    component,
    amountApplied: packet.amount,
    thresholdCrossed: false,
    passengersInjured: 0,
    destroyed: false,
  };

  switch (component) {
    case 'hull': {
      const before = helicopter.hull;
      helicopter.hull = clamp(before - packet.amount * tuning.hullDamagePerAmount, 0, 1);
      result.thresholdCrossed =
        before > tuning.hullCriticalThreshold && helicopter.hull <= tuning.hullCriticalThreshold;
      if (before > 0 && helicopter.hull <= 0 && helicopter.destroyedFor === null) {
        helicopter.destroyedFor = 0;
        result.destroyed = true;
      }
      break;
    }
    case 'engine': {
      const before = helicopter.engine;
      helicopter.engine = clamp(before - packet.amount * tuning.engineDamagePerHit, 0, 1);
      result.thresholdCrossed =
        before > tuning.liftFailureThreshold && helicopter.engine <= tuning.liftFailureThreshold;
      break;
    }
    case 'rotor': {
      const before = helicopter.rotor;
      helicopter.rotor = clamp(before - packet.amount * tuning.rotorDamagePerHit, 0, 1);
      result.thresholdCrossed =
        before > tuning.liftFailureThreshold && helicopter.rotor <= tuning.liftFailureThreshold;
      break;
    }
    case 'fuel': {
      const before = state.fuelSystem.hitCount;
      state.fuelSystem.hitCount = before + 1;
      state.fuelSystem.leakRatePerSecond += tuning.fuelLeakPerHit;
      result.thresholdCrossed =
        before < tuning.fireRiskHitCount && state.fuelSystem.hitCount >= tuning.fireRiskHitCount;
      break;
    }
    case 'weapons': {
      const before = helicopter.weaponHeat;
      helicopter.weaponHeat = clamp(before + packet.amount * tuning.weaponHeatPerHit, 0, 1);
      result.thresholdCrossed =
        before < tuning.weaponSpreadHeatThreshold &&
        helicopter.weaponHeat >= tuning.weaponSpreadHeatThreshold;
      break;
    }
    case 'bay': {
      // A hit that does not clear the injury threshold, or an empty bay, just rattles the cabin.
      if (packet.amount >= tuning.bayInjuryThreshold && helicopter.passengers.length > 0) {
        const room = helicopter.passengers.length - state.passengersInjured;
        const injured = Math.max(0, Math.min(tuning.passengersInjuredPerHit, room));
        state.passengersInjured += injured;
        result.passengersInjured = injured;
        result.thresholdCrossed = injured > 0;
      }
      break;
    }
  }

  return result;
};

/**
 * Ongoing fuel burn from an active leak, applied once per fixed step alongside the flight
 * model's own fuel burn. Returns the amount actually leaked so feedback layers can drive a
 * fire/smoke intensity without re-deriving it from the leak rate.
 */
export const stepFuelLeak = (helicopter: Helicopter, state: DamageState, dt: number): number => {
  const { leakRatePerSecond } = state.fuelSystem;
  if (leakRatePerSecond <= 0 || helicopter.fuel <= 0) return 0;
  const leaked = Math.min(helicopter.fuel, leakRatePerSecond * dt);
  helicopter.fuel -= leaked;
  return leaked;
};

/**
 * Multiplier applied to an explosive packet's base amount at a given distance from the blast
 * centre: 1 at the centre, falling off linearly to 0 at `radius` and staying there beyond it.
 * A straight line rather than a curve, so a caller distributing splash across several targets
 * can reason about it without also importing tuning.
 */
export const splashFalloff = (distance: number, radius: number): number => {
  if (radius <= 0) return distance <= 0 ? 1 : 0;
  return clamp(1 - distance / radius, 0, 1);
};

/** Lift available from the flight model's perspective — the worse of engine/rotor health, since
 * a healthy engine cannot compensate for blades that are half gone and vice versa. */
export const liftMultiplier = (helicopter: Helicopter, tuning: DamageTuning): number => {
  const health = clamp(Math.min(helicopter.engine, helicopter.rotor), 0, 1);
  return tuning.minLiftMultiplier + (1 - tuning.minLiftMultiplier) * health;
};

/** True once engine or rotor damage is severe enough that the flight model should override
 * player input with a forced descent, per the PRD's "severe damage produces a forced descent". */
export const forcedDescent = (helicopter: Helicopter, tuning: DamageTuning): boolean =>
  Math.min(helicopter.engine, helicopter.rotor) <= tuning.forcedDescentThreshold;

/** Extra weapon spread from accumulated heat damage, 0 below the threshold and ramping to
 * `maxWeaponSpreadPenalty` as heat approaches 1. */
export const weaponSpreadPenalty = (helicopter: Helicopter, tuning: DamageTuning): number => {
  if (helicopter.weaponHeat <= tuning.weaponSpreadHeatThreshold) return 0;
  const t = clamp(inverseLerp(tuning.weaponSpreadHeatThreshold, 1, helicopter.weaponHeat), 0, 1);
  return tuning.maxWeaponSpreadPenalty * t;
};

/**
 * Suppression state for infantry and exposed gunners. `value` is composure (1 = steady, 0 =
 * broken); `suppressedFor` is the countdown that currently keeps them in cover. Both are driven
 * only by `applyNearMiss`, `applySuppressiveFire`, and `stepMorale` below — no RNG, so the same
 * sequence of fire always produces the same cover window.
 */
export interface Morale {
  value: number;
  suppressedFor: number;
}

export const createMorale = (): Morale => ({ value: 1, suppressedFor: 0 });

export const isSuppressed = (morale: Morale): boolean => morale.suppressedFor > 0;

/**
 * A single startling event — a rocket or burst that lands close without a hit. Closer misses
 * cost more composure and buy a longer cover window; the window is always inside the PRD's
 * 2-5 second band because `lerp` never leaves the [min, max] range it is given.
 */
export const applyNearMiss = (morale: Morale, distance: number, tuning: DamageTuning): void => {
  // Anything at or past the radius was not "near" — it should not touch composure at all,
  // rather than fall through to the same minimum window an edge-of-radius miss would produce.
  if (distance >= tuning.nearMissRadius) return;
  const closeness = clamp(1 - distance / tuning.nearMissRadius, 0, 1);
  morale.value = clamp(morale.value - tuning.nearMissMoraleLoss * closeness, 0, 1);
  const duration = lerp(tuning.minSuppressionSeconds, tuning.maxSuppressionSeconds, closeness);
  morale.suppressedFor = Math.max(morale.suppressedFor, duration);
};

/**
 * Sustained fire trained on the unit, applied once per fixed step with `intensity` in 0..1 (how
 * much of the incoming fire is actually landing near them this tick). Once composure drops to
 * the suppression threshold they take cover; the longer composure has been ground down past
 * that threshold, the longer they stay down, again clamped into the 2-5 second band.
 */
export const applySuppressiveFire = (
  morale: Morale,
  intensity: number,
  dt: number,
  tuning: DamageTuning,
): void => {
  const pressure = clamp(intensity, 0, 1);
  morale.value = clamp(
    morale.value - tuning.sustainedFireMoraleLossPerSecond * pressure * dt,
    0,
    1,
  );
  if (morale.value <= tuning.suppressionMoraleThreshold) {
    const severity = clamp(1 - morale.value / tuning.suppressionMoraleThreshold, 0, 1);
    const duration = lerp(tuning.minSuppressionSeconds, tuning.maxSuppressionSeconds, severity);
    morale.suppressedFor = Math.max(morale.suppressedFor, duration);
  }
};

/**
 * One fixed step of morale bookkeeping: counts down the current cover window and lets composure
 * climb back on its own once the pressure that broke it has stopped. Call this every tick,
 * independent of whether fire was applied that tick.
 */
export const stepMorale = (morale: Morale, dt: number, tuning: DamageTuning): void => {
  if (morale.suppressedFor > 0) morale.suppressedFor = Math.max(0, morale.suppressedFor - dt);
  morale.value = clamp(morale.value + tuning.moraleRecoveryPerSecond * dt, 0, 1);
};
