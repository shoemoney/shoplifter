import { describe, expect, it } from 'vitest';
import { defaultMixerTuning, rotorLayers, type RotorInput } from './mixer.js';
import {
  AudioEngine,
  NullAudioEngine,
  createAudioEngine,
  type AudioBufferLike,
  type AudioContextLike,
  type AudioEngineOptions,
  type AudioEngineState,
  type AudioFrameState,
  type AudioNodeLike,
  type AudioParamLike,
  type GainNodeLike,
  type OscillatorNodeLike,
  type OscillatorShape,
  type StereoPannerNodeLike,
  type AudioBufferSourceNodeLike,
} from './engine.js';

/**
 * Vitest runs in Node, which has no Web Audio at all, so every test drives `AudioEngine` through
 * a fake context built from the same seam `engine.ts` defines for exactly this purpose. The fake
 * tracks every node it creates, in creation order, so tests can inspect the graph the engine
 * actually wired up rather than guessing at internals.
 */

class FakeAudioParam implements AudioParamLike {
  value = 1;
  setValueAtTime(value: number): void {
    this.value = value;
  }
  linearRampToValueAtTime(value: number): void {
    this.value = value;
  }
}

class FakeNode implements AudioNodeLike {
  readonly connectedTo: AudioNodeLike[] = [];
  connect(destination: AudioNodeLike): AudioNodeLike {
    this.connectedTo.push(destination);
    return destination;
  }
  disconnect(): void {
    this.connectedTo.length = 0;
  }
}

class FakeGainNode extends FakeNode implements GainNodeLike {
  readonly gain = new FakeAudioParam();
}

class FakePannerNode extends FakeNode implements StereoPannerNodeLike {
  readonly pan = new FakeAudioParam();
}

class FakeOscillatorNode extends FakeNode implements OscillatorNodeLike {
  type: OscillatorShape = 'sine';
  readonly frequency = new FakeAudioParam();
  onended: (() => void) | null = null;
  started = false;
  /** `stop()` only *schedules* an end in real Web Audio; a one-shot always calls it once for its
   *  natural end, so a second call is the signal that something cut the voice short (a budget
   *  eviction), not the natural end firing. */
  stopCallCount = 0;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopCallCount++;
  }
}

class FakeAudioBuffer implements AudioBufferLike {
  private readonly data: Float32Array;
  constructor(length: number) {
    this.data = new Float32Array(length);
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}

class FakeBufferSourceNode extends FakeNode implements AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null = null;
  loop = false;
  readonly playbackRate = new FakeAudioParam();
  onended: (() => void) | null = null;
  started = false;
  /** See the comment on `FakeOscillatorNode.stopCallCount` — a second call means an eviction. */
  stopCallCount = 0;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopCallCount++;
  }
}

class FakeAudioContext implements AudioContextLike {
  currentTime = 0;
  readonly destination: AudioNodeLike = new FakeNode();
  sampleRate = 48_000;
  state: AudioEngineState;
  resumeCalls = 0;
  closeCalls = 0;
  readonly gains: FakeGainNode[] = [];
  readonly panners: FakePannerNode[] = [];
  readonly oscillators: FakeOscillatorNode[] = [];
  readonly bufferSources: FakeBufferSourceNode[] = [];

  constructor(state: AudioEngineState = 'running') {
    this.state = state;
  }

  resume(): Promise<void> {
    this.resumeCalls++;
    this.state = 'running';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls++;
    this.state = 'closed';
    return Promise.resolve();
  }

  createGain(): GainNodeLike {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }

  createStereoPanner(): StereoPannerNodeLike {
    const node = new FakePannerNode();
    this.panners.push(node);
    return node;
  }

  createOscillator(): OscillatorNodeLike {
    const node = new FakeOscillatorNode();
    this.oscillators.push(node);
    return node;
  }

  createBufferSource(): AudioBufferSourceNodeLike {
    const node = new FakeBufferSourceNode();
    this.bufferSources.push(node);
    return node;
  }

  createBuffer(_numberOfChannels: number, length: number): AudioBufferLike {
    return new FakeAudioBuffer(length);
  }
}

const tuning = defaultMixerTuning();

const idleRotor: RotorInput = { collective: 0, engine: 0, rotor: 1, load: 0, grounded: true };

/**
 * The engine creates its four bus gains (master, music, effects, voice) before building the
 * rotor stack, so the rotor's own four gains (blade, turbine, slap, rattle) always land right
 * after them, in that order, in `context.gains`.
 */
const BUS_GAIN_COUNT = 4;
const ROTOR_BLADE_GAIN = BUS_GAIN_COUNT;
const ROTOR_TURBINE_GAIN = BUS_GAIN_COUNT + 1;
const ROTOR_SLAP_GAIN = BUS_GAIN_COUNT + 2;
const ROTOR_RATTLE_GAIN = BUS_GAIN_COUNT + 3;

