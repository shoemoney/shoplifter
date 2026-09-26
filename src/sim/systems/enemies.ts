import { length } from '@/core/math.js';
import type { Vec2 } from '@/core/math.js';
import type {
  Collider,
  CombatWorldView,
  EnemyKind,
  ProjectileKind,
  Team,
} from '../combat/types.js';
import { box, circle } from '../combat/types.js';
import type { EntityId } from '../components.js';

// TODO(balance): every tuning number below is a design placeholder, not a measurement. It
// belongs in a content/balance JSON file validated by the schema loader (see
// src/content/schemas/flight.ts for the pattern) once that pipeline exists for enemies. Until
// then it is centralised here, in one factory per kind, specifically so that migration is a
// mechanical extraction rather than a hunt through scattered literals.

// --- Small local geometry helpers -----------------------------------------------------------
// core/math.ts intentionally has no vector subtract/normalize — most callers there work in
// scalar axes. Enemies reason in full 2D aim vectors constantly, so the handful of helpers
// live here rather than growing the shared module for one file's convenience.

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });

const distance = (a: Vec2, b: Vec2): number => length(sub(a, b));

const normalize = (v: Vec2): Vec2 => {
  const len = length(v);
  return len > 1e-9 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 };
};

const angleOf = (v: Vec2): number => Math.atan2(v.y, v.x);

/** Wraps to (-PI, PI] so angular differences never take the long way around. */
const wrapAngle = (radians: number): number => {
  let r = radians % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r < -Math.PI) r += Math.PI * 2;
  return r;
};

const moveAngleToward = (current: number, target: number, maxDelta: number): number => {
  const delta = wrapAngle(target - current);
  if (Math.abs(delta) <= maxDelta) return wrapAngle(current + delta);
  return wrapAngle(current + Math.sign(delta) * maxDelta);
};

/**
 * Deterministic stand-in for firing inaccuracy. `Math.random()` is banned in simulation code
 * (replays must reproduce byte-for-byte), and pulling in the `Rng` here would mean every
 * infantryman needs its own persistent RNG stream just to wobble a shot. Two incommensurate
 * sine waves — the same trick `rotorNoise` uses in flight.ts — give a shot-to-shot spread that
 * never repeats in lockstep across units (the `id` term dephases them) but is bit-identical on
 * replay.
 */
const deterministicSpread = (id: EntityId, tick: number, amplitude: number): number => {
  if (amplitude <= 0) return 0;
  const phase = id * 12.9898;
  return (
    amplitude * (Math.sin(phase + tick * 0.73) * 0.7 + Math.sin(phase * 1.7 + tick * 0.31) * 0.3)
  );
};

// --- Shared step contract ---------------------------------------------------------------------

/**
 * What a step returns instead of a live projectile. Enemies never touch the projectile pool —
 * that keeps this module testable with nothing but a fake `CombatWorldView`, and lets the
 * integration layer decide pooling, VFX, and audio without enemies knowing any of it exists.
 */
export interface FireIntent {
  projectile: ProjectileKind;
  origin: Vec2;
  /** Unit vector. */
  direction: Vec2;
  speed: number;
  sourceTeam: Team;
}

export interface EnemyStepResult {
  fire: FireIntent | null;
  moved: boolean;
  /** Name of the state just entered this tick, or null when the state held. */
  stateChanged: string | null;
}

const noResult = (): EnemyStepResult => ({ fire: null, moved: false, stateChanged: null });

interface BaseEnemyState {
  id: EntityId;
  team: Team;
  position: Vec2;
  collider: Collider;
}

// --- Rifle infantry ------------------------------------------------------------------------

export interface RifleInfantryTuning {
  patrolRadius: number;
  patrolSpeed: number;
  range: number;
  /** Metres. Rifles only engage the helicopter at or below this altitude — see PRD "low altitude". */
  lowAltitudeThreshold: number;
  /** Minimum 0.7s, per the PRD's global no-lethal-attack-without-warning rule. */
  telegraphSeconds: number;
  burstCooldownSeconds: number;
  suppressionSeconds: number;
  bulletSpeed: number;
  accuracySpreadRadians: number;
}

export type RifleInfantryPhase = 'patrol' | 'cover' | 'aiming' | 'suppressed';

