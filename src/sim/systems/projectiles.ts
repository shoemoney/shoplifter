import { moveToward, type Vec2 } from '@/core/math.js';
import { SlotAllocator } from '@/core/pools.js';
import type { EntityId } from '../components.js';
import type { ProjectileKind, Team } from '../combat/types.js';

/**
 * Kinds that follow a ballistic arc. Everything else (bullets, AA shells) flies flat: the PRD's
 * door gun and AA burst read as flat, fast fire, while rockets and RPGs visibly drop, which is
 * how a player tells "gun" from "rocket" at a glance without reading a HUD icon.
 */
const ARCING_KINDS = new Set<ProjectileKind>(['rocket', 'rpg']);

/**
 * Kinds that steer toward a tracked target. `jetMissile` is the PRD's interceptor volley; the
 * homing drone's bolt is included too since the PRD gives the drone the same "acquire, then
 * chase" behaviour as the jet, just at gun range instead of missile range. Everything else
 * (including the player's own rockets, which are semi-active soft-lock at the moment of firing
 * only, never post-launch guidance) flies whatever line it launched on.
 */
const GUIDED_KINDS = new Set<ProjectileKind>(['jetMissile', 'droneBolt']);

export const isArcingKind = (kind: ProjectileKind): boolean => ARCING_KINDS.has(kind);
export const isGuidedKind = (kind: ProjectileKind): boolean => GUIDED_KINDS.has(kind);

const PROJECTILE_KINDS: readonly ProjectileKind[] = [
  'bullet',
  'rocket',
  'rpg',
  'aaShell',
  'jetMissile',
  'droneBolt',
];

const TEAMS: readonly Team[] = ['player', 'hostile', 'civilian'];

const indexOfKind = (kind: ProjectileKind): number => {
  const index = PROJECTILE_KINDS.indexOf(kind);
  if (index < 0) throw new Error(`unknown projectile kind: ${kind}`);
  return index;
};

const kindAtIndex = (index: number): ProjectileKind => {
  const kind = PROJECTILE_KINDS[index];
  if (kind === undefined) throw new Error(`projectile kind index out of range: ${index}`);
  return kind;
};

const indexOfTeam = (team: Team): number => {
  const index = TEAMS.indexOf(team);
  if (index < 0) throw new Error(`unknown team: ${team}`);
  return index;
};

const teamAtIndex = (index: number): Team => {
  const team = TEAMS[index];
  if (team === undefined) throw new Error(`team index out of range: ${index}`);
  return team;
};

/** Typed arrays share this read shape; `noUncheckedIndexedAccess` makes every read `| undefined`. */
type TypedNumberArray = Float32Array | Uint8Array | Int32Array;

const at = (arr: TypedNumberArray, index: number): number => {
  const value = arr[index];
  if (value === undefined) throw new Error(`slot ${index} is out of range`);
  return value;
};

