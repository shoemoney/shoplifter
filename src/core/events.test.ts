import { describe, expect, it, vi } from 'vitest';
import { EventQueue, type SimEvent } from './events.js';

type TestEvent = SimEvent<'hit' | 'rescue', { id: number }>;

const event = (type: TestEvent['type'], id: number, tick = 0): TestEvent => ({
  type,
  tick,
  payload: { id },
});

describe('EventQueue', () => {
  it('delivers to type listeners and the catch-all handler', () => {
    const queue = new EventQueue<TestEvent>();
    const hits: number[] = [];
    const all: string[] = [];
    queue.on('hit', (e) => hits.push(e.payload.id));
    queue.push(event('hit', 1));
    queue.push(event('rescue', 2));

    expect(queue.drain((e) => all.push(e.type))).toBe(2);
    expect(hits).toEqual([1]);
    expect(all).toEqual(['hit', 'rescue']);
    expect(queue.size).toBe(0);
  });

  it('defers events pushed during a drain to the next drain', () => {
    const queue = new EventQueue<TestEvent>();
    const seen: number[] = [];
    queue.on('hit', (e) => {
      seen.push(e.payload.id);
      if (e.payload.id === 1) queue.push(event('hit', 2));
    });

    queue.drain();
    queue.push(event('hit', 1));
    expect(queue.drain()).toBe(1);
    expect(seen).toEqual([1]);
    expect(queue.size).toBe(1);
    expect(queue.drain()).toBe(1);
    expect(seen).toEqual([1, 2]);
  });

  it('unsubscribes cleanly', () => {
    const queue = new EventQueue<TestEvent>();
    const listener = vi.fn();
    const off = queue.on('hit', listener);
    off();
    queue.push(event('hit', 1));
    queue.drain();
    expect(listener).not.toHaveBeenCalled();
  });

  it('refuses re-entrant draining', () => {
    const queue = new EventQueue<TestEvent>();
    queue.on('hit', () => queue.drain());
    queue.push(event('hit', 1));
    expect(() => queue.drain()).toThrow(/already draining/);
  });

  it('clears without dispatching', () => {
    const queue = new EventQueue<TestEvent>();
    const listener = vi.fn();
    queue.on('hit', listener);
    queue.push(event('hit', 1));
    queue.clear();
    expect(queue.drain()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });
});