export interface RifleInfantryState extends BaseEnemyState {
  kind: 'rifleInfantry';
  state: RifleInfantryPhase;
  patrolCenter: Vec2;
  patrolDirection: -1 | 1;
  aimTimer: number;
  burstCooldown: number;
  suppressionTimer: number;
  /** Set by the collision/damage system when a near miss lands; consumed on the next step. */
  pendingSuppression: boolean;
}

export const createRifleInfantry = (id: EntityId, position: Vec2): RifleInfantryState => ({
  id,
  team: 'hostile',
  position: { ...position },
  collider: circle(0.4),
  kind: 'rifleInfantry',
  state: 'patrol',
  patrolCenter: { ...position },
  patrolDirection: 1,
  aimTimer: 0,
  burstCooldown: 0,
  suppressionTimer: 0,
  pendingSuppression: false,
});

const canRifleEngage = (
  rifle: RifleInfantryState,
  view: CombatWorldView,
  tuning: RifleInfantryTuning,
): boolean =>
  !view.player.destroyed &&
  view.player.heightAboveGround <= tuning.lowAltitudeThreshold &&
  distance(rifle.position, view.player.position) <= tuning.range &&
  view.hasLineOfSight(rifle.position, view.player.position);

const stepRifleInfantry = (
  rifle: RifleInfantryState,
  view: CombatWorldView,
  tuning: RifleInfantryTuning,
): EnemyStepResult => {
  const result = noResult();

  // A near miss overrides whatever the unit was doing — cover first, everything else waits.
  if (rifle.pendingSuppression) {
    rifle.pendingSuppression = false;
    if (rifle.state !== 'suppressed') {
      rifle.state = 'suppressed';
      rifle.suppressionTimer = tuning.suppressionSeconds;
      result.stateChanged = 'suppressed';
      return result;
    }
  }

  switch (rifle.state) {
    case 'patrol': {
      rifle.position.x += rifle.patrolDirection * tuning.patrolSpeed * view.dt;
      result.moved = true;
      if (Math.abs(rifle.position.x - rifle.patrolCenter.x) >= tuning.patrolRadius) {
        rifle.patrolDirection = rifle.patrolDirection === 1 ? -1 : 1;
      }
      if (canRifleEngage(rifle, view, tuning)) {
        rifle.state = 'aiming';
        rifle.aimTimer = tuning.telegraphSeconds;
        result.stateChanged = 'aiming';
      }
      break;
    }
    case 'aiming': {
      if (!canRifleEngage(rifle, view, tuning)) {
        rifle.state = 'patrol';
        result.stateChanged = 'patrol';
        break;
      }
      rifle.aimTimer -= view.dt;
      if (rifle.aimTimer <= 0) {
        const base = angleOf(sub(view.player.position, rifle.position));
        const jittered =
          base + deterministicSpread(rifle.id, view.tick, tuning.accuracySpreadRadians);
        result.fire = {
          projectile: 'bullet',
          origin: { ...rifle.position },
          direction: { x: Math.cos(jittered), y: Math.sin(jittered) },
          speed: tuning.bulletSpeed,
          sourceTeam: 'hostile',
        };
        rifle.state = 'cover';
        rifle.burstCooldown = tuning.burstCooldownSeconds;
        result.stateChanged = 'cover';
      }
      break;
    }
    case 'cover': {
      rifle.burstCooldown -= view.dt;
      if (rifle.burstCooldown <= 0) {
        if (canRifleEngage(rifle, view, tuning)) {
          rifle.state = 'aiming';
          rifle.aimTimer = tuning.telegraphSeconds;
          result.stateChanged = 'aiming';
        } else {
          rifle.state = 'patrol';
          result.stateChanged = 'patrol';
        }
      }
      break;
    }
    case 'suppressed': {
      rifle.suppressionTimer -= view.dt;
      if (rifle.suppressionTimer <= 0) {
        rifle.state = 'cover';
        rifle.burstCooldown = 0;
        result.stateChanged = 'cover';
      }
      break;
    }
  }

  return result;
};

// --- RPG infantry ----------------------------------------------------------------------------

export interface RpgInfantryTuning {
  range: number;
  /** The PRD fixes this at 1.1s exactly. */
  telegraphSeconds: number;
  relocateSeconds: number;
  relocateSpeed: number;
  relocateDistance: number;
  rocketSpeed: number;
  /** Player speed below this counts as "hovering" for target priority. */
  hoverSpeedThreshold: number;
}

