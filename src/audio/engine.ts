import { Rng } from '@/core/rng.js';
import type { AudioSettings } from '@/save/schema.js';
import {
  busFor,
  cueGain,
  defaultMixerTuning,
  rotorLayers,
  spatialPan,
  stepDucking,
  applyAccessibility,
  type AccessibilityAudio,
  type Bus,
  type BusLevels,
  type CueCategory,
  type DuckingState,
  type GainRequest,
  type MixerTuning,
  type RotorInput,
  type RotorLayers,
} from './mixer.js';

/**
 * The Web Audio graph. `mixer.ts` decides what should happen to the mix — this file is the only
 * place that turns those decisions into oscillators, buffers and gain automation. There are no
 * audio assets in this repo yet, so every cue is synthesised; `CUE_LIBRARY` below is the seam a
 * real sample pack would replace without touching a single call site.
 *
 * Browsers start every `AudioContext` suspended until a user gesture unlocks it. That is a
 * normal, expected state — not a failure — so every play call here is a safe no-op until
 * `resume()` is called from a click handler, exactly the way `deviceRecovery.ts` treats a lost
 * GPU device as a normal outcome rather than an exception to catch.
 */

// ---------------------------------------------------------------------------------------------
// The injection seam: the exact slice of Web Audio this module touches, expressed as our own
// interfaces rather than the DOM lib's. That keeps the fake used by engine.test.ts to a handful
// of methods instead of every member of `AudioContext`/`AudioNode`, and it is the point of the
// exercise — Vitest runs in Node, which has no Web Audio at all.
// ---------------------------------------------------------------------------------------------

export type OscillatorShape = 'sine' | 'square' | 'sawtooth' | 'triangle';
export type AudioEngineState = 'suspended' | 'running' | 'closed';

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): void;
  linearRampToValueAtTime(value: number, endTime: number): void;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): AudioNodeLike;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface StereoPannerNodeLike extends AudioNodeLike {
  readonly pan: AudioParamLike;
}

export interface OscillatorNodeLike extends AudioNodeLike {
  type: OscillatorShape;
  readonly frequency: AudioParamLike;
  onended: (() => void) | null;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  readonly playbackRate: AudioParamLike;
  onended: (() => void) | null;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: AudioNodeLike;
  readonly sampleRate: number;
  state: AudioEngineState;
  resume(): Promise<void>;
  close(): Promise<void>;
  createGain(): GainNodeLike;
  createStereoPanner(): StereoPannerNodeLike;
  createOscillator(): OscillatorNodeLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike;
}

export type AudioContextFactory = () => AudioContextLike;

const createBrowserAudioContext = (): AudioContextLike => {
  // `AudioContext` is a DOM global; it simply does not exist under Node/Vitest, which is exactly
  // why callers should be injecting a fake rather than reaching this branch in tests.
  if (typeof AudioContext === 'undefined') {
    throw new Error('Web Audio (AudioContext) is not available in this environment.');
  }
  return new AudioContext() as unknown as AudioContextLike;
};

// ---------------------------------------------------------------------------------------------
// Synth recipes. A `CueDefinition` describes *what* to build, not how the graph is wired — that
// lives in `buildOneShotVoice` below. Swapping in a real sample pack later means adding a
// `{ kind: 'sample', url }` variant here; `playCue` would not need to change.
// ---------------------------------------------------------------------------------------------

interface EnvelopeShape {
  durationSeconds: number;
  attackSeconds: number;
  releaseSeconds: number;
}

interface ToneRecipe extends EnvelopeShape {
  kind: 'tone';
  shape: OscillatorShape;
  frequency: number;
}

interface SweepRecipe extends EnvelopeShape {
  kind: 'sweep';
  shape: OscillatorShape;
  startFrequency: number;
  endFrequency: number;
}

interface NoiseRecipe extends EnvelopeShape {
  kind: 'noise';
}

export type CueRecipe = ToneRecipe | SweepRecipe | NoiseRecipe;

