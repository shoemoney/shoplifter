import { describe, expect, it } from 'vitest';
import { Rng } from '@/core/rng.js';
import { FULL_UV } from './spriteBatch.js';
import type { Sprite } from './spriteBatch.js';
import {
  MAX_OCCLUSION_SECONDS,
  ParticleKind,
  ParticleSystem,
  defaultParticleTuning,
  type ParticleAtlasUv,
} from './particles.js';

const FAR_BELOW_GROUND = (): number => -1000;

const fullAtlas = (): ParticleAtlasUv => ({
  [ParticleKind.Dust]: FULL_UV,
  [ParticleKind.Spark]: FULL_UV,
  [ParticleKind.Smoke]: FULL_UV,
  [ParticleKind.Debris]: FULL_UV,
  [ParticleKind.Flash]: FULL_UV,
});

const makeFakeBatch = (): { draws: Sprite[]; draw(sprite: Sprite): boolean } => {
  const draws: Sprite[] = [];
  return {
    draws,
    draw(sprite: Sprite): boolean {
      draws.push(sprite);
      return true;
    },
  };
};

describe('ParticleSystem pool behaviour', () => {
  it('emit returns false once the pool is exhausted, without growing', () => {
    const system = new ParticleSystem({ rng: new Rng(1), capacity: 2 });
    const spawn = (): boolean =>
      system.emit({
        kind: ParticleKind.Spark,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        life: 1,
        startSize: 1,
        endSize: 1,
      });

    expect(spawn()).toBe(true);
    expect(spawn()).toBe(true);
    expect(spawn()).toBe(false);
    expect(system.capacity).toBe(2);
    expect(system.liveCount).toBe(2);
  });

  it('reuses a freed slot once a particle expires', () => {
    const system = new ParticleSystem({ rng: new Rng(1), capacity: 1 });
    system.emit({
      kind: ParticleKind.Spark,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 0.01,
      startSize: 1,
      endSize: 1,
    });
    expect(system.liveCount).toBe(1);

    system.step(0.02, { groundHeightAt: FAR_BELOW_GROUND });
    expect(system.liveCount).toBe(0);

    const reused = system.emit({
      kind: ParticleKind.Spark,
      x: 5,
      y: 5,
      vx: 0,
      vy: 0,
      life: 1,
      startSize: 1,
      endSize: 1,
    });
    expect(reused).toBe(true);
    expect(system.liveCount).toBe(1);
  });
});

describe('life expiry', () => {
  it('retires a particle exactly once its life reaches zero', () => {
    const system = new ParticleSystem({ rng: new Rng(2), capacity: 4 });
    // 0.08s of life against two 0.05s steps: the second step must cross zero, not land on it,
    // so the assertion does not hinge on float32 rounding landing exactly at 0.
    system.emit({
      kind: ParticleKind.Flash,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 0.08,
      startSize: 1,
      endSize: 1,
    });

    system.step(0.05, { groundHeightAt: FAR_BELOW_GROUND });
    expect(system.liveCount).toBe(1);

    system.step(0.05, { groundHeightAt: FAR_BELOW_GROUND });
    expect(system.liveCount).toBe(0);

    // Stepping a dead system further must not throw or resurrect anything.
    system.step(1, { groundHeightAt: FAR_BELOW_GROUND });
    expect(system.liveCount).toBe(0);
  });
});

describe('alpha and size fading', () => {
  it('interpolates size and fades alpha monotonically across a particle life', () => {
    const tuning = defaultParticleTuning();
    const system = new ParticleSystem({ rng: new Rng(7), tuning, capacity: 4 });
    system.emit({
      kind: ParticleKind.Smoke,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 1,
      startSize: 1,
      endSize: 3,
    });

    const atlas = fullAtlas();
    const sizes: number[] = [];
    const alphas: number[] = [];
    const steps = 20;
    const dt = 1 / steps;

    for (let i = 0; i < steps; i++) {
      system.step(dt, { groundHeightAt: FAR_BELOW_GROUND });
      const batch = makeFakeBatch();
      system.collect(batch, atlas);
      const sprite = batch.draws[0];
      if (sprite) {
        sizes.push(sprite.width);
        alphas.push(sprite.a ?? 0);
      }
    }

    expect(sizes.length).toBeGreaterThan(0);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThanOrEqual((sizes[i - 1] as number) - 1e-9);
    }

    const fadeInSeconds = tuning.kinds[ParticleKind.Smoke].fadeInSeconds;
    const fadeOutStart = Math.ceil(fadeInSeconds / dt) + 1;
    for (let i = fadeOutStart + 1; i < alphas.length; i++) {
      expect(alphas[i]).toBeLessThanOrEqual((alphas[i - 1] as number) + 1e-9);
    }
  });
});

describe('per-kind gravity', () => {
  it('smoke rises while debris falls', () => {
    const system = new ParticleSystem({ rng: new Rng(3), capacity: 8 });
    system.emit({
      kind: ParticleKind.Smoke,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 5,
      startSize: 1,
      endSize: 1,
    });
    system.emit({
      kind: ParticleKind.Debris,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 5,
      startSize: 1,
      endSize: 1,
    });

    for (let i = 0; i < 30; i++) system.step(1 / 30, { groundHeightAt: FAR_BELOW_GROUND });

    const batch = makeFakeBatch();
    system.collect(batch, fullAtlas());
    expect(batch.draws).toHaveLength(2);

    const smoke = batch.draws[0] as Sprite;
    const debris = batch.draws[1] as Sprite;
    expect(smoke.y).toBeGreaterThan(0);
    expect(debris.y).toBeLessThan(0);
  });
});