export type RpgInfantryPhase = 'seeking' | 'telegraph' | 'relocating';

export interface RpgInfantryState extends BaseEnemyState {
  kind: 'rpgInfantry';
  state: RpgInfantryPhase;
  aimTimer: number;
  relocateTimer: number;
  relocateTarget: Vec2;
}

export const createRpgInfantry = (id: EntityId, position: Vec2): RpgInfantryState => ({
  id,
  team: 'hostile',
  position: { ...position },
  collider: circle(0.4),
  kind: 'rpgInfantry',
  state: 'seeking',
  aimTimer: 0,
  relocateTimer: 0,
  relocateTarget: { ...position },
});

const canRpgEngage = (
  rpg: RpgInfantryState,
  view: CombatWorldView,
  tuning: RpgInfantryTuning,
): boolean => {
  if (view.player.destroyed) return false;
  if (distance(rpg.position, view.player.position) > tuning.range) return false;
  if (!view.hasLineOfSight(rpg.position, view.player.position)) return false;
  const speed = length(view.player.velocity);
  return view.player.grounded || speed <= tuning.hoverSpeedThreshold;
};

const stepRpgInfantry = (
  rpg: RpgInfantryState,
  view: CombatWorldView,
  tuning: RpgInfantryTuning,
): EnemyStepResult => {
  const result = noResult();

  switch (rpg.state) {
    case 'seeking': {
      if (canRpgEngage(rpg, view, tuning)) {
        rpg.state = 'telegraph';
        rpg.aimTimer = tuning.telegraphSeconds;
        result.stateChanged = 'telegraph';
      }
      break;
    }
    case 'telegraph': {
      // Losing the target mid-telegraph aborts the shot — this is the glint/audio warning the
      // player is meant to react to, not a guaranteed hit once it starts.
      if (!canRpgEngage(rpg, view, tuning)) {
        rpg.state = 'seeking';
        result.stateChanged = 'seeking';
        break;
      }
      rpg.aimTimer -= view.dt;
      if (rpg.aimTimer <= 0) {
        result.fire = {
          projectile: 'rpg',
          origin: { ...rpg.position },
          direction: normalize(sub(view.player.position, rpg.position)),
          speed: tuning.rocketSpeed,
          sourceTeam: 'hostile',
        };
        // Deterministic relocation away from the player's side rather than an RNG draw — a
        // fireteam that always displaces off-axis reads as trained, not lucky.
        const away = view.player.position.x >= rpg.position.x ? -1 : 1;
        rpg.relocateTarget = {
          x: rpg.position.x + away * tuning.relocateDistance,
          y: rpg.position.y,
        };
        rpg.relocateTimer = tuning.relocateSeconds;
        rpg.state = 'relocating';
        result.stateChanged = 'relocating';
      }
      break;
    }
    case 'relocating': {
      rpg.relocateTimer -= view.dt;
      const toTarget = sub(rpg.relocateTarget, rpg.position);
      const remaining = length(toTarget);
      if (remaining > 1e-3) {
        const step = Math.min(remaining, tuning.relocateSpeed * view.dt);
        const dir = normalize(toTarget);
        rpg.position.x += dir.x * step;
        rpg.position.y += dir.y * step;
        result.moved = true;
      }
      if (remaining <= 1e-3 || rpg.relocateTimer <= 0) {
        rpg.state = 'seeking';
        result.stateChanged = 'seeking';
      }
      break;
    }
  }

  return result;
};

// --- Light tank --------------------------------------------------------------------------------

export interface LightTankTuning {
  laneSpeed: number;
  turretTraverseRadPerSec: number;
  turretAimToleranceRad: number;
  /** Turret cannot elevate past this — the PRD's "cannot hit a high helicopter" rule. */
  maxElevationRad: number;
  range: number;
  telegraphSeconds: number;
  cooldownSeconds: number;
  shellSpeed: number;
  /** Half-angle, centred directly behind the hull, that counts as a rear-armour hit. */
  rearArcRad: number;
  rearArmorMultiplier: number;
  frontArmorMultiplier: number;
}

export type LightTankPhase = 'patrol' | 'tracking' | 'aiming' | 'cooldown';

export interface LightTankState extends BaseEnemyState {
  kind: 'lightTank';
  state: LightTankPhase;
  hullFacing: -1 | 1;
  laneMin: number;
  laneMax: number;
  /** World-space radians the barrel currently points, independent of hull facing. */
  turretAngle: number;
  aimTimer: number;
  cooldownTimer: number;
  /** True when the turret is aligned and the shot is unobstructed — HUD-observable. */
  firingLineClear: boolean;
}

