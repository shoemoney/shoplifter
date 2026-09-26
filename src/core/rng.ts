/**
 * Deterministic PRNG. `Math.random()` is banned in simulation code (enforced by ESLint)
 * because replay verification and the automated gameplay tests both compare state hashes
 * across runs.
 *
 * Algorithm: xorshift128 with 32-bit integer ops only, so results are bit-identical on
 * every platform a browser runs on. Float64 arithmetic would not be.
 */
export interface RngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

const UINT32 = 4294967296;

export class Rng {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;

  constructor(seed: number | RngState = 0x5eed1e) {
    if (typeof seed === 'number') this.seed(seed);
    else this.setState(seed);
  }

  /** Re-seeds from a single integer via splitmix32 so nearby seeds diverge immediately. */
  seed(seed: number): void {
    let x = seed >>> 0;
    const next = (): number => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    // A freshly seeded xorshift can start in a low-entropy region; discard a few draws.
    for (let i = 0; i < 8; i++) this.nextUint32();
  }

  getState(): RngState {
    return { a: this.a, b: this.b, c: this.c, d: this.d };
  }

  setState(state: RngState): void {
    this.a = state.a >>> 0;
    this.b = state.b >>> 0;
    this.c = state.c >>> 0;
    this.d = state.d >>> 0;
  }

  clone(): Rng {
    return new Rng(this.getState());
  }

  nextUint32(): number {
    let t = this.d;
    const s = this.a;
    this.d = this.c;
    this.c = this.b;
    this.b = s;
    t ^= t << 11;
    t ^= t >>> 8;
    this.a = (t ^ s ^ (s >>> 19)) >>> 0;
    return this.a;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint32() / UINT32;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    const span = max - min + 1;
    return min + (this.nextUint32() % span);
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Fisher-Yates in place. Deterministic for a given state. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }
}
