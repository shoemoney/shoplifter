import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@/core/math.js';
import {
  ProjectilePool,
  type ProjectileImpact,
  type ProjectileSpawnParams,
  type ProjectileStepContext,
} from './projectiles.js';

const DT = 1 / 120;

const neverHits: ProjectileStepContext['resolveHit'] = () => null;
const bottomlessPit: ProjectileStepContext['groundHeightAt'] = () => -10_000;
const noTargets: ProjectileStepContext['targetPositionAt'] = () => null;

const baseContext = (overrides: Partial<ProjectileStepContext> = {}): ProjectileStepContext => ({
  gravity: 14,
  groundHeightAt: bottomlessPit,
  resolveHit: neverHits,
  targetPositionAt: noTargets,
  ...overrides,
});

const bulletParams = (overrides: Partial<ProjectileSpawnParams> = {}): ProjectileSpawnParams => ({
  kind: 'bullet',
  team: 'player',
  position: { x: 0, y: 100 },
  velocity: { x: 200, y: 0 },
  damage: 8,
  splashRadius: 0,
  lifetimeSeconds: 2,
  targetId: null,
  turnRate: 0,
  sourceId: null,
  ...overrides,
});

describe('pool capacity', () => {
  it('returns undefined once every slot is spent', () => {
    const pool = new ProjectilePool(2);
    expect(pool.spawn(bulletParams())).toBe(0);
    expect(pool.spawn(bulletParams())).toBe(1);
    expect(pool.spawn(bulletParams())).toBeUndefined();
    expect(pool.liveCount).toBe(2);
  });

  it('reuses a released slot instead of growing the pool', () => {
    const pool = new ProjectilePool(1);
    const first = pool.spawn(bulletParams());
    expect(first).toBe(0);
    pool.release(0);
    expect(pool.isActive(0)).toBe(false);

    const second = pool.spawn(bulletParams({ position: { x: 5, y: 5 } }));
    expect(second).toBe(0);
    expect(pool.isActive(0)).toBe(true);
    expect(pool.positionX(0)).toBe(5);
  });

  it('throws when releasing a slot that is not live — that is a double-free', () => {
    const pool = new ProjectilePool(1);
    pool.spawn(bulletParams());
    pool.release(0);
    expect(() => pool.release(0)).toThrow();
  });
});

describe('lifetime and terrain', () => {
  it('expires a projectile that outlives its lifetime, exactly once', () => {
    const pool = new ProjectilePool(1);
    pool.spawn(bulletParams({ lifetimeSeconds: 0.05 }));

    let impacts: ProjectileImpact[] = [];
    for (let i = 0; i < 10; i++) {
      impacts = pool.step(DT, baseContext());
      if (impacts.length > 0) break;
    }

    expect(impacts).toHaveLength(1);
    expect(impacts[0]?.cause).toBe('expired');
    expect(pool.liveCount).toBe(0);
  });

  it('reports a ground impact when the projectile crosses the terrain height', () => {
    const pool = new ProjectilePool(1);
    pool.spawn(
      bulletParams({ position: { x: 0, y: 1 }, velocity: { x: 0, y: -50 }, lifetimeSeconds: 5 }),
    );

    let impacts: ProjectileImpact[] = [];
    for (let i = 0; i < 10; i++) {
      impacts = pool.step(DT, baseContext({ groundHeightAt: () => 0 }));
      if (impacts.length > 0) break;
    }

    expect(impacts).toHaveLength(1);
    expect(impacts[0]?.cause).toBe('ground');
    expect(impacts[0]?.at.y).toBe(0);
    expect(pool.liveCount).toBe(0);
  });

  it('does not release a projectile that is still airborne and within its lifetime', () => {
    const pool = new ProjectilePool(1);
    pool.spawn(bulletParams({ lifetimeSeconds: 5 }));
    const impacts = pool.step(DT, baseContext());
    expect(impacts).toHaveLength(0);
    expect(pool.isActive(0)).toBe(true);
  });
});

describe('gravity', () => {
  it('applies gravity to arcing kinds (rocket, rpg) but not to flat-flying kinds', () => {
    const pool = new ProjectilePool(4);
    const bullet = pool.spawn(bulletParams({ kind: 'bullet', velocity: { x: 10, y: 0 } }));
    const rocket = pool.spawn(bulletParams({ kind: 'rocket', velocity: { x: 10, y: 0 } }));
    const rpg = pool.spawn(bulletParams({ kind: 'rpg', velocity: { x: 10, y: 0 } }));
    const shell = pool.spawn(bulletParams({ kind: 'aaShell', velocity: { x: 10, y: 0 } }));
    expect(bullet).toBeDefined();
    expect(rocket).toBeDefined();
    expect(rpg).toBeDefined();
    expect(shell).toBeDefined();

    for (let i = 0; i < 30; i++) pool.step(DT, baseContext());

    expect(pool.velocityY(bullet as number)).toBe(0);
    expect(pool.velocityY(shell as number)).toBe(0);
    expect(pool.velocityY(rocket as number)).toBeLessThan(0);
    expect(pool.velocityY(rpg as number)).toBeLessThan(0);
  });
});