export const createLightTank = (
  id: EntityId,
  position: Vec2,
  laneMin: number,
  laneMax: number,
): LightTankState => ({
  id,
  team: 'hostile',
  position: { ...position },
  collider: box(1.2, 0.7),
  kind: 'lightTank',
  state: 'patrol',
  hullFacing: 1,
  laneMin,
  laneMax,
  turretAngle: 0,
  aimTimer: 0,
  cooldownTimer: 0,
  firingLineClear: false,
});

/** Pure so both the step function and tests can ask "would this geometry even let it fire". */
export const canLightTankEngage = (
  tank: LightTankState,
  view: CombatWorldView,
  tuning: LightTankTuning,
): boolean => {
  if (view.player.destroyed) return false;
  const toTarget = sub(view.player.position, tank.position);
  const horizontal = Math.abs(toTarget.x);
  if (horizontal < 1e-6 && Math.abs(toTarget.y) < 1e-6) return true;
  const elevation = Math.atan2(toTarget.y, Math.max(horizontal, 1e-6));
  if (Math.abs(elevation) > tuning.maxElevationRad) return false;
  if (distance(tank.position, view.player.position) > tuning.range) return false;
  return view.hasLineOfSight(tank.position, view.player.position);
};

/**
 * Rear-armour damage multiplier. `hitFrom` points from the tank toward wherever the shot
 * originated — the everyday sense of "hit from that direction". A hit from directly behind the
 * hull means `hitFrom` points opposite the hull's facing.
 */
export const lightTankDamageMultiplier = (
  tank: LightTankState,
  hitFrom: Vec2,
  tuning: LightTankTuning,
): number => {
  const hullAngle = tank.hullFacing === 1 ? 0 : Math.PI;
  const hitAngle = angleOf(hitFrom);
  const angleFromRear = Math.abs(wrapAngle(hitAngle - hullAngle - Math.PI));
  return angleFromRear <= tuning.rearArcRad
    ? tuning.rearArmorMultiplier
    : tuning.frontArmorMultiplier;
};

const stepLightTank = (
  tank: LightTankState,
  view: CombatWorldView,
  tuning: LightTankTuning,
): EnemyStepResult => {
  const result = noResult();

  if (tank.state === 'patrol' || tank.state === 'tracking') {
    tank.position.x += tank.hullFacing * tuning.laneSpeed * view.dt;
    result.moved = true;
    if (tank.position.x >= tank.laneMax) {
      tank.position.x = tank.laneMax;
      tank.hullFacing = -1;
    } else if (tank.position.x <= tank.laneMin) {
      tank.position.x = tank.laneMin;
      tank.hullFacing = 1;
    }
  }

  const engageable = canLightTankEngage(tank, view, tuning);
  const targetAngle = engageable
    ? angleOf(sub(view.player.position, tank.position))
    : tank.hullFacing === 1
      ? 0
      : Math.PI;
  const maxStep = tuning.turretTraverseRadPerSec * view.dt;
  tank.turretAngle = moveAngleToward(tank.turretAngle, targetAngle, maxStep);
  const aligned =
    Math.abs(wrapAngle(targetAngle - tank.turretAngle)) <= tuning.turretAimToleranceRad;
  tank.firingLineClear = engageable && aligned;

  switch (tank.state) {
    case 'patrol': {
      if (engageable) {
        tank.state = 'tracking';
        result.stateChanged = 'tracking';
      }
      break;
    }
    case 'tracking': {
      if (!engageable) {
        tank.state = 'patrol';
        result.stateChanged = 'patrol';
      } else if (tank.firingLineClear) {
        tank.state = 'aiming';
        tank.aimTimer = tuning.telegraphSeconds;
        result.stateChanged = 'aiming';
      }
      break;
    }
    case 'aiming': {
      if (!engageable) {
        tank.state = 'tracking';
        result.stateChanged = 'tracking';
        break;
      }
      tank.aimTimer -= view.dt;
      if (tank.aimTimer <= 0) {
        result.fire = {
          projectile: 'bullet',
          origin: { ...tank.position },
          direction: { x: Math.cos(tank.turretAngle), y: Math.sin(tank.turretAngle) },
          speed: tuning.shellSpeed,
          sourceTeam: 'hostile',
        };
        tank.state = 'cooldown';
        tank.cooldownTimer = tuning.cooldownSeconds;
        result.stateChanged = 'cooldown';
      }
      break;
    }
    case 'cooldown': {
      tank.cooldownTimer -= view.dt;
      if (tank.cooldownTimer <= 0) {
        tank.state = engageable ? 'tracking' : 'patrol';
        result.stateChanged = tank.state;
      }
      break;
    }
  }

  return result;
};

