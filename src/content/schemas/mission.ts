import { z } from 'zod';

/**
 * Mission content. The PRD is emphatic that runtime code must contain no mission-specific
 * entity placements — everything below is authored data referenced by stable string IDs, and
 * the loader is the only thing that turns it into simulation state.
 *
 * Validated with zod rather than raw JSON Schema (see DECISIONS M0-1) so the parsed type and
 * the validator come from one declaration and cannot drift apart.
 */

const id = z
  .string()
  .min(1)
  .regex(/^[a-z0-9_-]+$/i, 'ids are alphanumeric with - or _');

export const vec2Schema = z.object({ x: z.number(), y: z.number() });

/** Terrain is authored as segments and compiled into a sampled heightfield at load time. */
export const terrainSegmentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('flat'),
    startX: z.number().min(0),
    endX: z.number().min(0),
    height: z.number(),
  }),
  z.object({
    type: z.literal('ramp'),
    startX: z.number().min(0),
    endX: z.number().min(0),
    height: z.number(),
    endHeight: z.number(),
  }),
  z.object({
    type: z.literal('hills'),
    startX: z.number().min(0),
    endX: z.number().min(0),
    height: z.number(),
    amplitude: z.number().min(0),
    /** Cycles per metre. Two incommensurate waves are layered so hills do not visibly repeat. */
    frequency: z.number().gt(0),
  }),
]);

export const landingZoneSchema = z.object({
  id,
  label: z.string().min(1),
  x: z.number().min(0),
  width: z.number().positive(),
  kind: z.enum(['base', 'forward', 'field']),
  services: z.array(z.enum(['refuel', 'rearm', 'repair', 'unload'])).default([]),
});

export const civilianGroupSchema = z.object({
  id,
  /** Human-readable site name for the HUD and debrief. */
  site: z.string().min(1),
  x: z.number().min(0),
  count: z.number().int().min(1).max(32),
  /** How many of the group start wounded — they take two seats and board slowly. */
  wounded: z.number().int().min(0).default(0),
  release: z.enum(['immediate', 'proximity', 'objective']).default('proximity'),
  /** Lane the group walks along, metres above local ground. */
  laneOffset: z.number().default(0),
  /** Spread of the group around `x`, metres. */
  spread: z.number().min(0).default(12),
});

export const enemySocketSchema = z.object({
  id,
  kind: z.enum(['rifleInfantry', 'rpgInfantry', 'lightTank', 'aaGun', 'jet', 'drone']),
  x: z.number(),
  side: z.enum(['ground', 'air']),
  /** Earliest escalation tier this socket may be used at. */
  minTier: z.number().int().min(0).max(4).default(0),
  /** Threat-point cost charged against the director budget. */
  cost: z.number().min(0).default(1),
});

export const directorPhaseSchema = z.object({
  id,
  tier: z.number().int().min(0).max(4),
  /** What advances the director into this phase. */
  trigger: z.discriminatedUnion('type', [
    z.object({ type: z.literal('missionStart') }),
    z.object({ type: z.literal('unloadCount'), count: z.number().int().min(1) }),
    z.object({ type: z.literal('objective'), objectiveId: id }),
    z.object({ type: z.literal('reachX'), x: z.number() }),
  ]),
  threatPoints: z.number().min(0),
  maxConcurrentAir: z.number().int().min(0),
  maxConcurrentGround: z.number().int().min(0),
  reinforcementCooldown: z.number().min(0),
  /** Tier 4 is an authored climax; a finite wave budget is what stops it spawning forever. */
  maxWaves: z.number().int().min(1).optional(),
});

export const objectiveGoalSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rescue'), count: z.number().int().min(1) }),
  z.object({ type: z.literal('unload'), count: z.number().int().min(1) }),
  z.object({ type: z.literal('reachZone'), zoneId: id }),
  z.object({ type: z.literal('destroyTarget'), targetId: id }),
  z.object({ type: z.literal('collect'), itemId: id }),
]);

export const objectiveSchema = z.object({
  id,
  kind: z.enum(['primary', 'secondary', 'optional']),
  label: z.string().min(1),
  goal: objectiveGoalSchema,
  requires: z.array(id).default([]),
  deadlineSeconds: z.number().positive().optional(),
});

export const weatherVolumeSchema = z.object({
  id,
  startX: z.number(),
  endX: z.number(),
  /** Horizontal wind, m/s. Negative blows left. */
  wind: z.number().default(0),
  /** Vertical gust amplitude, m/s. Canyon downdrafts use this. */
  gust: z.number().min(0).default(0),
  visibility: z.number().min(0).max(1).default(1),
});

