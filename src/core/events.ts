/**
 * Simulation systems never call into rendering or audio directly. They push events onto a
 * queue that the presentation layer drains once per frame, which keeps the sim DOM-free and
 * lets replays re-derive effects without re-running audio.
 */
export interface SimEvent<K extends string = string, P = unknown> {
  type: K;
  tick: number;
  payload: P;
}

export type EventListener<E> = (event: E) => void;

export class EventQueue<E extends SimEvent> {
  private pending: E[] = [];
  private draining = false;
  private readonly listeners = new Map<string, Set<EventListener<E>>>();

  get size(): number {
    return this.pending.length;
  }

  push(event: E): void {
    this.pending.push(event);
  }

  on(type: E['type'], listener: EventListener<E>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  /**
   * Drains every queued event. Events pushed by listeners land in the next drain, not this
   * one — re-entrant draining would let one effect starve the frame.
   */
  drain(handler?: EventListener<E>): number {
    if (this.draining) throw new Error('EventQueue.drain: already draining');
    this.draining = true;
    const batch = this.pending;
    this.pending = [];
    try {
      for (const event of batch) {
        handler?.(event);
        const set = this.listeners.get(event.type);
        if (set) for (const listener of set) listener(event);
      }
    } finally {
      this.draining = false;
    }
    return batch.length;
  }

  clear(): void {
    this.pending.length = 0;
  }
}
