import { describe, expect, it } from 'vitest';
import { loadFlightBalance } from '@/content/loaders/balanceLoader.js';
import { loadMission, OPEN_SKY_ID } from '@/content/missions/index.js';
import { MissionWorld, neutralMissionInput, type MissionInput } from '@/sim/mission.js';
import {
  REPLAY_VERSION,
  ReplayPlayer,
  ReplayRecorder,
  deserializeReplay,
  inputsEqual,
  serializeReplay,
  verifyReplay,
  type Replay,
} from './replay.js';

const mission = loadMission(OPEN_SKY_ID);
const flight = loadFlightBalance();
const DT = 1 / 120;
const SEED = 21;

const makeWorld = (): MissionWorld => new MissionWorld({ mission, flight, dt: DT, seed: SEED });

const scriptAt = (i: number): MissionInput => ({
  thrustX: Math.sin(i * 0.011),
  thrustY: 0.55 + Math.sin(i * 0.006) * 0.3,
  boost: i % 380 < 80,
  yawLeft: i % 640 === 0,
  yawRight: i % 811 === 0,
  firePrimary: i % 290 < 110,
  fireSecondary: i % 1300 === 0,
  deployFlare: i % 1700 === 0,
  interact: i % 240 === 0,
  aimAngle: Math.sin(i * 0.003),
});

const capture = (ticks = 2400): Replay => {
  const world = makeWorld();
  const recorder = new ReplayRecorder({
    header: {
      missionId: mission.id,
      seed: SEED,
      dt: DT,
      difficulty: 'standard',
      recordedAt: 1_700_000_000_000,
    },
    checkpointInterval: 300,
  });
  for (let tick = 0; tick < ticks; tick++) {
    const input = scriptAt(tick);
    recorder.record(tick, input);
    world.step(input);
    recorder.checkpoint(tick, world.hash());
  }
  return recorder.finish();
};

describe('inputsEqual', () => {
  it('ignores stick jitter below the epsilon', () => {
    const a = neutralMissionInput();
    const b = { ...a, thrustX: 1e-6 };
    expect(inputsEqual(a, b)).toBe(true);
  });

  it('notices a real stick movement', () => {
    const a = neutralMissionInput();
    expect(inputsEqual(a, { ...a, thrustX: 0.4 })).toBe(false);
  });

  it('notices every button', () => {
    const a = neutralMissionInput();
    for (const key of [
      'boost',
      'yawLeft',
      'yawRight',
      'firePrimary',
      'fireSecondary',
      'deployFlare',
      'interact',
    ] as const) {
      expect(inputsEqual(a, { ...a, [key]: true })).toBe(false);
    }
  });
});

describe('recording', () => {
  it('stores only the ticks where input changed', () => {
    const recorder = new ReplayRecorder({
      header: { missionId: 'm', seed: 1, dt: DT, difficulty: 'standard', recordedAt: 0 },
    });
    const held: MissionInput = { ...neutralMissionInput(), thrustY: 1 };
    for (let tick = 0; tick < 600; tick++) recorder.record(tick, held);
    // 600 ticks of one held input is one frame, not six hundred.
    expect(recorder.finish().frames).toHaveLength(1);
  });

  it('records a frame per genuine change', () => {
    const recorder = new ReplayRecorder({
      header: { missionId: 'm', seed: 1, dt: DT, difficulty: 'standard', recordedAt: 0 },
    });
    for (let tick = 0; tick < 10; tick++) {
      recorder.record(tick, { ...neutralMissionInput(), firePrimary: tick % 2 === 0 });
    }
    expect(recorder.finish().frames).toHaveLength(10);
  });

  it('compresses the way a real session does — held inputs cost nothing', () => {
    const recorder = new ReplayRecorder({
      header: { missionId: 'm', seed: 1, dt: DT, difficulty: 'standard', recordedAt: 0 },
    });
    // A human changes input a handful of times a second, not 120 times. Twelve distinct
    // commands over ten simulated seconds is a realistic rate.
    for (let tick = 0; tick < 1200; tick++) {
      const phase = Math.floor(tick / 100);
      recorder.record(tick, {
        ...neutralMissionInput(),
        thrustY: phase % 2 === 0 ? 1 : 0.4,
        firePrimary: phase % 3 === 0,
      });
    }
    const replay = recorder.finish();
    expect(replay.totalTicks).toBe(1200);
    expect(replay.frames.length).toBeLessThan(40);
  });

  it('records every tick when the stick genuinely moves every tick', () => {
    // A continuously varying analog axis is not compressible, and must not be lossily squashed
    // into one — that would change the physics on playback.
    const replay = capture(600);
    expect(replay.frames).toHaveLength(600);
  });

  it('checkpoints on the configured interval', () => {
    const replay = capture(1200);
    expect(replay.checkpoints).toHaveLength(4);
    expect(replay.checkpoints[0]?.tick).toBe(0);
    expect(replay.checkpoints[1]?.tick).toBe(300);
  });

  it('stamps the version and mission it was recorded against', () => {
    const replay = capture(120);
    expect(replay.header.version).toBe(REPLAY_VERSION);
    expect(replay.header.missionId).toBe(mission.id);
    expect(replay.header.seed).toBe(SEED);
  });
});

