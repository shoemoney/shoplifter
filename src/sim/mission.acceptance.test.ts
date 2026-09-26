import { describe, expect, it } from 'vitest';
import { loadFlightBalance } from '@/content/loaders/balanceLoader.js';
import { loadMission, OPEN_SKY_ID } from '@/content/missions/index.js';
import { Autopilot, type FlightPlanStep } from '@/debug/autopilot.js';
import { gradeMission } from './systems/scoring.js';
import { tally } from './systems/civilians.js';
import { MissionWorld } from './mission.js';

/**
 * The PRD's gameplay acceptance tests, flown end to end with synthetic input. If the vertical
 * slice is not completable by a scripted pilot, it is not completable — this is the test that
 * catches a mission which looks right in the data and cannot actually be finished.
 */
const mission = loadMission(OPEN_SKY_ID);
const flight = loadFlightBalance();
const DT = 1 / 120;
const HOME_X = 200;
const CRUISE = 70;

const trip = (
  siteX: number,
  options: { interact?: boolean; board?: number } = {},
): FlightPlanStep[] => [
  { x: siteX, altitude: CRUISE },
  {
    x: siteX,
    altitude: 0,
    land: true,
    holdSeconds: options.board ?? 28,
    ...(options.interact ? { interact: true } : {}),
  },
  { x: siteX, altitude: CRUISE },
  { x: HOME_X, altitude: CRUISE },
  { x: HOME_X, altitude: 0, land: true, holdSeconds: 12 },
];

/**
 * One trip per site. Eight seats against 24 civilians, with wounded taking two, means three
 * trips carry at most 8 + 7 + 6 = 21 — comfortably over the mission's 18-rescue quota, and the
 * reason that quota is 18 rather than 24.
 */
const fullCampaignPlan: FlightPlanStep[] = [
  ...trip(1420),
  ...trip(4160, { interact: true }),
  ...trip(5280),
];

interface Run {
  world: MissionWorld;
  seconds: number;
  finished: boolean;
}

const flyMission = (seed: number): Run => {
  const world = new MissionWorld({ mission, flight, dt: DT, seed });
  const pilot = new Autopilot(fullCampaignPlan);
  const budgetTicks = Math.round(1500 / DT); // 25 simulated minutes of budget
  let ticks = 0;
  while (ticks < budgetTicks && !pilot.finished && world.phase === 'active') {
    world.step(pilot.update(world));
    ticks++;
  }
  return { world, seconds: ticks * DT, finished: pilot.finished };
};

describe('Operation Open Sky, flown end to end', () => {
  const run = flyMission(11);

  it('completes the mission without losing the aircraft', () => {
    // The mission can end before the plan does — finishing the objectives is the point, and
    // the last leg home is often still queued when the primaries complete.
    const done = run.world.phase === 'complete' || run.finished;
    expect(done, `run ended as "${run.world.phase}" after ${run.seconds.toFixed(0)}s`).toBe(true);
    expect(run.world.player.destroyedFor).toBeNull();
  });

  it('reaches the completed phase rather than failing', () => {
    expect(run.world.phase).toBe('complete');
  });

  it('meets the 18-rescue extraction threshold', () => {
    const counts = tally(run.world.civilians);
    expect(counts.rescued).toBeGreaterThanOrEqual(mission.requiredRescues);
  });

  it('finishes inside the PRD 20-minute blind-tester budget', () => {
    expect(run.seconds).toBeLessThan(20 * 60);
  });

  it('grades as a completed mission rather than a failure', () => {
    const grade = gradeMission(run.world.outcome());
    expect(grade.failed).toBe(false);
    expect(grade.rank).not.toBe('F');
    expect(grade.score).toBeGreaterThan(0);
  });

  it('is completable without killing a single enemy', () => {
    // The PRD is explicit that no mission is a shooting gallery. This pilot never fires a shot.
    expect(run.world.stats.threatsDestroyed).toBe(0);
    expect(tally(run.world.civilians).rescued).toBeGreaterThanOrEqual(mission.requiredRescues);
  });

  it('escalates the director across repeated unloads', () => {
    expect(run.world.stats.unloads).toBeGreaterThanOrEqual(3);
  });

  it('completes every primary objective', () => {
    expect(run.world.objectives.allPrimariesComplete()).toBe(true);
  });

  it('reaches every authored civilian site', () => {
    const untouched = run.world.civilians.filter((civilian) => civilian.state === 'captive');
    expect(untouched).toHaveLength(0);
  });

  it('accounts for all 24 civilians, one way or another', () => {
    const counts = tally(run.world.civilians);
    expect(counts.rescued + counts.dead + counts.awaiting + counts.aboard).toBe(24);
  });

  it('produces the same result on a replay of the same seed', () => {
    const replay = flyMission(11);
    expect(replay.world.hash()).toBe(run.world.hash());
    expect(replay.seconds).toBe(run.seconds);
  });
});
