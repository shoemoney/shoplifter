import { describe, expect, it } from 'vitest';
import {
  ObjectiveTracker,
  emptyProgress,
  goalProgress,
  type MissionProgress,
  type ObjectiveDefinition,
} from './objectives.js';

const definitions: readonly ObjectiveDefinition[] = [
  {
    id: 'rescue-18',
    kind: 'primary',
    label: 'Rescue 18 civilians',
    goal: { type: 'rescue', count: 18 },
  },
  {
    id: 'return-home',
    kind: 'primary',
    label: 'Return to base',
    goal: { type: 'reachZone', zoneId: 'home' },
    requires: ['rescue-18'],
  },
  {
    id: 'radar',
    kind: 'secondary',
    label: 'Destroy the radar mast',
    goal: { type: 'destroyTarget', targetId: 'radar-mast' },
  },
  {
    id: 'intel',
    kind: 'optional',
    label: 'Recover the intel case',
    goal: { type: 'collect', itemId: 'intel-case' },
    deadlineSeconds: 300,
  },
];

const progressWith = (overrides: Partial<MissionProgress> = {}): MissionProgress => ({
  ...emptyProgress(),
  ...overrides,
});

describe('goalProgress', () => {
  it('reports partial progress toward a rescue count', () => {
    expect(goalProgress({ type: 'rescue', count: 18 }, progressWith({ rescued: 9 }))).toBeCloseTo(
      0.5,
      6,
    );
  });

  it('never exceeds one when the player overachieves', () => {
    expect(goalProgress({ type: 'rescue', count: 18 }, progressWith({ rescued: 24 }))).toBe(1);
  });

  it('treats a zero-count goal as already met rather than dividing by zero', () => {
    expect(goalProgress({ type: 'rescue', count: 0 }, progressWith())).toBe(1);
  });

  it('is binary for zone, target and item goals', () => {
    const reached = progressWith({ zonesReached: new Set(['home']) });
    expect(goalProgress({ type: 'reachZone', zoneId: 'home' }, reached)).toBe(1);
    expect(goalProgress({ type: 'reachZone', zoneId: 'village' }, reached)).toBe(0);
  });
});

describe('ObjectiveTracker', () => {
  it('starts prerequisite-free objectives active and gated ones locked', () => {
    const tracker = new ObjectiveTracker(definitions);
    expect(tracker.state('rescue-18')?.status).toBe('active');
    expect(tracker.state('return-home')?.status).toBe('locked');
  });

  it('completes an objective and reports it once', () => {
    const tracker = new ObjectiveTracker(definitions);
    const events = tracker.update(progressWith({ rescued: 18 }));
    expect(events).toContainEqual({ type: 'objective:completed', id: 'rescue-18' });
    const again = tracker.update(progressWith({ rescued: 18 }));
    expect(again.some((e) => e.id === 'rescue-18')).toBe(false);
  });

  it('unlocks a gated objective only once its prerequisite is complete', () => {
    const tracker = new ObjectiveTracker(definitions);
    tracker.update(progressWith({ rescued: 4 }));
    expect(tracker.state('return-home')?.status).toBe('locked');

    const events = tracker.update(progressWith({ rescued: 18 }));
    expect(events).toContainEqual({ type: 'objective:activated', id: 'return-home' });
    expect(tracker.state('return-home')?.status).toBe('active');
  });

  it('fails an objective whose deadline passes', () => {
    const tracker = new ObjectiveTracker(definitions);
    const events = tracker.update(progressWith({ elapsedSeconds: 301 }));
    expect(events).toContainEqual({ type: 'objective:failed', id: 'intel', reason: 'deadline' });
    expect(tracker.state('intel')?.status).toBe('failed');
  });

  it('does not fail an objective already completed before its deadline', () => {
    const tracker = new ObjectiveTracker(definitions);
    tracker.update(progressWith({ itemsCollected: new Set(['intel-case']) }));
    const events = tracker.update(progressWith({ elapsedSeconds: 999 }));
    expect(events.some((e) => e.id === 'intel')).toBe(false);
    expect(tracker.state('intel')?.status).toBe('complete');
  });

  it('surfaces the active primary objective for the HUD', () => {
    const tracker = new ObjectiveTracker(definitions);
    expect(tracker.current()?.id).toBe('rescue-18');
    tracker.update(progressWith({ rescued: 18 }));
    expect(tracker.current()?.id).toBe('return-home');
  });

  it('counts completion by objective kind', () => {
    const tracker = new ObjectiveTracker(definitions);
    tracker.update(progressWith({ rescued: 18, targetsDestroyed: new Set(['radar-mast']) }));
    expect(tracker.countByKind('primary')).toEqual({ complete: 1, total: 2 });
    expect(tracker.countByKind('secondary')).toEqual({ complete: 1, total: 1 });
  });

  it('knows when every primary is complete, and when they are merely resolved', () => {
    const tracker = new ObjectiveTracker(definitions);
    expect(tracker.allPrimariesComplete()).toBe(false);
    expect(tracker.primariesResolved()).toBe(false);

    tracker.update(progressWith({ rescued: 18 }));
    tracker.update(progressWith({ rescued: 18, zonesReached: new Set(['home']) }));
    expect(tracker.allPrimariesComplete()).toBe(true);
    expect(tracker.primariesResolved()).toBe(true);
  });

  it('tracks progress for the HUD bar without completing early', () => {
    const tracker = new ObjectiveTracker(definitions);
    tracker.update(progressWith({ rescued: 6 }));
    expect(tracker.state('rescue-18')?.progress).toBeCloseTo(1 / 3, 6);
    expect(tracker.state('rescue-18')?.status).toBe('active');
  });
});
