import { describe, expect, it } from 'vitest';
import {
  GRADE_WEIGHTS,
  defaultGradeTuning,
  gradeMission,
  objectiveScore,
  rankFor,
  restraintScore,
  safetyScore,
  timeScore,
  type MissionOutcome,
} from './scoring.js';

const tuning = defaultGradeTuning();

const perfect = (): MissionOutcome => ({
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
  requiredRescues: 18,
  elapsedSeconds: 600,
  targetSeconds: 720,
});

describe('grade weights', () => {
  it('sums to one, with civilians carrying the majority', () => {
    const total = Object.values(GRADE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(GRADE_WEIGHTS.civilians).toBe(0.55);
  });
});

describe('rankFor', () => {
  it('matches the PRD thresholds', () => {
    expect(rankFor(100)).toBe('S');
    expect(rankFor(92)).toBe('S');
    expect(rankFor(91)).toBe('A');
    expect(rankFor(82)).toBe('A');
    expect(rankFor(81)).toBe('B');
    expect(rankFor(70)).toBe('B');
    expect(rankFor(69)).toBe('C');
    expect(rankFor(55)).toBe('C');
    expect(rankFor(54)).toBe('D');
    expect(rankFor(0)).toBe('D');
  });
});

describe('category scores', () => {
  it('weights primary objectives above secondary ones', () => {
    const primaryOnly = objectiveScore({
      primaryComplete: 2,
      primaryTotal: 2,
      secondaryComplete: 0,
      secondaryTotal: 2,
    });
    const secondaryOnly = objectiveScore({
      primaryComplete: 0,
      primaryTotal: 2,
      secondaryComplete: 2,
      secondaryTotal: 2,
    });
    expect(primaryOnly).toBeGreaterThan(secondaryOnly);
    expect(primaryOnly).toBeCloseTo(0.8, 6);
  });

  it('treats a mission with no secondary objectives as full secondary credit', () => {
    expect(
      objectiveScore({
        primaryComplete: 1,
        primaryTotal: 1,
        secondaryComplete: 0,
        secondaryTotal: 0,
      }),
    ).toBeCloseTo(1, 6);
  });

  it('zeroes safety when the aircraft is lost, whatever else happened', () => {
    expect(
      safetyScore(
        {
          hullRemaining: 1,
          passengersInjured: 0,
          aircraftLost: true,
          hardLandings: 0,
          crashLandings: 0,
        },
        tuning,
      ),
    ).toBe(0);
  });

  it('docks safety for injured passengers and bad landings', () => {
    const clean = safetyScore(
      {
        hullRemaining: 1,
        passengersInjured: 0,
        aircraftLost: false,
        hardLandings: 0,
        crashLandings: 0,
      },
      tuning,
    );
    const rough = safetyScore(
      {
        hullRemaining: 1,
        passengersInjured: 2,
        aircraftLost: false,
        hardLandings: 3,
        crashLandings: 1,
      },
      tuning,
    );
    expect(clean).toBe(1);
    expect(rough).toBeLessThan(clean);
    expect(rough).toBeGreaterThanOrEqual(0);
  });

  it('gives full time credit at or under par and zero past the overshoot limit', () => {
    expect(timeScore(500, 600, tuning)).toBe(1);
    expect(timeScore(600, 600, tuning)).toBe(1);
    expect(timeScore(900, 600, tuning)).toBeCloseTo(0.5, 6);
    expect(timeScore(1200, 600, tuning)).toBe(0);
    expect(timeScore(5000, 600, tuning)).toBe(0);
  });

  it('rewards suppression over destruction', () => {
    const suppressed = restraintScore({
      civiliansHitByPlayer: 0,
      collateralStructures: 0,
      threatsSuppressed: 4,
      threatsDestroyed: 0,
    });
    const slaughter = restraintScore({
      civiliansHitByPlayer: 0,
      collateralStructures: 0,
      threatsSuppressed: 0,
      threatsDestroyed: 4,
    });
    expect(suppressed).toBe(1);
    expect(slaughter).toBe(0);
  });

  it('treats a mission where nothing was engaged as fully restrained', () => {
    expect(
      restraintScore({
        civiliansHitByPlayer: 0,
        collateralStructures: 0,
        threatsSuppressed: 0,
        threatsDestroyed: 0,
      }),
    ).toBe(1);
  });
});

describe('gradeMission', () => {
  it('awards S for a flawless run', () => {
    const grade = gradeMission(perfect());
    expect(grade.score).toBeGreaterThanOrEqual(92);
    expect(grade.rank).toBe('S');
    expect(grade.failed).toBe(false);
  });

  it('never awards points for kills', () => {
    const peaceful = gradeMission(perfect());
    const violent = gradeMission({
      ...perfect(),
      restraint: {
        civiliansHitByPlayer: 0,
        collateralStructures: 0,
        threatsSuppressed: 0,
        threatsDestroyed: 40,
      },
    });
    // Forty kills scores strictly worse than none, and can never score better.
    expect(violent.score).toBeLessThan(peaceful.score);
  });

  it('makes civilian deaths impossible to outrun', () => {
    const outcome = perfect();
    outcome.civilians = { total: 24, rescued: 18, dead: 6 };
    // Finishing in record time must not buy the dead back.
    const fast = gradeMission({ ...outcome, elapsedSeconds: 1 });
    const slow = gradeMission({ ...outcome, elapsedSeconds: 720 });
    expect(fast.score).toBe(slow.score);
    expect(fast.rank).not.toBe('S');
  });

  it('itemises its penalties so a debrief can explain the number', () => {
    const grade = gradeMission({
      ...perfect(),
      civilians: { total: 24, rescued: 20, dead: 4 },
      restraint: {
        civiliansHitByPlayer: 2,
        collateralStructures: 0,
        threatsSuppressed: 1,
        threatsDestroyed: 0,
      },
    });
    expect(grade.penalties.deaths).toBeCloseTo(10, 6);
    expect(grade.penalties.friendlyFire).toBeCloseTo(8, 6);
  });

  it('fails the mission when the extraction threshold is missed', () => {
    const grade = gradeMission({
      ...perfect(),
      civilians: { total: 24, rescued: 10, dead: 2 },
    });
    expect(grade.failed).toBe(true);
    expect(grade.failureReason).toBe('extraction-threshold');
    expect(grade.rank).toBe('F');
  });

  it('fails the mission when the aircraft is lost, even with everyone rescued', () => {
    const outcome = perfect();
    outcome.safety.aircraftLost = true;
    const grade = gradeMission(outcome);
    expect(grade.failed).toBe(true);
    expect(grade.failureReason).toBe('aircraft-lost');
  });

  it('still computes a score for a failed mission, so the debrief has something to show', () => {
    const grade = gradeMission({ ...perfect(), civilians: { total: 24, rescued: 4, dead: 0 } });
    expect(grade.failed).toBe(true);
    expect(grade.score).toBeGreaterThan(0);
    expect(grade.breakdown.objectives).toBeGreaterThan(0);
  });

  it('clamps to the 0..100 band under extreme penalties', () => {
    const grade = gradeMission({
      ...perfect(),
      civilians: { total: 24, rescued: 0, dead: 24 },
      restraint: {
        civiliansHitByPlayer: 24,
        collateralStructures: 50,
        threatsSuppressed: 0,
        threatsDestroyed: 30,
      },
    });
    expect(grade.score).toBe(0);
    expect(grade.score).toBeGreaterThanOrEqual(0);
  });

  it('handles a mission with no civilians without dividing by zero', () => {
    const grade = gradeMission({
      ...perfect(),
      civilians: { total: 0, rescued: 0, dead: 0 },
      requiredRescues: 0,
    });
    expect(Number.isFinite(grade.score)).toBe(true);
    expect(grade.failed).toBe(false);
  });
});