const frame = (overrides: Partial<AudioFrameState> = {}): AudioFrameState => ({
  rotor: idleRotor,
  listenerX: 0,
  halfWidth: 200,
  activeDuckingCues: 0,
  ...overrides,
});

const harness = (
  contextState: AudioEngineState = 'running',
  options: AudioEngineOptions = {},
): { context: FakeAudioContext; engine: AudioEngine } => {
  const context = new FakeAudioContext(contextState);
  const engine = new AudioEngine({ createContext: () => context, ...options });
  return { context, engine };
};

describe('bus levels', () => {
  it('tracks settings for every bus', () => {
    const { engine } = harness('running', {
      audio: { master: 0.5, music: 0.6, effects: 0.7, voice: 0.8 },
    });
    expect(engine.busLevel('master')).toBe(0.5);
    expect(engine.busLevel('music')).toBe(0.6);
    expect(engine.busLevel('effects')).toBe(0.7);
    expect(engine.busLevel('voice')).toBe(0.8);
  });

  it('updates live when settings change', () => {
    const { engine } = harness();
    engine.setAudioSettings({ master: 0.2, music: 1, effects: 1, voice: 1 });
    expect(engine.busLevel('master')).toBe(0.2);
  });

  it('silences everything at the master stage when master is 0', () => {
    // The engine never re-applies bus/master levels per cue (that would double them up with
    // `cueGain`), so a zeroed master is the one place in the graph every voice must pass
    // through. Reading the master node back at 0 is the whole guarantee.
    const { engine } = harness('running', {
      audio: { master: 0, music: 1, effects: 1, voice: 1 },
    });
    expect(engine.busLevel('master')).toBe(0);
  });
});

describe('ducking', () => {
  it('pulls combat down under a missile warning but never the warning itself', () => {
    const { context, engine } = harness();
    for (let i = 0; i < 120; i++) engine.update(1 / 60, frame({ activeDuckingCues: 1 }));

    engine.playCue('weapon');
    const weaponGain = context.gains.at(-1)?.gain.value;
    engine.playCue('missileWarning');
    const warningGain = context.gains.at(-1)?.gain.value;

    expect(weaponGain).toBeCloseTo(1 - tuning.duckDepth, 2);
    expect(warningGain).toBe(1);
  });
});

describe('spatial cues', () => {
  it('gets quieter the further it is from the listener', () => {
    const { context, engine } = harness();
    engine.update(0, frame({ listenerX: 0 }));
    engine.playCue('weapon', { position: 0 });
    const near = context.gains.at(-1)?.gain.value ?? 0;

    engine.update(0, frame({ listenerX: -80 }));
    engine.playCue('weapon', { position: 0 });
    const far = context.gains.at(-1)?.gain.value ?? 0;

    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(near);
  });

  it('collapses pan to centre in mono mode', () => {
    const { context, engine } = harness('running', {
      accessibility: { mono: false, visualIndicators: false },
    });
    engine.update(0, frame({ listenerX: 0, halfWidth: 100 }));

    engine.playCue('weapon', { position: 50 });
    expect(context.panners.at(-1)?.pan.value).toBeGreaterThan(0);

    engine.setAccessibility({ mono: true, visualIndicators: false });
    engine.playCue('weapon', { position: 50 });
    expect(context.panners.at(-1)?.pan.value).toBe(0);
  });
});

describe('voice budget', () => {
  it('drops the quietest voice for a louder newcomer instead of dropping the newcomer', () => {
    const { context, engine } = harness('running', { maxVoices: 2 });
    engine.update(0, frame({ listenerX: 0 }));

    // Two quiet, distant cues fill the budget.
    engine.playCue('weapon', { position: 150 });
    engine.playCue('weapon', { position: 150 });
    expect(engine.activeVoiceCount).toBe(2);

    const firstQuietSource = context.bufferSources.at(-2);
    const secondQuietSource = context.bufferSources.at(-1);

    // A loud, close cue arrives with the budget full.
    engine.playCue('explosion', { position: 0 });

    expect(engine.activeVoiceCount).toBe(2);
    expect(firstQuietSource?.stopCallCount).toBe(2);
    expect(secondQuietSource?.stopCallCount).toBe(1);
    expect(context.bufferSources.at(-1)?.stopCallCount).toBe(1);
  });

  it('drops a new cue that would be the quietest voice in a full mix', () => {
    const { context, engine } = harness('running', { maxVoices: 1 });
    engine.update(0, frame({ listenerX: 0 }));

    engine.playCue('explosion', { position: 0 });
    expect(engine.activeVoiceCount).toBe(1);
    const loudSource = context.bufferSources.at(-1);

    engine.playCue('weapon', { position: 150 });
    expect(engine.activeVoiceCount).toBe(1);
    expect(loudSource?.stopCallCount).toBe(1);
  });
});

