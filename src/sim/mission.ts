import { EventQueue, type SimEvent } from '@/core/events.js';
import { Hash32, clamp } from '@/core/math.js';
import type { Vec2 } from '@/core/math.js';
import { Rng } from '@/core/rng.js';
import type { FlightBalance } from '@/content/schemas/flight.js';
import type { Mission } from '@/content/schemas/mission.js';
import { compileTerrain } from '@/content/loaders/missionLoader.js';
import { SpatialHash, overlaps, raycast } from './collision.js';
import {
  box,
  circle,
  type Body,
  type CombatWorldView,
  type DamagePacket,
  type EnemyKind,
  type PlayerView,
} from './combat/types.js';
import {
  createHelicopter,
  type EntityId,
  type FlightInput,
  type Helicopter,
} from './components.js';
import type { Terrain } from './terrain.js';
import { stepFlight } from './systems/flight.js';
import { stepLanding } from './systems/landing.js';
import {
  applyDamagePacket,
  applyNearMiss,
  createDamageState,
  createMorale,
  defaultDamageTuning,
  isSuppressed,
  splashFalloff,
  stepFuelLeak,
  stepMorale,
  type DamageState,
  type Morale,
} from './systems/damage.js';
import { ProjectilePool, type ProjectileImpact } from './systems/projectiles.js';
import {
  acquireRocketLock,
  createWeaponsState,
  defaultWeaponTuning,
  deployFlare,
  fireDoorGun,
  fireRocket,
  stepFlareRecharge,
  type WeaponsState,
} from './systems/weapons.js';
import {
  createAaGun,
  createDrone,
  createJet,
  createLightTank,
  createRifleInfantry,
  createRpgInfantry,
  defaultEnemyTuning,
  stepEnemy,
  type EnemyState,
} from './systems/enemies.js';
import {
  createDirectorState,
  defaultDirectorTuning,
  notifyFinalExtraction,
  notifyMajorObjectiveComplete,
  notifyUnload,
  releaseSocket,
  stepDirector,
  type DirectorState,
  type SpawnSocket,
} from './systems/director.js';
import {
  BoardingBay,
  applyContact,
  beginDisembark,
  capacityCost,
  contactZone,
  createCivilian,
  damageCivilian,
  defaultCivilianTuning,
  releaseCivilian,
  stepCivilian,
  tally,
  type Civilian,
  type CoverPoint,
  type Difficulty,
  type Hazard,
} from './systems/civilians.js';
import { ObjectiveTracker, emptyProgress, type MissionProgress } from './systems/objectives.js';
import type { MissionOutcome } from './systems/scoring.js';

/**
 * The whole mission in one deterministic simulation. Every system built in isolation gets wired
 * here, in a fixed order, with no DOM and no wall-clock time — which is what lets a full mission
 * be replayed, hashed, and run headlessly in a test.
 */
export interface MissionInput extends FlightInput {
  firePrimary: boolean;
  fireSecondary: boolean;
  deployFlare: boolean;
  /** Opens a civilian site, confirms a landing action, triggers unload. */
  interact: boolean;
  /** Weapon aim angle in radians, independent of the direction of travel. */
  aimAngle: number;
}

export const neutralMissionInput = (): MissionInput => ({
  thrustX: 0,
  thrustY: 0,
  boost: false,
  yawLeft: false,
  yawRight: false,
  firePrimary: false,
  fireSecondary: false,
  deployFlare: false,
  interact: false,
  aimAngle: 0,
});

export type MissionPhase = 'active' | 'complete' | 'failed';

export type MissionEventType =
  | 'mission:unloaded'
  | 'mission:complete'
  | 'mission:failed'
  | 'mission:siteReleased'
  | 'mission:enemySpawned'
  | 'mission:enemyDestroyed'
  | 'mission:enemySuppressed'
  | 'mission:playerHit'
  | 'mission:civilianHitByPlayer'
  | 'mission:weaponOverheated';

export type MissionEvent = SimEvent<MissionEventType, Record<string, unknown>>;

interface EnemyRuntime {
  enemy: EnemyState;
  health: number;
  maxHealth: number;
  morale: Morale;
  socketId: string;
  /** True once suppression has been credited, so restraint is not scored per tick. */
  suppressionCredited: boolean;
}

/** Health per enemy kind. Tanks and AA are armoured; infantry is not. */
const ENEMY_HEALTH: Readonly<Record<EnemyKind, number>> = {
  rifleInfantry: 1,
  rpgInfantry: 1.2,
  lightTank: 6,
  aaGun: 5,
  jet: 3,
  drone: 2,
};

export interface MissionWorldOptions {
  mission: Mission;
  flight: FlightBalance;
  dt: number;
  seed?: number;
  difficulty?: Difficulty;
}