// --- AA gun --------------------------------------------------------------------------------

export interface AaGunTuning {
  range: number;
  telegraphSeconds: number;
  burstCount: number;
  burstIntervalSeconds: number;
  cooldownSeconds: number;
  suppressionSeconds: number;
  shellSpeed: number;
  scanSweepRadPerSec: number;
  scanConeHalfAngleRad: number;
}

export type AaGunPhase = 'idle' | 'aiming' | 'burst' | 'cooldown' | 'suppressed';

export interface AaGunState extends BaseEnemyState {
  kind: 'aaGun';
  state: AaGunPhase;
  radar: boolean;
  /** World-space radians the radar cone currently points — HUD/terrain-mask visualisation only. */
  scanAngle: number;
  aimTimer: number;
  burstShotsRemaining: number;
  burstTimer: number;
  cooldownTimer: number;
  suppressionTimer: number;
  pendingSuppression: boolean;
}

export const createAaGun = (id: EntityId, position: Vec2, radar = false): AaGunState => ({
  id,
  team: 'hostile',
  position: { ...position },
  collider: box(0.9, 0.9),
  kind: 'aaGun',
  state: 'idle',
  radar,
  scanAngle: 0,
  aimTimer: 0,
  burstShotsRemaining: 0,
  burstTimer: 0,
  cooldownTimer: 0,
  suppressionTimer: 0,
  pendingSuppression: false,
});

const canAaEngage = (aa: AaGunState, view: CombatWorldView, tuning: AaGunTuning): boolean =>
  !view.player.destroyed &&
  distance(aa.position, view.player.position) <= tuning.range &&
  view.hasLineOfSight(aa.position, view.player.position);

const stepAaGun = (aa: AaGunState, view: CombatWorldView, tuning: AaGunTuning): EnemyStepResult => {
  const result = noResult();

  if (aa.radar) {
    aa.scanAngle = wrapAngle(aa.scanAngle + tuning.scanSweepRadPerSec * view.dt);
  }

  if (aa.pendingSuppression) {
    aa.pendingSuppression = false;
    if (aa.state !== 'suppressed') {
      aa.state = 'suppressed';
      aa.suppressionTimer = tuning.suppressionSeconds;
      result.stateChanged = 'suppressed';
      return result;
    }
  }

  const engageable = canAaEngage(aa, view, tuning);

  switch (aa.state) {
    case 'idle': {
      if (engageable) {
        aa.state = 'aiming';
        aa.aimTimer = tuning.telegraphSeconds;
        result.stateChanged = 'aiming';
      }
      break;
    }
    case 'aiming': {
      if (!engageable) {
        aa.state = 'idle';
        result.stateChanged = 'idle';
        break;
      }
      aa.aimTimer -= view.dt;
      if (aa.aimTimer <= 0) {
        aa.state = 'burst';
        aa.burstShotsRemaining = tuning.burstCount;
        aa.burstTimer = 0;
        result.stateChanged = 'burst';
      }
      break;
    }
    case 'burst': {
      aa.burstTimer -= view.dt;
      if (aa.burstShotsRemaining > 0 && aa.burstTimer <= 0) {
        const lead = computeLeadAimpoint(
          aa.position,
          view.player.position,
          view.player.velocity,
          tuning.shellSpeed,
        );
        const aimAt = lead ?? view.player.position;
        result.fire = {
          projectile: 'aaShell',
          origin: { ...aa.position },
          direction: normalize(sub(aimAt, aa.position)),
          speed: tuning.shellSpeed,
          sourceTeam: 'hostile',
        };
        aa.burstShotsRemaining -= 1;
        aa.burstTimer = tuning.burstIntervalSeconds;
      }
      if (aa.burstShotsRemaining <= 0) {
        aa.state = 'cooldown';
        aa.cooldownTimer = tuning.cooldownSeconds;
        result.stateChanged = 'cooldown';
      }
      break;
    }
    case 'cooldown': {
      aa.cooldownTimer -= view.dt;
      if (aa.cooldownTimer <= 0) {
        aa.state = 'idle';
        result.stateChanged = 'idle';
      }
      break;
    }
    case 'suppressed': {
      aa.suppressionTimer -= view.dt;
      if (aa.suppressionTimer <= 0) {
        aa.state = 'idle';
        result.stateChanged = 'idle';
      }
      break;
    }
  }

  return result;
};

