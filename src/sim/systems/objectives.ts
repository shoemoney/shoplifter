import type { EntityId } from '../components.js';

/**
 * Mission objectives and phase state. Objectives are authored content referenced by stable
 * string IDs — runtime code must never contain mission-specific placements, so everything here
 * is driven by data the level loader supplies.
 */
export type ObjectiveKind = 'primary' | 'secondary' | 'optional';

export type ObjectiveStatus = 'locked' | 'active' | 'complete' | 'failed';

export type ObjectiveGoal =
  | { type: 'rescue'; count: number }
  | { type: 'reachZone'; zoneId: string }
  | { type: 'destroyTarget'; targetId: string }
  | { type: 'protect'; entityId: EntityId; untilTick: number }
  | { type: 'unload'; count: number }
  | { type: 'collect'; itemId: string };

export interface ObjectiveDefinition {
  id: string;
  kind: ObjectiveKind;
  /** Shown in the HUD's top-centre objective line. */
  label: string;
  goal: ObjectiveGoal;
  /** Objectives that must be complete before this one activates. */
  requires?: readonly string[];
  /** Optional deadline in simulated seconds from mission start. */
  deadlineSeconds?: number;
}

export interface ObjectiveState {
  id: string;
  status: ObjectiveStatus;
  /** 0..1 for the HUD's extraction progress bar. */
  progress: number;
}

export type MissionPhase = 'briefing' | 'active' | 'debrief';

export interface MissionProgress {
  rescued: number;
  unloaded: number;
  zonesReached: ReadonlySet<string>;
  targetsDestroyed: ReadonlySet<string>;
  itemsCollected: ReadonlySet<string>;
  elapsedSeconds: number;
}

export const emptyProgress = (): MissionProgress => ({
  rescued: 0,
  unloaded: 0,
  zonesReached: new Set<string>(),
  targetsDestroyed: new Set<string>(),
  itemsCollected: new Set<string>(),
  elapsedSeconds: 0,
});

/** How far along a goal is, 0..1. Used for both completion and the HUD progress bar. */
export const goalProgress = (goal: ObjectiveGoal, progress: MissionProgress): number => {
  switch (goal.type) {
    case 'rescue':
      return goal.count <= 0 ? 1 : Math.min(1, progress.rescued / goal.count);
    case 'unload':
      return goal.count <= 0 ? 1 : Math.min(1, progress.unloaded / goal.count);
    case 'reachZone':
      return progress.zonesReached.has(goal.zoneId) ? 1 : 0;
    case 'destroyTarget':
      return progress.targetsDestroyed.has(goal.targetId) ? 1 : 0;
    case 'collect':
      return progress.itemsCollected.has(goal.itemId) ? 1 : 0;
    case 'protect':
      // Protection is measured by surviving to the deadline, so it reads as partial until then.
      return Math.min(1, progress.elapsedSeconds > 0 ? 1 : 0);
    default:
      return 0;
  }
};

export type ObjectiveEvent =
  | { type: 'objective:activated'; id: string }
  | { type: 'objective:completed'; id: string }
  | { type: 'objective:failed'; id: string; reason: 'deadline' | 'target-lost' };

/**
 * Tracks the authored objective list against live mission progress. Pure with respect to the
 * world: it reads a progress snapshot and reports what changed, so the same logic drives the
 * live HUD and a replayed debrief.
 */
export class ObjectiveTracker {
  private readonly definitions: readonly ObjectiveDefinition[];
  private readonly states = new Map<string, ObjectiveState>();

  constructor(definitions: readonly ObjectiveDefinition[]) {
    this.definitions = definitions;
    for (const definition of definitions) {
      this.states.set(definition.id, {
        id: definition.id,
        // Anything with prerequisites starts locked; everything else is live from the briefing.
        status: definition.requires && definition.requires.length > 0 ? 'locked' : 'active',
        progress: 0,
      });
    }
  }

  get all(): readonly ObjectiveState[] {
    return [...this.states.values()];
  }

  state(id: string): ObjectiveState | undefined {
    return this.states.get(id);
  }

  /** The objective the HUD should be showing: the first active primary, else the first active. */
  current(): ObjectiveState | undefined {
    for (const definition of this.definitions) {
      const state = this.states.get(definition.id);
      if (state?.status === 'active' && definition.kind === 'primary') return state;
    }
    return this.all.find((state) => state.status === 'active');
  }

  countByKind(kind: ObjectiveKind): { complete: number; total: number } {
    let complete = 0;
    let total = 0;
    for (const definition of this.definitions) {
      if (definition.kind !== kind) continue;
      total++;
      if (this.states.get(definition.id)?.status === 'complete') complete++;
    }
    return { complete, total };
  }

  private prerequisitesMet(definition: ObjectiveDefinition): boolean {
    if (!definition.requires) return true;
    return definition.requires.every((id) => this.states.get(id)?.status === 'complete');
  }

  /** Advances every objective against the current progress and returns what changed. */
  update(progress: MissionProgress): ObjectiveEvent[] {
    const events: ObjectiveEvent[] = [];

    for (const definition of this.definitions) {
      const state = this.states.get(definition.id);
      if (!state || state.status === 'complete' || state.status === 'failed') continue;

      if (state.status === 'locked') {
        if (!this.prerequisitesMet(definition)) continue;
        state.status = 'active';
        events.push({ type: 'objective:activated', id: definition.id });
      }

      state.progress = goalProgress(definition.goal, progress);

      if (state.progress >= 1) {
        state.status = 'complete';
        events.push({ type: 'objective:completed', id: definition.id });
        continue;
      }

      if (
        definition.deadlineSeconds !== undefined &&
        progress.elapsedSeconds > definition.deadlineSeconds
      ) {
        state.status = 'failed';
        events.push({ type: 'objective:failed', id: definition.id, reason: 'deadline' });
      }
    }

    return events;
  }

  /** True once every primary objective is resolved one way or the other. */
  primariesResolved(): boolean {
    return this.definitions
      .filter((definition) => definition.kind === 'primary')
      .every((definition) => {
        const status = this.states.get(definition.id)?.status;
        return status === 'complete' || status === 'failed';
      });
  }

  allPrimariesComplete(): boolean {
    const { complete, total } = this.countByKind('primary');
    return total > 0 && complete === total;
  }
}
