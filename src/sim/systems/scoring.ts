import { clamp } from '@/core/math.js';

/**
 * Mission grading. The single most important rule, inherited straight from 1982: kills award
 * nothing. Dan Gorlin deliberately refused a seven-digit score because a finite population made
 * each death mean something, and a grade that quietly rewards destruction would undo that no
 * matter what the design document says.
 */
export const GRADE_WEIGHTS = {
  civilians: 0.55,
  objectives: 0.2,
  safety: 0.1,
  time: 0.1,
  restraint: 0.05,
} as const;

export type GradeCategory = keyof typeof GRADE_WEIGHTS;

export type Rank = 'S' | 'A' | 'B' | 'C' | 'D' | 'F';

export interface CivilianOutcome {
  total: number;
  rescued: number;
  dead: number;
}

export interface ObjectiveOutcome {
  primaryComplete: number;
  primaryTotal: number;
  secondaryComplete: number;
  secondaryTotal: number;
}

export interface SafetyOutcome {
  /** 0..1 hull remaining at mission end. */
  hullRemaining: number;
  /** Passengers hurt while aboard. */
  passengersInjured: number;
  /** True when the aircraft was destroyed and not recovered. */
  aircraftLost: boolean;
  hardLandings: number;
  crashLandings: number;
}

export interface RestraintOutcome {
  /** Civilians hit by the player's own fire. The heaviest restraint penalty. */
  civiliansHitByPlayer: number;
  /** Non-threatening structures the player destroyed. */
  collateralStructures: number;
  /** Threats neutralised by suppression instead of killing. Earns the restraint bonus. */
  threatsSuppressed: number;
  threatsDestroyed: number;
}

export interface MissionOutcome {
  civilians: CivilianOutcome;
  objectives: ObjectiveOutcome;
  safety: SafetyOutcome;
  restraint: RestraintOutcome;
  /** Rescues needed for the mission to count as completed at all. */
  requiredRescues: number;
  elapsedSeconds: number;
  /** Par time. Finishing faster than this earns full time credit. */
  targetSeconds: number;
}

export interface GradeTuning {
  /** Points removed per civilian death, on top of the rescue credit they take with them. */
  deathPenaltyPoints: number;
  /** Points removed per civilian hit by the player's own fire. */
  friendlyFirePenaltyPoints: number;
  /** Beyond this multiple of par time, the time score is zero. */
  timeOvershootLimit: number;
  hardLandingPenalty: number;
  crashLandingPenalty: number;
}

export const defaultGradeTuning = (): GradeTuning => ({
  deathPenaltyPoints: 2.5,
  friendlyFirePenaltyPoints: 4,
  timeOvershootLimit: 2,
  hardLandingPenalty: 0.08,
  crashLandingPenalty: 0.25,
});

export const RANK_THRESHOLDS: ReadonlyArray<{ rank: Rank; min: number }> = [
  { rank: 'S', min: 92 },
  { rank: 'A', min: 82 },
  { rank: 'B', min: 70 },
  { rank: 'C', min: 55 },
  { rank: 'D', min: 0 },
];

export const rankFor = (score: number): Rank => {
  for (const threshold of RANK_THRESHOLDS) {
    if (score >= threshold.min) return threshold.rank;
  }
  return 'D';
};

const ratio = (part: number, whole: number): number => (whole <= 0 ? 1 : clamp(part / whole, 0, 1));

/** Secondary objectives count, but they cannot substitute for the primary ones. */
export const objectiveScore = (outcome: ObjectiveOutcome): number => {
  const primary = ratio(outcome.primaryComplete, outcome.primaryTotal);
  const secondary = ratio(outcome.secondaryComplete, outcome.secondaryTotal);
  return primary * 0.8 + secondary * 0.2;
};