export const checkpointSchema = z.object({
  id,
  x: z.number().min(0),
  afterObjective: id.optional(),
});

export const missionSchema = z
  .object({
    id,
    version: z.literal(1),
    name: z.string().min(1),
    biome: z.enum(['salt_flats', 'jungle_river', 'alpine_border', 'flooded_megacity']),
    lengthMeters: z.number().positive(),
    altitudeCeiling: z.number().positive(),
    /** Par time for the time component of the grade, seconds. */
    targetSeconds: z.number().positive(),
    requiredRescues: z.number().int().min(0),
    playerSpawn: vec2Schema,
    terrainSegments: z.array(terrainSegmentSchema).min(1),
    landingZones: z.array(landingZoneSchema).min(1),
    civilianGroups: z.array(civilianGroupSchema).default([]),
    enemySockets: z.array(enemySocketSchema).default([]),
    directorPhases: z.array(directorPhaseSchema).min(1),
    objectives: z.array(objectiveSchema).min(1),
    weatherVolumes: z.array(weatherVolumeSchema).default([]),
    checkpoints: z.array(checkpointSchema).default([]),
  })
  .superRefine((mission, ctx) => {
    // Cross-field checks the shape alone cannot express. Each one has bitten a level editor
    // somewhere: a dangling id, a gap in the terrain, a rescue target nobody can reach.
    const zoneIds = new Set(mission.landingZones.map((zone) => zone.id));
    const objectiveIds = new Set(mission.objectives.map((objective) => objective.id));

    for (const objective of mission.objectives) {
      if (objective.goal.type === 'reachZone' && !zoneIds.has(objective.goal.zoneId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['objectives', objective.id, 'goal', 'zoneId'],
          message: `unknown landing zone "${objective.goal.zoneId}"`,
        });
      }
      for (const required of objective.requires) {
        if (!objectiveIds.has(required)) {
          ctx.addIssue({
            code: 'custom',
            path: ['objectives', objective.id, 'requires'],
            message: `unknown objective "${required}"`,
          });
        }
      }
    }

    for (const phase of mission.directorPhases) {
      if (phase.trigger.type === 'objective' && !objectiveIds.has(phase.trigger.objectiveId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['directorPhases', phase.id, 'trigger'],
          message: `unknown objective "${phase.trigger.objectiveId}"`,
        });
      }
    }

    const available = mission.civilianGroups.reduce((sum, group) => sum + group.count, 0);
    if (mission.requiredRescues > available) {
      ctx.addIssue({
        code: 'custom',
        path: ['requiredRescues'],
        message: `mission requires ${mission.requiredRescues} rescues but only places ${available} civilians`,
      });
    }

    const sorted = [...mission.terrainSegments].sort((a, b) => a.startX - b.startX);
    const first = sorted[0];
    if (first && first.startX > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['terrainSegments'],
        message: `terrain starts at ${first.startX} m, leaving a gap from 0`,
      });
    }
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      if (!previous || !current) continue;
      if (Math.abs(current.startX - previous.endX) > 0.001) {
        ctx.addIssue({
          code: 'custom',
          path: ['terrainSegments', i],
          message: `terrain gap or overlap between ${previous.endX} m and ${current.startX} m`,
        });
      }
    }
    const last = sorted[sorted.length - 1];
    if (last && last.endX < mission.lengthMeters) {
      ctx.addIssue({
        code: 'custom',
        path: ['terrainSegments'],
        message: `terrain ends at ${last.endX} m, short of the ${mission.lengthMeters} m map`,
      });
    }

    if (!mission.directorPhases.some((phase) => phase.trigger.type === 'missionStart')) {
      ctx.addIssue({
        code: 'custom',
        path: ['directorPhases'],
        message: 'no phase triggers at missionStart, so the director would never begin',
      });
    }
  });

export type Mission = z.infer<typeof missionSchema>;
export type TerrainSegment = z.infer<typeof terrainSegmentSchema>;
export type LandingZone = z.infer<typeof landingZoneSchema>;
export type CivilianGroup = z.infer<typeof civilianGroupSchema>;
export type EnemySocket = z.infer<typeof enemySocketSchema>;
export type DirectorPhase = z.infer<typeof directorPhaseSchema>;
export type MissionObjective = z.infer<typeof objectiveSchema>;
export type WeatherVolume = z.infer<typeof weatherVolumeSchema>;
export type Checkpoint = z.infer<typeof checkpointSchema>;
