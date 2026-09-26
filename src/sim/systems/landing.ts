import { clamp, radToDeg } from '@/core/math.js';
import type { LandingTuning } from '@/content/schemas/flight.js';
import type {
  Helicopter,
  LandingContact,
  LandingQuality,
  TouchdownPayload,
} from '../components.js';
import type { Terrain } from '../terrain.js';

export interface LandingStepContext {
  tuning: LandingTuning;
  terrain: Terrain;
  dt: number;
}

export interface LandingStepResult {
  touchdown: TouchdownPayload | null;
  liftoff: boolean;
  contacts: LandingContact;
}

export interface SkidProbe {
  leftGround: number;
  rightGround: number;
  /** Ground angle between the two skid contact points, degrees. */
  slopeDegrees: number;
  /** Ground height under the lower skid — the one that touches first. */
  supportHeight: number;
}

/**
 * Samples the ground under both skids. Landing is judged on the pair, not on a single point:
 * the original let you plant one skid on a rock and tip, and that is the behaviour worth
 * keeping rather than a centre-point ground check that always succeeds.
 */
export const probeSkids = (
  helicopter: Helicopter,
  terrain: Terrain,
  tuning: LandingTuning,
): SkidProbe => {
  const half = tuning.skidHalfWidth;
  const leftGround = terrain.heightAt(helicopter.position.x - half);
  const rightGround = terrain.heightAt(helicopter.position.x + half);
  return {
    leftGround,
    rightGround,
    slopeDegrees: Math.abs(radToDeg(Math.atan2(rightGround - leftGround, half * 2))),
    supportHeight: Math.max(leftGround, rightGround),
  };
};

export interface TouchdownAssessment {
  quality: LandingQuality;
  hullDamage: number;
  reason: 'speed' | 'slope' | 'pitch' | 'none';
}

/**
 * Classifies a touchdown. Order matters: a gentle set-down onto a 12-degree slope is still a
 * crash, so geometry is checked even when the descent rate is inside tolerance.
 */
export const assessTouchdown = (
  verticalSpeed: number,
  horizontalSpeed: number,
  slopeDegrees: number,
  pitchDegrees: number,
  tuning: LandingTuning,
): TouchdownAssessment => {
  const descent = Math.abs(Math.min(0, verticalSpeed));
  const lateral = Math.abs(horizontalSpeed);

  if (descent > tuning.crashVerticalSpeed) {
    const excess = (descent - tuning.crashVerticalSpeed) / tuning.crashVerticalSpeed;
    return {
      quality: 'crash',
      hullDamage: clamp(tuning.crashHullDamage * (1 + excess), 0, 1),
      reason: 'speed',
    };
  }
  if (slopeDegrees > tuning.safeSlopeDegrees) {
    // Too steep to sit on: the aircraft slides or rolls regardless of how softly it arrived.
    const excess = (slopeDegrees - tuning.safeSlopeDegrees) / tuning.safeSlopeDegrees;
    return {
      quality: excess > 1 ? 'crash' : 'hard',
      hullDamage: excess > 1 ? tuning.crashHullDamage : tuning.hardHullDamage,
      reason: 'slope',
    };
  }
  if (Math.abs(pitchDegrees) > tuning.safePitchDegrees) {
    // Nose-down or nose-up on contact digs a skid in — the PRD's "improperly tilted" case.
    return { quality: 'hard', hullDamage: tuning.hardHullDamage, reason: 'pitch' };
  }
  if (descent > tuning.safeVerticalSpeed || lateral > tuning.safeHorizontalSpeed) {
    const over = Math.max(
      (descent - tuning.safeVerticalSpeed) / (tuning.crashVerticalSpeed - tuning.safeVerticalSpeed),
      (lateral - tuning.safeHorizontalSpeed) / tuning.safeHorizontalSpeed,
    );
    return {
      quality: 'hard',
      hullDamage: clamp(tuning.hardHullDamage * (0.5 + clamp(over, 0, 1)), 0, 1),
      reason: 'speed',
    };
  }
  return { quality: 'safe', hullDamage: 0, reason: 'none' };
};

/**
 * Resolves ground contact after the flight step has already integrated position. Runs second on
 * purpose: resolving contact before integration lets a fast descent tunnel through the ground
 * between ticks.
 */
export const stepLanding = (
  helicopter: Helicopter,
  context: LandingStepContext,
): LandingStepResult => {
  const { tuning, terrain } = context;
  const probe = probeSkids(helicopter, terrain, tuning);
  const restingY = probe.supportHeight + tuning.skidDrop;
  const wasGrounded = helicopter.grounded;

  const result: LandingStepResult = { touchdown: null, liftoff: false, contacts: 0 };

  if (helicopter.position.y > restingY + 1e-4) {
    helicopter.grounded = false;
    helicopter.landingContactCount = 0;
    if (wasGrounded) result.liftoff = true;
    return result;
  }

  // At or below resting height: the skids are down.
  const verticalSpeed = helicopter.velocity.y;
  const horizontalSpeed = helicopter.velocity.x;

  helicopter.position.y = restingY;
  helicopter.velocity.y = Math.max(0, helicopter.velocity.y);

  // The hull rests on whichever skid the ground pushes up first; the other hangs in the gap.
  // A gap wider than a few centimetres means only one skid is actually carrying the aircraft.
  const skidGap = Math.abs(probe.leftGround - probe.rightGround);
  const contacts: LandingContact = skidGap < 0.05 ? 2 : 1;
  helicopter.landingContactCount = contacts;
  helicopter.grounded = true;
  result.contacts = contacts;

  // Friction: the skids scrub off lateral speed rather than sliding forever.
  helicopter.velocity.x -= helicopter.velocity.x * Math.min(1, tuning.skidFriction * context.dt);
  if (Math.abs(helicopter.velocity.x) < 0.05) helicopter.velocity.x = 0;

  if (!wasGrounded) {
    const assessment = assessTouchdown(
      verticalSpeed,
      horizontalSpeed,
      probe.slopeDegrees,
      radToDeg(helicopter.pitch),
      tuning,
    );
    if (assessment.hullDamage > 0) {
      helicopter.hull = clamp(helicopter.hull - assessment.hullDamage, 0, 1);
    }
    result.touchdown = {
      quality: assessment.quality,
      verticalSpeed,
      horizontalSpeed,
      slopeDegrees: probe.slopeDegrees,
      hullDamage: assessment.hullDamage,
    };
  }

  return result;
};
