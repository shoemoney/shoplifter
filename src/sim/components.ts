import type { Vec2 } from '@/core/math.js';

export type EntityId = number;

/** -1 = facing left, 0 = facing the foreground (anti-tank posture), 1 = facing right. */
export type Facing = -1 | 0 | 1;

export type LandingContact = 0 | 1 | 2;

export type LandingQuality = 'safe' | 'hard' | 'crash';

/**
 * The helicopter. Movement and weapon facing are separate fields on purpose: flying left while
 * shooting right is the single most characteristic thing the 1982 game let you do, and folding
 * them into one heading would quietly delete it.
 */
export interface Helicopter {
  position: Vec2;
  velocity: Vec2;
  acceleration: Vec2;
  /** Visual/handling angle in radians; follows horizontal acceleration with spring damping. */
  pitch: number;
  pitchVelocity: number;
  facing: Facing;
  /** Facing being rotated toward, or null when settled. */
  yawTarget: Facing | null;
  /** Seconds remaining in the current yaw transition. */
  yawTimer: number;
  grounded: boolean;
  landingContactCount: LandingContact;
  /** 0..1. Reaching 0 destroys the aircraft. */
  hull: number;
  /** 0..1. Scales available lift and thrust. */
  engine: number;
  /** 0..1. Below 1 adds periodic control noise, never instant failure. */
  rotor: number;
  /** Litres. */
  fuel: number;
  passengers: EntityId[];
  capacity: number;
  weaponHeat: number;
  rockets: number;
  flares: number;
  boosting: boolean;
  /** Seconds since the aircraft was destroyed, or null while alive. */
  destroyedFor: number | null;
}

export interface FlightInput {
  /** -1..1, positive right. */
  thrustX: number;
  /** -1..1, positive up. */
  thrustY: number;
  boost: boolean;
  /** Edge-triggered: rotate one step toward the left-facing plane. */
  yawLeft: boolean;
  /** Edge-triggered: rotate one step toward the right-facing plane. */
  yawRight: boolean;
}

export const neutralInput = (): FlightInput => ({
  thrustX: 0,
  thrustY: 0,
  boost: false,
  yawLeft: false,
  yawRight: false,
});

export const createHelicopter = (overrides: Partial<Helicopter> = {}): Helicopter => ({
  position: { x: 0, y: 0 },
  velocity: { x: 0, y: 0 },
  acceleration: { x: 0, y: 0 },
  pitch: 0,
  pitchVelocity: 0,
  facing: 1,
  yawTarget: null,
  yawTimer: 0,
  grounded: false,
  landingContactCount: 0,
  hull: 1,
  engine: 1,
  rotor: 1,
  fuel: 100,
  passengers: [],
  capacity: 8,
  weaponHeat: 0,
  rockets: 8,
  flares: 4,
  boosting: false,
  destroyedFor: null,
  ...overrides,
});

export type GameEventType =
  | 'flight:touchdown'
  | 'flight:liftoff'
  | 'flight:yawStarted'
  | 'flight:yawCompleted'
  | 'flight:destroyed'
  | 'flight:fuelEmpty'
  | 'flight:damaged';

export interface TouchdownPayload {
  quality: LandingQuality;
  verticalSpeed: number;
  horizontalSpeed: number;
  slopeDegrees: number;
  hullDamage: number;
}
