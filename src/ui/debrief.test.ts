import { describe, expect, it } from 'vitest';
import { createCivilian } from '@/sim/systems/civilians.js';
import { gradeMission, type MissionOutcome } from '@/sim/systems/scoring.js';
import { buildDebrief, buildTips, fateOf, formatDuration } from './debrief.js';

const outcome = (overrides: Partial<MissionOutcome> = {}): MissionOutcome => ({
  civilians: { total: 24, rescued: 20, dead: 2 },
  objectives: { primaryComplete: 2, primaryTotal: 2, secondaryComplete: 0, secondaryTotal: 1 },
  safety: {
    hullRemaining: 0.6,
    passengersInjured: 0,
    aircraftLost: false,
    hardLandings: 1,
    crashLandings: 0,
  },
  restraint: {
    civiliansHitByPlayer: 0,
    collateralStructures: 1,
    threatsSuppressed: 3,
    threatsDestroyed: 2,
  },
  requiredRescues: 18,
  elapsedSeconds: 680,
  targetSeconds: 720,
  ...overrides,
});

describe('fateOf', () => {
  it('maps terminal states, and treats everyone else as stranded', () => {
    expect(fateOf(createCivilian({ id: 1, state: 'rescued' }))).toBe('rescued');
    expect(fateOf(createCivilian({ id: 2, state: 'dead' }))).toBe('dead');
    expect(fateOf(createCivilian({ id: 3, state: 'captive' }))).toBe('stranded');
    expect(fateOf(createCivilian({ id: 4, state: 'aboard' }))).toBe('stranded');
  });
});

describe('buildDebrief', () => {
  const civilians = [
    createCivilian({ id: 1, name: 'A', state: 'rescued' }),
    createCivilian({ id: 2, name: 'B', state: 'rescued', wounded: true }),
    createCivilian({ id: 3, name: 'C', state: 'dead' }),
    createCivilian({ id: 4, name: 'D', state: 'captive' }),
  ];

  it('lists every civilian by name and fate', () => {
    const model = buildDebrief({
      missionName: 'Operation Open Sky',
      outcome: outcome(),
      grade: gradeMission(outcome()),
      civilians,
    });
    expect(model.civilians).toHaveLength(4);
    expect(model.civilians[1]).toMatchObject({ name: 'B', fate: 'rescued', wounded: true });
    expect(model.counts).toEqual({ rescued: 2, dead: 1, stranded: 1, total: 4 });
  });

  it('reports threats neutralised as a plain statistic, not a score', () => {
    const model = buildDebrief({
      missionName: 'm',
      outcome: outcome(),
      grade: gradeMission(outcome()),
      civilians,
    });
    expect(model.threatsNeutralised).toBe(5);
    // Nothing in the model turns kills into points.
    expect(Object.keys(model)).not.toContain('killScore');
  });

  it('surfaces aircraft damage and collateral incidents', () => {
    const model = buildDebrief({
      missionName: 'm',
      outcome: outcome(),
      grade: gradeMission(outcome()),
      civilians,
    });
    expect(model.aircraftDamage).toBeCloseTo(0.4, 6);
    expect(model.collateralIncidents).toBe(1);
  });
});

describe('improvement tips', () => {
  it('names friendly fire specifically when it happened', () => {
    const data = outcome({
      civilians: { total: 24, rescued: 18, dead: 3 },
      restraint: {
        civiliansHitByPlayer: 2,
        collateralStructures: 0,
        threatsSuppressed: 1,
        threatsDestroyed: 1,
      },
    });
    const tips = buildTips(data, gradeMission(data));
    expect(tips.some((tip) => tip.message.includes('your own fire'))).toBe(true);
  });

  it('gives different advice when civilians died to the enemy', () => {
    const data = outcome({ civilians: { total: 24, rescued: 18, dead: 3 } });
    const tips = buildTips(data, gradeMission(data));
    expect(tips.some((tip) => tip.message.includes('Suppress the nearest threat'))).toBe(true);
  });

  it('counts the civilians left behind', () => {
    const data = outcome({ civilians: { total: 24, rescued: 18, dead: 0 } });
    const tips = buildTips(data, gradeMission(data));
    expect(tips.some((tip) => tip.message.includes('6 civilians were left behind'))).toBe(true);
  });

  it('calls out crash landings over hard ones', () => {
    const data = outcome({
      safety: {
        hullRemaining: 0.2,
        passengersInjured: 0,
        aircraftLost: false,
        hardLandings: 4,
        crashLandings: 2,
      },
    });
    const tips = buildTips(data, gradeMission(data));
    expect(tips.some((tip) => tip.message.includes('crash landings'))).toBe(true);
    expect(tips.some((tip) => tip.message.includes('Several hard landings'))).toBe(false);
  });

  it('nudges toward suppression when the player cleared the map', () => {
    const data = outcome({
      restraint: {
        civiliansHitByPlayer: 0,
        collateralStructures: 0,
        threatsSuppressed: 1,
        threatsDestroyed: 9,
      },
    });
    const tips = buildTips(data, gradeMission(data));
    expect(tips.some((tip) => tip.category === 'restraint')).toBe(true);
  });

  it('says nothing when there is nothing to improve', () => {
    const data = outcome({
      civilians: { total: 24, rescued: 24, dead: 0 },
      objectives: { primaryComplete: 2, primaryTotal: 2, secondaryComplete: 1, secondaryTotal: 1 },
      safety: {
        hullRemaining: 1,
        passengersInjured: 0,
        aircraftLost: false,
        hardLandings: 0,
        crashLandings: 0,
      },
      restraint: {
        civiliansHitByPlayer: 0,
        collateralStructures: 0,
        threatsSuppressed: 4,
        threatsDestroyed: 0,
      },
      elapsedSeconds: 500,
    });
    expect(buildTips(data, gradeMission(data))).toEqual([]);
  });
});

describe('formatDuration', () => {
  it('renders minutes and padded seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(680)).toBe('11:20');
  });

  it('never renders a negative clock', () => {
    expect(formatDuration(-5)).toBe('0:00');
  });
});