export interface CueDefinition {
  recipe: CueRecipe;
}

/**
 * One synthesised placeholder per cue category. `boarding` is the rising chime that opens the
 * rescue window; `civilianVoice` doubles as the chime that closes it, since the PRD only names
 * the two moments (boarding, rescue) and the mixer only routes one bus (`voice`) for a grateful
 * passenger — a second category would just be the same sound on the same bus.
 */
export const CUE_LIBRARY: Readonly<Record<CueCategory, CueDefinition>> = {
  rotor: {
    recipe: {
      kind: 'tone',
      shape: 'sine',
      frequency: 90,
      durationSeconds: 0.18,
      attackSeconds: 0.01,
      releaseSeconds: 0.12,
    },
  },
  weapon: {
    recipe: { kind: 'noise', durationSeconds: 0.09, attackSeconds: 0.002, releaseSeconds: 0.08 },
  },
  explosion: {
    recipe: { kind: 'noise', durationSeconds: 1.1, attackSeconds: 0.005, releaseSeconds: 1.0 },
  },
  ambient: {
    recipe: {
      kind: 'tone',
      shape: 'sine',
      frequency: 110,
      durationSeconds: 2.4,
      attackSeconds: 0.4,
      releaseSeconds: 0.8,
    },
  },
  music: {
    recipe: {
      kind: 'tone',
      shape: 'triangle',
      frequency: 220,
      durationSeconds: 2,
      attackSeconds: 0.3,
      releaseSeconds: 0.6,
    },
  },
  missileWarning: {
    recipe: {
      kind: 'tone',
      shape: 'square',
      frequency: 1200,
      durationSeconds: 0.16,
      attackSeconds: 0.004,
      releaseSeconds: 0.05,
    },
  },
  civilianCritical: {
    recipe: {
      kind: 'tone',
      shape: 'sine',
      frequency: 880,
      durationSeconds: 0.22,
      attackSeconds: 0.005,
      releaseSeconds: 0.08,
    },
  },
  civilianVoice: {
    recipe: {
      kind: 'tone',
      shape: 'sine',
      frequency: 523.25,
      durationSeconds: 0.35,
      attackSeconds: 0.02,
      releaseSeconds: 0.2,
    },
  },
  boarding: {
    recipe: {
      kind: 'sweep',
      shape: 'sine',
      startFrequency: 420,
      endFrequency: 840,
      durationSeconds: 0.45,
      attackSeconds: 0.02,
      releaseSeconds: 0.2,
    },
  },
  ui: {
    recipe: { kind: 'noise', durationSeconds: 0.03, attackSeconds: 0.001, releaseSeconds: 0.02 },
  },
};

const fillNoise = (buffer: AudioBufferLike, rng: Rng): void => {
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = rng.range(-1, 1);
};

const buildNoiseBuffer = (
  context: AudioContextLike,
  rng: Rng,
  seconds: number,
): AudioBufferLike => {
  const length = Math.max(1, Math.round(context.sampleRate * Math.max(seconds, 0.02)));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  fillNoise(buffer, rng);
  return buffer;
};

interface OneShotVoice {
  /** The node a caller connects onward (through a panner, into a bus). */
  output: GainNodeLike;
  /** Cuts the voice short with a declick fade, for budget eviction rather than natural end. */
  stopEarly: () => void;
}

/** A hard `stop()` with no fade clicks; a few milliseconds of ramp is cheaper than a pop. */
const EVICTION_FADE_SECONDS = 0.015;

