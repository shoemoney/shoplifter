import { SlotAllocator } from '@/core/pools.js';
import { clamp, lerp } from '@/core/math.js';
import type { Rng } from '@/core/rng.js';
import type { Sprite, UvRect } from './spriteBatch.js';

/**
 * Structure-of-arrays particle system for dust, sparks, smoke, debris and explosion flashes.
 * Every particle lives in typed arrays sized once at construction and indexed by a
 * `SlotAllocator`, so `step` and `collect` never allocate — the same requirement that keeps
 * `sim/systems/flight.ts` GC-free at 60Hz applies here at particle counts two orders larger.
 *
 * Particles do not own a draw call: `collect` pushes into the caller's `SpriteBatch` so the
 * whole scene, particles included, stays inside the PRD's single-draw-call sprite budget.
 */
export enum ParticleKind {
  Dust = 0,
  Spark = 1,
  Smoke = 2,
  Debris = 3,
  Flash = 4,
}

/** Longest a particle may count as "occluding" for `isPointOccluded`. Hard rule, not a target —
 * see docs/PRD.md Art Direction -> Effects: "particles may never conceal landing hazards for
 * more than 0.4 seconds". Enforced at construction, not by convention, so no future tuning
 * change can quietly blow the budget. */
export const MAX_OCCLUSION_SECONDS = 0.4;

export interface ParticleKindTuning {
  /** Acceleration applied to vertical velocity every second, y-up like `sim/systems/flight.ts`:
   * negative falls, positive rises (buoyant smoke). */
  gravity: number;
  /** Linear velocity damping per second, applied to both axes. */
  drag: number;
  lifeSeconds: { min: number; max: number };
  startSize: { min: number; max: number };
  /** endSize = startSize * endSizeScale, so >1 grows (smoke dissipating) and <1 shrinks (a spark
   * burning out). */
  endSizeScale: number;
  color: { r: number; g: number; b: number };
  peakAlpha: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  /** Whether this kind is ever counted by `isPointOccluded` at all. */
  occludes: boolean;
  /** Longest this kind may count as occluding. Clamped to `MAX_OCCLUSION_SECONDS` at
   * construction regardless of what is configured here. */
  opaqueSeconds: number;
  /** Whether this kind collides with and settles on terrain (debris; not smoke or sparks). */
  groundCollides: boolean;
  /** Sprite depth passed straight through to `SpriteBatch`'s parallax layering. */
  depth: number;
}

export interface ParticleTuning {
  // TODO(balance): move these numbers into a balance JSON file through content/loaders once
  // particles need per-mission overrides, the way flight and landing tuning already do.
  kinds: Record<ParticleKind, ParticleKindTuning>;
  explosion: {
    flashCount: number;
    debrisCount: number;
    sparkCount: number;
    smokeCount: number;
    debrisSpeed: { min: number; max: number };
    sparkSpeed: { min: number; max: number };
    smokeUpwardSpeed: { min: number; max: number };
  };
  rotorWash: {
    count: number;
    /** Above this height above ground, rotor wash emits nothing at all. */
    maxHeightAboveGround: number;
    spreadX: number;
    outwardSpeed: { min: number; max: number };
    upwardSpeed: { min: number; max: number };
  };
  impactSparks: {
    count: number;
    speed: { min: number; max: number };
    spreadRadians: number;
  };
  smokeTrail: {
    count: number;
    jitterSpeed: number;
  };
  debris: {
    burstCount: number;
    speed: { min: number; max: number };
    /** Velocity retained (as a fraction) on bounce. */
    restitution: number;
    /** Horizontal velocity retained (as a fraction) on ground contact. */
    groundFriction: number;
    /** Impact speed below which debris settles instead of bouncing. */
    bounceThreshold: number;
  };
}

const clampKindTuning = (kind: ParticleKindTuning): ParticleKindTuning => ({
  ...kind,
  opaqueSeconds: Math.min(kind.opaqueSeconds, MAX_OCCLUSION_SECONDS),
});

/** The 1982-original had no particles at all; every figure here is a modern design target, not
 * a measurement, and is expected to move into balance JSON. Keep `opaqueSeconds` under
 * `MAX_OCCLUSION_SECONDS` when tuning — the constructor clamps it either way. */
