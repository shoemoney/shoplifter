import { describe, expect, it } from 'vitest';
import { ActionMap } from '@/input/actions.js';
import { defaultCameraTuning } from '@/render/camera.js';
import { defaultSettings, type Settings } from '@/save/schema.js';
import {
  applyCameraSettings,
  applyInputSettings,
  cameraShakeScale,
  civilianFriendlyFire,
  devicePixelRatioCeiling,
  difficultyOf,
  hudPreferences,
  resolveTrigger,
  simSpeed,
  speedAffectsGrade,
} from './settingsRuntime.js';

const settings = (mutate: (s: Settings) => void = () => {}): Settings => {
  const value = defaultSettings();
  mutate(value);
  return value;
};

describe('input settings', () => {
  it('applies dead zone and curve to both sticks', () => {
    const actions = new ActionMap();
    applyInputSettings(
      settings((s) => {
        s.axes.thrust.deadZone = 0.3;
        s.axes.thrust.curve = 2;
        s.axes.aim.deadZone = 0.05;
      }),
      actions,
    );
    expect(actions.tuning.thrustX.deadZone).toBe(0.3);
    expect(actions.tuning.thrustY.curve).toBe(2);
    expect(actions.tuning.aimX.deadZone).toBe(0.05);
  });

  it('inverts each axis independently — the 1982 option, per stick', () => {
    const actions = new ActionMap();
    applyInputSettings(
      settings((s) => {
        s.axes.thrust.invertY = true;
        s.axes.aim.invertX = true;
      }),
      actions,
    );
    expect(actions.tuning.thrustY.invert).toBe(true);
    expect(actions.tuning.thrustX.invert).toBe(false);
    expect(actions.tuning.aimX.invert).toBe(true);
    expect(actions.tuning.aimY.invert).toBe(false);
  });

  it('actually inverts the value the simulation reads', () => {
    const actions = new ActionMap();
    applyInputSettings(
      settings((s) => {
        s.axes.thrust.invertY = true;
        s.axes.thrust.deadZone = 0;
        s.axes.thrust.curve = 1;
      }),
      actions,
    );
    actions.setAxis('thrustY', 0.6);
    expect(actions.snapshot(1).axes.thrustY).toBeCloseTo(-0.6, 6);
  });
});

describe('accessibility', () => {
  it('scales camera shake, and reduced motion turns it off entirely', () => {
    expect(cameraShakeScale(settings())).toBe(1);
    expect(cameraShakeScale(settings((s) => (s.accessibility.cameraShake = 0.4)))).toBe(0.4);
    // Not "less of it" — none of it.
    expect(cameraShakeScale(settings((s) => (s.accessibility.reducedMotion = true)))).toBe(0);
  });

  it('calms the camera response under reduced motion', () => {
    const base = defaultCameraTuning();
    const calm = applyCameraSettings(
      settings((s) => (s.accessibility.reducedMotion = true)),
      base,
    );
    expect(calm.maxZoomOut).toBeLessThan(base.maxZoomOut);
    expect(calm.lookAheadFraction).toBeLessThan(base.lookAheadFraction);
  });

  it('leaves the camera alone when reduced motion is off', () => {
    const base = defaultCameraTuning();
    expect(applyCameraSettings(settings(), base)).toEqual(base);
  });

  it('offers exactly the three game speeds the PRD allows', () => {
    for (const speed of [0.75, 0.9, 1] as const) {
      expect(simSpeed(settings((s) => (s.accessibility.gameSpeed = speed)))).toBe(speed);
    }
  });

  it('only penalises reduced speed on the harder difficulties', () => {
    expect(
      speedAffectsGrade(
        settings((s) => {
          s.accessibility.gameSpeed = 0.75;
          s.difficulty = 'standard';
        }),
      ),
    ).toBe(false);
    expect(
      speedAffectsGrade(
        settings((s) => {
          s.accessibility.gameSpeed = 0.75;
          s.difficulty = 'veteran';
        }),
      ),
    ).toBe(true);
  });

  it('disables the player killing civilians in civilian-friendly mode', () => {
    expect(civilianFriendlyFire(settings())).toBe(true);
    expect(
      civilianFriendlyFire(settings((s) => (s.accessibility.civilianFriendlyMode = true))),
    ).toBe(false);
  });

  it('passes the HUD preferences straight through', () => {
    const prefs = hudPreferences(
      settings((s) => {
        s.accessibility.alwaysShowLandingAid = true;
        s.accessibility.colorblindPalette = 'deuteranopia';
      }),
    );
    expect(prefs.alwaysShowLandingAid).toBe(true);
    expect(prefs.colorblindPalette).toBe('deuteranopia');
  });
});

describe('hold vs toggle', () => {
  it('passes the raw button through in hold mode', () => {
    expect(resolveTrigger(true, true, false, false)).toBe(true);
    expect(resolveTrigger(true, false, false, true)).toBe(false);
  });

  it('latches in toggle mode and only flips on a press edge', () => {
    expect(resolveTrigger(false, true, true, false)).toBe(true);
    expect(resolveTrigger(false, true, false, true)).toBe(true);
    expect(resolveTrigger(false, false, true, true)).toBe(false);
  });
});

describe('miscellaneous', () => {
  it('reads difficulty straight off the settings', () => {
    expect(difficultyOf(settings((s) => (s.difficulty = 'classic')))).toBe('classic');
  });

  it('clamps the device pixel ratio ceiling to something a GPU can render', () => {
    expect(devicePixelRatioCeiling(settings((s) => (s.maxDevicePixelRatio = 2)))).toBe(2);
    expect(devicePixelRatioCeiling(settings((s) => (s.maxDevicePixelRatio = 9)))).toBe(4);
  });
});