const buildOneShotVoice = (
  context: AudioContextLike,
  recipe: CueRecipe,
  rng: Rng,
  onFinished: () => void,
): OneShotVoice => {
  const now = context.currentTime;
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0, now);

  let source: OscillatorNodeLike | AudioBufferSourceNodeLike;
  if (recipe.kind === 'noise') {
    const bufferSource = context.createBufferSource();
    bufferSource.buffer = buildNoiseBuffer(context, rng, recipe.durationSeconds);
    bufferSource.connect(envelope);
    source = bufferSource;
  } else {
    const osc = context.createOscillator();
    osc.type = recipe.shape;
    if (recipe.kind === 'tone') {
      osc.frequency.setValueAtTime(recipe.frequency, now);
    } else {
      osc.frequency.setValueAtTime(recipe.startFrequency, now);
      osc.frequency.linearRampToValueAtTime(recipe.endFrequency, now + recipe.durationSeconds);
    }
    osc.connect(envelope);
    source = osc;
  }

  const attackEnd = now + recipe.attackSeconds;
  const end = now + recipe.durationSeconds;
  const releaseStart = Math.max(attackEnd, end - recipe.releaseSeconds);
  envelope.gain.linearRampToValueAtTime(1, attackEnd);
  envelope.gain.setValueAtTime(1, releaseStart);
  envelope.gain.linearRampToValueAtTime(0, end);

  source.onended = onFinished;
  source.start(now);
  source.stop(end);

  const stopEarly = (): void => {
    const stopTime = context.currentTime + EVICTION_FADE_SECONDS;
    envelope.gain.setValueAtTime(envelope.gain.value, context.currentTime);
    envelope.gain.linearRampToValueAtTime(0, stopTime);
    // This is a deliberate eviction, already removed from bookkeeping — the natural-end callback
    // must not fire a second time when the shortened `stop()` below actually ends the source.
    source.onended = null;
    source.stop(stopTime);
  };

  return { output: envelope, stopEarly };
};

// ---------------------------------------------------------------------------------------------
// The rotor stack: four continuous layers per `rotorLayers()`, built once and left running for
// the engine's lifetime. Volume tells the story frame to frame; nothing here is a one-shot cue,
// so it never competes with `playCue` for the voice budget below.
// ---------------------------------------------------------------------------------------------

const BLADE_BASE_HZ = 42;
const TURBINE_BASE_HZ = 220;
const ROTOR_LOOP_SECONDS = 1;

interface RotorStack {
  blade: GainNodeLike;
  turbine: GainNodeLike;
  slap: GainNodeLike;
  rattle: GainNodeLike;
  bladeOsc: OscillatorNodeLike;
  turbineOsc: OscillatorNodeLike;
  slapSource: AudioBufferSourceNodeLike;
  rattleSource: AudioBufferSourceNodeLike;
}

const buildRotorLayer = (
  context: AudioContextLike,
  destination: AudioNodeLike,
  source: OscillatorNodeLike | AudioBufferSourceNodeLike,
): GainNodeLike => {
  const gain = context.createGain();
  gain.gain.setValueAtTime(0, context.currentTime);
  source.connect(gain);
  gain.connect(destination);
  source.start(0);
  return gain;
};

const buildRotorStack = (
  context: AudioContextLike,
  rng: Rng,
  destination: AudioNodeLike,
): RotorStack => {
  const loopBuffer = buildNoiseBuffer(context, rng, ROTOR_LOOP_SECONDS);

  const bladeOsc = context.createOscillator();
  bladeOsc.type = 'sine';
  bladeOsc.frequency.setValueAtTime(BLADE_BASE_HZ, context.currentTime);
  const blade = buildRotorLayer(context, destination, bladeOsc);

  const turbineOsc = context.createOscillator();
  turbineOsc.type = 'sawtooth';
  turbineOsc.frequency.setValueAtTime(TURBINE_BASE_HZ, context.currentTime);
  const turbine = buildRotorLayer(context, destination, turbineOsc);

  const slapSource = context.createBufferSource();
  slapSource.buffer = loopBuffer;
  slapSource.loop = true;
  const slap = buildRotorLayer(context, destination, slapSource);

  const rattleSource = context.createBufferSource();
  rattleSource.buffer = loopBuffer;
  rattleSource.loop = true;
  const rattle = buildRotorLayer(context, destination, rattleSource);

  return { blade, turbine, slap, rattle, bladeOsc, turbineOsc, slapSource, rattleSource };
};