export class MissionWorld {
  readonly mission: Mission;
  readonly terrain: Terrain;
  readonly dt: number;
  readonly rng: Rng;
  readonly events = new EventQueue<MissionEvent>();
  readonly difficulty: Difficulty;

  readonly player: Helicopter;
  readonly weapons: WeaponsState;
  readonly civilians: Civilian[] = [];
  readonly projectiles: ProjectilePool;
  readonly objectives: ObjectiveTracker;

  private readonly enemies = new Map<EntityId, EnemyRuntime>();
  private readonly sockets: SpawnSocket[] = [];
  private readonly director: DirectorState;
  private readonly bay = new BoardingBay();
  private readonly damage: DamageState;
  private readonly spatial = new SpatialHash(16);
  private readonly bodies: Body[] = [];
  private readonly queryScratch: Body[] = [];
  private readonly coverPoints: CoverPoint[] = [];
  private readonly hazards: Hazard[] = [];

  private readonly weaponTuning = defaultWeaponTuning();
  private readonly damageTuning = defaultDamageTuning();
  private readonly enemyTuning = defaultEnemyTuning();
  private readonly directorTuning = defaultDirectorTuning();
  private readonly civilianTuning = defaultCivilianTuning();
  private readonly flightBalance: FlightBalance;

  private nextEntityId = 1000;
  private progress: MissionProgress = emptyProgress();
  private releasedGroups = new Set<string>();

  tick = 0;
  phase: MissionPhase = 'active';

  /** Debrief counters. Accumulated as they happen so the grade needs no replay. */
  readonly stats = {
    unloads: 0,
    hardLandings: 0,
    crashLandings: 0,
    safeLandings: 0,
    civiliansHitByPlayer: 0,
    collateralStructures: 0,
    threatsDestroyed: 0,
    threatsSuppressed: 0,
    passengersInjured: 0,
  };

  constructor(options: MissionWorldOptions) {
    this.mission = options.mission;
    this.dt = options.dt;
    this.difficulty = options.difficulty ?? 'standard';
    this.flightBalance = options.flight;
    this.rng = new Rng(options.seed ?? 0x63686f70);
    this.terrain = compileTerrain(options.mission);

    const spawnX = options.mission.playerSpawn.x;
    this.player = createHelicopter({
      position: { x: spawnX, y: this.terrain.heightAt(spawnX) + options.flight.landing.skidDrop },
      capacity: options.flight.capacity,
      fuel: options.flight.fuelCapacity,
    });
    this.player.grounded = true;
    this.player.landingContactCount = 2;

    this.weapons = createWeaponsState(this.weaponTuning);
    this.damage = createDamageState();
    this.projectiles = new ProjectilePool(512);
    this.director = createDirectorState(this.directorTuning);
    this.objectives = new ObjectiveTracker(
      options.mission.objectives.map((objective) => ({
        id: objective.id,
        kind: objective.kind,
        label: objective.label,
        goal: objective.goal,
        requires: objective.requires,
        ...(objective.deadlineSeconds === undefined
          ? {}
          : { deadlineSeconds: objective.deadlineSeconds }),
      })),
    );

    this.buildCivilians();
    this.buildSockets();
    this.buildCover();
  }

  get elapsed(): number {
    return this.tick * this.dt;
  }

  get playerId(): EntityId {
    return 1;
  }

  get liveEnemies(): readonly EnemyRuntime[] {
    return [...this.enemies.values()];
  }

  private emit(type: MissionEventType, payload: Record<string, unknown> = {}): void {
    this.events.push({ type, tick: this.tick, payload });
  }

  // --- Construction -------------------------------------------------------

  private buildCivilians(): void {
    let id = 100;
    for (const group of this.mission.civilianGroups) {
      for (let i = 0; i < group.count; i++) {
        // Deterministic spread: the same mission always places the same people in the same spots.
        const offset = group.count === 1 ? 0 : (i / (group.count - 1) - 0.5) * group.spread;
        const x = group.x + offset;
        const civilian = createCivilian({
          id: id++,
          name: `${group.site} ${i + 1}`,
          position: { x, y: this.terrain.heightAt(x) + group.laneOffset },
          laneY: this.terrain.heightAt(x) + group.laneOffset,
          wounded: i < group.wounded,
        });
        if (civilian.wounded) civilian.health = 0.5;
        this.civilians.push(civilian);
      }
      if (group.release === 'immediate') {
        this.releaseGroup(group.id);
      }
    }
  }

  private buildSockets(): void {
    for (const socket of this.mission.enemySockets) {
      this.sockets.push({
        id: socket.id,
        position: {
          x: socket.x,
          y: this.terrain.heightAt(socket.x) + (socket.side === 'air' ? 60 : 1),
        },
        kind: socket.kind,
        side: socket.side,
      });
    }
  }