describe('rotor layers', () => {
  it('reflects rotorLayers() for collective, load and damage', () => {
    const { context, engine } = harness();
    const input: RotorInput = {
      collective: 0.8,
      engine: 1,
      rotor: 0.3,
      load: 0.9,
      grounded: false,
    };
    engine.update(1 / 60, frame({ rotor: input }));

    const expected = rotorLayers(input, tuning);
    const [bladeOsc, turbineOsc] = context.oscillators;
    const [slapSource, rattleSource] = context.bufferSources;

    expect(context.gains[ROTOR_BLADE_GAIN]?.gain.value).toBeCloseTo(expected.blade, 6);
    expect(context.gains[ROTOR_TURBINE_GAIN]?.gain.value).toBeCloseTo(expected.turbine, 6);
    expect(context.gains[ROTOR_SLAP_GAIN]?.gain.value).toBeCloseTo(expected.slap, 6);
    expect(context.gains[ROTOR_RATTLE_GAIN]?.gain.value).toBeCloseTo(expected.rattle, 6);
    expect(bladeOsc?.frequency.value).toBeGreaterThan(0);
    expect(turbineOsc?.frequency.value).toBeGreaterThan(0);
    expect(slapSource?.playbackRate.value).toBeCloseTo(expected.pitch, 6);
    expect(rattleSource?.playbackRate.value).toBeCloseTo(expected.pitch, 6);
  });

  it('changes turbine and pitch as collective rises', () => {
    const { context, engine } = harness();
    engine.update(
      1 / 60,
      frame({ rotor: { ...idleRotor, collective: 0, engine: 1, grounded: false } }),
    );
    const idleTurbine = context.gains[ROTOR_TURBINE_GAIN]?.gain.value;

    engine.update(
      1 / 60,
      frame({ rotor: { ...idleRotor, collective: 1, engine: 1, grounded: false } }),
    );
    const climbingTurbine = context.gains[ROTOR_TURBINE_GAIN]?.gain.value;

    expect(climbingTurbine).toBeGreaterThan(idleTurbine ?? 0);
  });
});

describe('autoplay policy', () => {
  it('never throws while the context is suspended, and drops play calls silently', () => {
    const { engine } = harness('suspended');
    expect(() => engine.playCue('weapon')).not.toThrow();
    expect(() => engine.update(1 / 60, frame())).not.toThrow();
    expect(engine.activeVoiceCount).toBe(0);
    expect(engine.state).toBe('suspended');
  });

  it('unlocks playback once resume() resolves', async () => {
    const { context, engine } = harness('suspended');
    engine.playCue('weapon');
    expect(engine.activeVoiceCount).toBe(0);

    await engine.resume();

    expect(context.resumeCalls).toBe(1);
    expect(engine.state).toBe('running');

    engine.playCue('weapon');
    expect(engine.activeVoiceCount).toBe(1);
  });
});

describe('dispose', () => {
  it('closes the context and stops taking further work', () => {
    const { context, engine } = harness();
    engine.playCue('weapon');
    expect(engine.activeVoiceCount).toBe(1);

    engine.dispose();

    expect(context.closeCalls).toBe(1);
    expect(engine.activeVoiceCount).toBe(0);
    expect(() => engine.playCue('weapon')).not.toThrow();
    expect(() => engine.update(1 / 60, frame())).not.toThrow();
    expect(engine.activeVoiceCount).toBe(0);
  });
});

describe('NullAudioEngine', () => {
  it('accepts every call without throwing or ever becoming audible', async () => {
    const engine = new NullAudioEngine();
    expect(() => engine.playCue('explosion', { position: 0, level: 1 })).not.toThrow();
    expect(() => engine.update(1 / 60, frame())).not.toThrow();
    expect(() =>
      engine.setAudioSettings({ master: 1, music: 1, effects: 1, voice: 1 }),
    ).not.toThrow();
    expect(() => engine.setAccessibility({ mono: true, visualIndicators: true })).not.toThrow();
    expect(engine.busLevel('master')).toBe(0);
    expect(engine.activeVoiceCount).toBe(0);
    await expect(engine.resume()).resolves.toBeUndefined();
    expect(() => engine.dispose()).not.toThrow();
  });
});

describe('createAudioEngine', () => {
  it('falls back to a silent engine when the context cannot be built', () => {
    const engine = createAudioEngine({
      createContext: () => {
        throw new Error('no web audio here');
      },
    });
    expect(engine).toBeInstanceOf(NullAudioEngine);
    expect(() => engine.playCue('ui')).not.toThrow();
  });

  it('builds a real engine when the context is available', () => {
    const engine = createAudioEngine({ createContext: () => new FakeAudioContext() });
    expect(engine).toBeInstanceOf(AudioEngine);
    engine.dispose();
  });
});