const applyRotorLayers = (stack: RotorStack, layers: RotorLayers): void => {
  stack.blade.gain.value = layers.blade;
  stack.turbine.gain.value = layers.turbine;
  stack.slap.gain.value = layers.slap;
  stack.rattle.gain.value = layers.rattle;
  stack.bladeOsc.frequency.value = BLADE_BASE_HZ * layers.pitch;
  stack.turbineOsc.frequency.value = TURBINE_BASE_HZ * layers.pitch;
  stack.slapSource.playbackRate.value = layers.pitch;
  stack.rattleSource.playbackRate.value = layers.pitch;
};

const stopRotorStack = (stack: RotorStack): void => {
  const now = 0;
  stack.bladeOsc.onended = null;
  stack.turbineOsc.onended = null;
  stack.slapSource.onended = null;
  stack.rattleSource.onended = null;
  stack.bladeOsc.stop(now);
  stack.turbineOsc.stop(now);
  stack.slapSource.stop(now);
  stack.rattleSource.stop(now);
};

// ---------------------------------------------------------------------------------------------
// Public engine surface, shared by the real engine and the silent fallback.
// ---------------------------------------------------------------------------------------------

export interface PlayCueOptions {
  /** World-space X position for a spatial cue; omitted means unpositioned (full volume, centred). */
  position?: number;
  /** Extra per-instance loudness, 0..1. Defaults to 1 (the recipe's full loudness). */
  level?: number;
}

export interface AudioFrameState {
  rotor: RotorInput;
  /** Listener (camera) X, for spatial gain/pan on cues played this frame. */
  listenerX: number;
  /** Half the audible stage width, for `spatialPan`. */
  halfWidth: number;
  /** How many ducking cues (missile warning, civilian-critical) are currently active. */
  activeDuckingCues: number;
}

export interface AudioEnginePort {
  readonly state: AudioEngineState;
  readonly activeVoiceCount: number;
  resume(): Promise<void>;
  playCue(category: CueCategory, options?: PlayCueOptions): void;
  update(dt: number, frame: AudioFrameState): void;
  setAudioSettings(settings: AudioSettings): void;
  setAccessibility(options: AccessibilityAudio): void;
  /** Current gain of one bus node, for tuning screens and tests — not part of the mix math. */
  busLevel(bus: Bus): number;
  dispose(): void;
}

export interface AudioEngineOptions {
  createContext?: AudioContextFactory;
  audio?: AudioSettings;
  /**
   * `AccessibilitySettings` in save/schema.ts carries `visualizedAudio` but no mono flag — mono
   * audio is the kind of accessibility option that more often comes from the OS than a save
   * file. Callers pass mixer's own `AccessibilityAudio` shape directly; deriving it from
   * `Settings.accessibility` (plus whatever supplies `mono`) is the app layer's job.
   */
  accessibility?: AccessibilityAudio;
  tuning?: MixerTuning;
  /** Hard ceiling on simultaneous one-shot voices. The rotor stack is not counted against it. */
  maxVoices?: number;
  seed?: number;
}

const DEFAULT_MAX_VOICES = 24;
const DEFAULT_SEED = 0x5eed_a0d1;
const DEFAULT_ACCESSIBILITY: AccessibilityAudio = { mono: false, visualIndicators: false };

/**
 * Bus and master attenuation live in the real gain graph (`applyBusLevels`), so cues are scored
 * through `cueGain` with every bus level held at 1 — otherwise settings would be applied twice.
 */
const NEUTRAL_BUS_LEVELS: BusLevels = { master: 1, music: 1, effects: 1, voice: 1 };

/** Used when the caller has not loaded settings yet — full, unattenuated bus levels. */
const NEUTRAL_AUDIO_SETTINGS: AudioSettings = { master: 1, music: 1, effects: 1, voice: 1 };

