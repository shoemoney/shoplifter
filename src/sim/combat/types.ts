import type { Vec2 } from '@/core/math.js';
import type { EntityId } from '../components.js';

/**
 * Shared combat vocabulary. Every combat system writes against these types so the systems can be
 * built and tested independently — collision does not need to know what a rocket is, and the
 * enemy director does not need to know how a collider is shaped.
 */

export type Team = 'player' | 'hostile' | 'civilian';

export type ColliderKind = 'circle' | 'capsule' | 'box';

export interface Collider {
  kind: ColliderKind;
  /** Circle and capsule radius, metres. Ignored by boxes. */
  radius: number;
  /** Capsule half-length along `angle`; box half-width. Ignored by circles. */
  halfWidth: number;
  /** Box half-height. Ignored by circles and capsules. */
  halfHeight: number;
  /** Orientation in radians for capsules and boxes. */
  angle: number;
}

export const circle = (radius: number): Collider => ({
  kind: 'circle',
  radius,
  halfWidth: 0,
  halfHeight: 0,
  angle: 0,
});

export const capsule = (radius: number, halfLength: number, angle = 0): Collider => ({
  kind: 'capsule',
  radius,
  halfWidth: halfLength,
  halfHeight: 0,
  angle,
});

export const box = (halfWidth: number, halfHeight: number, angle = 0): Collider => ({
  kind: 'box',
  radius: 0,
  halfWidth,
  halfHeight,
  angle,
});

/** Anything the broad phase can index. */
export interface Body {
  id: EntityId;
  team: Team;
  position: Vec2;
  collider: Collider;
}

export type DamageKind = 'bullet' | 'explosive' | 'collision' | 'fire';

/**
 * A single application of damage. Carries its origin so feedback can be directional and so the
 * scoring system can tell a player kill from a hostile one — the PRD forbids hidden effects,
 * and every packet must be attributable.
 */
export interface DamagePacket {
  amount: number;
  kind: DamageKind;
  sourceId: EntityId | null;
  sourceTeam: Team;
  /** World position of the hit. */
  at: Vec2;
}

/** Damageable subsystems of the player helicopter. */
export type ComponentSlot = 'hull' | 'engine' | 'rotor' | 'fuel' | 'weapons' | 'bay';

export type ProjectileKind = 'bullet' | 'rocket' | 'rpg' | 'aaShell' | 'jetMissile' | 'droneBolt';

export type EnemyKind = 'rifleInfantry' | 'rpgInfantry' | 'lightTank' | 'aaGun' | 'jet' | 'drone';

/** Escalation tier, per the PRD director table. Tier 4 is an authored climax, never endless. */
export type EscalationTier = 0 | 1 | 2 | 3 | 4;

export interface DirectorBudget {
  threatPoints: number;
  maxConcurrentAir: number;
  maxConcurrentGround: number;
  reinforcementCooldown: number;
  escalationTier: EscalationTier;
}

/**
 * What every combat system is allowed to know about the player. Deliberately narrower than
 * `Helicopter`: enemies should not be able to reach into the flight model.
 */
export interface PlayerView {
  id: EntityId;
  position: Vec2;
  velocity: Vec2;
  /** Metres above the terrain directly below. */
  heightAboveGround: number;
  grounded: boolean;
  destroyed: boolean;
  /** -1 left, 0 foreground, 1 right. */
  facing: -1 | 0 | 1;
  passengers: number;
}

/** Line-of-sight and terrain queries every enemy needs, without importing the terrain module. */
export interface CombatWorldView {
  tick: number;
  dt: number;
  player: PlayerView;
  groundHeightAt: (x: number) => number;
  /** True when nothing blocks the straight line between two world points. */
  hasLineOfSight: (from: Vec2, to: Vec2) => boolean;
}
