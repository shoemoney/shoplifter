import { clamp, degToRad, lerp, type Vec2 } from '@/core/math.js';
import type { Rng } from '@/core/rng.js';
import type { EntityId } from '../components.js';
import type { ProjectileSpawnParams } from './projectiles.js';

/**
 * All player-weapon numbers in one object. The PRD gives exact figures for the door gun and
 * flares and looser guidance for rockets, so everything lives here as a single tunable block
 * rather than scattered constants — this should move to `src/content/balance/weapons.json` with
 * a matching zod schema in a later milestone, the same way flight tuning already has one.
 */
export interface WeaponTuning {
  /** Fraction per second added while the trigger is held. */
  doorGunHeatPerSecond: number;
  /** Fraction per second removed once the cooling delay has elapsed. */
  doorGunCoolingPerSecond: number;
  /** Seconds after the trigger is released before cooling begins. */
  doorGunCoolingDelaySeconds: number;
  /** Heat at which the gun locks out. Always 1.0 per the PRD; kept as data, not a magic number. */
  doorGunOverheatThreshold: number;
  /** Heat the gun must cool back down to before lockout clears. */
  doorGunLockoutRecoverThreshold: number;
  /** Seconds into an unbroken burst before spread starts to grow. */
  doorGunAccurateSeconds: number;
  doorGunBaseSpreadRadians: number;
  doorGunMaxSpreadRadians: number;
  /** Seconds to ramp from base to max spread once past the accurate window. */
  doorGunSpreadRampSeconds: number;
  doorGunDamage: number;
  doorGunBulletSpeed: number;
  doorGunBulletLifetimeSeconds: number;
  /**
   * Metres. The PRD specifies "70% of screen width"; the default camera's base world width
   * (`src/render/camera.ts`, `defaultCameraTuning().baseWorldWidth`) is 60 m, so 42 m is that
   * figure at rest. Sim code must not import the renderer, so this is a snapshot, not a live
   * computation — revisit if the base world width ever changes.
   */
  doorGunFalloffStartMetres: number;
  /** Metres past the falloff start over which damage ramps down to the floor multiplier. */
  doorGunFalloffRangeMetres: number;
  /** Damage multiplier at and beyond the end of the falloff range. */
  doorGunFalloffMinMultiplier: number;

  rocketsInitial: number;
  rocketDamage: number;
  rocketSpeed: number;
  rocketLifetimeSeconds: number;
  rocketSplashRadiusMetres: number;
  /** Half-angle of the semi-active soft-lock cone, radians either side of boresight. */
  rocketLockConeHalfAngleRadians: number;
  /** A candidate whose line-to-target passes within this many metres of a civilian is refused. */
  rocketCivilianBlockRadiusMetres: number;

  flareCharges: number;
  /** Seconds to regenerate one charge, when not paused by an active lock. */
  flareRechargeSeconds: number;
  /** Deploying with time-to-impact inside this window fully breaks a heat-seeking lock. */
  flareBreakWindowMinSeconds: number;
  flareBreakWindowMaxSeconds: number;
  /** Wider band either side of the break window: still helps, just degrades accuracy. */
  flareDegradedWindowMinSeconds: number;
  flareDegradedWindowMaxSeconds: number;
  /** Accuracy penalty applied to the incoming missile on a 'degraded' outcome, 0..1. */
  flareDegradedAccuracyPenalty: number;
}

export const defaultWeaponTuning = (): WeaponTuning => ({
  doorGunHeatPerSecond: 0.28,
  doorGunCoolingPerSecond: 0.22,
  doorGunCoolingDelaySeconds: 0.25,
  doorGunOverheatThreshold: 1.0,
  doorGunLockoutRecoverThreshold: 0.55,
  doorGunAccurateSeconds: 0.6,
  doorGunBaseSpreadRadians: degToRad(1),
  doorGunMaxSpreadRadians: degToRad(9),
  doorGunSpreadRampSeconds: 1.2,
  doorGunDamage: 8,
  doorGunBulletSpeed: 260,
  doorGunBulletLifetimeSeconds: 1.5,
  doorGunFalloffStartMetres: 42,
  doorGunFalloffRangeMetres: 30,
  doorGunFalloffMinMultiplier: 0.35,

  rocketsInitial: 8,
  rocketDamage: 65,
  rocketSpeed: 90,
  rocketLifetimeSeconds: 4,
  rocketSplashRadiusMetres: 6,
  rocketLockConeHalfAngleRadians: degToRad(12),
  rocketCivilianBlockRadiusMetres: 3,

  flareCharges: 2,
  flareRechargeSeconds: 8,
  flareBreakWindowMinSeconds: 0.4,
  flareBreakWindowMaxSeconds: 1.4,
  flareDegradedWindowMinSeconds: 0.15,
  flareDegradedWindowMaxSeconds: 2.5,
  flareDegradedAccuracyPenalty: 0.4,
});