// --- Interceptor jet -------------------------------------------------------------------------

export interface JetTuning {
  /** Minimum 0.7s; the PRD's off-screen-warning floor applies to the jet more than anything. */
  warningSeconds: number;
  attackPassSeconds: number;
  missileVolleyCount: number;
  missileIntervalSeconds: number;
  missileSpeed: number;
  passSpeed: number;
  entryDistance: number;
  passAltitude: number;
  cooldownSeconds: number;
}

export type JetPhase = 'cooldown' | 'warning' | 'attackPass';

export interface JetState extends BaseEnemyState {
  kind: 'jet';
  state: JetPhase;
  /** Which side it entered/will enter from; the pass always crosses toward the opposite side. */
  side: -1 | 1;
  warningTimer: number;
  passTimer: number;
  missilesRemaining: number;
  missileTimer: number;
  cooldownTimer: number;
  velocity: Vec2;
}

export const createJet = (id: EntityId, side: -1 | 1, tuning: JetTuning): JetState => ({
  id,
  team: 'hostile',
  position: { x: side * tuning.entryDistance, y: tuning.passAltitude },
  collider: box(2.5, 0.8),
  kind: 'jet',
  state: 'cooldown',
  side,
  warningTimer: 0,
  passTimer: 0,
  missilesRemaining: 0,
  missileTimer: 0,
  cooldownTimer: 0,
  velocity: { x: 0, y: 0 },
});

const stepJet = (jet: JetState, view: CombatWorldView, tuning: JetTuning): EnemyStepResult => {
  const result = noResult();

  switch (jet.state) {
    case 'cooldown': {
      jet.cooldownTimer -= view.dt;
      if (jet.cooldownTimer <= 0) {
        jet.state = 'warning';
        jet.warningTimer = tuning.warningSeconds;
        result.stateChanged = 'warning';
      }
      break;
    }
    case 'warning': {
      jet.warningTimer -= view.dt;
      if (jet.warningTimer <= 0) {
        jet.position = { x: jet.side * tuning.entryDistance, y: tuning.passAltitude };
        jet.velocity = { x: -jet.side * tuning.passSpeed, y: 0 };
        jet.passTimer = tuning.attackPassSeconds;
        jet.missilesRemaining = tuning.missileVolleyCount;
        jet.missileTimer = tuning.missileIntervalSeconds;
        jet.state = 'attackPass';
        result.stateChanged = 'attackPass';
      }
      break;
    }
    case 'attackPass': {
      jet.position.x += jet.velocity.x * view.dt;
      jet.position.y += jet.velocity.y * view.dt;
      result.moved = true;
      jet.passTimer -= view.dt;

      if (jet.missilesRemaining > 0) {
        jet.missileTimer -= view.dt;
        if (jet.missileTimer <= 0) {
          result.fire = {
            projectile: 'jetMissile',
            origin: { ...jet.position },
            direction: normalize(sub(view.player.position, jet.position)),
            speed: tuning.missileSpeed,
            sourceTeam: 'hostile',
          };
          jet.missilesRemaining -= 1;
          jet.missileTimer = tuning.missileIntervalSeconds;
        }
      }

      if (jet.passTimer <= 0) {
        jet.state = 'cooldown';
        jet.cooldownTimer = tuning.cooldownSeconds;
        result.stateChanged = 'cooldown';
      }
      break;
    }
  }

  return result;
};

// --- Homing drone ----------------------------------------------------------------------------

export interface DroneTuning {
  speed: number;
  acquisitionRange: number;
  gunRange: number;
  /** Minimum 0.7s, once the tier-gated gun unlocks. */
  gunTelegraphSeconds: number;
  gunBoltSpeed: number;
  gunCooldownSeconds: number;
}

export type DronePhase = 'dormant' | 'pursuing';
export type DroneGunPhase = 'idle' | 'aiming' | 'cooldown';

