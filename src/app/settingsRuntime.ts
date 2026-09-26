import { clamp } from '@/core/math.js';
import type { ActionMap, AxisAction } from '@/input/actions.js';
import type { CameraTuning } from '@/render/camera.js';
import type { Settings } from '@/save/schema.js';
import type { Difficulty } from '@/sim/systems/civilians.js';

/**
 * Translates saved settings into runtime knobs. Kept separate from the app so the mapping is
 * testable without a browser — "does inverting Y actually invert Y" is exactly the kind of
 * wiring that silently rots, and accessibility options are the ones players cannot work around.
 */

/** Axes driven by the thrust stick; the rest follow the aim stick. */
const THRUST_AXES: readonly AxisAction[] = ['thrustX', 'thrustY'];
const AIM_AXES: readonly AxisAction[] = ['aimX', 'aimY'];

export const applyInputSettings = (settings: Settings, actions: ActionMap): void => {
  for (const axis of THRUST_AXES) {
    const tuning = actions.tuning[axis];
    tuning.deadZone = settings.axes.thrust.deadZone;
    tuning.curve = settings.axes.thrust.curve;
    tuning.invert =
      axis === 'thrustX' ? settings.axes.thrust.invertX : settings.axes.thrust.invertY;
  }
  for (const axis of AIM_AXES) {
    const tuning = actions.tuning[axis];
    tuning.deadZone = settings.axes.aim.deadZone;
    tuning.curve = settings.axes.aim.curve;
    tuning.invert = axis === 'aimX' ? settings.axes.aim.invertX : settings.axes.aim.invertY;
  }
};

/**
 * Camera shake multiplier. Reduced motion zeroes it outright rather than merely lowering it,
 * because "less of the thing that makes me ill" is not an accommodation.
 */
export const cameraShakeScale = (settings: Settings): number =>
  settings.accessibility.reducedMotion ? 0 : clamp(settings.accessibility.cameraShake, 0, 1);

/** Camera tuning adjusted for accessibility: reduced motion also calms the zoom response. */
export const applyCameraSettings = (settings: Settings, tuning: CameraTuning): CameraTuning =>
  settings.accessibility.reducedMotion
    ? {
        ...tuning,
        maxZoomOut: tuning.maxZoomOut * 0.35,
        lookAheadFraction: tuning.lookAheadFraction * 0.7,
      }
    : tuning;

/**
 * Simulation speed multiplier. The PRD allows 75%, 90% and 100%, and states the first two do
 * not affect the grade on the first two difficulty settings — so the speed scales how much real
 * time feeds the clock, never the fixed timestep itself. Changing dt would change the physics.
 */
export const simSpeed = (settings: Settings): number => settings.accessibility.gameSpeed;

/** True when a reduced game speed should still count for a full grade. */
export const speedAffectsGrade = (settings: Settings): boolean =>
  settings.accessibility.gameSpeed < 1 &&
  (settings.difficulty === 'veteran' || settings.difficulty === 'classic');

export const difficultyOf = (settings: Settings): Difficulty => settings.difficulty;

/** Civilian-friendly mode stops the player's direct fire from killing civilians. */
export const civilianFriendlyFire = (settings: Settings): boolean =>
  !settings.accessibility.civilianFriendlyMode;

export interface HudPreferences {
  alwaysShowLandingAid: boolean;
  subtitles: boolean;
  visualizedAudio: boolean;
  reducedFlashes: boolean;
  colorblindPalette: Settings['accessibility']['colorblindPalette'];
}

export const hudPreferences = (settings: Settings): HudPreferences => ({
  alwaysShowLandingAid: settings.accessibility.alwaysShowLandingAid,
  subtitles: settings.accessibility.subtitles,
  visualizedAudio: settings.accessibility.visualizedAudio,
  reducedFlashes: settings.accessibility.reducedFlashes,
  colorblindPalette: settings.accessibility.colorblindPalette,
});

/**
 * Hold-to-fire vs toggle. Returns the trigger state the simulation should see, given the raw
 * button state and the latched toggle state, so both schemes reach the sim identically.
 */
export const resolveTrigger = (
  hold: boolean,
  rawDown: boolean,
  rawPressed: boolean,
  latched: boolean,
): boolean => (hold ? rawDown : rawPressed ? !latched : latched);

export const devicePixelRatioCeiling = (settings: Settings): number =>
  clamp(settings.maxDevicePixelRatio, 1, 4);