/** Mutable weapon state carried on the player entity, alongside `Helicopter`. */
export interface WeaponsState {
  heat: number;
  overheated: boolean;
  /** Seconds since the trigger was last released; drives the cooling delay. */
  timeSinceLastFire: number;
  /** Seconds since the current unbroken burst began; drives spread growth. */
  burstElapsed: number;
  rockets: number;
  flares: number;
  /** Seconds accumulated toward the next flare charge. */
  flareRechargeElapsed: number;
}

export const createWeaponsState = (tuning: WeaponTuning): WeaponsState => ({
  heat: 0,
  overheated: false,
  timeSinceLastFire: Number.POSITIVE_INFINITY,
  burstElapsed: 0,
  rockets: tuning.rocketsInitial,
  flares: tuning.flareCharges,
  flareRechargeElapsed: 0,
});

// --- Door gun ----------------------------------------------------------------------------------

export interface DoorGunStepResult {
  /** True this tick when the gun is actually cycling — trigger held and not locked out. */
  firing: boolean;
  /** Current spread half-angle in radians. */
  spreadRadians: number;
  /** Set on the exact tick heat reaches the overheat threshold. */
  justOverheated: boolean;
  /** Set on the exact tick heat falls back through the lockout-recover threshold. */
  justRecovered: boolean;
}

/** Spread grows linearly from base to max once a burst runs past its accurate window. */
const burstSpread = (burstElapsed: number, tuning: WeaponTuning): number => {
  const overtime = burstElapsed - tuning.doorGunAccurateSeconds;
  if (overtime <= 0) return tuning.doorGunBaseSpreadRadians;
  const t = clamp(overtime / tuning.doorGunSpreadRampSeconds, 0, 1);
  return lerp(tuning.doorGunBaseSpreadRadians, tuning.doorGunMaxSpreadRadians, t);
};

/**
 * One fixed step of the door gun's heat and spread model. Mutates `state` in place and reports
 * the edges the presentation layer cares about, the same shape `stepFlight` uses.
 */
export const stepDoorGun = (
  state: WeaponsState,
  tuning: WeaponTuning,
  trigger: boolean,
  dt: number,
): DoorGunStepResult => {
  const wantsToFire = trigger && !state.overheated;

  if (wantsToFire) {
    state.burstElapsed += dt;
    state.timeSinceLastFire = 0;
    state.heat = clamp(
      state.heat + tuning.doorGunHeatPerSecond * dt,
      0,
      tuning.doorGunOverheatThreshold,
    );
  } else {
    state.burstElapsed = 0;
    state.timeSinceLastFire += dt;
  }

  const wasOverheated = state.overheated;
  if (!wasOverheated && state.heat >= tuning.doorGunOverheatThreshold) {
    state.overheated = true;
  }

  // Cooling only ever runs while the trigger is not actively adding heat, and only after the
  // spin-down delay — a barrel does not start shedding heat the instant you let go.
  if (!wantsToFire && state.timeSinceLastFire >= tuning.doorGunCoolingDelaySeconds) {
    state.heat = Math.max(0, state.heat - tuning.doorGunCoolingPerSecond * dt);
  }

  let justRecovered = false;
  if (state.overheated && state.heat <= tuning.doorGunLockoutRecoverThreshold) {
    state.overheated = false;
    justRecovered = true;
  }

  return {
    firing: wantsToFire,
    spreadRadians: burstSpread(state.burstElapsed, tuning),
    justOverheated: !wasOverheated && state.overheated,
    justRecovered,
  };
};

/** Damage at range, per the PRD's falloff-past-70%-of-screen-width rule. */
export const doorGunDamageAtRange = (distanceMetres: number, tuning: WeaponTuning): number => {
  if (distanceMetres <= tuning.doorGunFalloffStartMetres) return tuning.doorGunDamage;
  const t = clamp(
    (distanceMetres - tuning.doorGunFalloffStartMetres) / tuning.doorGunFalloffRangeMetres,
    0,
    1,
  );
  return lerp(tuning.doorGunDamage, tuning.doorGunDamage * tuning.doorGunFalloffMinMultiplier, t);
};