describe('ground settling', () => {
  it('settles debris onto the terrain instead of passing through it', () => {
    const system = new ParticleSystem({ rng: new Rng(5), capacity: 4 });
    const groundY = 2;
    // Life comfortably outlasts the settling window below, so the particle is still alive
    // (and drawable) once it has come to rest on the ground.
    system.emit({
      kind: ParticleKind.Debris,
      x: 0,
      y: 10,
      vx: 0,
      vy: -2,
      life: 12,
      startSize: 1,
      endSize: 1,
    });

    for (let i = 0; i < 480; i++) system.step(1 / 60, { groundHeightAt: () => groundY });

    const batch = makeFakeBatch();
    system.collect(batch, fullAtlas());
    const sprite = batch.draws[0];
    expect(sprite).toBeDefined();
    expect(sprite?.y).toBeCloseTo(groundY, 1);
  });
});

describe('determinism', () => {
  it('produces identical particles from two systems given the same seed and emissions', () => {
    const makeSystem = (): ParticleSystem => new ParticleSystem({ rng: new Rng(42), capacity: 64 });
    const a = makeSystem();
    const b = makeSystem();

    a.emitExplosion(10, 5);
    b.emitExplosion(10, 5);

    for (let i = 0; i < 10; i++) {
      a.step(1 / 60, { groundHeightAt: FAR_BELOW_GROUND });
      b.step(1 / 60, { groundHeightAt: FAR_BELOW_GROUND });
    }

    const atlas = fullAtlas();
    const batchA = makeFakeBatch();
    const batchB = makeFakeBatch();
    a.collect(batchA, atlas);
    b.collect(batchB, atlas);

    expect(batchB.draws).toEqual(batchA.draws);
  });
});

describe('collect', () => {
  it('emits exactly one sprite per live particle, with sane sizes', () => {
    const system = new ParticleSystem({ rng: new Rng(9), capacity: 32 });
    system.emitDebris(0, 0);
    const before = system.liveCount;
    expect(before).toBeGreaterThan(0);

    const batch = makeFakeBatch();
    const drawn = system.collect(batch, fullAtlas());

    expect(drawn).toBe(before);
    expect(batch.draws).toHaveLength(before);
    for (const sprite of batch.draws) {
      expect(sprite.width).toBeGreaterThan(0);
      expect(sprite.width).toBeLessThan(50);
      expect(sprite.height).toBe(sprite.width);
      expect(Number.isFinite(sprite.x)).toBe(true);
      expect(Number.isFinite(sprite.y)).toBe(true);
    }
  });
});

describe('emitExplosion', () => {
  it('produces a burst of many particles, not just one', () => {
    const system = new ParticleSystem({ rng: new Rng(11), capacity: 128 });
    const emitted = system.emitExplosion(0, 0);
    expect(emitted).toBeGreaterThan(10);
    expect(system.liveCount).toBe(emitted);
  });
});

describe('emitRotorWash', () => {
  it('only emits when close to the ground', () => {
    const system = new ParticleSystem({ rng: new Rng(13), capacity: 32 });

    const farAboveGround = system.emitRotorWash(0, 0, 50);
    expect(farAboveGround).toBe(0);
    expect(system.liveCount).toBe(0);

    const nearGround = system.emitRotorWash(0, 0, 1);
    expect(nearGround).toBeGreaterThan(0);
    expect(system.liveCount).toBe(nearGround);
  });
});

describe('0.4-second occlusion bound', () => {
  it('stops reporting a point occluded once a particle passes its opaque window', () => {
    const system = new ParticleSystem({ rng: new Rng(1), capacity: 4 });
    system.emit({
      kind: ParticleKind.Smoke,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 5,
      startSize: 20,
      endSize: 20,
    });
    expect(system.isPointOccluded(0, 0)).toBe(true);

    const cap = defaultParticleTuning().kinds[ParticleKind.Smoke].opaqueSeconds;
    expect(cap).toBeLessThanOrEqual(MAX_OCCLUSION_SECONDS);

    const dt = 0.01;
    const steps = Math.ceil(cap / dt) + 5;
    for (let i = 0; i < steps; i++) system.step(dt, { groundHeightAt: FAR_BELOW_GROUND });

    expect(system.isPointOccluded(0, 0)).toBe(false);
  });

  it('clamps a kind configured beyond the bound at construction time', () => {
    const tuning = defaultParticleTuning();
    tuning.kinds[ParticleKind.Debris] = {
      ...tuning.kinds[ParticleKind.Debris],
      opaqueSeconds: 10,
    };
    const system = new ParticleSystem({ rng: new Rng(1), tuning, capacity: 4 });
    system.emit({
      kind: ParticleKind.Debris,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 20,
      startSize: 20,
      endSize: 20,
    });
    expect(system.isPointOccluded(0, 0)).toBe(true);

    const dt = 0.01;
    const steps = Math.ceil(MAX_OCCLUSION_SECONDS / dt) + 5;
    for (let i = 0; i < steps; i++) system.step(dt, { groundHeightAt: FAR_BELOW_GROUND });

    expect(system.isPointOccluded(0, 0)).toBe(false);
  });
});
