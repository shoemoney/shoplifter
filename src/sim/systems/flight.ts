import { clamp } from '@/core/math.js';
import type { FlightTuning } from '@/content/schemas/flight.js';
import type { Facing, FlightInput, Helicopter } from '../components.js';
import type { Terrain } from '../terrain.js';

export interface FlightStepContext {
  tuning: FlightTuning;
  terrain: Terrain;
  dt: number;
  tick: number;
}

export interface YawTransition {
  from: Facing;
  to: Facing;
}

export interface FlightStepResult {
  /** Set on the tick a yaw transition begins. */
  yawStarted: YawTransition | null;
  /** Set on the tick a yaw transition completes. */
  yawCompleted: Facing | null;
  fuelJustEmptied: boolean;
  heightAboveGround: number;
}

/**
 * Effective thrust multiplier from engine health. A dead engine still autorotates rather than
 * dropping like a brick: `minEngineEfficiency` is the floor, not zero.
 */
export const engineEfficiency = (helicopter: Helicopter, tuning: FlightTuning): number => {
  if (helicopter.fuel <= 0) return 0;
  const health = clamp(helicopter.engine, 0, 1);
  return tuning.minEngineEfficiency + (1 - tuning.minEngineEfficiency) * health;
};

/** Passengers make the aircraft heavier to lift, never heavy enough to be unflyable. */
export const climbFactor = (helicopter: Helicopter, tuning: FlightTuning): number =>
  clamp(1 - helicopter.passengers.length * tuning.passengerClimbPenalty, 0.6, 1);

/**
 * Extra lift within about one rotor diameter of the ground. Fades linearly with height so there
 * is no step change at the boundary that would read as a physics bug on approach.
 */
export const groundEffect = (heightAboveGround: number, tuning: FlightTuning): number => {
  if (heightAboveGround >= tuning.groundEffectHeight) return 0;
  const proximity = clamp(1 - heightAboveGround / tuning.groundEffectHeight, 0, 1);
  return tuning.groundEffectLift * proximity;
};

/**
 * Deterministic control noise from a damaged rotor. Two incommensurate sine waves rather than
 * an RNG draw: the aircraft must wander, and two identical replays must wander identically.
 */
export const rotorNoise = (
  helicopter: Helicopter,
  tuning: FlightTuning,
  seconds: number,
): number => {
  const damage = clamp(1 - helicopter.rotor, 0, 1);
  if (damage <= 0) return 0;
  return (
    tuning.rotorNoise * damage * (Math.sin(seconds * 7.3) * 0.65 + Math.sin(seconds * 2.1) * 0.35)
  );
};

/**
 * Soft speed limit. Past the cap, drag rises steeply instead of the velocity being clamped, so
 * a dive or a boost can genuinely exceed the number and then bleed back — a hard clamp makes
 * the aircraft feel like it hits a wall.
 */
export const softLimitDrag = (speed: number, cap: number, tuning: FlightTuning): number => {
  const excess = Math.abs(speed) - cap;
  if (excess <= 0) return 0;
  return tuning.excessSpeedDrag * excess * Math.sign(speed);
};

const stepFacing = (current: Facing, toward: -1 | 1): Facing => {
  const next = current + toward;
  return clamp(next, -1, 1) as Facing;
};

/**
 * One fixed simulation step of the flight model. Integrates thrust, gravity, damping and the
 * soft speed limits, advances the yaw transition, burns fuel, and springs the visual pitch.
 * Ground contact is resolved separately by the landing system, which runs immediately after.
 */