export interface DoorGunFireOutcome {
  step: DoorGunStepResult;
  /** null when the gun did not actually cycle this tick (trigger released, or locked out). */
  spawnParams: ProjectileSpawnParams | null;
}

/**
 * Steps the heat model and, if the gun is actually firing this tick, produces a bullet spawn
 * request with the burst's current spread jittered in. The caller feeds `spawnParams` into a
 * `ProjectilePool`; this module never touches the pool directly so it stays testable alone.
 */
export const fireDoorGun = (
  state: WeaponsState,
  tuning: WeaponTuning,
  origin: Vec2,
  aimAngleRadians: number,
  trigger: boolean,
  dt: number,
  rng: Rng,
  sourceId: EntityId | null,
): DoorGunFireOutcome => {
  const step = stepDoorGun(state, tuning, trigger, dt);
  if (!step.firing) return { step, spawnParams: null };

  const angle = aimAngleRadians + rng.range(-step.spreadRadians, step.spreadRadians);
  return {
    step,
    spawnParams: {
      kind: 'bullet',
      team: 'player',
      position: { x: origin.x, y: origin.y },
      velocity: {
        x: Math.cos(angle) * tuning.doorGunBulletSpeed,
        y: Math.sin(angle) * tuning.doorGunBulletSpeed,
      },
      damage: tuning.doorGunDamage,
      splashRadius: 0,
      lifetimeSeconds: tuning.doorGunBulletLifetimeSeconds,
      targetId: null,
      turnRate: 0,
      sourceId,
    },
  };
};

// --- Rockets -------------------------------------------------------------------------------

export interface LockCandidate {
  id: EntityId;
  position: Vec2;
}

export interface RocketLockResult {
  targetId: EntityId | null;
  /** Off-boresight angle of the chosen target, radians. Null when nothing was acquired. */
  angleRadians: number | null;
}

/** Shortest distance from `p` to the segment `a`-`b`, without allocating a `Vec2`. */
const distancePointToSegment = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number => {
  const abx = bx - ax;
  const aby = by - ay;
  const abLenSq = abx * abx + aby * aby;
  const t = abLenSq === 0 ? 0 : clamp(((px - ax) * abx + (py - ay) * aby) / abLenSq, 0, 1);
  const closestX = ax + abx * t;
  const closestY = ay + aby * t;
  const dx = px - closestX;
  const dy = py - closestY;
  return Math.sqrt(dx * dx + dy * dy);
};

