import { clamp } from '@/core/math.js';
import type { Vec2 } from '@/core/math.js';
import type { EntityId } from '../components.js';
import type { DamagePacket } from '../combat/types.js';

/**
 * Civilians are the point of the game, not pickups. The 1982 original tracked a finite
 * population and scored only how many of them lived; everything here exists to make each one
 * individually legible — where they are, what they are doing, and why they died if they died.
 */
export type CivilianState =
  | 'captive'
  | 'released'
  | 'seekCover'
  | 'panic'
  | 'approachLz'
  | 'waitForSpace'
  | 'boarding'
  | 'aboard'
  | 'disembarking'
  | 'rescued'
  | 'injured'
  | 'dead';

/** States in which a civilian is out in the open and can be hurt. */
export const EXPOSED_STATES: readonly CivilianState[] = [
  'released',
  'seekCover',
  'panic',
  'approachLz',
  'waitForSpace',
  'boarding',
  'disembarking',
];

export const isExposed = (state: CivilianState): boolean => EXPOSED_STATES.includes(state);

export const isAlive = (state: CivilianState): boolean => state !== 'dead';

/** Counted by the debrief as saved. Terminal, like `dead`. */
export const isResolved = (state: CivilianState): boolean =>
  state === 'rescued' || state === 'dead';

export interface Civilian {
  id: EntityId;
  /** A simple identity so the debrief can name the dead. Portraits are explicitly optional. */
  name: string;
  state: CivilianState;
  position: Vec2;
  /**
   * Civilians walk authored lanes rather than steering freely. Free-form pathing produces
   * civilians who wander into rotors and read as suicidal rather than panicked.
   */
  laneY: number;
  health: number;
  wounded: boolean;
  /** Seconds spent in the current state. */
  stateTimer: number;
  /** Seconds of panic remaining; panic overrides careful behaviour. */
  panicFor: number;
  boardingProgress: number;
  boardingSlot: 0 | 1 | null;
  /** Cover point being used or approached, if any. */
  coverX: number | null;
  /** Set when the aircraft was full and this civilian waved it off. */
  wavedOff: boolean;
  /** Ticks knocked down by downwash or a near miss; they cannot act while > 0. */
  knockedDownFor: number;
}

export interface CoverPoint {
  x: number;
  /** How much incoming fire this cover removes, 0..1. */
  quality: number;
}

export interface Hazard {
  x: number;
  radius: number;
  /** 'blast' markers are telegraphed and avoidable; 'fire' is already burning. */
  kind: 'fire' | 'blast';
}

export type Difficulty = 'story' | 'standard' | 'veteran' | 'classic';

export interface LandingZoneView {
  position: Vec2;
  grounded: boolean;
  /** Settled within tolerance, not bouncing or sliding. */
  stable: boolean;
  destroyed: boolean;
  /** Capacity units still free. A wounded civilian needs two. */
  freeCapacity: number;
}

export interface CivilianWorldView {
  dt: number;
  tick: number;
  helicopter: LandingZoneView;
  /** 0 = quiet, 1 = under fire. Drives whether released civilians run for cover first. */
  threatLevel: number;
  coverPoints: readonly CoverPoint[];
  hazards: readonly Hazard[];
  difficulty: Difficulty;
}

/**
 * Every tunable in one object. These are gameplay figures from the PRD, not measurements of the
 * original, and they belong in balance JSON once the mission content lands in Milestone 4.
 */
export interface CivilianTuning {
  walkSpeed: number;
  panicSpeed: number;
  /** A safe landed helicopter inside this radius creates an approach request. */
  approachRadius: number;
  boardingSeconds: number;
  woundedBoardingSeconds: number;
  /** Capacity units a wounded civilian occupies. */
  woundedCapacityCost: number;
  /** How close to the door a civilian must be before boarding starts. */
  boardingReach: number;
  panicSeconds: number;
  /** Seconds a knocked-down civilian spends on the ground. */
  knockdownSeconds: number;
  /** Radius around a hazard a careful civilian refuses to enter. */
  hazardAvoidance: number;
  /** Rotor disc half-length, metres. Inside this and low, the blades are lethal. */
  rotorHalfLength: number;
  rotorRadius: number;
  /** Half-width of each skid's crush zone. */
  skidHalfWidth: number;
  /** Downwash radius that knocks civilians over without injuring them. */
  downwashRadius: number;
  /** Injury dealt by a first rotor contact on the forgiving difficulties. */
  rotorContactInjury: number;
  disembarkSeconds: number;
}

