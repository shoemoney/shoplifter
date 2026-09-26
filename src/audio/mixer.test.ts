import { describe, expect, it } from 'vitest';
import {
  DUCKING_CUES,
  applyAccessibility,
  busFor,
  cueGain,
  defaultMixerTuning,
  musicLayers,
  rotorLayers,
  spatialGain,
  spatialPan,
  stepDucking,
  type BusLevels,
  type DuckingState,
  type RotorInput,
} from './mixer.js';

const tuning = defaultMixerTuning();
const levels: BusLevels = { master: 1, music: 1, effects: 1, voice: 1 };
const quiet: DuckingState = { amount: 0, activeCues: 0 };

const rotor = (overrides: Partial<RotorInput> = {}): RotorInput => ({
  collective: 0.55,
  engine: 1,
  rotor: 1,
  load: 0,
  grounded: false,
  ...overrides,
});

describe('bus routing', () => {
  it('routes music, voice and everything else to the right bus', () => {
    expect(busFor('music')).toBe('music');
    expect(busFor('civilianVoice')).toBe('voice');
    expect(busFor('weapon')).toBe('effects');
    expect(busFor('missileWarning')).toBe('effects');
  });
});

describe('spatial audio', () => {
  it('is full volume up close and silent past the far distance', () => {
    expect(spatialGain(0, tuning)).toBe(1);
    expect(spatialGain(tuning.nearDistance, tuning)).toBe(1);
    expect(spatialGain(tuning.farDistance, tuning)).toBe(0);
    expect(spatialGain(tuning.farDistance + 500, tuning)).toBe(0);
  });

  it('falls off monotonically in between', () => {
    let previous = 1;
    for (let d = tuning.nearDistance; d <= tuning.farDistance; d += 10) {
      const gain = spatialGain(d, tuning);
      expect(gain).toBeLessThanOrEqual(previous + 1e-9);
      previous = gain;
    }
  });

  it('pans by screen-relative position', () => {
    expect(spatialPan(30, 0, 30)).toBe(1);
    expect(spatialPan(-30, 0, 30)).toBe(-1);
    expect(spatialPan(0, 0, 30)).toBe(0);
    expect(spatialPan(900, 0, 30)).toBe(1);
  });

  it('collapses to centre in mono mode', () => {
    expect(spatialPan(30, 0, 30, true)).toBe(0);
    expect(applyAccessibility(-1, { mono: true, visualIndicators: false })).toBe(0);
    expect(applyAccessibility(-1, { mono: false, visualIndicators: false })).toBe(-1);
  });
});

describe('ducking', () => {
  it('names the two cues that duck the mix', () => {
    expect(DUCKING_CUES).toContain('missileWarning');
    expect(DUCKING_CUES).toContain('civilianCritical');
  });

  it('attacks faster than it releases', () => {
    const attacking = stepDucking(quiet, 1, 1 / 60, tuning);
    const releasing = stepDucking({ amount: 1, activeCues: 0 }, 0, 1 / 60, tuning);
    expect(attacking.amount).toBeGreaterThan(0);
    expect(1 - releasing.amount).toBeLessThan(attacking.amount);
  });

  it('settles at fully ducked and fully open', () => {
    let state = quiet;
    for (let i = 0; i < 120; i++) state = stepDucking(state, 1, 1 / 60, tuning);
    expect(state.amount).toBeCloseTo(1, 2);

    for (let i = 0; i < 600; i++) state = stepDucking(state, 0, 1 / 60, tuning);
    expect(state.amount).toBeCloseTo(0, 2);
  });

  it('pulls combat down under a missile warning', () => {
    const ducked: DuckingState = { amount: 1, activeCues: 1 };
    const open = cueGain({ category: 'weapon', level: 1, levels, ducking: quiet, tuning });
    const under = cueGain({ category: 'weapon', level: 1, levels, ducking: ducked, tuning });
    expect(under).toBeLessThan(open);
    expect(under).toBeCloseTo(1 - tuning.duckDepth, 6);
  });

  it('never ducks the warning that caused the duck', () => {
    const ducked: DuckingState = { amount: 1, activeCues: 1 };
    for (const category of DUCKING_CUES) {
      expect(cueGain({ category, level: 1, levels, ducking: ducked, tuning })).toBe(1);
    }
  });
});