interface ActiveVoice {
  id: number;
  /** The mix gain this voice was created at; the budget evicts by this, not creation order. */
  gain: number;
  stop: () => void;
}

export class AudioEngine implements AudioEnginePort {
  private readonly context: AudioContextLike;
  private readonly master: GainNodeLike;
  private readonly musicBus: GainNodeLike;
  private readonly effectsBus: GainNodeLike;
  private readonly voiceBus: GainNodeLike;
  private readonly rotorStack: RotorStack;
  private readonly rng: Rng;
  private readonly tuning: MixerTuning;
  private readonly maxVoices: number;
  private readonly activeVoices: ActiveVoice[] = [];
  private nextVoiceId = 1;

  private settings: AudioSettings;
  private accessibility: AccessibilityAudio;
  private ducking: DuckingState = { amount: 0, activeCues: 0 };
  private listenerX = 0;
  private halfWidth = 1;
  private disposed = false;

  constructor(options: AudioEngineOptions = {}) {
    const createContext = options.createContext ?? createBrowserAudioContext;
    this.context = createContext();
    this.tuning = options.tuning ?? defaultMixerTuning();
    this.maxVoices = options.maxVoices ?? DEFAULT_MAX_VOICES;
    this.rng = new Rng(options.seed ?? DEFAULT_SEED);
    this.settings = options.audio ?? NEUTRAL_AUDIO_SETTINGS;
    this.accessibility = options.accessibility ?? DEFAULT_ACCESSIBILITY;

    this.master = this.context.createGain();
    this.musicBus = this.context.createGain();
    this.effectsBus = this.context.createGain();
    this.voiceBus = this.context.createGain();
    this.musicBus.connect(this.master);
    this.effectsBus.connect(this.master);
    this.voiceBus.connect(this.master);
    this.master.connect(this.context.destination);
    this.applyBusLevels();

    this.rotorStack = buildRotorStack(this.context, this.rng, this.effectsBus);
    applyRotorLayers(
      this.rotorStack,
      rotorLayers({ collective: 0, engine: 0, rotor: 1, load: 0, grounded: true }, this.tuning),
    );
  }

  get state(): AudioEngineState {
    return this.context.state;
  }

  get activeVoiceCount(): number {
    return this.activeVoices.length;
  }

  busLevel(bus: Bus): number {
    return this.busNode(bus).gain.value;
  }

  setAudioSettings(settings: AudioSettings): void {
    if (this.disposed) return;
    this.settings = settings;
    this.applyBusLevels();
  }

  setAccessibility(options: AccessibilityAudio): void {
    if (this.disposed) return;
    this.accessibility = options;
  }

  resume(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    // A rejected resume just means the gesture requirement is not satisfied yet; the context
    // stays suspended and every play call keeps quietly no-oping until the next attempt.
    return this.context.resume().catch(() => undefined);
  }

  update(dt: number, frame: AudioFrameState): void {
    if (this.disposed) return;
    this.ducking = stepDucking(this.ducking, frame.activeDuckingCues, dt, this.tuning);
    this.listenerX = frame.listenerX;
    this.halfWidth = frame.halfWidth;
    applyRotorLayers(this.rotorStack, rotorLayers(frame.rotor, this.tuning));
  }

