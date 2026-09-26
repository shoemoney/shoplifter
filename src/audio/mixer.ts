import { clamp } from '@/core/math.js';

/**
 * Audio mixing rules, kept separate from the Web Audio graph. The decisions that matter — what
 * ducks what, how loud a source is at a given distance, how the rotor's layers respond to
 * collective and damage — are gameplay decisions, and they need to be testable without a
 * browser or a speaker.
 */
export type Bus = 'master' | 'music' | 'effects' | 'voice';

export interface BusLevels {
  master: number;
  music: number;
  effects: number;
  voice: number;
}

export type CueCategory =
  | 'rotor'
  | 'weapon'
  | 'explosion'
  | 'ambient'
  | 'music'
  | 'missileWarning'
  | 'civilianCritical'
  | 'civilianVoice'
  | 'boarding'
  | 'ui';

/**
 * Cues that duck the rest of the mix. The PRD is specific: the combat mix drops under missile
 * and civilian-critical warnings, because those are the two things the player cannot afford to
 * miss under fire.
 */
export const DUCKING_CUES: readonly CueCategory[] = ['missileWarning', 'civilianCritical'];

export const busFor = (category: CueCategory): Bus => {
  switch (category) {
    case 'music':
      return 'music';
    case 'civilianVoice':
      return 'voice';
    default:
      return 'effects';
  }
};

export interface DuckingState {
  /** 0 = no ducking, 1 = fully ducked. */
  amount: number;
  activeCues: number;
}

export interface MixerTuning {
  /** How far the mix drops under a ducking cue. */
  duckDepth: number;
  duckAttackPerSecond: number;
  duckReleasePerSecond: number;
  /** Distance at which a spatial cue is at full volume. */
  nearDistance: number;
  /** Distance past which a spatial cue is inaudible. */
  farDistance: number;
  /** Rotor layers fade in over this much collective input. */
  rotorCollectiveRange: number;
}

export const defaultMixerTuning = (): MixerTuning => ({
  duckDepth: 0.55,
  duckAttackPerSecond: 8,
  duckReleasePerSecond: 2.2,
  nearDistance: 12,
  farDistance: 160,
  rotorCollectiveRange: 0.8,
});

/**
 * Inverse-distance falloff with a near plateau and a hard far cutoff. A pure 1/d curve never
 * reaches zero, which leaves a haze of distant gunfire under everything.
 */
export const spatialGain = (distance: number, tuning: MixerTuning): number => {
  if (distance <= tuning.nearDistance) return 1;
  if (distance >= tuning.farDistance) return 0;
  const span = tuning.farDistance - tuning.nearDistance;
  return clamp(1 - (distance - tuning.nearDistance) / span, 0, 1) ** 1.6;
};

/** Stereo pan in [-1, 1] from the listener's point of view. Mono mode flattens this to 0. */
export const spatialPan = (
  sourceX: number,
  listenerX: number,
  halfWidth: number,
  mono = false,
): number => {
  if (mono || halfWidth <= 0) return 0;
  return clamp((sourceX - listenerX) / halfWidth, -1, 1);
};

export const stepDucking = (
  state: DuckingState,
  activeDuckingCues: number,
  dt: number,
  tuning: MixerTuning,
): DuckingState => {
  const target = activeDuckingCues > 0 ? 1 : 0;
  const rate = target > state.amount ? tuning.duckAttackPerSecond : tuning.duckReleasePerSecond;
  const delta = (target - state.amount) * clamp(rate * dt, 0, 1);
  return { amount: clamp(state.amount + delta, 0, 1), activeCues: activeDuckingCues };
};

export interface GainRequest {
  category: CueCategory;
  /** Pre-mix loudness of the cue itself, 0..1. */
  level: number;
  distance?: number;
  levels: BusLevels;
  ducking: DuckingState;
  tuning: MixerTuning;
}

/**
 * Final gain for one cue. A ducking cue is never ducked by itself — the warning that causes the
 * duck has to stay audible, which is the entire point of ducking.
 */
export const cueGain = (request: GainRequest): number => {
  const bus = busFor(request.category);
  const busLevel = request.levels[bus];
  const spatial =
    request.distance === undefined ? 1 : spatialGain(request.distance, request.tuning);
  const ducked = DUCKING_CUES.includes(request.category)
    ? 1
    : 1 - request.ducking.amount * request.tuning.duckDepth;
  return clamp(request.level * busLevel * request.levels.master * spatial * ducked, 0, 1);
};

export interface RotorInput {
  /** Vertical thrust input, 0..1. */
  collective: number;
  /** 0..1 engine health. */
  engine: number;
  /** 0..1 rotor health. */
  rotor: number;
  /** Passengers as a fraction of capacity. */
  load: number;
  grounded: boolean;
}

export interface RotorLayers {
  /** Steady blade-pass tone. */
  blade: number;
  /** Turbine whine, rises with collective. */
  turbine: number;
  /** Load-dependent thump; the sound of lifting a full cabin. */
  slap: number;
  /** Damage rattle. Present only when the rotor is hurt. */
  rattle: number;
  /** Playback rate multiplier for the whole stack. */
  pitch: number;
}

/**
 * Procedural rotor layers, per the PRD. The player should be able to hear the aircraft
 * struggling before the gauges say so, which is why load and damage drive their own layers
 * rather than just attenuating one loop.
 */
export const rotorLayers = (input: RotorInput, tuning: MixerTuning): RotorLayers => {
  const collective = clamp(input.collective, 0, 1);
  const drive = clamp(collective / tuning.rotorCollectiveRange, 0, 1);
  const engine = clamp(input.engine, 0, 1);
  const rotorHealth = clamp(input.rotor, 0, 1);
  const load = clamp(input.load, 0, 1);

  return {
    blade: clamp((input.grounded ? 0.45 : 0.75) * (0.4 + 0.6 * engine), 0, 1),
    turbine: clamp(0.25 + 0.7 * drive * engine, 0, 1),
    // Slap needs both a loaded cabin and the power to lift it; an idle full cabin is quiet.
    slap: clamp(load * drive * 0.85, 0, 1),
    rattle: clamp((1 - rotorHealth) * 0.9, 0, 1),
    pitch: clamp(0.82 + 0.3 * drive * engine - 0.06 * load, 0.6, 1.25),
  };
};

/**
 * Music layer count for the current escalation tier, receding during boarding so civilian audio
 * can carry the moment — the rescue is the scene, not the firefight around it.
 */
export const musicLayers = (escalationTier: number, boarding: boolean): number => {
  const base = clamp(Math.floor(escalationTier), 0, 4);
  return boarding ? Math.min(base, 1) : base;
};

export interface AccessibilityAudio {
  mono: boolean;
  visualIndicators: boolean;
}

/** Applies the accessibility audio options to a computed pan value. */
export const applyAccessibility = (pan: number, options: AccessibilityAudio): number =>
  options.mono ? 0 : pan;
