import { EventQueue, type SimEvent } from '@/core/events.js';
import { Hash32 } from '@/core/math.js';
import { Rng } from '@/core/rng.js';
import type { FlightBalance } from '@/content/schemas/flight.js';
import {
  createHelicopter,
  type FlightInput,
  type GameEventType,
  type Helicopter,
} from './components.js';
import { stepFlight } from './systems/flight.js';
import { stepLanding } from './systems/landing.js';
import type { Terrain } from './terrain.js';

export type GameEvent = SimEvent<GameEventType, Record<string, unknown>>;

export interface WorldOptions {
  balance: FlightBalance;
  terrain: Terrain;
  dt: number;
  seed?: number;
  /** Spawn position. `y` defaults to resting on the terrain at `x`. */
  spawn?: { x: number; y?: number };
}

/**
 * The simulation. It owns no DOM, no GPU handles and no wall-clock time — everything it needs
 * arrives as data, and everything it produces for the presentation layer leaves through the
 * event queue. That is what makes a replay reproducible and a headless test possible.
 */
export class World {
  readonly events = new EventQueue<GameEvent>();
  readonly rng: Rng;
  readonly dt: number;
  readonly terrain: Terrain;
  readonly balance: FlightBalance;

  tick = 0;
  player: Helicopter;

  constructor(options: WorldOptions) {
    this.dt = options.dt;
    this.terrain = options.terrain;
    this.balance = options.balance;
    this.rng = new Rng(options.seed ?? 0x63686f70);

    const spawnX = options.spawn?.x ?? 40;
    const spawnY =
      options.spawn?.y ?? this.terrain.heightAt(spawnX) + options.balance.landing.skidDrop;
    this.player = createHelicopter({
      position: { x: spawnX, y: spawnY },
      capacity: options.balance.capacity,
      fuel: options.balance.fuelCapacity,
    });
    // Spawning on the pad means starting grounded, not falling one tick onto it.
    this.player.grounded = true;
    this.player.landingContactCount = 2;
  }

  get elapsed(): number {
    return this.tick * this.dt;
  }

  private emit(type: GameEventType, payload: Record<string, unknown> = {}): void {
    this.events.push({ type, tick: this.tick, payload });
  }

  /** One fixed step. Flight integrates, then landing resolves contact against the new position. */
  step(input: FlightInput): void {
    const flight = stepFlight(this.player, input, {
      tuning: this.balance.flight,
      terrain: this.terrain,
      dt: this.dt,
      tick: this.tick,
    });

    if (flight.yawStarted) this.emit('flight:yawStarted', { ...flight.yawStarted });
    if (flight.yawCompleted !== null)
      this.emit('flight:yawCompleted', { facing: flight.yawCompleted });
    if (flight.fuelJustEmptied) this.emit('flight:fuelEmpty');

    const landing = stepLanding(this.player, {
      tuning: this.balance.landing,
      terrain: this.terrain,
      dt: this.dt,
    });

    if (landing.touchdown) {
      this.emit('flight:touchdown', { ...landing.touchdown });
      if (landing.touchdown.hullDamage > 0) {
        this.emit('flight:damaged', { amount: landing.touchdown.hullDamage, source: 'landing' });
      }
    }
    if (landing.liftoff) this.emit('flight:liftoff');

    if (this.player.hull <= 0 && this.player.destroyedFor === null) {
      this.player.destroyedFor = 0;
      this.emit('flight:destroyed', { tick: this.tick });
    }

    this.tick++;
  }

  /**
   * Hash of everything the simulation owns. Two runs fed identical inputs must produce
   * identical hashes; the replay verifier compares these rather than eyeballing positions.
   */
  hash(): string {
    const h = new Hash32();
    const p = this.player;
    h.writeUint32(this.tick);
    h.writeFloat(p.position.x).writeFloat(p.position.y);
    h.writeFloat(p.velocity.x).writeFloat(p.velocity.y);
    h.writeFloat(p.pitch).writeFloat(p.pitchVelocity);
    h.writeUint32(p.facing + 1).writeFloat(p.yawTimer);
    h.writeBool(p.grounded).writeUint32(p.landingContactCount);
    h.writeFloat(p.hull).writeFloat(p.engine).writeFloat(p.rotor).writeFloat(p.fuel);
    h.writeUint32(p.passengers.length);
    const state = this.rng.getState();
    h.writeUint32(state.a).writeUint32(state.b).writeUint32(state.c).writeUint32(state.d);
    return h.hex();
  }
}

/** Convenience for tests and the sandbox: run a fixed input for a number of seconds. */
export const runFor = (world: World, seconds: number, input: FlightInput): void => {
  const steps = Math.round(seconds / world.dt);
  for (let i = 0; i < steps; i++) world.step(input);
};