export const defaultCivilianTuning = (): CivilianTuning => ({
  walkSpeed: 3.4,
  panicSpeed: 5.1,
  approachRadius: 24,
  boardingSeconds: 0.55,
  woundedBoardingSeconds: 1.5,
  woundedCapacityCost: 2,
  boardingReach: 2.2,
  panicSeconds: 3.5,
  knockdownSeconds: 1.6,
  hazardAvoidance: 2.5,
  rotorHalfLength: 4.2,
  rotorRadius: 1.1,
  skidHalfWidth: 1.8,
  downwashRadius: 6.5,
  rotorContactInjury: 0.55,
  disembarkSeconds: 0.4,
});

export const createCivilian = (overrides: Partial<Civilian> & { id: EntityId }): Civilian => ({
  name: `civilian-${overrides.id}`,
  state: 'captive',
  position: { x: 0, y: 0 },
  laneY: 0,
  health: 1,
  wounded: false,
  stateTimer: 0,
  panicFor: 0,
  boardingProgress: 0,
  boardingSlot: null,
  coverX: null,
  wavedOff: false,
  knockedDownFor: 0,
  ...overrides,
});

export type CivilianEventType =
  | 'civilian:released'
  | 'civilian:tookCover'
  | 'civilian:panicked'
  | 'civilian:wavedOff'
  | 'civilian:boardingStarted'
  | 'civilian:boarded'
  | 'civilian:rescued'
  | 'civilian:injured'
  | 'civilian:died'
  | 'civilian:knockedDown'
  | 'civilian:boardingCancelled';

export interface CivilianStepResult {
  events: CivilianEventType[];
  /** Capacity units this civilian occupies once aboard. */
  capacityCost: number;
}

/** A wounded civilian takes two seats — carrying them is a real cost, not a label. */
export const capacityCost = (civilian: Civilian, tuning: CivilianTuning): number =>
  civilian.wounded ? tuning.woundedCapacityCost : 1;

const boardingDuration = (civilian: Civilian, tuning: CivilianTuning): number =>
  civilian.wounded ? tuning.woundedBoardingSeconds : tuning.boardingSeconds;

/**
 * The rotor is lethal, the skids crush, and the downwash only knocks people over. Modelling
 * them as three separate zones is what lets Standard difficulty be forgiving about the first
 * contact while Veteran and Classic stay lethal — a single "hit the helicopter" test could not.
 */
export type ContactZone = 'rotor' | 'skid' | 'downwash' | 'none';

export const contactZone = (
  civilianPosition: Vec2,
  helicopter: LandingZoneView,
  tuning: CivilianTuning,
): ContactZone => {
  const dx = civilianPosition.x - helicopter.position.x;
  const dy = civilianPosition.y - helicopter.position.y;
  const absX = Math.abs(dx);

  // The rotor disc sits above the fuselage; a civilian standing upright reaches into it.
  if (absX <= tuning.rotorHalfLength && dy > -0.5 && dy < tuning.rotorRadius + 2.2) {
    return 'rotor';
  }
  if (absX <= tuning.skidHalfWidth && dy <= 0 && dy > -2.4) return 'skid';
  if (Math.hypot(dx, dy) <= tuning.downwashRadius) return 'downwash';
  return 'none';
};

/** Veteran and Classic keep the original's lethal skids; the gentler settings injure instead. */
export const rotorContactIsLethal = (difficulty: Difficulty): boolean =>
  difficulty === 'veteran' || difficulty === 'classic';

const nearestCover = (civilian: Civilian, view: CivilianWorldView): CoverPoint | null => {
  let best: CoverPoint | null = null;
  let bestDistance = Infinity;
  for (const cover of view.coverPoints) {
    const distance = Math.abs(cover.x - civilian.position.x);
    // Ties break toward the higher-quality cover so the choice is deterministic.
    if (
      distance < bestDistance ||
      (distance === bestDistance && best && cover.quality > best.quality)
    ) {
      best = cover;
      bestDistance = distance;
    }
  }
  return best;
};

