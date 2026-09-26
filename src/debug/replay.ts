import type { MissionInput } from '@/sim/mission.js';
import { neutralMissionInput } from '@/sim/mission.js';

/**
 * Replay capture and verification. This is what all the determinism discipline was for: if the
 * simulation is a pure function of (seed, inputs), a mission is fully described by the inputs
 * and can be re-run bit-for-bit — for bug reports, for regression tests, and for proving a
 * leaderboard run was actually flown.
 */
export const REPLAY_VERSION = 1;

export interface ReplayHeader {
  version: number;
  missionId: string;
  seed: number;
  /** Fixed timestep the recording was made at. Replaying at a different dt is not valid. */
  dt: number;
  difficulty: string;
  /** Epoch milliseconds, for display only — never fed to the simulation. */
  recordedAt: number;
}

/** An input change and the tick it takes effect on. */
export interface InputFrame {
  tick: number;
  input: MissionInput;
}

export interface ReplayCheckpoint {
  tick: number;
  hash: string;
}

export interface Replay {
  header: ReplayHeader;
  /**
   * Only the ticks where input CHANGED. A mission is mostly held buttons and steady sticks, so
   * storing every tick would be ~99% redundant at 120 Hz.
   */
  frames: InputFrame[];
  checkpoints: ReplayCheckpoint[];
  totalTicks: number;
}

/** Axis comparison tolerance. Sticks jitter below this and it is not worth a frame. */
const AXIS_EPSILON = 1e-4;

export const inputsEqual = (a: MissionInput, b: MissionInput): boolean =>
  Math.abs(a.thrustX - b.thrustX) < AXIS_EPSILON &&
  Math.abs(a.thrustY - b.thrustY) < AXIS_EPSILON &&
  Math.abs(a.aimAngle - b.aimAngle) < AXIS_EPSILON &&
  a.boost === b.boost &&
  a.yawLeft === b.yawLeft &&
  a.yawRight === b.yawRight &&
  a.firePrimary === b.firePrimary &&
  a.fireSecondary === b.fireSecondary &&
  a.deployFlare === b.deployFlare &&
  a.interact === b.interact;

export interface RecorderOptions {
  header: Omit<ReplayHeader, 'version'>;
  /** Ticks between state hashes. More checkpoints localise a divergence more tightly. */
  checkpointInterval?: number;
}

export class ReplayRecorder {
  private readonly frames: InputFrame[] = [];
  private readonly checkpoints: ReplayCheckpoint[] = [];
  private readonly header: ReplayHeader;
  private readonly interval: number;
  private last: MissionInput = neutralMissionInput();
  private started = false;
  private ticks = 0;

  constructor(options: RecorderOptions) {
    this.header = { ...options.header, version: REPLAY_VERSION };
    this.interval = options.checkpointInterval ?? 600;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** Call once per simulation tick, before stepping, with that tick's input. */
  record(tick: number, input: MissionInput): void {
    if (!this.started || !inputsEqual(input, this.last)) {
      this.frames.push({ tick, input: { ...input } });
      this.last = { ...input };
      this.started = true;
    }
    this.ticks = tick + 1;
  }

  /** Call after stepping, with the world's state hash. Recorded only on checkpoint ticks. */
  checkpoint(tick: number, hash: string): void {
    if (tick % this.interval !== 0) return;
    this.checkpoints.push({ tick, hash });
  }

  finish(): Replay {
    return {
      header: this.header,
      frames: [...this.frames],
      checkpoints: [...this.checkpoints],
      totalTicks: this.ticks,
    };
  }
}

/**
 * Expands the sparse frame list back into per-tick input. Inputs persist until the next recorded
 * change, which is exactly how a held button behaves.
 */
export class ReplayPlayer {
  private index = 0;
  private current: MissionInput = neutralMissionInput();

  constructor(private readonly replay: Replay) {}

  get totalTicks(): number {
    return this.replay.totalTicks;
  }

  inputAt(tick: number): MissionInput {
    while (this.index < this.replay.frames.length) {
      const frame = this.replay.frames[this.index];
      if (!frame || frame.tick > tick) break;
      this.current = frame.input;
      this.index++;
    }
    return this.current;
  }

  checkpointAt(tick: number): ReplayCheckpoint | undefined {
    return this.replay.checkpoints.find((checkpoint) => checkpoint.tick === tick);
  }
}

export interface VerifyResult {
  ok: boolean;
  /** Tick where the hashes first diverged, or null when the replay matched throughout. */
  divergedAtTick: number | null;
  expectedHash: string | null;
  actualHash: string | null;
  checkpointsChecked: number;
}

export interface VerifiableWorld {
  step: (input: MissionInput) => void;
  hash: () => string;
}

/**
 * Re-runs a replay against a fresh world and compares state hashes at every checkpoint. Stops at
 * the first divergence, because everything after it is noise — the interesting information is
 * the earliest tick where the two runs stopped agreeing.
 */
export const verifyReplay = (replay: Replay, world: VerifiableWorld): VerifyResult => {
  const player = new ReplayPlayer(replay);
  let checked = 0;

  for (let tick = 0; tick < replay.totalTicks; tick++) {
    world.step(player.inputAt(tick));
    const checkpoint = player.checkpointAt(tick);
    if (!checkpoint) continue;
    checked++;
    const actual = world.hash();
    if (actual !== checkpoint.hash) {
      return {
        ok: false,
        divergedAtTick: tick,
        expectedHash: checkpoint.hash,
        actualHash: actual,
        checkpointsChecked: checked,
      };
    }
  }

  return {
    ok: true,
    divergedAtTick: null,
    expectedHash: null,
    actualHash: null,
    checkpointsChecked: checked,
  };
};

/**
 * JSON for storage. Deliberately NOT rounded: shrinking axis values to four decimals changes
 * the inputs enough to change the physics, and a replay that does not reproduce bit-for-bit is
 * not a replay. Compression comes from storing only the ticks where input changed.
 */
export const serializeReplay = (replay: Replay): string => JSON.stringify(replay);

export const deserializeReplay = (json: string): Replay => {
  const parsed: unknown = JSON.parse(json);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('header' in parsed) ||
    !('frames' in parsed)
  ) {
    throw new Error('Not a replay');
  }
  const replay = parsed as Replay;
  if (replay.header.version !== REPLAY_VERSION) {
    throw new Error(
      `Replay version ${replay.header.version} cannot be played by this build (expected ${REPLAY_VERSION})`,
    );
  }
  return replay;
};
