import type { Vec2 } from '@/core/math.js';
import type { Rng } from '@/core/rng.js';
import type {
  CombatWorldView,
  DirectorBudget,
  EnemyKind,
  EscalationTier,
  PlayerView,
} from '../combat/types.js';

// TODO(balance): tier tables and cooldowns below are design placeholders, not measurements —
// they belong in a mission-authored balance JSON once the content pipeline covers the director
// (see src/content/schemas/flight.ts for the loader pattern this should eventually follow).

/**
 * An authored placement the director may fill, never a coordinate it invents. The PRD is
 * explicit that runtime code must not contain mission-specific entity placements — sockets are
 * mission content, the director only decides which ones activate and when.
 */
export interface SpawnSocket {
  id: string;
  position: Vec2;
  kind: EnemyKind;
  side: 'ground' | 'air';
}

interface TierBudget {
  maxConcurrentAir: number;
  maxConcurrentGround: number;
  reinforcementCooldown: number;
}

export interface DirectorTuning {
  /** Enemy kinds unlocked at each escalation tier, cumulative per the PRD's tier table. */
  kindsByTier: Readonly<Record<EscalationTier, readonly EnemyKind[]>>;
  budgetByTier: Readonly<Record<EscalationTier, TierBudget>>;
  /** Hard ceiling on tier-4 spawns — the authored climax must terminate, never spawn forever. */
  tier4ClimaxSpawnLimit: number;
  /** No reinforcement before this much combat time has elapsed, so a mission always opens quiet. */
  minStartDelaySeconds: number;
  /** The AA gun controls high-altitude routes; spawning one against a grounded player is a
   *  lethal threat with nothing to shoot at and no reason for the player to expect it. */
  aaMinPlayerAltitude: number;
}

export const defaultDirectorTuning = (): DirectorTuning => ({
  kindsByTier: {
    0: ['rifleInfantry', 'lightTank'],
    1: ['rifleInfantry', 'lightTank', 'aaGun', 'jet'],
    2: ['rifleInfantry', 'lightTank', 'aaGun', 'jet', 'drone'],
    3: ['rifleInfantry', 'lightTank', 'aaGun', 'jet', 'drone'],
    4: ['rifleInfantry', 'lightTank', 'aaGun', 'jet', 'drone'],
  },
  budgetByTier: {
    0: { maxConcurrentAir: 0, maxConcurrentGround: 3, reinforcementCooldown: 6 },
    1: { maxConcurrentAir: 1, maxConcurrentGround: 3, reinforcementCooldown: 5 },
    2: { maxConcurrentAir: 2, maxConcurrentGround: 4, reinforcementCooldown: 4.5 },
    // Tier 3: "shorter reinforcement cooldown and mixed attacks" per the PRD, literally.
    3: { maxConcurrentAir: 2, maxConcurrentGround: 5, reinforcementCooldown: 2.5 },
    4: { maxConcurrentAir: 3, maxConcurrentGround: 6, reinforcementCooldown: 1.5 },
  },
  tier4ClimaxSpawnLimit: 8,
  minStartDelaySeconds: 1,
  aaMinPlayerAltitude: 25,
});

/**
 * Mutable director progress. `budget` mirrors the shared `DirectorBudget` contract exactly so
 * the HUD/debug overlay can display it without knowing anything else about this module.
 */
export interface DirectorState {
  budget: DirectorBudget;
  cooldownRemaining: number;
  elapsedCombatSeconds: number;
  unloadCount: number;
  majorObjectiveComplete: boolean;
  finalExtractionTriggered: boolean;
  activeGroundCount: number;
  activeAirCount: number;
  tier4SpawnsUsed: number;
  /** Once true, `stepDirector` never spawns again — the tier-4 termination proof. */
  tier4Complete: boolean;
  occupiedSocketIds: Set<string>;
}

export const createDirectorState = (tuning: DirectorTuning): DirectorState => ({
  budget: { threatPoints: 0, escalationTier: 0, ...tuning.budgetByTier[0] },
  cooldownRemaining: 0,
  elapsedCombatSeconds: 0,
  unloadCount: 0,
  majorObjectiveComplete: false,
  finalExtractionTriggered: false,
  activeGroundCount: 0,
  activeAirCount: 0,
  tier4SpawnsUsed: 0,
  tier4Complete: false,
  occupiedSocketIds: new Set(),
});

