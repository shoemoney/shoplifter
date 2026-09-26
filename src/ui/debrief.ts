import type { MissionGrade, MissionOutcome } from '@/sim/systems/scoring.js';
import type { Civilian } from '@/sim/systems/civilians.js';

/**
 * The debrief. The PRD's instruction is unambiguous: show every civilian outcome, and do not
 * celebrate the kill count. Threats neutralised appears as a neutral statistic at the bottom,
 * never as an achievement — the screen is about who came home.
 */
export type CivilianFate = 'rescued' | 'dead' | 'stranded';

export interface CivilianRow {
  id: number;
  name: string;
  fate: CivilianFate;
  wounded: boolean;
}

export interface DebriefTip {
  /** The category the tip addresses, so the UI can place it next to that line. */
  category: 'civilians' | 'objectives' | 'safety' | 'time' | 'restraint';
  message: string;
}

export interface DebriefModel {
  missionName: string;
  grade: MissionGrade;
  civilians: CivilianRow[];
  counts: { rescued: number; dead: number; stranded: number; total: number };
  flightTimeSeconds: number;
  aircraftDamage: number;
  collateralIncidents: number;
  /** Neutral statistic, deliberately unglamorous and last. */
  threatsNeutralised: number;
  tips: DebriefTip[];
}

export const fateOf = (civilian: Civilian): CivilianFate => {
  if (civilian.state === 'rescued') return 'rescued';
  if (civilian.state === 'dead') return 'dead';
  return 'stranded';
};

/**
 * Turns a weak category into one concrete, actionable sentence. Generic encouragement teaches
 * nothing; each tip names the thing that cost points and what to do instead.
 */
export const buildTips = (outcome: MissionOutcome, grade: MissionGrade): DebriefTip[] => {
  const tips: DebriefTip[] = [];

  if (outcome.civilians.dead > 0) {
    tips.push({
      category: 'civilians',
      message:
        outcome.restraint.civiliansHitByPlayer > 0
          ? `${outcome.restraint.civiliansHitByPlayer} civilian${outcome.restraint.civiliansHitByPlayer === 1 ? '' : 's'} died to your own fire. Yaw to the foreground plane before engaging targets near a crowd.`
          : `${outcome.civilians.dead} civilian${outcome.civilians.dead === 1 ? '' : 's'} died. Suppress the nearest threat before releasing a group, rather than after.`,
    });
  }

  const stranded = outcome.civilians.total - outcome.civilians.rescued - outcome.civilians.dead;
  if (stranded > 0) {
    tips.push({
      category: 'civilians',
      message: `${stranded} civilian${stranded === 1 ? ' was' : 's were'} left behind. The aircraft holds eight; plan the return trip before the last seat fills.`,
    });
  }

  if (outcome.objectives.primaryComplete < outcome.objectives.primaryTotal) {
    tips.push({
      category: 'objectives',
      message:
        'A primary objective went unfinished. Primary objectives are worth four times a secondary.',
    });
  }

  if (outcome.safety.crashLandings > 0) {
    tips.push({
      category: 'safety',
      message: `${outcome.safety.crashLandings} crash landing${outcome.safety.crashLandings === 1 ? '' : 's'}. Bleed vertical speed below 3.2 m/s before the skids touch; the landing aid shows the projection.`,
    });
  } else if (outcome.safety.hardLandings > 2) {
    tips.push({
      category: 'safety',
      message:
        'Several hard landings. Level the aircraft before touchdown — pitch past 9 degrees digs a skid in even at a safe descent rate.',
    });
  }

  if (grade.breakdown.time < 5) {
    tips.push({
      category: 'time',
      message: 'Well over par time. A forward refuel pad is usually closer than the base.',
    });
  }

  if (outcome.restraint.threatsDestroyed > outcome.restraint.threatsSuppressed * 2) {
    tips.push({
      category: 'restraint',
      message:
        'Most threats were destroyed rather than suppressed. Sustained near misses pin infantry for several seconds, which is all a landing needs.',
    });
  }

  return tips;
};

export const buildDebrief = (args: {
  missionName: string;
  outcome: MissionOutcome;
  grade: MissionGrade;
  civilians: readonly Civilian[];
}): DebriefModel => {
  const rows: CivilianRow[] = args.civilians.map((civilian) => ({
    id: civilian.id,
    name: civilian.name,
    fate: fateOf(civilian),
    wounded: civilian.wounded,
  }));

  const counts = rows.reduce(
    (acc, row) => {
      acc[row.fate]++;
      return acc;
    },
    { rescued: 0, dead: 0, stranded: 0, total: rows.length },
  );

  return {
    missionName: args.missionName,
    grade: args.grade,
    civilians: rows,
    counts,
    flightTimeSeconds: args.outcome.elapsedSeconds,
    aircraftDamage: 1 - args.outcome.safety.hullRemaining,
    collateralIncidents:
      args.outcome.restraint.collateralStructures + args.outcome.restraint.civiliansHitByPlayer,
    threatsNeutralised:
      args.outcome.restraint.threatsDestroyed + args.outcome.restraint.threatsSuppressed,
    tips: buildTips(args.outcome, args.grade),
  };
};

export const formatDuration = (seconds: number): string => {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`;
};