export const defaultParticleTuning = (): ParticleTuning => ({
  kinds: {
    [ParticleKind.Dust]: {
      gravity: -6,
      drag: 1.5,
      lifeSeconds: { min: 0.4, max: 0.9 },
      startSize: { min: 0.3, max: 0.6 },
      endSizeScale: 1.8,
      color: { r: 0.75, g: 0.68, b: 0.55 },
      peakAlpha: 0.5,
      fadeInSeconds: 0.05,
      fadeOutSeconds: 0.3,
      occludes: true,
      opaqueSeconds: 0.25,
      groundCollides: false,
      depth: 0.55,
    },
    [ParticleKind.Spark]: {
      gravity: -20,
      drag: 0.5,
      lifeSeconds: { min: 0.15, max: 0.35 },
      startSize: { min: 0.08, max: 0.15 },
      endSizeScale: 0.4,
      color: { r: 1, g: 0.85, b: 0.3 },
      peakAlpha: 1,
      fadeInSeconds: 0.02,
      fadeOutSeconds: 0.15,
      occludes: false,
      opaqueSeconds: 0,
      groundCollides: false,
      depth: 0.3,
    },
    [ParticleKind.Smoke]: {
      gravity: 2.5,
      drag: 0.8,
      lifeSeconds: { min: 1.2, max: 2.5 },
      startSize: { min: 0.5, max: 0.9 },
      endSizeScale: 2.5,
      color: { r: 0.35, g: 0.35, b: 0.35 },
      peakAlpha: 0.45,
      fadeInSeconds: 0.2,
      fadeOutSeconds: 0.8,
      occludes: true,
      opaqueSeconds: 0.35,
      groundCollides: false,
      depth: 0.6,
    },
    [ParticleKind.Debris]: {
      gravity: -18,
      drag: 0.3,
      lifeSeconds: { min: 1.5, max: 3 },
      startSize: { min: 0.2, max: 0.4 },
      endSizeScale: 1,
      color: { r: 0.4, g: 0.32, b: 0.22 },
      peakAlpha: 1,
      fadeInSeconds: 0,
      fadeOutSeconds: 0.4,
      occludes: true,
      opaqueSeconds: 0.4,
      groundCollides: true,
      depth: 0.45,
    },
    [ParticleKind.Flash]: {
      gravity: 0,
      drag: 0,
      lifeSeconds: { min: 0.08, max: 0.15 },
      startSize: { min: 1.5, max: 2.5 },
      endSizeScale: 1.6,
      color: { r: 1, g: 0.95, b: 0.8 },
      peakAlpha: 1,
      fadeInSeconds: 0,
      fadeOutSeconds: 0.1,
      occludes: true,
      opaqueSeconds: 0.1,
      groundCollides: false,
      depth: 0.2,
    },
  },
  explosion: {
    flashCount: 3,
    debrisCount: 14,
    sparkCount: 18,
    smokeCount: 10,
    debrisSpeed: { min: 4, max: 14 },
    sparkSpeed: { min: 10, max: 22 },
    smokeUpwardSpeed: { min: 0.5, max: 1.5 },
  },
  rotorWash: {
    count: 6,
    maxHeightAboveGround: 6,
    spreadX: 2.2,
    outwardSpeed: { min: 0.6, max: 1.8 },
    upwardSpeed: { min: 0.4, max: 1.1 },
  },
  impactSparks: {
    count: 8,
    speed: { min: 6, max: 14 },
    spreadRadians: Math.PI / 3,
  },
  smokeTrail: {
    count: 2,
    jitterSpeed: 0.4,
  },
  debris: {
    burstCount: 6,
    speed: { min: 3, max: 9 },
    restitution: 0.35,
    groundFriction: 0.6,
    bounceThreshold: 1.5,
  },
});

export interface ParticleEmitSpec {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  startSize: number;
  endSize: number;
  rotation?: number;
  rotationSpeed?: number;
}

export interface ParticleStepContext {
  /** Terrain sampled by x, exactly like `CombatWorldView.groundHeightAt` — injected so debris
   * can settle without this module importing the sim's terrain type. */
  groundHeightAt: (x: number) => number;
}

/** Structural subset of `SpriteBatch` this module needs. A fake object shaped like this is
 * enough to unit-test `collect` without a GPU. */
export interface ParticleDrawTarget {
  draw(sprite: Sprite): boolean;
}

export type ParticleAtlasUv = Record<ParticleKind, UvRect>;

export interface ParticleSystemOptions {
  /** The only source of randomness this system draws from. `Math.random()` is banned in
   * simulation code, and particles are simulation output as far as replays are concerned. */
  rng: Rng;
  /** Maximum live particles. Preallocated once; emitting past it fails gracefully. */
  capacity?: number;
  tuning?: ParticleTuning;
}

export class ParticleSystem {
  readonly tuning: ParticleTuning;