  /** Cover points sit at the edges of each civilian site — somewhere to run that is not the LZ. */
  private buildCover(): void {
    for (const group of this.mission.civilianGroups) {
      this.coverPoints.push({ x: group.x - group.spread, quality: 0.7 });
      this.coverPoints.push({ x: group.x + group.spread, quality: 0.7 });
    }
  }

  // --- World views --------------------------------------------------------

  private playerView(): PlayerView {
    return {
      id: this.playerId,
      position: this.player.position,
      velocity: this.player.velocity,
      heightAboveGround: this.player.position.y - this.terrain.heightAt(this.player.position.x),
      grounded: this.player.grounded,
      destroyed: this.player.destroyedFor !== null,
      facing: this.player.facing,
      passengers: this.player.passengers.length,
    };
  }

  /**
   * Terrain-only line of sight. Sampled rather than swept: a canyon wall between a drone and the
   * player is the case that matters, and 24 samples over a few hundred metres resolves it well
   * inside the width of the geometry.
   */
  private hasLineOfSight = (from: Vec2, to: Vec2): boolean => {
    const steps = 24;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      if (this.terrain.heightAt(x) > y) return false;
    }
    return true;
  };

  private combatView(): CombatWorldView {
    return {
      tick: this.tick,
      dt: this.dt,
      player: this.playerView(),
      groundHeightAt: (x: number) => this.terrain.heightAt(x),
      hasLineOfSight: this.hasLineOfSight,
    };
  }

  private freeCapacity(): number {
    let used = 0;
    for (const civilian of this.civilians) {
      if (civilian.state === 'aboard' || civilian.state === 'boarding') {
        used += capacityCost(civilian, this.civilianTuning);
      }
    }
    return Math.max(0, this.player.capacity - used);
  }

  /** The landing zone the aircraft is currently sitting in, if any. */
  private currentZone() {
    if (!this.player.grounded) return undefined;
    return this.mission.landingZones.find(
      (zone) => Math.abs(this.player.position.x - zone.x) <= zone.width / 2,
    );
  }

  /**
   * How dangerous it is to be standing in the open right now. Only enemies that are close,
   * unsuppressed, AND can actually see the landing zone count: a 120 m radius counted tanks
   * behind a ridge, which pinned civilians in cover forever and made the mission unwinnable
   * without clearing the map — the exact outcome the PRD forbids.
   */
  private threatLevel(): number {
    let nearby = 0;
    for (const runtime of this.enemies.values()) {
      if (isSuppressed(runtime.morale)) continue;
      const distance = Math.hypot(
        runtime.enemy.position.x - this.player.position.x,
        runtime.enemy.position.y - this.player.position.y,
      );
      if (distance > 70) continue;
      if (!this.hasLineOfSight(runtime.enemy.position, this.player.position)) continue;
      nearby++;
    }
    return clamp(nearby / 4, 0, 1);
  }

  // --- Collision ----------------------------------------------------------

  private rebuildSpatial(): void {
    this.bodies.length = 0;
    this.spatial.clear();

    if (this.player.destroyedFor === null) {
      this.bodies.push({
        id: this.playerId,
        team: 'player',
        position: this.player.position,
        collider: box(3, 1.5),
      });
    }
    for (const runtime of this.enemies.values()) {
      this.bodies.push({
        id: runtime.enemy.id,
        team: runtime.enemy.team,
        position: runtime.enemy.position,
        collider: runtime.enemy.collider,
      });
    }
    for (const civilian of this.civilians) {
      if (
        civilian.state === 'dead' ||
        civilian.state === 'rescued' ||
        civilian.state === 'aboard'
      ) {
        continue;
      }
      this.bodies.push({
        id: civilian.id,
        team: 'civilian',
        position: civilian.position,
        collider: circle(0.6),
      });
    }
    for (const body of this.bodies) this.spatial.insert(body);
  }

  /**
   * Sweeps a projectile's segment against everything it is allowed to hit. Civilians are
   * deliberately included: the player's own fire must be able to kill them, because the
   * restraint that avoids it is the game.
   */
  private resolveHit = (
    index: number,
    from: Vec2,
    to: Vec2,
  ): { targetId: EntityId; at: Vec2 } | null => {
    const team = this.projectiles.teamAt(index);
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    const reach = Math.hypot(to.x - from.x, to.y - from.y) / 2 + 4;

    this.queryScratch.length = 0;
    this.spatial.queryCircle({ x: midX, y: midY }, reach, this.queryScratch);

    let bestT = Infinity;
    let best: Body | null = null;
    for (const body of this.queryScratch) {
      if (body.team === team) continue;
      const t = raycast(from, to, body);
      if (t !== null && t < bestT) {
        bestT = t;
        best = body;
      }
    }
    if (!best) return null;
    return {
      targetId: best.id,
      at: { x: from.x + (to.x - from.x) * bestT, y: from.y + (to.y - from.y) * bestT },
    };
  };

  // --- Damage -------------------------------------------------------------

  private hurtEnemy(id: EntityId, amount: number): void {
    const runtime = this.enemies.get(id);
    if (!runtime) return;
    runtime.health -= amount;
    if (runtime.health <= 0) {
      this.enemies.delete(id);
      releaseSocket(this.director, {
        id: runtime.socketId,
        position: runtime.enemy.position,
        kind: runtime.enemy.kind,
        side: runtime.enemy.kind === 'jet' || runtime.enemy.kind === 'drone' ? 'air' : 'ground',
      });
      this.stats.threatsDestroyed++;
      this.emit('mission:enemyDestroyed', { id, kind: runtime.enemy.kind });
    }
  }

  private hurtPlayer(packet: DamagePacket): void {
    if (this.player.destroyedFor !== null) return;
    const result = applyDamagePacket(this.player, this.damage, packet, this.damageTuning);
    this.stats.passengersInjured += result.passengersInjured;
    this.emit('mission:playerHit', {
      component: result.component,
      amount: result.amountApplied,
    });
    if (result.destroyed) this.fail('aircraft-lost');
  }

  private hurtCivilian(civilian: Civilian, packet: DamagePacket): void {
    const before = civilian.state;
    const result = damageCivilian(civilian, packet, this.difficulty);
    if (packet.sourceTeam === 'player' && (result.died || result.injured)) {
      this.stats.civiliansHitByPlayer++;
      this.emit('mission:civilianHitByPlayer', { id: civilian.id, died: result.died });
    }
    if (result.died && before !== 'dead') {
      for (const event of result.events) this.emit('mission:playerHit', { civilianEvent: event });
    }
  }

  private applyImpact(impact: ProjectileImpact): void {
    const packet: DamagePacket = {
      amount: impact.damage,
      kind: impact.splashRadius > 0 ? 'explosive' : 'bullet',
      sourceId: impact.sourceId,
      sourceTeam: impact.team,
      at: impact.at,
    };

    if (impact.cause === 'hit' && impact.targetId !== null) {
      this.dispatchDamage(impact.targetId, packet);
    }

    if (impact.splashRadius <= 0) {
      // A near miss still matters: suppression is how a landing window gets made without a kill.
      if (impact.team === 'player') this.suppressNear(impact.at, 6);
      return;
    }

    this.queryScratch.length = 0;
    this.spatial.queryCircle(impact.at, impact.splashRadius, this.queryScratch);
    for (const body of this.queryScratch) {
      if (impact.cause === 'hit' && body.id === impact.targetId) continue;
      const distance = Math.hypot(body.position.x - impact.at.x, body.position.y - impact.at.y);
      const falloff = splashFalloff(distance, impact.splashRadius);
      if (falloff <= 0) continue;
      this.dispatchDamage(body.id, { ...packet, amount: impact.damage * falloff });
    }
    this.suppressNear(impact.at, impact.splashRadius * 1.6);
  }

  private dispatchDamage(targetId: EntityId, packet: DamagePacket): void {
    if (targetId === this.playerId) {
      this.hurtPlayer(packet);
      return;
    }
    if (this.enemies.has(targetId)) {
      this.hurtEnemy(targetId, packet.amount);
      return;
    }
    const civilian = this.civilians.find((candidate) => candidate.id === targetId);
    if (civilian) this.hurtCivilian(civilian, packet);
  }

  private suppressNear(at: Vec2, radius: number): void {
    for (const runtime of this.enemies.values()) {
      const distance = Math.hypot(runtime.enemy.position.x - at.x, runtime.enemy.position.y - at.y);
      if (distance > radius) continue;
      applyNearMiss(runtime.morale, distance, this.damageTuning);
      if (isSuppressed(runtime.morale) && !runtime.suppressionCredited) {
        runtime.suppressionCredited = true;
        this.stats.threatsSuppressed++;
        this.emit('mission:enemySuppressed', { id: runtime.enemy.id });
      }
    }
  }

  // --- Spawning -----------------------------------------------------------

  private spawnEnemy(socket: SpawnSocket): void {
    const id = this.nextEntityId++;
    let enemy: EnemyState;
    switch (socket.kind) {
      case 'rifleInfantry':
        enemy = createRifleInfantry(id, socket.position);
        break;
      case 'rpgInfantry':
        enemy = createRpgInfantry(id, socket.position);
        break;
      case 'lightTank':
        enemy = createLightTank(
          id,
          socket.position,
          socket.position.x - 60,
          socket.position.x + 60,
        );
        break;
      case 'aaGun':
        enemy = createAaGun(id, socket.position, true);
        break;
      case 'drone':
        enemy = createDrone(id, socket.position);
        break;
      case 'jet':
        enemy = createJet(
          id,
          socket.position.x < this.player.position.x ? 1 : -1,
          this.enemyTuning.jet,
        );
        break;
      default:
        return;
    }
    const maxHealth = ENEMY_HEALTH[socket.kind];
    this.enemies.set(id, {
      enemy,
      health: maxHealth,
      maxHealth,
      morale: createMorale(),
      socketId: socket.id,
      suppressionCredited: false,
    });
    this.emit('mission:enemySpawned', { id, kind: socket.kind, socketId: socket.id });
  }

  private releaseGroup(groupId: string): void {
    if (this.releasedGroups.has(groupId)) return;
    const group = this.mission.civilianGroups.find((candidate) => candidate.id === groupId);
    if (!group) return;
    this.releasedGroups.add(groupId);
    let released = 0;
    for (const civilian of this.civilians) {
      if (!civilian.name.startsWith(group.site)) continue;
      if (releaseCivilian(civilian)) released++;
    }
    this.emit('mission:siteReleased', { groupId, released });
  }

  // --- Step ---------------------------------------------------------------

  step(input: MissionInput): void {
    if (this.phase !== 'active') {
      this.tick++;
      return;
    }

    this.rebuildSpatial();

    // 1. Flight and ground contact.
    stepFlight(this.player, input, {
      tuning: this.flightBalance.flight,
      terrain: this.terrain,
      dt: this.dt,
      tick: this.tick,
    });
    const landing = stepLanding(this.player, {
      tuning: this.flightBalance.landing,
      terrain: this.terrain,
      dt: this.dt,
    });
    if (landing.touchdown) {
      if (landing.touchdown.quality === 'safe') this.stats.safeLandings++;
      else if (landing.touchdown.quality === 'hard') this.stats.hardLandings++;
      else this.stats.crashLandings++;
    }
    // Landing damage bypasses the damage system, so the destruction check has to live here too.
    if (this.player.hull <= 0 && this.player.destroyedFor === null) {
      this.player.destroyedFor = 0;
      this.fail('aircraft-lost');
    }
    stepFuelLeak(this.player, this.damage, this.dt);

    // 2. Player weapons.
    this.stepWeapons(input);

    // 3. Enemies. Their fire becomes projectiles; they never touch the pool themselves.
    this.stepEnemies();

    // 4. Projectiles, then the damage their impacts caused.
    const impacts = this.projectiles.step(this.dt, {
      gravity: this.flightBalance.flight.gravity,
      groundHeightAt: (x) => this.terrain.heightAt(x),
      resolveHit: this.resolveHit,
      targetPositionAt: (id) =>
        id === this.playerId
          ? this.player.position
          : (this.enemies.get(id)?.enemy.position ?? null),
    });
    for (const impact of impacts) this.applyImpact(impact);

    // 5. Civilians, rotor safety, boarding.
    this.stepCivilians();

    // 6. Site releases, unloading, and the director's response to both.
    this.stepMissionFlow(input);

    // 7. Objectives last: they read the state everything else just produced.
    this.progress.elapsedSeconds = this.elapsed;
    for (const event of this.objectives.update(this.progress)) {
      if (event.type === 'objective:completed') {
        this.progress.targetsDestroyed = new Set(this.progress.targetsDestroyed);
        notifyMajorObjectiveComplete(this.director, this.directorTuning);
      }
    }
    this.checkEnd();

    this.tick++;
  }

  private stepWeapons(input: MissionInput): void {
    const underLock = this.isUnderMissileLock();
    stepFlareRecharge(this.weapons, this.weaponTuning, this.dt, underLock);

    const origin = { x: this.player.position.x, y: this.player.position.y };
    // The gun is locked while the skids are down, as in the original.
    const trigger = input.firePrimary && !this.player.grounded && this.player.destroyedFor === null;
    const gun = fireDoorGun(
      this.weapons,
      this.weaponTuning,
      origin,
      input.aimAngle,
      trigger,
      this.dt,
      this.rng,
      this.playerId,
    );
    if (gun.step.justOverheated) this.emit('mission:weaponOverheated');
    if (gun.spawnParams) this.projectiles.spawn(gun.spawnParams);

    if (input.fireSecondary && !this.player.grounded && this.weapons.rockets > 0) {
      const candidates = [...this.enemies.values()].map((runtime) => ({
        id: runtime.enemy.id,
        position: runtime.enemy.position,
      }));
      const civilianPositions = this.civilians
        .filter((civilian) => civilian.state !== 'dead' && civilian.state !== 'aboard')
        .map((civilian) => civilian.position);
      // The lock is refused through a civilian; firing anyway is allowed, and on the player.
      acquireRocketLock(origin, input.aimAngle, candidates, civilianPositions, this.weaponTuning);
      const rocket = fireRocket(
        this.weapons,
        this.weaponTuning,
        origin,
        input.aimAngle,
        this.playerId,
      );
      if (rocket.spawnParams) this.projectiles.spawn(rocket.spawnParams);
    }

    if (input.deployFlare) {
      const lock = this.nearestIncomingMissile();
      deployFlare(this.weapons, this.weaponTuning, lock);
      if (lock) this.breakNearestMissileLock();
    }

    this.player.rockets = this.weapons.rockets;
    this.player.flares = this.weapons.flares;
    this.player.weaponHeat = this.weapons.heat;
  }

  private isUnderMissileLock(): boolean {
    return this.nearestIncomingMissile() !== null;
  }

  private nearestIncomingMissile(): { timeToImpactSeconds: number } | null {
    let best: number | null = null;
    for (let i = 0; i < this.projectiles.capacity; i++) {
      if (!this.projectiles.isActive(i)) continue;
      if (this.projectiles.teamAt(i) !== 'hostile') continue;
      const kind = this.projectiles.kindAt(i);
      if (kind !== 'jetMissile' && kind !== 'rpg') continue;
      const dx = this.player.position.x - this.projectiles.positionX(i);
      const dy = this.player.position.y - this.projectiles.positionY(i);
      const distance = Math.hypot(dx, dy);
      const speed = Math.hypot(this.projectiles.velocityX(i), this.projectiles.velocityY(i));
      if (speed <= 0) continue;
      const time = distance / speed;
      if (best === null || time < best) best = time;
    }
    return best === null ? null : { timeToImpactSeconds: best };
  }

  private breakNearestMissileLock(): void {
    for (let i = 0; i < this.projectiles.capacity; i++) {
      if (!this.projectiles.isActive(i)) continue;
      if (this.projectiles.teamAt(i) !== 'hostile') continue;
      if (this.projectiles.kindAt(i) !== 'jetMissile') continue;
      this.projectiles.breakLock(i);
    }
  }

  private stepEnemies(): void {
    const view = this.combatView();
    for (const runtime of this.enemies.values()) {
      stepMorale(runtime.morale, this.dt, this.damageTuning);
      if (isSuppressed(runtime.morale)) continue;

      const result = stepEnemy(runtime.enemy, view, this.enemyTuning);
      if (!result.fire) continue;
      const intent = result.fire;
      this.projectiles.spawn({
        kind: intent.projectile,
        team: intent.sourceTeam,
        position: { ...intent.origin },
        velocity: {
          x: intent.direction.x * intent.speed,
          y: intent.direction.y * intent.speed,
        },
        damage: intent.projectile === 'rpg' || intent.projectile === 'jetMissile' ? 0.35 : 0.08,
        splashRadius: intent.projectile === 'rpg' || intent.projectile === 'jetMissile' ? 5 : 0,
        lifetimeSeconds: 6,
        targetId: intent.projectile === 'jetMissile' ? this.playerId : null,
        turnRate: intent.projectile === 'jetMissile' ? 1.6 : 0,
        sourceId: runtime.enemy.id,
      });
    }
  }

  private stepCivilians(): void {
    const zone = this.currentZone();
    const stable =
      this.player.grounded &&
      this.player.landingContactCount === 2 &&
      Math.abs(this.player.velocity.x) < 0.5;

    const view = {
      dt: this.dt,
      tick: this.tick,
      helicopter: {
        position: this.player.position,
        grounded: this.player.grounded,
        stable,
        destroyed: this.player.destroyedFor !== null,
        freeCapacity: this.freeCapacity(),
      },
      threatLevel: this.threatLevel(),
      coverPoints: this.coverPoints,
      hazards: this.hazards,
      difficulty: this.difficulty,
    };

    // The skid crush zone is narrower than the boarding reach, so a civilian walking to the door
    // necessarily passes through it. Someone deliberately boarding a settled aircraft is not
    // someone being landed on; the crush case is the aircraft arriving on top of them.
    const boardingStates = new Set(['approachLz', 'waitForSpace', 'boarding']);
    const settled = stable && Math.abs(this.player.velocity.y) < 0.5;

    for (const civilian of this.civilians) {
      const usingTheDoor = settled && boardingStates.has(civilian.state);
      // Contact is checked before the civilian acts, so a person who walks under the disc this
      // tick is hurt this tick rather than one tick late.
      if (civilian.state !== 'aboard' && civilian.state !== 'dead' && !usingTheDoor) {
        const zoneHit = contactZone(civilian.position, view.helicopter, this.civilianTuning);
        // Downwash knocks people over while the aircraft is arriving or leaving. A parked
        // helicopter must not keep re-knocking them down: the knockdown blocks every action,
        // so anyone inside the 6.5 m wash was pinned forever and could never board.
        const parkedWash = zoneHit === 'downwash' && settled;
        if (zoneHit !== 'none' && !parkedWash) {
          applyContact(civilian, zoneHit, this.civilianTuning, this.difficulty);
        }
      }
      stepCivilian(civilian, view, this.civilianTuning, this.bay);
    }
    void zone;
  }

  private stepMissionFlow(input: MissionInput): void {
    // Proximity release: flying near a site opens it. Objective-gated sites need the interact
    // press as well, so the player chooses when to expose people to the fight.
    for (const group of this.mission.civilianGroups) {
      if (this.releasedGroups.has(group.id)) continue;
      const distance = Math.abs(this.player.position.x - group.x);
      if (group.release === 'proximity' && distance < 60) this.releaseGroup(group.id);
      else if (group.release === 'objective' && distance < 40 && input.interact) {
        this.releaseGroup(group.id);
      }
    }

    const zone = this.currentZone();
    // Setting down inside an authored zone is what satisfies a reachZone objective. Doing it
    // here rather than on proximity means a flyover does not count as arriving.
    if (zone) this.markZoneReached(zone.id);
    const canUnload = zone?.services.includes('unload') ?? false;
    if (canUnload && this.player.grounded) {
      let disembarked = 0;
      for (const civilian of this.civilians) {
        if (beginDisembark(civilian)) disembarked++;
      }
      if (disembarked > 0) {
        this.stats.unloads++;
        this.progress.unloaded = this.stats.unloads;
        notifyUnload(this.director, this.directorTuning);
        this.emit('mission:unloaded', { count: disembarked, zoneId: zone?.id });
      }
      if (zone?.services.includes('refuel')) {
        this.player.fuel = Math.min(
          this.flightBalance.fuelCapacity,
          this.player.fuel + 18 * this.dt,
        );
      }
      if (zone?.services.includes('rearm')) {
        this.weapons.rockets = this.weaponTuning.rocketsInitial;
      }
      if (zone?.services.includes('repair')) {
        this.player.hull = Math.min(1, this.player.hull + 0.08 * this.dt);
        this.player.engine = Math.min(1, this.player.engine + 0.08 * this.dt);
        this.player.rotor = Math.min(1, this.player.rotor + 0.08 * this.dt);
        // Patching the tank is the whole point of a repair pad. Without this the leak rate only
        // ever accumulates, so a single sortie through defended airspace becomes terminal no
        // matter how well the player flies afterwards.
        this.damage.fuelSystem.leakRatePerSecond = 0;
        this.damage.fuelSystem.hitCount = 0;
      }
    }

    // Passengers on the aircraft, and rescues banked at the pad.
    const counts = tally(this.civilians);
    this.progress.rescued = counts.rescued;
    this.player.passengers = this.civilians
      .filter((civilian) => civilian.state === 'aboard')
      .map((civilian) => civilian.id);

    if (this.player.position.x >= this.mission.lengthMeters - 220) {
      notifyFinalExtraction(this.director, this.directorTuning);
    }

    const spawned = stepDirector(
      this.director,
      this.sockets,
      this.combatView(),
      this.directorTuning,
      this.rng,
    );
    for (const request of spawned.spawns) {
      const socket = this.sockets.find((candidate) => candidate.id === request.socketId);
      if (socket) this.spawnEnemy(socket);
    }
  }

  private checkEnd(): void {
    if (this.phase !== 'active') return;
    if (this.player.destroyedFor !== null) {
      this.fail('aircraft-lost');
      return;
    }
    if (this.objectives.allPrimariesComplete()) {
      this.phase = 'complete';
      this.emit('mission:complete', { rescued: this.progress.rescued });
    }
  }

  private fail(reason: string): void {
    if (this.phase !== 'active') return;
    this.phase = 'failed';
    this.emit('mission:failed', { reason });
  }

  /** Records a zone arrival, which objectives read. Driven by the app layer's zone triggers. */
  markZoneReached(zoneId: string): void {
    const zones = new Set(this.progress.zonesReached);
    zones.add(zoneId);
    this.progress.zonesReached = zones;
  }

  markTargetDestroyed(targetId: string): void {
    const targets = new Set(this.progress.targetsDestroyed);
    targets.add(targetId);
    this.progress.targetsDestroyed = targets;
  }

  markItemCollected(itemId: string): void {
    const items = new Set(this.progress.itemsCollected);
    items.add(itemId);
    this.progress.itemsCollected = items;
  }

  /** Everything the grade needs, accumulated live rather than reconstructed from a replay. */
  outcome(): MissionOutcome {
    const counts = tally(this.civilians);
    const primary = this.objectives.countByKind('primary');
    const secondary = this.objectives.countByKind('secondary');
    return {
      civilians: { total: counts.total, rescued: counts.rescued, dead: counts.dead },
      objectives: {
        primaryComplete: primary.complete,
        primaryTotal: primary.total,
        secondaryComplete: secondary.complete,
        secondaryTotal: secondary.total,
      },
      safety: {
        hullRemaining: this.player.hull,
        passengersInjured: this.stats.passengersInjured,
        aircraftLost: this.player.destroyedFor !== null,
        hardLandings: this.stats.hardLandings,
        crashLandings: this.stats.crashLandings,
      },
      restraint: {
        civiliansHitByPlayer: this.stats.civiliansHitByPlayer,
        collateralStructures: this.stats.collateralStructures,
        threatsSuppressed: this.stats.threatsSuppressed,
        threatsDestroyed: this.stats.threatsDestroyed,
      },
      requiredRescues: this.mission.requiredRescues,
      elapsedSeconds: this.elapsed,
      targetSeconds: this.mission.targetSeconds,
    };
  }

  // --- Debug commands -----------------------------------------------------
  // The PRD requires a way to spawn every actor and force every mission phase. Without it,
  // testing a late-mission state means playing fifteen minutes to reach it, so it never gets
  // tested. These mutate the world directly and are not reachable from gameplay input.

  debugForcePhase(phase: MissionPhase): void {
    if (phase === 'failed') {
      this.player.hull = 0;
      this.player.destroyedFor = 0;
      this.fail('debug');
      return;
    }
    if (phase === 'complete') {
      this.progress.rescued = this.mission.requiredRescues;
      this.progress.unloaded = Math.max(this.progress.unloaded, 1);
      const zones = new Set(this.progress.zonesReached);
      for (const zone of this.mission.landingZones) zones.add(zone.id);
      this.progress.zonesReached = zones;
      this.objectives.update(this.progress);
      this.phase = 'complete';
      this.emit('mission:complete', { rescued: this.progress.rescued, debug: true });
      return;
    }
    this.phase = 'active';
  }

  /** Spawns one of every enemy kind the mission authors, at their own sockets. */
  debugSpawnAll(): number {
    const seen = new Set<string>();
    let spawned = 0;
    for (const socket of this.sockets) {
      if (seen.has(socket.kind)) continue;
      seen.add(socket.kind);
      this.spawnEnemy(socket);
      spawned++;
    }
    return spawned;
  }

  debugSpawnKind(kind: EnemyKind): boolean {
    const socket = this.sockets.find((candidate) => candidate.kind === kind);
    if (!socket) return false;
    this.spawnEnemy(socket);
    return true;
  }

  debugReleaseAllCivilians(): void {
    for (const group of this.mission.civilianGroups) this.releaseGroup(group.id);
  }

  debugTeleport(x: number, y?: number): void {
    this.player.position.x = x;
    this.player.position.y = y ?? this.terrain.heightAt(x) + 40;
    this.player.velocity.x = 0;
    this.player.velocity.y = 0;
    this.player.grounded = false;
  }

  /** Replay verification hash over everything the simulation owns. */
  hash(): string {
    const h = new Hash32();
    h.writeUint32(this.tick);
    const p = this.player;
    h.writeFloat(p.position.x).writeFloat(p.position.y);
    h.writeFloat(p.velocity.x).writeFloat(p.velocity.y);
    h.writeFloat(p.hull).writeFloat(p.fuel).writeUint32(p.passengers.length);
    h.writeUint32(this.enemies.size);
    h.writeUint32(this.projectiles.liveCount);
    for (const civilian of this.civilians) {
      h.writeFloat(civilian.position.x).writeFloat(civilian.health);
      h.writeUint32(civilian.state.length);
    }
    const state = this.rng.getState();
    h.writeUint32(state.a).writeUint32(state.b).writeUint32(state.c).writeUint32(state.d);
    return h.hex();
  }
}

/** Convenience for tests and headless runs. */
export const runMission = (
  world: MissionWorld,
  seconds: number,
  input: MissionInput = neutralMissionInput(),
): void => {
  const steps = Math.round(seconds / world.dt);
  for (let i = 0; i < steps; i++) world.step(input);
};

export const overlapsBodies = overlaps;
