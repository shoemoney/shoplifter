import { describe, expect, it } from 'vitest';
import { Pool, SlotAllocator } from './pools.js';

interface Projectile {
  x: number;
  alive: boolean;
}

const makePool = (options: { initial?: number; max?: number } = {}): Pool<Projectile> =>
  new Pool<Projectile>({
    create: () => ({ x: 0, alive: false }),
    reset: (item) => {
      item.x = 0;
      item.alive = false;
    },
    ...options,
  });

describe('Pool', () => {
  it('prewarms the requested number of items', () => {
    const pool = makePool({ initial: 16 });
    expect(pool.available).toBe(16);
    expect(pool.live).toBe(0);
  });

  it('recycles rather than allocating once warm', () => {
    const pool = makePool({ initial: 1 });
    const first = pool.acquire();
    expect(first).toBeDefined();
    pool.release(first as Projectile);
    expect(pool.acquire()).toBe(first);
    expect(pool.capacity).toBe(1);
  });

  it('resets state on release so a stale projectile cannot reappear alive', () => {
    const pool = makePool({ initial: 1 });
    const item = pool.acquire() as Projectile;
    item.x = 42;
    item.alive = true;
    pool.release(item);
    expect(pool.acquire()).toMatchObject({ x: 0, alive: false });
  });

  it('returns undefined at the ceiling instead of growing without bound', () => {
    const pool = makePool({ max: 2 });
    expect(pool.acquire()).toBeDefined();
    expect(pool.acquire()).toBeDefined();
    expect(pool.acquire()).toBeUndefined();
    expect(pool.live).toBe(2);
  });

  it('throws on a double release', () => {
    const pool = makePool({ initial: 1 });
    const item = pool.acquire() as Projectile;
    pool.release(item);
    expect(() => pool.release(item)).toThrow(/nothing is live/);
  });
});

describe('SlotAllocator', () => {
  it('hands out dense indices', () => {
    const slots = new SlotAllocator(4);
    expect([slots.alloc(), slots.alloc(), slots.alloc()]).toEqual([0, 1, 2]);
    expect(slots.live).toBe(3);
  });

  it('reuses freed indices before growing', () => {
    const slots = new SlotAllocator(4);
    slots.alloc();
    const second = slots.alloc() as number;
    slots.free(second);
    expect(slots.alloc()).toBe(second);
  });

  it('returns undefined when full', () => {
    const slots = new SlotAllocator(2);
    slots.alloc();
    slots.alloc();
    expect(slots.alloc()).toBeUndefined();
  });

  it('rejects an out-of-range free', () => {
    const slots = new SlotAllocator(2);
    expect(() => slots.free(0)).toThrow(/bad index/);
  });

  it('resets to empty', () => {
    const slots = new SlotAllocator(2);
    slots.alloc();
    slots.reset();
    expect(slots.live).toBe(0);
    expect(slots.alloc()).toBe(0);
  });
});