  private readonly rng: Rng;
  private readonly slots: SlotAllocator;

  private readonly alive: Uint8Array;
  private readonly kind: Uint8Array;
  private readonly posX: Float32Array;
  private readonly posY: Float32Array;
  private readonly velX: Float32Array;
  private readonly velY: Float32Array;
  private readonly life: Float32Array;
  private readonly lifeTotal: Float32Array;
  private readonly startSize: Float32Array;
  private readonly endSize: Float32Array;
  private readonly size: Float32Array;
  private readonly rotation: Float32Array;
  private readonly rotationSpeed: Float32Array;
  private readonly alpha: Float32Array;

  constructor(options: ParticleSystemOptions) {
    this.rng = options.rng;
    const capacity = options.capacity ?? 1024;
    this.slots = new SlotAllocator(capacity);
    const source = options.tuning ?? defaultParticleTuning();
    this.tuning = {
      ...source,
      kinds: {
        [ParticleKind.Dust]: clampKindTuning(source.kinds[ParticleKind.Dust]),
        [ParticleKind.Spark]: clampKindTuning(source.kinds[ParticleKind.Spark]),
        [ParticleKind.Smoke]: clampKindTuning(source.kinds[ParticleKind.Smoke]),
        [ParticleKind.Debris]: clampKindTuning(source.kinds[ParticleKind.Debris]),
        [ParticleKind.Flash]: clampKindTuning(source.kinds[ParticleKind.Flash]),
      },
    };

    this.alive = new Uint8Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.velX = new Float32Array(capacity);
    this.velY = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.lifeTotal = new Float32Array(capacity);
    this.startSize = new Float32Array(capacity);
    this.endSize = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.rotation = new Float32Array(capacity);
    this.rotationSpeed = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
  }

  get capacity(): number {
    return this.slots.capacity;
  }

  get liveCount(): number {
    return this.slots.live;
  }

  /** Low-level emit. Burst helpers below are the usual entry point; this exists for direct
   * control and for tests that need deterministic sizes/life without going through the RNG.
   * Returns false rather than growing when the pool is exhausted. */
  emit(spec: ParticleEmitSpec): boolean {
    const index = this.slots.alloc();
    if (index === undefined) return false;

    this.alive[index] = 1;
    this.kind[index] = spec.kind;
    this.posX[index] = spec.x;
    this.posY[index] = spec.y;
    this.velX[index] = spec.vx;
    this.velY[index] = spec.vy;
    this.life[index] = spec.life;
    this.lifeTotal[index] = spec.life;
    this.startSize[index] = spec.startSize;
    this.endSize[index] = spec.endSize;
    this.size[index] = spec.startSize;
    this.rotation[index] = spec.rotation ?? 0;
    this.rotationSpeed[index] = spec.rotationSpeed ?? 0;
    this.alpha[index] = 0;
    return true;
  }

  /** Randomizes life/size/spin from the kind's tuning around an explicit position and velocity.
   * Every burst helper below is this plus a way of picking `vx`/`vy`. */
  private spawnFromKind(
    kind: ParticleKind,
    x: number,
    y: number,
    vx: number,
    vy: number,
    rotationSpeed = 0,
  ): boolean {
    const k = this.tuning.kinds[kind];
    const startSize = this.rng.range(k.startSize.min, k.startSize.max);
    return this.emit({
      kind,
      x,
      y,
      vx,
      vy,
      life: this.rng.range(k.lifeSeconds.min, k.lifeSeconds.max),
      startSize,
      endSize: startSize * k.endSizeScale,
      rotation: this.rng.range(0, Math.PI * 2),
      rotationSpeed,
    });
  }