describe('no tunnelling', () => {
  it('reports a hit via the swept segment even when the endpoint has already passed the target', () => {
    const pool = new ProjectilePool(1);
    // Fast enough to cross an 8m-wide target zone in a single 1/120s tick.
    const index = pool.spawn(
      bulletParams({ position: { x: -1, y: 0 }, velocity: { x: 2000, y: 0 }, lifetimeSeconds: 5 }),
    );
    expect(index).toBeDefined();

    const targetMinX = 3;
    const targetMaxX = 11;
    const crossesTarget = (from: Vec2, to: Vec2): boolean => {
      const lo = Math.min(from.x, to.x);
      const hi = Math.max(from.x, to.x);
      return hi >= targetMinX && lo <= targetMaxX;
    };

    const impacts = pool.step(
      DT,
      baseContext({
        resolveHit: (_i, from, to) => (crossesTarget(from, to) ? { targetId: 99, at: to } : null),
      }),
    );

    expect(impacts).toHaveLength(1);
    expect(impacts[0]?.cause).toBe('hit');
    expect(impacts[0]?.targetId).toBe(99);
    // The endpoint alone (checked as a point) would have missed a target this narrow relative
    // to the per-tick travel distance — proof the check used the segment, not just `to`.
    expect(pool.liveCount).toBe(0);
  });
});

describe('guided homing', () => {
  it('steers a guided kind toward its target, capped by the turn-rate limit', () => {
    const pool = new ProjectilePool(1);
    const turnRate = Math.PI; // radians/second
    const index = pool.spawn(
      bulletParams({
        kind: 'jetMissile',
        position: { x: 0, y: 0 },
        velocity: { x: 50, y: 0 },
        targetId: 7,
        turnRate,
        lifetimeSeconds: 5,
      }),
    );
    expect(index).toBeDefined();
    const slot = index as number;

    // Target sits directly "north" of the launch point — a 90-degree correction. Placed far
    // enough away that the missile's own lateral drift while turning (tens of metres) never
    // meaningfully changes the bearing, so the final heading is a clean check on turn-rate math
    // rather than on how much the missile drifted off the target's exact line.
    const context = baseContext({
      targetPositionAt: (id) => (id === 7 ? { x: 0, y: 1_000_000 } : null),
    });

    pool.step(DT, context);
    const angleAfterOneStep = Math.atan2(pool.velocityY(slot), pool.velocityX(slot));
    expect(Math.abs(angleAfterOneStep)).toBeCloseTo(turnRate * DT, 5);

    // The speed itself must be preserved by steering — only heading changes.
    const speed = Math.hypot(pool.velocityX(slot), pool.velocityY(slot));
    expect(speed).toBeCloseTo(50, 3);

    for (let i = 0; i < 200; i++) pool.step(DT, context);
    const finalAngle = Math.atan2(pool.velocityY(slot), pool.velocityX(slot));
    expect(finalAngle).toBeCloseTo(Math.PI / 2, 2);
  });

  it('flies straight once its lock is broken, even if a target position is still available', () => {
    const pool = new ProjectilePool(1);
    const index = pool.spawn(
      bulletParams({
        kind: 'jetMissile',
        position: { x: 0, y: 0 },
        velocity: { x: 50, y: 0 },
        targetId: 7,
        turnRate: Math.PI,
        lifetimeSeconds: 5,
      }),
    );
    const slot = index as number;
    pool.breakLock(slot);
    expect(pool.isLockBroken(slot)).toBe(true);

    const context = baseContext({ targetPositionAt: () => ({ x: 0, y: 1000 }) });
    for (let i = 0; i < 30; i++) pool.step(DT, context);

    expect(pool.velocityX(slot)).toBeCloseTo(50, 5);
    expect(pool.velocityY(slot)).toBeCloseTo(0, 5);
  });

  it('leaves non-guided kinds alone even when a target position is supplied', () => {
    const pool = new ProjectilePool(1);
    const index = pool.spawn(
      bulletParams({
        kind: 'rocket',
        position: { x: 0, y: 0 },
        velocity: { x: 50, y: 0 },
        targetId: 7,
        turnRate: Math.PI,
        lifetimeSeconds: 5,
      }),
    );
    const slot = index as number;
    const context = baseContext({
      gravity: 0,
      targetPositionAt: () => ({ x: 0, y: 1000 }),
    });
    pool.step(DT, context);
    expect(pool.velocityX(slot)).toBeCloseTo(50, 5);
    expect(pool.velocityY(slot)).toBeCloseTo(0, 5);
  });
});