describe('playback', () => {
  it('holds an input until the next recorded change', () => {
    const replay: Replay = {
      header: {
        version: 1,
        missionId: 'm',
        seed: 1,
        dt: DT,
        difficulty: 'standard',
        recordedAt: 0,
      },
      frames: [
        { tick: 0, input: { ...neutralMissionInput(), thrustY: 1 } },
        { tick: 100, input: { ...neutralMissionInput(), thrustY: 0 } },
      ],
      checkpoints: [],
      totalTicks: 200,
    };
    const player = new ReplayPlayer(replay);
    expect(player.inputAt(0).thrustY).toBe(1);
    expect(player.inputAt(50).thrustY).toBe(1);
    expect(player.inputAt(99).thrustY).toBe(1);
    expect(player.inputAt(100).thrustY).toBe(0);
    expect(player.inputAt(199).thrustY).toBe(0);
  });
});

describe('verification', () => {
  it('replays a captured mission bit for bit', () => {
    const replay = capture(2400);
    const result = verifyReplay(replay, makeWorld());
    expect(result.ok).toBe(true);
    expect(result.divergedAtTick).toBeNull();
    expect(result.checkpointsChecked).toBe(replay.checkpoints.length);
  });

  it('survives a JSON round trip', () => {
    const replay = capture(1200);
    const restored = deserializeReplay(serializeReplay(replay));
    expect(verifyReplay(restored, makeWorld()).ok).toBe(true);
  });

  it('catches a divergence and reports the earliest tick it happened', () => {
    const replay = capture(1200);
    // Corrupt one input in the middle: everything after it must diverge.
    const frame = replay.frames[Math.floor(replay.frames.length / 2)];
    expect(frame).toBeDefined();
    if (!frame) return;
    frame.input = { ...frame.input, thrustX: frame.input.thrustX + 0.5 };

    const result = verifyReplay(replay, makeWorld());
    expect(result.ok).toBe(false);
    expect(result.divergedAtTick).not.toBeNull();
    expect(result.expectedHash).not.toBe(result.actualHash);
  });

  it('catches a replay run against the wrong seed', () => {
    const replay = capture(1200);
    const wrongSeed = new MissionWorld({ mission, flight, dt: DT, seed: SEED + 1 });
    const result = verifyReplay(replay, wrongSeed);
    // Different seeds diverge as soon as the director makes its first choice.
    expect(result.ok).toBe(false);
  });

  it('refuses a replay from an incompatible build', () => {
    const replay = capture(120);
    const tampered = JSON.parse(serializeReplay(replay)) as Replay;
    tampered.header.version = 99;
    expect(() => deserializeReplay(JSON.stringify(tampered))).toThrow(/cannot be played/);
  });

  it('refuses something that is not a replay at all', () => {
    expect(() => deserializeReplay('{"nope":true}')).toThrow(/Not a replay/);
  });
});