  /** Explosion: a flash, an outward ring of debris and sparks, and a slower rising smoke
   * column. Returns the number of particles actually emitted (less than requested once the
   * pool runs dry). */
  emitExplosion(x: number, y: number): number {
    const cfg = this.tuning.explosion;
    let emitted = 0;

    for (let i = 0; i < cfg.flashCount; i++) {
      if (this.spawnFromKind(ParticleKind.Flash, x, y, 0, 0)) emitted++;
    }
    for (let i = 0; i < cfg.debrisCount; i++) {
      const angle = this.rng.range(0, Math.PI * 2);
      const speed = this.rng.range(cfg.debrisSpeed.min, cfg.debrisSpeed.max);
      const spin = this.rng.range(-6, 6);
      if (
        this.spawnFromKind(
          ParticleKind.Debris,
          x,
          y,
          Math.cos(angle) * speed,
          Math.sin(angle) * speed,
          spin,
        )
      ) {
        emitted++;
      }
    }
    for (let i = 0; i < cfg.sparkCount; i++) {
      const angle = this.rng.range(0, Math.PI * 2);
      const speed = this.rng.range(cfg.sparkSpeed.min, cfg.sparkSpeed.max);
      if (
        this.spawnFromKind(
          ParticleKind.Spark,
          x,
          y,
          Math.cos(angle) * speed,
          Math.sin(angle) * speed,
        )
      ) {
        emitted++;
      }
    }
    for (let i = 0; i < cfg.smokeCount; i++) {
      const angle = this.rng.range(0, Math.PI * 2);
      const drift = this.rng.range(0, 1.5);
      const rise = this.rng.range(cfg.smokeUpwardSpeed.min, cfg.smokeUpwardSpeed.max);
      if (this.spawnFromKind(ParticleKind.Smoke, x, y, Math.cos(angle) * drift, rise)) emitted++;
    }
    return emitted;
  }

  /** Dust kicked up under a hovering helicopter. Emits nothing once the aircraft is more than
   * `maxHeightAboveGround` above the terrain — rotor wash is a ground-proximity effect, not a
   * permanent skirt around the aircraft. */
  emitRotorWash(x: number, groundY: number, heightAboveGround: number): number {
    const cfg = this.tuning.rotorWash;
    if (heightAboveGround > cfg.maxHeightAboveGround) return 0;

    let emitted = 0;
    for (let i = 0; i < cfg.count; i++) {
      const offsetX = this.rng.range(-cfg.spreadX, cfg.spreadX);
      const outwardSign = offsetX >= 0 ? 1 : -1;
      const outward = this.rng.range(cfg.outwardSpeed.min, cfg.outwardSpeed.max) * outwardSign;
      const upward = this.rng.range(cfg.upwardSpeed.min, cfg.upwardSpeed.max);
      if (this.spawnFromKind(ParticleKind.Dust, x + offsetX, groundY, outward, upward)) emitted++;
    }
    return emitted;
  }

  /** A cone of sparks around a surface normal — bullet or rocket impacts. */
  emitImpactSparks(x: number, y: number, normalRadians = 0): number {
    const cfg = this.tuning.impactSparks;
    let emitted = 0;
    for (let i = 0; i < cfg.count; i++) {
      const angle = normalRadians + this.rng.range(-cfg.spreadRadians / 2, cfg.spreadRadians / 2);
      const speed = this.rng.range(cfg.speed.min, cfg.speed.max);
      if (
        this.spawnFromKind(
          ParticleKind.Spark,
          x,
          y,
          Math.cos(angle) * speed,
          Math.sin(angle) * speed,
        )
      ) {
        emitted++;
      }
    }
    return emitted;
  }

  /** A wisp or two of smoke trailing a moving emitter (a damaged engine, a burning wreck being
   * dragged). `biasVX`/`biasVY` is the emitter's own velocity; jitter rides on top of it. */
  emitSmokeTrail(x: number, y: number, biasVX = 0, biasVY = 0): number {
    const cfg = this.tuning.smokeTrail;
    let emitted = 0;
    for (let i = 0; i < cfg.count; i++) {
      const jitterX = this.rng.range(-cfg.jitterSpeed, cfg.jitterSpeed);
      const jitterY = this.rng.range(-cfg.jitterSpeed, cfg.jitterSpeed);
      if (this.spawnFromKind(ParticleKind.Smoke, x, y, biasVX + jitterX, biasVY + jitterY)) {
        emitted++;
      }
    }
    return emitted;
  }

  /** A standalone debris burst — wreckage breaking apart outside of a full explosion. */
  emitDebris(x: number, y: number): number {
    const cfg = this.tuning.debris;
    let emitted = 0;
    for (let i = 0; i < cfg.burstCount; i++) {
      const angle = this.rng.range(0, Math.PI);
      const speed = this.rng.range(cfg.speed.min, cfg.speed.max);
      const spin = this.rng.range(-6, 6);
      if (
        this.spawnFromKind(
          ParticleKind.Debris,
          x,
          y,
          Math.cos(angle) * speed,
          Math.sin(angle) * speed,
          spin,
        )
      ) {
        emitted++;
      }
    }
    return emitted;
  }