export interface DroneState extends BaseEnemyState {
  kind: 'drone';
  state: DronePhase;
  acquired: boolean;
  /** Set by the director once escalation reaches the tier that grants the gun. */
  gunUnlocked: boolean;
  gunState: DroneGunPhase;
  aimTimer: number;
  gunCooldownTimer: number;
}

export const createDrone = (id: EntityId, position: Vec2): DroneState => ({
  id,
  team: 'hostile',
  position: { ...position },
  collider: circle(0.5),
  kind: 'drone',
  state: 'dormant',
  acquired: false,
  gunUnlocked: false,
  gunState: 'idle',
  aimTimer: 0,
  gunCooldownTimer: 0,
});

const stepDrone = (
  drone: DroneState,
  view: CombatWorldView,
  tuning: DroneTuning,
): EnemyStepResult => {
  const result = noResult();

  if (!drone.acquired) {
    const inRange = distance(drone.position, view.player.position) <= tuning.acquisitionRange;
    if (inRange && view.hasLineOfSight(drone.position, view.player.position)) {
      drone.acquired = true;
      drone.state = 'pursuing';
      result.stateChanged = 'pursuing';
    }
    return result;
  }

  // Deliberately no base-zone clamp here: the 1982 drone's special menace was that it could
  // follow you all the way home, and that is the one thing worth preserving verbatim.
  const toPlayer = sub(view.player.position, drone.position);
  const dist = length(toPlayer);
  if (dist > 1e-3) {
    const dir = normalize(toPlayer);
    const step = Math.min(dist, tuning.speed * view.dt);
    drone.position.x += dir.x * step;
    drone.position.y += dir.y * step;
    result.moved = true;
  }

  if (!drone.gunUnlocked) return result;

  const gunInRange =
    dist <= tuning.gunRange && view.hasLineOfSight(drone.position, view.player.position);

  switch (drone.gunState) {
    case 'idle': {
      if (gunInRange) {
        drone.gunState = 'aiming';
        drone.aimTimer = tuning.gunTelegraphSeconds;
        result.stateChanged = 'aiming';
      }
      break;
    }
    case 'aiming': {
      if (!gunInRange) {
        drone.gunState = 'idle';
        result.stateChanged = 'idle';
        break;
      }
      drone.aimTimer -= view.dt;
      if (drone.aimTimer <= 0) {
        result.fire = {
          projectile: 'droneBolt',
          origin: { ...drone.position },
          direction: normalize(sub(view.player.position, drone.position)),
          speed: tuning.gunBoltSpeed,
          sourceTeam: 'hostile',
        };
        drone.gunState = 'cooldown';
        drone.gunCooldownTimer = tuning.gunCooldownSeconds;
        result.stateChanged = 'cooldown';
      }
      break;
    }
    case 'cooldown': {
      drone.gunCooldownTimer -= view.dt;
      if (drone.gunCooldownTimer <= 0) {
        drone.gunState = 'idle';
        result.stateChanged = 'idle';
      }
      break;
    }
  }

  return result;
};

// --- Aggregate tuning, union, dispatcher -----------------------------------------------------

export interface EnemyTuning {
  rifle: RifleInfantryTuning;
  rpg: RpgInfantryTuning;
  tank: LightTankTuning;
  aa: AaGunTuning;
  jet: JetTuning;
  drone: DroneTuning;
}

const degToRad = (deg: number): number => (deg * Math.PI) / 180;