/**
 * True when stepping toward `targetX` would take the civilian through a hazard. Panicked
 * civilians skip this check, which is exactly the PRD's "panic may cause poor decisions" — but
 * the panic state is visible, so the player can read why it happened.
 */
export const pathIsBlocked = (
  fromX: number,
  targetX: number,
  view: CivilianWorldView,
  tuning: CivilianTuning,
): boolean => {
  const low = Math.min(fromX, targetX);
  const high = Math.max(fromX, targetX);
  for (const hazard of view.hazards) {
    const reach = hazard.radius + tuning.hazardAvoidance;
    if (hazard.x + reach >= low && hazard.x - reach <= high) return true;
  }
  return false;
};

const moveToward = (civilian: Civilian, targetX: number, speed: number, dt: number): boolean => {
  const delta = targetX - civilian.position.x;
  const step = speed * dt;
  if (Math.abs(delta) <= step) {
    civilian.position.x = targetX;
    return true;
  }
  civilian.position.x += Math.sign(delta) * step;
  return false;
};

const enter = (civilian: Civilian, state: CivilianState): void => {
  civilian.state = state;
  civilian.stateTimer = 0;
};

/**
 * One fixed tick of a single civilian. Boarding slots and capacity are owned by `BoardingBay`
 * because they are shared across civilians; everything else here is local to one person.
 */