  /** Integrates motion, applies per-kind gravity/drag, settles or bounces ground-colliding kinds,
   * fades alpha and size over life, and retires anything whose life has run out. No allocation:
   * every array here was sized once at construction. */
  step(dt: number, context: ParticleStepContext): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] !== 1) continue;

      const remainingLife = (this.life[i] ?? 0) - dt;
      if (remainingLife <= 0) {
        this.alive[i] = 0;
        this.slots.free(i);
        continue;
      }
      this.life[i] = remainingLife;

      // Numeric enums accept any number without a cast, so an explicit annotation (not an
      // assertion) is what gives `tuning.kinds[kind]` a real ParticleKind key.
      const kind: ParticleKind = this.kind[i] ?? 0;
      const k = this.tuning.kinds[kind];

      const currentVX = this.velX[i] ?? 0;
      const currentVY = this.velY[i] ?? 0;
      const vx = currentVX - k.drag * currentVX * dt;
      const vy = currentVY + (k.gravity - k.drag * currentVY) * dt;

      const nextX = (this.posX[i] ?? 0) + vx * dt;
      let nextY = (this.posY[i] ?? 0) + vy * dt;
      let settledVX = vx;
      let settledVY = vy;

      if (k.groundCollides) {
        const groundY = context.groundHeightAt(nextX);
        if (nextY <= groundY) {
          nextY = groundY;
          const impactSpeed = Math.abs(vy);
          settledVY =
            impactSpeed > this.tuning.debris.bounceThreshold
              ? -vy * this.tuning.debris.restitution
              : 0;
          settledVX = vx * this.tuning.debris.groundFriction;
        }
      }

      this.velX[i] = settledVX;
      this.velY[i] = settledVY;
      this.posX[i] = nextX;
      this.posY[i] = nextY;

      const lifeTotal = this.lifeTotal[i] ?? remainingLife;
      const age = lifeTotal - remainingLife;
      const t = clamp(age / lifeTotal, 0, 1);
      this.size[i] = lerp(this.startSize[i] ?? 0, this.endSize[i] ?? 0, t);

      const fadeIn = k.fadeInSeconds > 0 ? clamp(age / k.fadeInSeconds, 0, 1) : 1;
      const fadeOut = k.fadeOutSeconds > 0 ? clamp(remainingLife / k.fadeOutSeconds, 0, 1) : 1;
      this.alpha[i] = k.peakAlpha * Math.min(fadeIn, fadeOut);

      this.rotation[i] = (this.rotation[i] ?? 0) + (this.rotationSpeed[i] ?? 0) * dt;
    }
  }

  /** True when an opaque particle currently covers this world point. Bounded by construction:
   * no kind can hold `true` here for longer than `MAX_OCCLUSION_SECONDS` after it was emitted,
   * however long the particle itself keeps living and fading beyond that window. */
  isPointOccluded(x: number, y: number): boolean {
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] !== 1) continue;

      // Numeric enums accept any number without a cast, so an explicit annotation (not an
      // assertion) is what gives `tuning.kinds[kind]` a real ParticleKind key.
      const kind: ParticleKind = this.kind[i] ?? 0;
      const k = this.tuning.kinds[kind];
      if (!k.occludes) continue;

      const lifeTotal = this.lifeTotal[i] ?? 0;
      const age = lifeTotal - (this.life[i] ?? 0);
      if (age >= k.opaqueSeconds) continue;

      const dx = x - (this.posX[i] ?? 0);
      const dy = y - (this.posY[i] ?? 0);
      const radius = (this.size[i] ?? 0) / 2;
      if (dx * dx + dy * dy <= radius * radius) return true;
    }
    return false;
  }

  /** Pushes every live particle into `batch` via `draw()`. Returns how many were actually
   * accepted (equal to `liveCount` unless the batch itself is full). Reads only — never mutates
   * particle state, so it is safe to call more than once per step (e.g. once per camera layer). */
  collect(batch: ParticleDrawTarget, atlasUv: ParticleAtlasUv): number {
    let drawn = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] !== 1) continue;

      // Numeric enums accept any number without a cast, so an explicit annotation (not an
      // assertion) is what gives `tuning.kinds[kind]` a real ParticleKind key.
      const kind: ParticleKind = this.kind[i] ?? 0;
      const k = this.tuning.kinds[kind];
      const size = this.size[i] ?? 0;

      const sprite: Sprite = {
        x: this.posX[i] ?? 0,
        y: this.posY[i] ?? 0,
        width: size,
        height: size,
        rotation: this.rotation[i] ?? 0,
        depth: k.depth,
        uv: atlasUv[kind],
        r: k.color.r,
        g: k.color.g,
        b: k.color.b,
        a: this.alpha[i] ?? 0,
      };
      if (batch.draw(sprite)) drawn++;
    }
    return drawn;
  }
}
