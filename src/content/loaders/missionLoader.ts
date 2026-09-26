import { Heightfield } from '@/sim/terrain.js';
import { missionSchema, type Mission, type TerrainSegment } from '../schemas/mission.js';

export interface MissionIssue {
  path: string;
  message: string;
}

export class MissionValidationError extends Error {
  constructor(
    readonly missionId: string,
    readonly issues: MissionIssue[],
  ) {
    super(
      `Mission "${missionId}" is invalid:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`,
    );
    this.name = 'MissionValidationError';
  }
}

export type MissionParseResult =
  { ok: true; mission: Mission } | { ok: false; issues: MissionIssue[] };

/**
 * Returns editor-friendly issues rather than throwing. Someone hand-editing mission JSON should
 * get a list of what is wrong with paths they can find in their file, not a stack trace.
 */
export const parseMission = (raw: unknown): MissionParseResult => {
  const result = missionSchema.safeParse(raw);
  if (result.success) return { ok: true, mission: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
      message: issue.message,
    })),
  };
};

export const parseMissionOrThrow = (raw: unknown): Mission => {
  const result = parseMission(raw);
  if (!result.ok) {
    const id = typeof raw === 'object' && raw !== null && 'id' in raw ? String(raw.id) : 'unknown';
    throw new MissionValidationError(id, result.issues);
  }
  return result.mission;
};

/** Height of an authored segment at a world x. Segments are compiled, not sampled at runtime. */
export const segmentHeightAt = (segment: TerrainSegment, x: number): number => {
  switch (segment.type) {
    case 'flat':
      return segment.height;
    case 'ramp': {
      const span = segment.endX - segment.startX;
      if (span <= 0) return segment.height;
      const t = Math.min(1, Math.max(0, (x - segment.startX) / span));
      return segment.height + (segment.endHeight - segment.height) * t;
    }
    case 'hills': {
      const local = x - segment.startX;
      // Two incommensurate waves so the hills never visibly tile over a 6 km map.
      return (
        segment.height +
        Math.sin(local * segment.frequency) * segment.amplitude +
        Math.sin(local * segment.frequency * 2.37) * segment.amplitude * 0.38
      );
    }
    default:
      return 0;
  }
};

export interface CompileOptions {
  /** Metres between heightfield samples. 4 m keeps a 6 km map to 1,500 samples. */
  spacing?: number;
}

/**
 * Compiles authored terrain segments into a sampled heightfield. The schema already guarantees
 * the segments tile the whole map with no gaps, so any x inside the map resolves to exactly one
 * segment; the fallback only covers floating-point edges.
 */
export const compileTerrain = (
  mission: Mission,
  { spacing = 4 }: CompileOptions = {},
): Heightfield => {
  const segments = [...mission.terrainSegments].sort((a, b) => a.startX - b.startX);
  const count = Math.ceil(mission.lengthMeters / spacing) + 1;
  const samples = new Float32Array(count);

  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const x = i * spacing;
    while (cursor < segments.length - 1) {
      const segment = segments[cursor];
      if (segment && x <= segment.endX) break;
      cursor++;
    }
    const segment = segments[cursor];
    samples[i] = segment ? segmentHeightAt(segment, x) : 0;
  }

  flattenLandingZones(mission, samples, spacing);
  return new Heightfield({ samples, originX: 0, spacing });
};

/**
 * Levels the ground under every authored landing zone, with a short blend either side.
 *
 * An authored landing zone is a prepared surface by definition. Without this, a zone placed on
 * hilly terrain can exceed the 7-degree slope tolerance, which does not merely make landing
 * hard — it makes the zone unusable, because civilians only approach a *stable* aircraft. The
 * mission then looks correct in the data and cannot be completed.
 */
const flattenLandingZones = (mission: Mission, samples: Float32Array, spacing: number): void => {
  const blend = 12;
  for (const zone of mission.landingZones) {
    const half = zone.width / 2;
    const centreIndex = Math.round(zone.x / spacing);
    const padHeight = samples[Math.min(samples.length - 1, Math.max(0, centreIndex))] ?? 0;

    const from = Math.max(0, Math.floor((zone.x - half - blend) / spacing));
    const to = Math.min(samples.length - 1, Math.ceil((zone.x + half + blend) / spacing));
    for (let i = from; i <= to; i++) {
      const x = i * spacing;
      const distance = Math.abs(x - zone.x);
      if (distance <= half) {
        samples[i] = padHeight;
        continue;
      }
      // Ease back into the authored terrain so the pad does not end in a cliff.
      const t = Math.min(1, (distance - half) / blend);
      const original = samples[i] ?? padHeight;
      samples[i] = padHeight + (original - padHeight) * t * t;
    }
  }
};

/** Total civilians the mission places. The debrief denominator. */
export const civilianTotal = (mission: Mission): number =>
  mission.civilianGroups.reduce((sum, group) => sum + group.count, 0);

/** The base pad: where the player spawns and where passengers are unloaded. */
export const homeZone = (mission: Mission) =>
  mission.landingZones.find((zone) => zone.kind === 'base') ?? mission.landingZones[0];

/** Wind and gust in effect at a world x, or calm outside every authored volume. */
export const weatherAt = (
  mission: Mission,
  x: number,
): { wind: number; gust: number; visibility: number } => {
  for (const volume of mission.weatherVolumes) {
    if (x >= volume.startX && x <= volume.endX) {
      return { wind: volume.wind, gust: volume.gust, visibility: volume.visibility };
    }
  }
  return { wind: 0, gust: 0, visibility: 1 };
};