export const stepCivilian = (
  civilian: Civilian,
  view: CivilianWorldView,
  tuning: CivilianTuning,
  bay: BoardingBay,
): CivilianStepResult => {
  const result: CivilianStepResult = { events: [], capacityCost: capacityCost(civilian, tuning) };
  civilian.stateTimer += view.dt;

  if (civilian.state === 'dead' || civilian.state === 'rescued') return result;

  if (civilian.knockedDownFor > 0) {
    civilian.knockedDownFor = Math.max(0, civilian.knockedDownFor - view.dt);
    // A civilian on the ground cannot walk, board, or take cover. They can still be hurt.
    if (civilian.state !== 'aboard') return result;
  }

  if (civilian.panicFor > 0) {
    civilian.panicFor = Math.max(0, civilian.panicFor - view.dt);
    if (civilian.panicFor === 0 && civilian.state === 'panic') enter(civilian, 'released');
  }

  const helicopter = view.helicopter;
  const distanceToLz = Math.hypot(
    civilian.position.x - helicopter.position.x,
    civilian.position.y - helicopter.position.y,
  );
  const lzIsOpen = helicopter.grounded && helicopter.stable && !helicopter.destroyed;

  switch (civilian.state) {
    case 'captive':
      // Released by an external event (a door blown open); nothing to do until then.
      break;

    case 'released': {
      if (lzIsOpen && distanceToLz <= tuning.approachRadius) {
        enter(civilian, 'approachLz');
        break;
      }
      // Under fire, cover comes first. In the quiet they wait in the open and wave.
      if (view.threatLevel > 0.25) {
        const cover = nearestCover(civilian, view);
        if (cover) {
          civilian.coverX = cover.x;
          enter(civilian, 'seekCover');
          result.events.push('civilian:tookCover');
        }
      }
      break;
    }

    case 'seekCover': {
      const target = civilian.coverX ?? civilian.position.x;
      if (!pathIsBlocked(civilian.position.x, target, view, tuning)) {
        moveToward(civilian, target, tuning.walkSpeed, view.dt);
      }
      if (lzIsOpen && distanceToLz <= tuning.approachRadius && view.threatLevel < 0.75) {
        enter(civilian, 'approachLz');
      }
      break;
    }

    case 'panic': {
      // Panicked civilians run without checking hazards — readable, and sometimes fatal.
      const away =
        civilian.position.x + (civilian.position.x >= helicopter.position.x ? 1 : -1) * 6;
      moveToward(civilian, away, tuning.panicSpeed, view.dt);
      break;
    }

    case 'approachLz': {
      if (!lzIsOpen) {
        enter(civilian, 'released');
        break;
      }
      const doorX = helicopter.position.x;
      if (pathIsBlocked(civilian.position.x, doorX, view, tuning)) break;
      moveToward(civilian, doorX, tuning.walkSpeed, view.dt);

      if (Math.abs(civilian.position.x - doorX) <= tuning.boardingReach) {
        if (helicopter.freeCapacity < capacityCost(civilian, tuning)) {
          // The aircraft is full: wave it off and wait for the next trip, as in the original.
          civilian.wavedOff = true;
          enter(civilian, 'waitForSpace');
          result.events.push('civilian:wavedOff');
          break;
        }
        const slot = bay.claim(civilian.id);
        if (slot === null) break; // both doors busy; queue in place rather than clipping through
        civilian.boardingSlot = slot;
        civilian.boardingProgress = 0;
        enter(civilian, 'boarding');
        result.events.push('civilian:boardingStarted');
      }
      break;
    }

    case 'waitForSpace': {
      if (!lzIsOpen) {
        enter(civilian, 'released');
        break;
      }
      if (helicopter.freeCapacity >= capacityCost(civilian, tuning)) {
        civilian.wavedOff = false;
        enter(civilian, 'approachLz');
      }
      break;
    }

    case 'boarding': {
      // Lifting off mid-board cancels the attempt and knocks people down; it must never be a
      // silent kill, because the player needs to understand what their impatience cost.
      if (!lzIsOpen) {
        bay.release(civilian.id);
        civilian.boardingSlot = null;
        civilian.boardingProgress = 0;
        civilian.knockedDownFor = tuning.knockdownSeconds;
        enter(civilian, 'released');
        result.events.push('civilian:boardingCancelled', 'civilian:knockedDown');
        break;
      }
      civilian.boardingProgress += view.dt;
      if (civilian.boardingProgress >= boardingDuration(civilian, tuning)) {
        bay.release(civilian.id);
        civilian.boardingSlot = null;
        enter(civilian, 'aboard');
        result.events.push('civilian:boarded');
      }
      break;
    }

    case 'aboard':
      if (helicopter.destroyed) {
        civilian.state = 'dead';
        result.events.push('civilian:died');
      }
      break;

    case 'disembarking':
      if (civilian.stateTimer >= tuning.disembarkSeconds) {
        enter(civilian, 'rescued');
        result.events.push('civilian:rescued');
      }
      break;

    case 'injured': {
      // The injured still crawl toward a landed helicopter, just slowly.
      if (lzIsOpen && distanceToLz <= tuning.approachRadius) enter(civilian, 'approachLz');
      break;
    }

    default:
      break;
  }

  return result;
};

/** Sends an aboard civilian out of the aircraft at a safe pad. */
export const beginDisembark = (civilian: Civilian): boolean => {
  if (civilian.state !== 'aboard') return false;
  enter(civilian, 'disembarking');
  return true;
};

export const releaseCivilian = (civilian: Civilian): boolean => {
  if (civilian.state !== 'captive') return false;
  enter(civilian, 'released');
  return true;
};

export const panic = (civilian: Civilian, tuning: CivilianTuning): boolean => {
  if (!isExposed(civilian.state)) return false;
  civilian.panicFor = tuning.panicSeconds;
  enter(civilian, 'panic');
  return true;
};

export interface CivilianDamageResult {
  events: CivilianEventType[];
  died: boolean;
  injured: boolean;
}

/**
 * Applies damage to a civilian. The first serious wound injures rather than kills on the
 * forgiving difficulties — the PRD is explicit that a civilian must never die silently, and an
 * injured civilian who then dies is a story the player can follow.
 */