const normalizeAngle = (angle: number): number => {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

/**
 * Picks the candidate closest to boresight, inside the soft-lock cone, whose line of engagement
 * does not pass near a civilian. The PRD is explicit that rockets must never auto-select a
 * target through a civilian, so that check runs before the angle comparison, not after — a
 * blocked candidate is never a lock, no matter how central it is.
 */
export const acquireRocketLock = (
  origin: Vec2,
  aimAngleRadians: number,
  candidates: readonly LockCandidate[],
  civilianPositions: readonly Vec2[],
  tuning: WeaponTuning,
): RocketLockResult => {
  let bestId: EntityId | null = null;
  let bestAngle: number | null = null;

  for (const candidate of candidates) {
    const dx = candidate.position.x - origin.x;
    const dy = candidate.position.y - origin.y;
    if (dx === 0 && dy === 0) continue;

    const offBoresight = Math.abs(normalizeAngle(Math.atan2(dy, dx) - aimAngleRadians));
    if (offBoresight > tuning.rocketLockConeHalfAngleRadians) continue;

    const blockedByCivilian = civilianPositions.some(
      (civilian) =>
        distancePointToSegment(
          civilian.x,
          civilian.y,
          origin.x,
          origin.y,
          candidate.position.x,
          candidate.position.y,
        ) <= tuning.rocketCivilianBlockRadiusMetres,
    );
    if (blockedByCivilian) continue;

    if (bestAngle === null || offBoresight < bestAngle) {
      bestAngle = offBoresight;
      bestId = candidate.id;
    }
  }

  return { targetId: bestId, angleRadians: bestAngle };
};

export interface RocketFireOutcome {
  fired: boolean;
  spawnParams: ProjectileSpawnParams | null;
}

/**
 * Fires an unguided splash rocket along the aim direction. The soft lock above is an aiming and
 * HUD aid, not post-launch guidance — once fired, a rocket flies its line like the PRD's other
 * ballistic kinds, so no `targetId` is attached to the spawn.
 */
export const fireRocket = (
  state: WeaponsState,
  tuning: WeaponTuning,
  origin: Vec2,
  aimAngleRadians: number,
  sourceId: EntityId | null,
): RocketFireOutcome => {
  if (state.rockets <= 0) return { fired: false, spawnParams: null };
  state.rockets -= 1;

  return {
    fired: true,
    spawnParams: {
      kind: 'rocket',
      team: 'player',
      position: { x: origin.x, y: origin.y },
      velocity: {
        x: Math.cos(aimAngleRadians) * tuning.rocketSpeed,
        y: Math.sin(aimAngleRadians) * tuning.rocketSpeed,
      },
      damage: tuning.rocketDamage,
      splashRadius: tuning.rocketSplashRadiusMetres,
      lifetimeSeconds: tuning.rocketLifetimeSeconds,
      targetId: null,
      turnRate: 0,
      sourceId,
    },
  };
};

// --- Flares ----------------------------------------------------------------------------------

export interface IncomingLock {
  /** Seconds until the tracked missile would impact if its guidance is left undisturbed. */
  timeToImpactSeconds: number;
}

export type LockBreakOutcome = 'broken' | 'degraded' | 'missed-window';

export interface LockBreakResult {
  outcome: LockBreakOutcome;
  /** 1 = guidance fully defeated (guaranteed miss), 0 = no effect, between = degraded accuracy. */
  accuracyPenalty: number;
}

const classifyFlareTiming = (
  timeToImpactSeconds: number,
  tuning: WeaponTuning,
): LockBreakResult => {
  if (
    timeToImpactSeconds >= tuning.flareBreakWindowMinSeconds &&
    timeToImpactSeconds <= tuning.flareBreakWindowMaxSeconds
  ) {
    return { outcome: 'broken', accuracyPenalty: 1 };
  }
  if (
    timeToImpactSeconds >= tuning.flareDegradedWindowMinSeconds &&
    timeToImpactSeconds <= tuning.flareDegradedWindowMaxSeconds
  ) {
    return { outcome: 'degraded', accuracyPenalty: tuning.flareDegradedAccuracyPenalty };
  }
  return { outcome: 'missed-window', accuracyPenalty: 0 };
};

export interface FlareDeployResult {
  /** False when there was no charge to spend; nothing else in the result is meaningful then. */
  fired: boolean;
  lockBreak: LockBreakResult | null;
}

/**
 * Spends one flare charge, if any remain, and classifies the outcome against whatever missile is
 * currently tracking the player. `incomingLock === null` (nothing is locked on) always resolves
 * to 'missed-window' — the flare still launches and still costs a charge, it just has nothing to
 * defeat, exactly like popping a flare with no threat around in the real thing.
 */
export const deployFlare = (
  state: WeaponsState,
  tuning: WeaponTuning,
  incomingLock: IncomingLock | null,
): FlareDeployResult => {
  if (state.flares <= 0) return { fired: false, lockBreak: null };

  state.flares -= 1;
  // A charge just spent starts its own recharge clock fresh.
  state.flareRechargeElapsed = 0;

  if (incomingLock === null) {
    return { fired: true, lockBreak: { outcome: 'missed-window', accuracyPenalty: 0 } };
  }
  return { fired: true, lockBreak: classifyFlareTiming(incomingLock.timeToImpactSeconds, tuning) };
};

/**
 * Regenerates flare charges over time. Recharge is fully paused while a missile lock is active,
 * per the PRD — the aircraft that most needs a flare back is the one under threat, and the PRD
 * deliberately denies free refills during that window rather than rewarding it.
 */
export const stepFlareRecharge = (
  state: WeaponsState,
  tuning: WeaponTuning,
  dt: number,
  isUnderMissileLock: boolean,
): void => {
  if (isUnderMissileLock || state.flares >= tuning.flareCharges) return;

  state.flareRechargeElapsed += dt;
  while (
    state.flareRechargeElapsed >= tuning.flareRechargeSeconds &&
    state.flares < tuning.flareCharges
  ) {
    state.flareRechargeElapsed -= tuning.flareRechargeSeconds;
    state.flares += 1;
  }
  if (state.flares >= tuning.flareCharges) state.flareRechargeElapsed = 0;
};
