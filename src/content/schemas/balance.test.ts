import { describe, expect, it } from 'vitest';
import coreBalance from '../balance/core.json' with { type: 'json' };
import { parseBalance } from './balance.js';
import { BalanceStore, loadCoreBalance } from '../loaders/balanceLoader.js';

describe('balance schema', () => {
  it('accepts the shipped core balance', () => {
    const result = parseBalance(coreBalance);
    expect(result.ok).toBe(true);
  });

  it('pins the simulation to the PRD 120 Hz tick', () => {
    expect(loadCoreBalance().sim.tickHz).toBe(120);
  });

  it('reports a path and message per issue instead of throwing', () => {
    const result = parseBalance({ ...coreBalance, sim: { tickHz: -1, maxTicksPerFrame: 8 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe('sim.tickHz');
    expect(result.issues[0]?.message).toBeTruthy();
  });

  it('rejects a missing section', () => {
    const withoutCamera: Record<string, unknown> = { ...coreBalance };
    delete withoutCamera.camera;
    expect(parseBalance(withoutCamera).ok).toBe(false);
  });

  it('rejects an unversioned document', () => {
    expect(parseBalance({ ...coreBalance, schemaVersion: 2 }).ok).toBe(false);
  });

  it('rejects smoothing values outside the exclusive 0..1 range', () => {
    const broken = structuredClone(coreBalance);
    broken.camera.positionSmoothing = 1;
    expect(parseBalance(broken).ok).toBe(false);
  });
});

describe('BalanceStore', () => {
  it('notifies subscribers on a valid replacement', () => {
    const store = new BalanceStore();
    let seen = 0;
    store.subscribe((balance) => {
      seen = balance.sim.tickHz;
    });
    const next = structuredClone(coreBalance);
    next.sim.tickHz = 240;
    expect(store.replace(next)).toEqual([]);
    expect(seen).toBe(240);
    expect(store.value.sim.tickHz).toBe(240);
  });

  it('keeps the last good values when a hot-reloaded edit is invalid', () => {
    const store = new BalanceStore();
    const before = store.value.sim.tickHz;
    const issues = store.replace({ schemaVersion: 1 });
    expect(issues.length).toBeGreaterThan(0);
    expect(store.value.sim.tickHz).toBe(before);
  });
});