/**
 * Escalation only ever moves forward. The PRD forbids rubber-banding, and a director that could
 * drop back to an easier tier after a bad run for the player would be exactly that in disguise.
 */
const escalateTo = (state: DirectorState, tier: EscalationTier, tuning: DirectorTuning): void => {
  if (tier <= state.budget.escalationTier) return;
  state.budget = { ...state.budget, escalationTier: tier, ...tuning.budgetByTier[tier] };
};

/** Tier 1 after the first unload, tier 2 after the second — the PRD's table, directly. */
export const notifyUnload = (state: DirectorState, tuning: DirectorTuning): void => {
  state.unloadCount += 1;
  if (state.unloadCount === 1) escalateTo(state, 1, tuning);
  else if (state.unloadCount >= 2) escalateTo(state, 2, tuning);
};

export const notifyMajorObjectiveComplete = (
  state: DirectorState,
  tuning: DirectorTuning,
): void => {
  state.majorObjectiveComplete = true;
  escalateTo(state, 3, tuning);
};

export const notifyFinalExtraction = (state: DirectorState, tuning: DirectorTuning): void => {
  state.finalExtractionTriggered = true;
  state.tier4SpawnsUsed = 0;
  state.tier4Complete = false;
  escalateTo(state, 4, tuning);
};

/** The integration layer calls this when a spawned enemy dies or leaves, freeing its socket. */
export const releaseSocket = (state: DirectorState, socket: SpawnSocket): void => {
  if (!state.occupiedSocketIds.delete(socket.id)) return;
  if (socket.side === 'air') state.activeAirCount = Math.max(0, state.activeAirCount - 1);
  else state.activeGroundCount = Math.max(0, state.activeGroundCount - 1);
};

const isSocketEligible = (
  socket: SpawnSocket,
  state: DirectorState,
  allowedKinds: readonly EnemyKind[],
  player: PlayerView,
  tuning: DirectorTuning,
): boolean => {
  if (state.occupiedSocketIds.has(socket.id)) return false;
  if (!allowedKinds.includes(socket.kind)) return false;
  const capacity =
    socket.side === 'air' ? state.budget.maxConcurrentAir : state.budget.maxConcurrentGround;
  const active = socket.side === 'air' ? state.activeAirCount : state.activeGroundCount;
  if (active >= capacity) return false;
  if (socket.kind === 'aaGun' && player.heightAboveGround < tuning.aaMinPlayerAltitude)
    return false;
  return true;
};

export interface DirectorSpawnRequest {
  socketId: string;
  kind: EnemyKind;
}

export interface DirectorStepResult {
  spawns: readonly DirectorSpawnRequest[];
}

/**
 * Advances the director by one fixed tick. At most one socket activates per call — reinforcement
 * is gated entirely by `cooldownRemaining`, so there is no path that floods several threats onto
 * the player in the same tick regardless of how many sockets qualify.
 */
export const stepDirector = (
  state: DirectorState,
  sockets: readonly SpawnSocket[],
  view: CombatWorldView,
  tuning: DirectorTuning,
  rng: Rng,
): DirectorStepResult => {
  state.elapsedCombatSeconds += view.dt;
  if (state.cooldownRemaining > 0) {
    state.cooldownRemaining = Math.max(0, state.cooldownRemaining - view.dt);
  }

  if (
    state.tier4Complete ||
    state.cooldownRemaining > 0 ||
    state.elapsedCombatSeconds < tuning.minStartDelaySeconds
  ) {
    return { spawns: [] };
  }

  const allowedKinds = tuning.kindsByTier[state.budget.escalationTier];
  // Sockets are an authored, per-level set — small and static, not a per-entity hot path like
  // enemies.ts steps every tick — so filtering here once per director tick is deliberate.
  const eligible = sockets.filter((socket) =>
    isSocketEligible(socket, state, allowedKinds, view.player, tuning),
  );
  if (eligible.length === 0) return { spawns: [] };

  const chosen = rng.pick(eligible);
  state.occupiedSocketIds.add(chosen.id);
  if (chosen.side === 'air') state.activeAirCount += 1;
  else state.activeGroundCount += 1;
  state.cooldownRemaining = state.budget.reinforcementCooldown;

  if (state.budget.escalationTier === 4) {
    state.tier4SpawnsUsed += 1;
    if (state.tier4SpawnsUsed >= tuning.tier4ClimaxSpawnLimit) {
      state.tier4Complete = true;
    }
  }

  return { spawns: [{ socketId: chosen.id, kind: chosen.kind }] };
};
