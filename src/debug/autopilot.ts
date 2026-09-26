import { clamp } from '@/core/math.js';
import type { MissionWorld, MissionInput } from '@/sim/mission.js';
import { neutralMissionInput } from '@/sim/mission.js';

/**
 * A scripted pilot. It exists so the whole rescue loop — launch, transit, land, board, return,
 * unload — can be flown by a test with synthetic input, which is the only honest way to prove
 * the loop is completable. It is also the soak harness's pilot.
 *
 * Deliberately a plain PD controller on the same `MissionInput` a human produces: if the
 * autopilot can fly it, the controls are sane; if it fights the aircraft, so will a player.
 */
export interface FlightPlanStep {
  /** World x to fly to. */
  x: number;
  /** Metres above ground to hold. Use 0 with `land: true` to set down. */
  altitude: number;
  land?: boolean;
  /** Seconds to sit here once arrived, for boarding or unloading. */
  holdSeconds?: number;
  /** Press interact on arrival — opens objective-gated civilian sites. */
  interact?: boolean;
}

export interface AutopilotTuning {
  /** Metres of x error treated as "arrived". */
  arriveRadius: number;
  /** Horizontal speed the controller aims for, m/s. */
  cruiseSpeed: number;
  /** Descent rate on the final approach, m/s. Stays inside the safe touchdown limit. */
  approachDescent: number;
  /** Descent rate used above `flareHeight`, where there is room to bleed it off again. */
  fastDescent: number;
  /** Height above ground at which the fast descent gives way to the approach rate, metres. */
  flareHeight: number;
  hoverInput: number;
}

export const defaultAutopilotTuning = (): AutopilotTuning => ({
  arriveRadius: 4,
  cruiseSpeed: 34,
  approachDescent: 2.2,
  fastDescent: 9,
  flareHeight: 16,
  hoverInput: 0.538,
});

export class Autopilot {
  private index = 0;
  private holdRemaining = 0;
  private readonly plan: FlightPlanStep[];
  private readonly tuning: AutopilotTuning;

  constructor(plan: readonly FlightPlanStep[], tuning: AutopilotTuning = defaultAutopilotTuning()) {
    this.plan = [...plan];
    this.tuning = tuning;
  }

  get finished(): boolean {
    return this.index >= this.plan.length;
  }

  get currentStep(): FlightPlanStep | undefined {
    return this.plan[this.index];
  }

  /** Produces one tick of input for the current world state. */
  update(world: MissionWorld): MissionInput {
    const input = neutralMissionInput();
    const step = this.plan[this.index];
    if (!step) return input;

    const player = world.player;
    const agl = player.position.y - world.terrain.heightAt(player.position.x);
    const dx = step.x - player.position.x;
    const arrived = Math.abs(dx) <= this.tuning.arriveRadius;

    // Horizontal: aim for a speed proportional to remaining distance, then drive velocity to it.
    const desiredVx = clamp(dx * 0.6, -this.tuning.cruiseSpeed, this.tuning.cruiseSpeed);
    input.thrustX = clamp((desiredVx - player.velocity.x) * 0.35, -1, 1);

    // Vertical: hold the target altitude, or bleed down for a landing once overhead.
    const wantsGround = step.land === true && arrived;
    const targetAgl = wantsGround ? 0 : step.altitude;
    // Two-phase descent, the way a pilot actually flies it: come down quickly while there is
    // height to bleed it off in, then flare to the safe touchdown rate near the ground. One slow
    // rate all the way from cruise spends most of the mission descending.
    const desiredVy = wantsGround
      ? agl > this.tuning.flareHeight
        ? -this.tuning.fastDescent
        : -this.tuning.approachDescent
      : clamp((targetAgl - agl) * 0.8, -this.tuning.fastDescent, 12);
    // A 9 m/s descent command needs more authority than the gentle rate this started with.
    input.thrustY = clamp(this.tuning.hoverInput + (desiredVy - player.velocity.y) * 0.3, 0, 1);

    if (step.interact) input.interact = true;

    const settled = wantsGround ? player.grounded : arrived && Math.abs(agl - step.altitude) < 3;
    if (settled) {
      this.holdRemaining = this.holdRemaining > 0 ? this.holdRemaining : (step.holdSeconds ?? 0);
      this.holdRemaining -= world.dt;
      if (this.holdRemaining <= 0) {
        this.index++;
        this.holdRemaining = 0;
      }
    }

    // On the ground with more plan left, keep the skids planted rather than bouncing.
    if (player.grounded && !wantsGround) input.thrustY = Math.max(input.thrustY, 0.75);

    return input;
  }
}

/**
 * A plan that flies the standard extraction round trip for a mission: out to a site, land,
 * board, come home, land, unload.
 */
export const roundTripPlan = (
  siteX: number,
  homeX: number,
  options: { boardSeconds?: number; unloadSeconds?: number; cruiseAltitude?: number } = {},
): FlightPlanStep[] => {
  const altitude = options.cruiseAltitude ?? 40;
  return [
    { x: siteX, altitude },
    { x: siteX, altitude: 0, land: true, holdSeconds: options.boardSeconds ?? 8 },
    { x: siteX, altitude },
    { x: homeX, altitude },
    { x: homeX, altitude: 0, land: true, holdSeconds: options.unloadSeconds ?? 3 },
  ];
};