export const defaultEnemyTuning = (): EnemyTuning => ({
  rifle: {
    patrolRadius: 6,
    patrolSpeed: 1.2,
    range: 40,
    lowAltitudeThreshold: 15,
    telegraphSeconds: 0.75,
    burstCooldownSeconds: 1.4,
    suppressionSeconds: 2.5,
    bulletSpeed: 90,
    accuracySpreadRadians: degToRad(12),
  },
  rpg: {
    range: 55,
    telegraphSeconds: 1.1,
    relocateSeconds: 2.2,
    relocateSpeed: 3.5,
    relocateDistance: 8,
    rocketSpeed: 40,
    hoverSpeedThreshold: 3,
  },
  tank: {
    laneSpeed: 4,
    turretTraverseRadPerSec: degToRad(90),
    turretAimToleranceRad: degToRad(3),
    maxElevationRad: degToRad(35),
    range: 60,
    telegraphSeconds: 0.8,
    cooldownSeconds: 1.6,
    shellSpeed: 70,
    rearArcRad: degToRad(50),
    rearArmorMultiplier: 1.8,
    frontArmorMultiplier: 0.6,
  },
  aa: {
    range: 140,
    telegraphSeconds: 0.85,
    burstCount: 4,
    burstIntervalSeconds: 0.12,
    cooldownSeconds: 2.5,
    suppressionSeconds: 3,
    shellSpeed: 110,
    scanSweepRadPerSec: degToRad(60),
    scanConeHalfAngleRad: degToRad(20),
  },
  jet: {
    warningSeconds: 1.6,
    attackPassSeconds: 3.5,
    missileVolleyCount: 3,
    missileIntervalSeconds: 0.5,
    missileSpeed: 60,
    passSpeed: 55,
    entryDistance: 220,
    passAltitude: 90,
    cooldownSeconds: 9,
  },
  drone: {
    speed: 3.2,
    acquisitionRange: 70,
    gunRange: 20,
    gunTelegraphSeconds: 0.75,
    gunBoltSpeed: 45,
    gunCooldownSeconds: 1.2,
  },
});

export type EnemyState =
  RifleInfantryState | RpgInfantryState | LightTankState | AaGunState | JetState | DroneState;

/**
 * Advances one enemy by one fixed tick. Dispatches on `kind` rather than using a class per
 * enemy so every kind's full behaviour stays a flat, greppable switch case — consistent with
 * how `stepFlight` reads as one procedure instead of an inheritance tree.
 */
export const stepEnemy = (
  enemy: EnemyState,
  view: CombatWorldView,
  tuning: EnemyTuning,
): EnemyStepResult => {
  switch (enemy.kind) {
    case 'rifleInfantry':
      return stepRifleInfantry(enemy, view, tuning.rifle);
    case 'rpgInfantry':
      return stepRpgInfantry(enemy, view, tuning.rpg);
    case 'lightTank':
      return stepLightTank(enemy, view, tuning.tank);
    case 'aaGun':
      return stepAaGun(enemy, view, tuning.aa);
    case 'jet':
      return stepJet(enemy, view, tuning.jet);
    case 'drone':
      return stepDrone(enemy, view, tuning.drone);
  }
};

/**
 * Classic firing-solution quadratic: the smallest positive time at which a projectile launched
 * now at `projectileSpeed` meets a target starting at `toTarget` (relative to the shooter) and
 * moving at constant `targetVelocity`. Returns null when there is no positive real solution —
 * the target is outrunning the projectile — so callers fall back to a direct shot instead of
 * aiming at nonsense.
 */
export const leadInterceptTime = (
  toTarget: Vec2,
  targetVelocity: Vec2,
  projectileSpeed: number,
): number | null => {
  const a =
    targetVelocity.x * targetVelocity.x +
    targetVelocity.y * targetVelocity.y -
    projectileSpeed * projectileSpeed;
  const b = 2 * (toTarget.x * targetVelocity.x + toTarget.y * targetVelocity.y);
  const c = toTarget.x * toTarget.x + toTarget.y * toTarget.y;

  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) < 1e-9) return null;
    const t = -c / b;
    return t > 0 ? t : null;
  }

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const sqrtDiscriminant = Math.sqrt(discriminant);
  const t1 = (-b - sqrtDiscriminant) / (2 * a);
  const t2 = (-b + sqrtDiscriminant) / (2 * a);
  const positive = [t1, t2].filter((t) => t > 0);
  if (positive.length === 0) return null;
  return Math.min(...positive);
};

/** World-space point to aim at so a constant-speed projectile actually meets a moving target. */
export const computeLeadAimpoint = (
  shooterPosition: Vec2,
  targetPosition: Vec2,
  targetVelocity: Vec2,
  projectileSpeed: number,
): Vec2 | null => {
  const toTarget = sub(targetPosition, shooterPosition);
  const t = leadInterceptTime(toTarget, targetVelocity, projectileSpeed);
  if (t === null) return null;
  return { x: targetPosition.x + targetVelocity.x * t, y: targetPosition.y + targetVelocity.y * t };
};

/** Narrows `EnemyState['kind']` to the shared `EnemyKind` contract for integration-layer code. */
export const enemyKindOf = (enemy: EnemyState): EnemyKind => enemy.kind;
