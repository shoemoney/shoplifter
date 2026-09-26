import { describe, expect, it } from 'vitest';
import { Rng } from '@/core/rng.js';
import type { CombatWorldView, PlayerView } from '../combat/types.js';
import {
  createDirectorState,
  defaultDirectorTuning,
  notifyFinalExtraction,
  notifyMajorObjectiveComplete,
  notifyUnload,
  releaseSocket,
  stepDirector,
  type SpawnSocket,
} from './director.js';

const makeView = (playerOverrides: Partial<PlayerView> = {}): CombatWorldView => ({
  tick: 0,
  dt: 1 / 60,
  groundHeightAt: () => 0,
  hasLineOfSight: () => true,
  player: {
    id: 1,
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    heightAboveGround: 0,
    grounded: true,
    destroyed: false,
    facing: 1,
    passengers: 0,
    ...playerOverrides,
  },
});

const groundSockets = (count: number): SpawnSocket[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `g${i}`,
    position: { x: i * 5, y: 0 },
    kind: 'rifleInfantry',
    side: 'ground',
  }));

describe('director tier progression', () => {
  it('starts at tier 0 and escalates on the first and second unload, matching the PRD table', () => {
    const tuning = defaultDirectorTuning();
    const state = createDirectorState(tuning);
    expect(state.budget.escalationTier).toBe(0);

    notifyUnload(state, tuning);
    expect(state.budget.escalationTier).toBe(1);

    notifyUnload(state, tuning);
    expect(state.budget.escalationTier).toBe(2);
  });

  it('escalates to tier 3 only on a major objective and tier 4 only on final extraction', () => {
    const tuning = defaultDirectorTuning();
    const state = createDirectorState(tuning);

    notifyMajorObjectiveComplete(state, tuning);
    expect(state.budget.escalationTier).toBe(3);

    notifyFinalExtraction(state, tuning);
    expect(state.budget.escalationTier).toBe(4);
  });

  it('never rubber-bands back down when a lower-tier event fires late', () => {
    const tuning = defaultDirectorTuning();
    const state = createDirectorState(tuning);
    notifyFinalExtraction(state, tuning);
    expect(state.budget.escalationTier).toBe(4);
    notifyUnload(state, tuning);
    expect(state.budget.escalationTier).toBe(4);
  });
});

describe('director spawn gating', () => {
  it('never exceeds maxConcurrentGround, no matter how many sockets and ticks are offered', () => {
    const tuning = defaultDirectorTuning();
    const state = createDirectorState(tuning);
    const sockets = groundSockets(10);
    const rng = new Rng(1);
    const view = makeView();

    for (let i = 0; i < 5000; i++) {
      stepDirector(state, sockets, view, tuning, rng);
    }

    expect(state.activeGroundCount).toBeLessThanOrEqual(tuning.budgetByTier[0].maxConcurrentGround);
  });

  it('respects the reinforcement cooldown between spawns', () => {
    const tuning = defaultDirectorTuning();
    const state = createDirectorState(tuning);
    const sockets = groundSockets(5);
    const rng = new Rng(2);
    const view = makeView();
    const spawnTicks: number[] = [];

    for (let i = 0; i < 3000; i++) {
      const result = stepDirector(state, sockets, view, tuning, rng);
      if (result.spawns.length > 0) spawnTicks.push(i);
    }

    expect(spawnTicks.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < spawnTicks.length; i++) {
      const prev = spawnTicks[i - 1];
      const curr = spawnTicks[i];
      if (prev === undefined || curr === undefined) throw new Error('unreachable');
      const gapSeconds = (curr - prev) * view.dt;
      expect(gapSeconds).toBeGreaterThanOrEqual(
        tuning.budgetByTier[0].reinforcementCooldown - view.dt,
      );
    }
  });

  it('does not spawn before the minimum start delay, even with an eligible socket ready', () => {
    const tuning = defaultDirectorTuning();
    const state = createDirectorState(tuning);
    const sockets = groundSockets(1);
    const rng = new Rng(4);
    const view = makeView();
    const ticksBeforeDelay = Math.floor(tuning.minStartDelaySeconds / view.dt) - 2;

    for (let i = 0; i < ticksBeforeDelay; i++) {
      const result = stepDirector(state, sockets, view, tuning, rng);
      expect(result.spawns.length).toBe(0);
    }
  });

  it('will not select an AA gun socket while the player is below the AA altitude threshold', () => {
    const tuning = defaultDirectorTuning();
    const state = createDirectorState(tuning);
    notifyUnload(state, tuning);
    notifyUnload(state, tuning);
    const sockets: SpawnSocket[] = [
      { id: 'aa1', position: { x: 0, y: 0 }, kind: 'aaGun', side: 'air' },
    ];
    const rng = new Rng(9);
    const lowView = makeView({ heightAboveGround: 5 });

    for (let i = 0; i < 2000; i++) stepDirector(state, sockets, lowView, tuning, rng);
    expect(state.occupiedSocketIds.has('aa1')).toBe(false);

    const highView = makeView({ heightAboveGround: 60 });
    let spawned = false;
    for (let i = 0; i < 2000 && !spawned; i++) {
      const result = stepDirector(state, sockets, highView, tuning, rng);
      if (result.spawns.length > 0) spawned = true;
    }
    expect(spawned).toBe(true);
  });
});

describe('tier 4 climax termination', () => {
  it('spawns exactly the authored ceiling and then stops forever, even with infinite supply', () => {
    const tuning = defaultDirectorTuning();
    const state = createDirectorState(tuning);
    notifyFinalExtraction(state, tuning);

    const sockets: SpawnSocket[] = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`,
      position: { x: i, y: i % 2 === 0 ? 0 : 50 },
      kind: i % 2 === 0 ? 'rifleInfantry' : 'jet',
      side: i % 2 === 0 ? 'ground' : 'air',
    }));
    const rng = new Rng(3);
    const view = makeView({ heightAboveGround: 60 });
    let totalSpawns = 0;

    for (let i = 0; i < 20000; i++) {
      const result = stepDirector(state, sockets, view, tuning, rng);
      totalSpawns += result.spawns.length;
      // Free every socket immediately so occupancy/concurrency is never the limiting factor —
      // the only thing that should be able to stop this loop is the tier-4 spawn ceiling.
      for (const spawn of result.spawns) {
        const socket = sockets.find((s) => s.id === spawn.socketId);
        if (socket) releaseSocket(state, socket);
      }
    }

    expect(state.tier4Complete).toBe(true);
    expect(totalSpawns).toBe(tuning.tier4ClimaxSpawnLimit);
    expect(state.tier4SpawnsUsed).toBe(tuning.tier4ClimaxSpawnLimit);
  });
});

describe('deterministic socket selection', () => {
  it('two directors seeded identically choose an identical spawn sequence', () => {
    const tuning = defaultDirectorTuning();
    const sockets = groundSockets(8);
    const view = makeView();

    const runDirector = (seed: number): string[] => {
      const state = createDirectorState(tuning);
      const rng = new Rng(seed);
      const chosen: string[] = [];
      for (let i = 0; i < 3000; i++) {
        const result = stepDirector(state, sockets, view, tuning, rng);
        for (const spawn of result.spawns) {
          chosen.push(spawn.socketId);
          const socket = sockets.find((s) => s.id === spawn.socketId);
          if (socket) releaseSocket(state, socket);
        }
      }
      return chosen;
    };

    const a = runDirector(777);
    const b = runDirector(777);
    expect(a.length).toBeGreaterThan(5);
    expect(a).toEqual(b);
  });
});