export const stepFlight = (
  helicopter: Helicopter,
  input: FlightInput,
  context: FlightStepContext,
): FlightStepResult => {
  const { tuning, terrain, dt } = context;
  const result: FlightStepResult = {
    yawStarted: null,
    yawCompleted: null,
    fuelJustEmptied: false,
    heightAboveGround: 0,
  };

  const destroyed = helicopter.destroyedFor !== null;
  const efficiency = destroyed ? 0 : engineEfficiency(helicopter, tuning);
  const groundHeight = terrain.heightAt(helicopter.position.x);
  const heightAboveGround = Math.max(0, helicopter.position.y - groundHeight);
  result.heightAboveGround = heightAboveGround;

  // --- Yaw -----------------------------------------------------------------
  // Turning is prohibited while grounded, as in the original: the skids are planted.
  if (helicopter.yawTimer > 0) {
    helicopter.yawTimer -= dt;
    if (helicopter.yawTimer <= 0) {
      helicopter.yawTimer = 0;
      if (helicopter.yawTarget !== null) {
        helicopter.facing = helicopter.yawTarget;
        helicopter.yawTarget = null;
        result.yawCompleted = helicopter.facing;
      }
    }
  } else if (!helicopter.grounded && !destroyed && (input.yawLeft || input.yawRight)) {
    const toward: -1 | 1 = input.yawLeft ? -1 : 1;
    const next = stepFacing(helicopter.facing, toward);
    if (next !== helicopter.facing) {
      helicopter.yawTarget = next;
      helicopter.yawTimer = tuning.yawDurationSeconds;
      result.yawStarted = { from: helicopter.facing, to: next };
    }
  }

  // --- Forces --------------------------------------------------------------
  const boosting = input.boost && !destroyed && helicopter.fuel > 0;
  helicopter.boosting = boosting;

  const noise = rotorNoise(helicopter, tuning, context.tick * dt);
  const horizontalThrust =
    (clamp(input.thrustX, -1, 1) + noise) * tuning.horizontalAcceleration * efficiency;

  const liftInput = clamp(input.thrustY, -1, 1);
  const lift =
    liftInput *
    tuning.verticalAcceleration *
    efficiency *
    climbFactor(helicopter, tuning) *
    (1 + groundEffect(heightAboveGround, tuning));

  const speedCap = tuning.maxHorizontalSpeed * (boosting ? tuning.boostSpeedMultiplier : 1);
  const verticalCap = helicopter.velocity.y >= 0 ? tuning.maxClimbSpeed : tuning.maxDescentSpeed;

  // Linear damping plus a steep penalty past the cap. See DECISIONS M1-1 for why this is not
  // the quadratic form written in the PRD's equation block.
  helicopter.acceleration.x =
    horizontalThrust -
    tuning.dragX * helicopter.velocity.x -
    softLimitDrag(helicopter.velocity.x, speedCap, tuning);
  helicopter.acceleration.y =
    lift -
    tuning.gravity -
    tuning.dragY * helicopter.velocity.y -
    softLimitDrag(helicopter.velocity.y, verticalCap, tuning);

  helicopter.velocity.x += helicopter.acceleration.x * dt;
  helicopter.velocity.y += helicopter.acceleration.y * dt;
  helicopter.position.x += helicopter.velocity.x * dt;
  helicopter.position.y += helicopter.velocity.y * dt;

  // --- Fuel ----------------------------------------------------------------
  if (!destroyed && helicopter.fuel > 0) {
    const burn = tuning.fuelBurnPerSecond * (boosting ? tuning.boostFuelMultiplier : 1) * dt;
    helicopter.fuel = Math.max(0, helicopter.fuel - burn);
    if (helicopter.fuel === 0) result.fuelJustEmptied = true;
  }

  // --- Visual pitch --------------------------------------------------------
  // Spring-damped so the nose leads acceleration rather than snapping to velocity. The rotor
  // and fuselage stay visually independent of weapon facing.
  const pitchTarget = clamp(
    -helicopter.acceleration.x * tuning.pitchPerAcceleration,
    -tuning.maxPitch,
    tuning.maxPitch,
  );
  const pitchAcceleration =
    (pitchTarget - helicopter.pitch) * tuning.pitchStiffness -
    helicopter.pitchVelocity * tuning.pitchDamping;
  helicopter.pitchVelocity += pitchAcceleration * dt;
  helicopter.pitch += helicopter.pitchVelocity * dt;

  if (destroyed) helicopter.destroyedFor = (helicopter.destroyedFor ?? 0) + dt;

  return result;
};
