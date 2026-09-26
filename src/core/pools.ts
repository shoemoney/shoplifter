/**
 * Object pool for projectiles, particles and temporary audio emitters. The hot loops must not
 * allocate: a per-frame `new` for 2,000 particles is what turns a 60 FPS build into a
 * GC-stutter build.
 */
export interface PoolOptions<T> {
  create: () => T;
  reset: (item: T) => void;
  initial?: number;
  /** Hard ceiling. Acquiring past it returns undefined rather than growing without bound. */
  max?: number;
}

export class Pool<T> {
  private readonly free: T[] = [];
  private readonly createItem: () => T;
  private readonly resetItem: (item: T) => void;
  private readonly max: number;
  private liveCount = 0;

  constructor(options: PoolOptions<T>) {
    this.createItem = options.create;
    this.resetItem = options.reset;
    this.max = options.max ?? Number.POSITIVE_INFINITY;
    for (let i = 0; i < (options.initial ?? 0); i++) this.free.push(this.createItem());
  }

  get live(): number {
    return this.liveCount;
  }

  get available(): number {
    return this.free.length;
  }

  get capacity(): number {
    return this.liveCount + this.free.length;
  }

  acquire(): T | undefined {
    const recycled = this.free.pop();
    if (recycled !== undefined) {
      this.liveCount++;
      return recycled;
    }
    if (this.capacity >= this.max) return undefined;
    this.liveCount++;
    return this.createItem();
  }

  release(item: T): void {
    if (this.liveCount === 0) throw new Error('Pool.release: nothing is live (double release?)');
    this.liveCount--;
    this.resetItem(item);
    this.free.push(item);
  }
}

/**
 * Structure-of-arrays slot allocator for high-volume entities. Callers own the typed arrays;
 * this only tracks which indices are in use, with a free list so indices are reused densely.
 */
export class SlotAllocator {
  private readonly freeList: number[] = [];
  private highWater = 0;

  constructor(readonly capacity: number) {}

  get live(): number {
    return this.highWater - this.freeList.length;
  }

  alloc(): number | undefined {
    const recycled = this.freeList.pop();
    if (recycled !== undefined) return recycled;
    if (this.highWater >= this.capacity) return undefined;
    return this.highWater++;
  }

  free(index: number): void {
    if (index < 0 || index >= this.highWater)
      throw new Error(`SlotAllocator.free: bad index ${index}`);
    this.freeList.push(index);
  }

  reset(): void {
    this.freeList.length = 0;
    this.highWater = 0;
  }
}