const normalizeAngle = (angle: number): number => {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

export interface ProjectileSpawnParams {
  kind: ProjectileKind;
  team: Team;
  position: Vec2;
  velocity: Vec2;
  damage: number;
  /** Metres. 0 for kinetic-only kinds — the HUD only draws a ring when this is positive. */
  splashRadius: number;
  /** Seconds until the projectile expires even if it never hits anything. */
  lifetimeSeconds: number;
  /** Homing target for guided kinds. Ignored (and should be null) for everything else. */
  targetId: EntityId | null;
  /** Turn-rate ceiling in radians/second for guided kinds. Ignored for everything else. */
  turnRate: number;
  /** Entity that fired this, carried through so a later damage packet can attribute the kill. */
  sourceId: EntityId | null;
}

/**
 * What the collision layer hands back when a swept segment actually connects. Deliberately thin:
 * this module has no opinion on damage kinds or hull/armor math, only on "something was hit,
 * here, so stop simulating this projectile."
 */
export interface HitResult {
  targetId: EntityId;
  at: Vec2;
}

export type GroundHeightAt = (x: number) => number;

/**
 * Injected rather than imported so this module never needs to know how collision shapes work.
 * `from`/`to` are the swept segment for this tick — checking only the endpoint would let a fast
 * projectile tunnel through a target that fit entirely between two ticks.
 */
export type ResolveHit = (index: number, from: Vec2, to: Vec2) => HitResult | null;

/** Returns null once a homing target has died or left tracking; the projectile then flies straight. */
export type TargetPositionAt = (targetId: EntityId) => Vec2 | null;

export interface ProjectileStepContext {
  gravity: number;
  groundHeightAt: GroundHeightAt;
  resolveHit: ResolveHit;
  targetPositionAt: TargetPositionAt;
}

export type ImpactCause = 'hit' | 'ground' | 'expired';

export interface ProjectileImpact {
  index: number;
  kind: ProjectileKind;
  team: Team;
  cause: ImpactCause;
  at: Vec2;
  damage: number;
  splashRadius: number;
  /** Only set when `cause === 'hit'`. */
  targetId: EntityId | null;
  sourceId: EntityId | null;
}

/**
 * Structure-of-arrays projectile pool. Backed by typed arrays sized once at construction so a
 * screen full of bullets, rockets and missiles never triggers a per-frame allocation — the same
 * reason `SlotAllocator` exists rather than an array of projectile objects.
 */
export class ProjectilePool {
  readonly capacity: number;

  private readonly allocator: SlotAllocator;
  private readonly active: Uint8Array;
  private readonly kindIndex: Uint8Array;
  private readonly teamIndex: Uint8Array;
  private readonly lockBroken: Uint8Array;

  private readonly posX: Float32Array;
  private readonly posY: Float32Array;
  private readonly prevX: Float32Array;
  private readonly prevY: Float32Array;
  private readonly velX: Float32Array;
  private readonly velY: Float32Array;
  private readonly life: Float32Array;
  private readonly damage: Float32Array;
  private readonly splash: Float32Array;
  private readonly turnRate: Float32Array;
  private readonly targetId: Int32Array;
  private readonly sourceId: Int32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.allocator = new SlotAllocator(capacity);
    this.active = new Uint8Array(capacity);
    this.kindIndex = new Uint8Array(capacity);
    this.teamIndex = new Uint8Array(capacity);
    this.lockBroken = new Uint8Array(capacity);
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.prevX = new Float32Array(capacity);
    this.prevY = new Float32Array(capacity);
    this.velX = new Float32Array(capacity);
    this.velY = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.damage = new Float32Array(capacity);
    this.splash = new Float32Array(capacity);
    this.turnRate = new Float32Array(capacity);
    this.targetId = new Int32Array(capacity);
    this.sourceId = new Int32Array(capacity);
  }

  get liveCount(): number {
    return this.allocator.live;
  }

  isActive(index: number): boolean {
    return index >= 0 && index < this.capacity && at(this.active, index) === 1;
  }

  /** Returns the new slot index, or undefined when the pool is full. */
  spawn(params: ProjectileSpawnParams): number | undefined {
    const index = this.allocator.alloc();
    if (index === undefined) return undefined;

    this.active[index] = 1;
    this.kindIndex[index] = indexOfKind(params.kind);
    this.teamIndex[index] = indexOfTeam(params.team);
    this.lockBroken[index] = 0;
    this.posX[index] = params.position.x;
    this.posY[index] = params.position.y;
    this.prevX[index] = params.position.x;
    this.prevY[index] = params.position.y;
    this.velX[index] = params.velocity.x;
    this.velY[index] = params.velocity.y;
    this.life[index] = params.lifetimeSeconds;
    this.damage[index] = params.damage;
    this.splash[index] = params.splashRadius;
    this.turnRate[index] = params.turnRate;
    this.targetId[index] = params.targetId ?? -1;
    this.sourceId[index] = params.sourceId ?? -1;
    return index;
  }

  release(index: number): void {
    if (!this.isActive(index)) throw new Error(`ProjectilePool.release: slot ${index} is not live`);
    this.active[index] = 0;
    this.allocator.free(index);
  }

  /** Breaks a guided kind's homing. It keeps flying on its current heading rather than vanishing. */
  breakLock(index: number): void {
    if (!this.isActive(index)) return;
    this.lockBroken[index] = 1;
  }

  kindAt(index: number): ProjectileKind {
    return kindAtIndex(at(this.kindIndex, index));
  }

  teamAt(index: number): Team {
    return teamAtIndex(at(this.teamIndex, index));
  }

  positionX(index: number): number {
    return at(this.posX, index);
  }

  positionY(index: number): number {
    return at(this.posY, index);
  }

  previousX(index: number): number {
    return at(this.prevX, index);
  }

  previousY(index: number): number {
    return at(this.prevY, index);
  }

  velocityX(index: number): number {
    return at(this.velX, index);
  }

  velocityY(index: number): number {
    return at(this.velY, index);
  }

  lifeRemaining(index: number): number {
    return at(this.life, index);
  }

  isLockBroken(index: number): boolean {
    return at(this.lockBroken, index) === 1;
  }

  /**
   * Advances every live projectile one fixed step. Returns the impacts that happened this tick —
   * a small, bounded list (at most one per resolved projectile), never proportional to pool
   * capacity, so allocating it fresh each call costs nothing like a per-projectile allocation
   * would.
   */
  step(dt: number, context: ProjectileStepContext): ProjectileImpact[] {
    const impacts: ProjectileImpact[] = [];

    for (let i = 0; i < this.capacity; i++) {
      if (at(this.active, i) === 0) continue;

      const kind = this.kindAt(i);
      const team = this.teamAt(i);

      this.prevX[i] = at(this.posX, i);
      this.prevY[i] = at(this.posY, i);

      if (GUIDED_KINDS.has(kind) && at(this.lockBroken, i) === 0) {
        const target = context.targetPositionAt(at(this.targetId, i));
        if (target !== null) this.steerToward(i, target, dt);
      }

      if (ARCING_KINDS.has(kind)) {
        this.velY[i] = at(this.velY, i) - context.gravity * dt;
      }

      this.posX[i] = at(this.posX, i) + at(this.velX, i) * dt;
      this.posY[i] = at(this.posY, i) + at(this.velY, i) * dt;
      this.life[i] = at(this.life, i) - dt;

      const from: Vec2 = { x: at(this.prevX, i), y: at(this.prevY, i) };
      const to: Vec2 = { x: at(this.posX, i), y: at(this.posY, i) };

      const hit = context.resolveHit(i, from, to);
      if (hit !== null) {
        impacts.push(this.buildImpact(i, kind, team, 'hit', hit.at, hit.targetId));
        this.release(i);
        continue;
      }

      const groundHeight = context.groundHeightAt(to.x);
      if (to.y <= groundHeight) {
        impacts.push(this.buildImpact(i, kind, team, 'ground', { x: to.x, y: groundHeight }, null));
        this.release(i);
        continue;
      }

      if (at(this.life, i) <= 0) {
        impacts.push(this.buildImpact(i, kind, team, 'expired', to, null));
        this.release(i);
      }
    }

    return impacts;
  }

  private buildImpact(
    index: number,
    kind: ProjectileKind,
    team: Team,
    cause: ImpactCause,
    atPoint: Vec2,
    targetId: EntityId | null,
  ): ProjectileImpact {
    const source = at(this.sourceId, index);
    return {
      index,
      kind,
      team,
      cause,
      at: atPoint,
      damage: at(this.damage, index),
      splashRadius: at(this.splash, index),
      targetId,
      sourceId: source === -1 ? null : source,
    };
  }

  /** Turns the velocity vector toward `target`, capped by this slot's turn-rate, without allocating. */
  private steerToward(index: number, target: Vec2, dt: number): void {
    const vx = at(this.velX, index);
    const vy = at(this.velY, index);
    const speed = Math.hypot(vx, vy);
    if (speed <= 0) return;

    const currentAngle = Math.atan2(vy, vx);
    const desiredAngle = Math.atan2(
      target.y - at(this.posY, index),
      target.x - at(this.posX, index),
    );
    const delta = normalizeAngle(desiredAngle - currentAngle);
    const maxDelta = at(this.turnRate, index) * dt;
    const turn = moveToward(0, delta, Math.max(0, maxDelta));
    const newAngle = currentAngle + turn;

    this.velX[index] = Math.cos(newAngle) * speed;
    this.velY[index] = Math.sin(newAngle) * speed;
  }
}