  playCue(category: CueCategory, options: PlayCueOptions = {}): void {
    if (this.disposed) return;
    // Autoplay policy: nothing scheduled on a suspended context will ever be heard, and
    // scheduling it anyway just leaks oscillators until `resume()` — so this is a no-op.
    if (this.context.state !== 'running') return;

    const level = options.level ?? 1;
    const request: GainRequest =
      options.position === undefined
        ? {
            category,
            level,
            levels: NEUTRAL_BUS_LEVELS,
            ducking: this.ducking,
            tuning: this.tuning,
          }
        : {
            category,
            level,
            distance: Math.abs(options.position - this.listenerX),
            levels: NEUTRAL_BUS_LEVELS,
            ducking: this.ducking,
            tuning: this.tuning,
          };
    const gain = cueGain(request);
    if (gain <= 0) return; // inaudible — not worth a voice slot

    if (!this.reserveVoiceSlot(gain)) return;

    const rawPan =
      options.position === undefined
        ? 0
        : spatialPan(options.position, this.listenerX, this.halfWidth);
    const pan = applyAccessibility(rawPan, this.accessibility);

    const id = this.nextVoiceId++;
    const recipe = CUE_LIBRARY[category].recipe;
    const voice = buildOneShotVoice(this.context, recipe, this.rng, () => this.releaseVoice(id));

    const panner = this.context.createStereoPanner();
    panner.pan.setValueAtTime(pan, this.context.currentTime);

    const voiceGain = this.context.createGain();
    voiceGain.gain.setValueAtTime(gain, this.context.currentTime);

    voice.output.connect(panner);
    panner.connect(voiceGain);
    voiceGain.connect(this.busNode(busFor(category)));

    this.activeVoices.push({ id, gain, stop: voice.stopEarly });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const voice of this.activeVoices) voice.stop();
    this.activeVoices.length = 0;
    stopRotorStack(this.rotorStack);
    void this.context.close().catch(() => undefined);
  }

  private busNode(bus: Bus): GainNodeLike {
    switch (bus) {
      case 'master':
        return this.master;
      case 'music':
        return this.musicBus;
      case 'effects':
        return this.effectsBus;
      case 'voice':
        return this.voiceBus;
    }
  }

  private applyBusLevels(): void {
    const now = this.context.currentTime;
    this.master.gain.setValueAtTime(this.settings.master, now);
    this.musicBus.gain.setValueAtTime(this.settings.music, now);
    this.effectsBus.gain.setValueAtTime(this.settings.effects, now);
    this.voiceBus.gain.setValueAtTime(this.settings.voice, now);
  }

  /**
   * Enforces the voice budget by loudness, not arrival order. Returns whether the caller may go
   * ahead and build its voice.
   */
  private reserveVoiceSlot(candidateGain: number): boolean {
    if (this.activeVoices.length < this.maxVoices) return true;

    let quietestIndex = -1;
    let quietestGain = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.activeVoices.length; i++) {
      const voice = this.activeVoices[i];
      if (voice !== undefined && voice.gain < quietestGain) {
        quietestGain = voice.gain;
        quietestIndex = i;
      }
    }
    if (quietestIndex === -1 || candidateGain <= quietestGain) {
      // The new cue would be the quietest voice in the mix — drop it, not an existing one.
      return false;
    }
    const evicted = this.activeVoices[quietestIndex];
    this.activeVoices.splice(quietestIndex, 1);
    evicted?.stop();
    return true;
  }

  private releaseVoice(id: number): void {
    const index = this.activeVoices.findIndex((voice) => voice.id === id);
    if (index !== -1) this.activeVoices.splice(index, 1);
  }
}

/** Silent stand-in for when `AudioContext` is unavailable. The game must run without sound, never crash. */
export class NullAudioEngine implements AudioEnginePort {
  readonly state: AudioEngineState = 'closed';
  readonly activeVoiceCount = 0;

  resume(): Promise<void> {
    return Promise.resolve();
  }

  playCue(_category: CueCategory, _options?: PlayCueOptions): void {
    // Silent by design.
  }

  update(_dt: number, _frame: AudioFrameState): void {
    // Silent by design.
  }

  setAudioSettings(_settings: AudioSettings): void {
    // Silent by design.
  }

  setAccessibility(_options: AccessibilityAudio): void {
    // Silent by design.
  }

  busLevel(_bus: Bus): number {
    return 0;
  }

  dispose(): void {
    // Nothing was ever opened.
  }
}

/** Builds a real engine, falling back to silence if Web Audio cannot be constructed at all. */
export const createAudioEngine = (options: AudioEngineOptions = {}): AudioEnginePort => {
  try {
    return new AudioEngine(options);
  } catch {
    return new NullAudioEngine();
  }
};
