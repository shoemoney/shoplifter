import { z } from 'zod';

/**
 * Flight tuning. Every figure here is a modern design target from the PRD, not a measurement of
 * the 1982 binary. Hover sits at roughly 55% vertical input because `gravity / verticalAcceleration`
 * is 14 / 26 — keep that relationship in mind when editing either number.
 */
export const flightTuningSchema = z.object({
  maxHorizontalSpeed: z.number().positive(),
  boostSpeedMultiplier: z.number().min(1).max(2),
  maxClimbSpeed: z.number().positive(),
  maxDescentSpeed: z.number().positive(),
  horizontalAcceleration: z.number().positive(),
  verticalAcceleration: z.number().positive(),
  gravity: z.number().positive(),
  dragX: z.number().min(0),
  dragY: z.number().min(0),
  /** Extra drag per m/s of speed past the soft limit. Soft limits, never hard clamps. */
  excessSpeedDrag: z.number().min(0),
  /** Lowest engine efficiency at zero engine health. */
  minEngineEfficiency: z.number().min(0).max(1),
  /** Per-passenger reduction in climb response. */
  passengerClimbPenalty: z.number().min(0).max(0.1),
  /** Extra lift near flat ground, as a fraction. */
  groundEffectLift: z.number().min(0).max(0.2),
  /** Height over which ground effect fades out, metres (about one rotor diameter). */
  groundEffectHeight: z.number().positive(),
  /** Peak lateral control noise from a fully damaged rotor, as a fraction of thrust. */
  rotorNoise: z.number().min(0).max(1),
  pitchPerAcceleration: z.number().min(0),
  maxPitch: z.number().positive(),
  pitchStiffness: z.number().positive(),
  pitchDamping: z.number().positive(),
  yawDurationSeconds: z.number().min(0.05).max(1),
  fuelBurnPerSecond: z.number().min(0),
  boostFuelMultiplier: z.number().min(1),
});

export const landingTuningSchema = z.object({
  /** Half the distance between skids, metres. Both must contact for a landing. */
  skidHalfWidth: z.number().positive(),
  /** Distance from the hull origin down to the skids, metres. */
  skidDrop: z.number().positive(),
  safeVerticalSpeed: z.number().positive(),
  crashVerticalSpeed: z.number().positive(),
  safeHorizontalSpeed: z.number().positive(),
  safeSlopeDegrees: z.number().positive(),
  /** Pitch past this at touchdown digs a skid in, whatever the descent rate. */
  safePitchDegrees: z.number().positive(),
  /** Rate the skids scrub off lateral speed, per second. */
  skidFriction: z.number().positive(),
  /** Hull damage at the crash threshold, 0..1. Scales with excess speed above it. */
  crashHullDamage: z.number().min(0).max(1),
  hardHullDamage: z.number().min(0).max(1),
});

export const flightBalanceSchema = z.object({
  schemaVersion: z.literal(1),
  flight: flightTuningSchema,
  landing: landingTuningSchema,
  capacity: z.number().int().min(1).max(16),
  fuelCapacity: z.number().positive(),
});

export type FlightTuning = z.infer<typeof flightTuningSchema>;
export type LandingTuning = z.infer<typeof landingTuningSchema>;
export type FlightBalance = z.infer<typeof flightBalanceSchema>;