describe('cue gain', () => {
  it('multiplies the cue, its bus, and the master', () => {
    const gain = cueGain({
      category: 'music',
      level: 0.5,
      levels: { master: 0.5, music: 0.5, effects: 1, voice: 1 },
      ducking: quiet,
      tuning,
    });
    expect(gain).toBeCloseTo(0.125, 6);
  });

  it('silences everything when the master is down', () => {
    expect(
      cueGain({
        category: 'explosion',
        level: 1,
        levels: { ...levels, master: 0 },
        ducking: quiet,
        tuning,
      }),
    ).toBe(0);
  });

  it('applies distance only when the cue is positioned', () => {
    const positioned = cueGain({
      category: 'weapon',
      level: 1,
      distance: tuning.farDistance,
      levels,
      ducking: quiet,
      tuning,
    });
    const ambient = cueGain({ category: 'weapon', level: 1, levels, ducking: quiet, tuning });
    expect(positioned).toBe(0);
    expect(ambient).toBe(1);
  });
});

describe('procedural rotor', () => {
  it('rises with collective', () => {
    const idle = rotorLayers(rotor({ collective: 0 }), tuning);
    const climbing = rotorLayers(rotor({ collective: 1 }), tuning);
    expect(climbing.turbine).toBeGreaterThan(idle.turbine);
    expect(climbing.pitch).toBeGreaterThan(idle.pitch);
  });

  it('adds blade slap only when a loaded cabin is being lifted', () => {
    const emptyClimb = rotorLayers(rotor({ collective: 1, load: 0 }), tuning);
    const loadedClimb = rotorLayers(rotor({ collective: 1, load: 1 }), tuning);
    const loadedIdle = rotorLayers(rotor({ collective: 0, load: 1 }), tuning);
    expect(emptyClimb.slap).toBe(0);
    expect(loadedClimb.slap).toBeGreaterThan(0.5);
    expect(loadedIdle.slap).toBe(0);
  });

  it('rattles only when the rotor is damaged', () => {
    expect(rotorLayers(rotor({ rotor: 1 }), tuning).rattle).toBe(0);
    expect(rotorLayers(rotor({ rotor: 0.2 }), tuning).rattle).toBeGreaterThan(0.5);
  });

  it('loses turbine voice as the engine fails', () => {
    const healthy = rotorLayers(rotor({ engine: 1 }), tuning);
    const failing = rotorLayers(rotor({ engine: 0.2 }), tuning);
    expect(failing.turbine).toBeLessThan(healthy.turbine);
    expect(failing.blade).toBeLessThan(healthy.blade);
  });

  it('is quieter on the ground', () => {
    expect(rotorLayers(rotor({ grounded: true }), tuning).blade).toBeLessThan(
      rotorLayers(rotor({ grounded: false }), tuning).blade,
    );
  });

  it('keeps every layer inside a usable gain range', () => {
    for (const collective of [0, 0.25, 0.5, 0.75, 1]) {
      for (const load of [0, 0.5, 1]) {
        const layers = rotorLayers(rotor({ collective, load, rotor: 0.4, engine: 0.6 }), tuning);
        for (const value of [layers.blade, layers.turbine, layers.slap, layers.rattle]) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
        expect(layers.pitch).toBeGreaterThan(0.5);
        expect(layers.pitch).toBeLessThan(1.5);
      }
    }
  });
});

describe('music layering', () => {
  it('adds layers as the director escalates', () => {
    expect(musicLayers(0, false)).toBe(0);
    expect(musicLayers(3, false)).toBe(3);
    expect(musicLayers(9, false)).toBe(4);
  });

  it('recedes during boarding so the civilians carry the scene', () => {
    expect(musicLayers(4, true)).toBeLessThanOrEqual(1);
    expect(musicLayers(0, true)).toBe(0);
  });
});
