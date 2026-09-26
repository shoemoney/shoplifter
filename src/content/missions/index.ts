import openSky from './m01_open_sky.json' with { type: 'json' };
import { parseMissionOrThrow } from '../loaders/missionLoader.js';
import type { Mission } from '../schemas/mission.js';

/** Raw authored JSON, exported so tests can assert against the file rather than the parse. */
export const rawMissions: readonly unknown[] = [openSky];

/**
 * Every shipped mission, validated at module load. A malformed mission must fail loudly at
 * startup rather than halfway through a level the player has already begun.
 */
export const loadMissions = (): readonly Mission[] => rawMissions.map(parseMissionOrThrow);

export const loadMission = (id: string): Mission => {
  const mission = loadMissions().find((candidate) => candidate.id === id);
  if (!mission) throw new Error(`No mission with id "${id}"`);
  return mission;
};

export const OPEN_SKY_ID = 'm01_open_sky';