export const damageCivilian = (
  civilian: Civilian,
  packet: DamagePacket,
  difficulty: Difficulty,
): CivilianDamageResult => {
  const result: CivilianDamageResult = { events: [], died: false, injured: false };
  if (civilian.state === 'dead' || civilian.state === 'rescued') return result;

  civilian.health = clamp(civilian.health - packet.amount, 0, 1);

  if (civilian.health <= 0) {
    civilian.state = 'dead';
    result.died = true;
    result.events.push('civilian:died');
    return result;
  }

  if (!civilian.wounded && civilian.health < 0.55) {
    civilian.wounded = true;
    result.injured = true;
    result.events.push('civilian:injured');
    if (civilian.state !== 'aboard' && civilian.state !== 'boarding') enter(civilian, 'injured');
  }

  // Being shot at is a reason to run, on every difficulty.
  if (difficulty !== 'story' && isExposed(civilian.state)) {
    civilian.panicFor = Math.max(civilian.panicFor, 1.5);
  }
  return result;
};

/**
 * Applies a rotor, skid or downwash contact. Landing on someone is always a serious mission
 * penalty; on Veteran and Classic it is also lethal on first contact, as it was in 1982.
 */
export const applyContact = (
  civilian: Civilian,
  zone: ContactZone,
  tuning: CivilianTuning,
  difficulty: Difficulty,
): CivilianDamageResult => {
  const result: CivilianDamageResult = { events: [], died: false, injured: false };
  if (zone === 'none' || civilian.state === 'dead' || civilian.state === 'aboard') return result;

  if (zone === 'downwash') {
    if (civilian.knockedDownFor <= 0) {
      civilian.knockedDownFor = tuning.knockdownSeconds;
      result.events.push('civilian:knockedDown');
    }
    return result;
  }

  if (rotorContactIsLethal(difficulty)) {
    civilian.health = 0;
    civilian.state = 'dead';
    result.died = true;
    result.events.push('civilian:died');
    return result;
  }

  civilian.health = clamp(civilian.health - tuning.rotorContactInjury, 0, 1);
  civilian.knockedDownFor = tuning.knockdownSeconds;
  result.events.push('civilian:knockedDown');
  if (civilian.health <= 0) {
    civilian.state = 'dead';
    result.died = true;
    result.events.push('civilian:died');
  } else if (!civilian.wounded) {
    civilian.wounded = true;
    result.injured = true;
    result.events.push('civilian:injured');
    enter(civilian, 'injured');
  }
  return result;
};

/**
 * The two door slots. The PRD allows two civilians to board at once when both sides are clear,
 * which is the difference between a tense extraction and a queue.
 */
export class BoardingBay {
  private readonly slots: [EntityId | null, EntityId | null] = [null, null];
  private bothSidesClear = true;

  /** Only one door works when the far side is blocked by terrain or fire. */
  setBothSidesClear(clear: boolean): void {
    this.bothSidesClear = clear;
    if (!clear && this.slots[1] !== null) this.slots[1] = null;
  }

  get occupied(): number {
    return (this.slots[0] === null ? 0 : 1) + (this.slots[1] === null ? 0 : 1);
  }

  get capacity(): number {
    return this.bothSidesClear ? 2 : 1;
  }

  claim(id: EntityId): 0 | 1 | null {
    if (this.slots[0] === id) return 0;
    if (this.slots[1] === id) return 1;
    if (this.slots[0] === null) {
      this.slots[0] = id;
      return 0;
    }
    if (this.bothSidesClear && this.slots[1] === null) {
      this.slots[1] = id;
      return 1;
    }
    return null;
  }

  release(id: EntityId): void {
    if (this.slots[0] === id) this.slots[0] = null;
    if (this.slots[1] === id) this.slots[1] = null;
  }

  clear(): void {
    this.slots[0] = null;
    this.slots[1] = null;
  }
}

export interface RescueTally {
  total: number;
  rescued: number;
  dead: number;
  aboard: number;
  awaiting: number;
}

/** The only score that matters. Kills are deliberately absent. */
export const tally = (civilians: readonly Civilian[]): RescueTally => {
  let rescued = 0;
  let dead = 0;
  let aboard = 0;
  for (const civilian of civilians) {
    if (civilian.state === 'rescued') rescued++;
    else if (civilian.state === 'dead') dead++;
    else if (civilian.state === 'aboard' || civilian.state === 'boarding') aboard++;
  }
  return {
    total: civilians.length,
    rescued,
    dead,
    aboard,
    awaiting: civilians.length - rescued - dead - aboard,
  };
};