export const safetyScore = (outcome: SafetyOutcome, tuning: GradeTuning): number => {
  if (outcome.aircraftLost) return 0;
  const injuries = outcome.passengersInjured * 0.12;
  const landings =
    outcome.hardLandings * tuning.hardLandingPenalty +
    outcome.crashLandings * tuning.crashLandingPenalty;
  return clamp(outcome.hullRemaining - injuries - landings, 0, 1);
};

/**
 * Full credit at or under par, falling to zero at `timeOvershootLimit` times par. Time is only
 * 10% of the grade and is deliberately unable to buy back a death.
 */
export const timeScore = (
  elapsedSeconds: number,
  targetSeconds: number,
  tuning: GradeTuning,
): number => {
  if (targetSeconds <= 0) return 1;
  if (elapsedSeconds <= targetSeconds) return 1;
  const overshoot =
    (elapsedSeconds - targetSeconds) / (targetSeconds * (tuning.timeOvershootLimit - 1));
  return clamp(1 - overshoot, 0, 1);
};

/**
 * Restraint rewards solving a threat without killing it. Suppression creating a landing window
 * is the intended play; clearing the map is not rewarded, only tolerated.
 */
export const restraintScore = (outcome: RestraintOutcome): number => {
  const handled = outcome.threatsSuppressed + outcome.threatsDestroyed;
  const suppression = handled === 0 ? 1 : outcome.threatsSuppressed / handled;
  const collateral = clamp(outcome.collateralStructures * 0.15, 0, 1);
  return clamp(suppression - collateral, 0, 1);
};

export interface GradeBreakdown {
  civilians: number;
  objectives: number;
  safety: number;
  time: number;
  restraint: number;
}

export interface MissionGrade {
  /** 0..100 after penalties. */
  score: number;
  rank: Rank;
  /** Weighted points contributed by each category, before penalties. */
  breakdown: GradeBreakdown;
  /** Points removed, itemised so the debrief can explain the number. */
  penalties: { deaths: number; friendlyFire: number };
  failed: boolean;
  failureReason: 'extraction-threshold' | 'aircraft-lost' | null;
}

/**
 * Grades a finished mission. Failure is a separate axis from the score: an aircraft lost or the
 * extraction threshold missed fails the mission outright, and the score still gets computed so
 * the debrief can show the player what they did manage.
 */
export const gradeMission = (
  outcome: MissionOutcome,
  tuning: GradeTuning = defaultGradeTuning(),
): MissionGrade => {
  const civilians = ratio(outcome.civilians.rescued, outcome.civilians.total);
  const objectives = objectiveScore(outcome.objectives);
  const safety = safetyScore(outcome.safety, tuning);
  const time = timeScore(outcome.elapsedSeconds, outcome.targetSeconds, tuning);
  const restraint = restraintScore(outcome.restraint);

  const breakdown: GradeBreakdown = {
    civilians: civilians * GRADE_WEIGHTS.civilians * 100,
    objectives: objectives * GRADE_WEIGHTS.objectives * 100,
    safety: safety * GRADE_WEIGHTS.safety * 100,
    time: time * GRADE_WEIGHTS.time * 100,
    restraint: restraint * GRADE_WEIGHTS.restraint * 100,
  };

  const penalties = {
    deaths: outcome.civilians.dead * tuning.deathPenaltyPoints,
    friendlyFire: outcome.restraint.civiliansHitByPlayer * tuning.friendlyFirePenaltyPoints,
  };

  const raw =
    breakdown.civilians +
    breakdown.objectives +
    breakdown.safety +
    breakdown.time +
    breakdown.restraint;
  const score = clamp(raw - penalties.deaths - penalties.friendlyFire, 0, 100);

  const failureReason: MissionGrade['failureReason'] = outcome.safety.aircraftLost
    ? 'aircraft-lost'
    : outcome.civilians.rescued < outcome.requiredRescues
      ? 'extraction-threshold'
      : null;

  return {
    score,
    rank: failureReason ? 'F' : rankFor(score),
    breakdown,
    penalties,
    failed: failureReason !== null,
    failureReason,
  };
};
