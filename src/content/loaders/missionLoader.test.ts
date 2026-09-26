import { describe, expect, it } from 'vitest';
import openSky from '../missions/m01_open_sky.json' with { type: 'json' };
import { loadMission, loadMissions, OPEN_SKY_ID } from '../missions/index.js';
import {
  civilianTotal,
  compileTerrain,
  homeZone,
  parseMission,
  parseMissionOrThrow,
  segmentHeightAt,
  weatherAt,
  MissionValidationError,
} from './missionLoader.js';

const clone = (): Record<string, unknown> => structuredClone(openSky);

describe('mission validation', () => {
  it('accepts the shipped vertical slice', () => {
    const result = parseMission(openSky);
    expect(result.ok).toBe(true);
  });

  it('reports editor-friendly paths instead of throwing', () => {
    const broken = clone();
    broken.lengthMeters = -1;
    const result = parseMission(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe('lengthMeters');
    expect(result.issues[0]?.message).toBeTruthy();
  });

  it('throws a named error with every issue when asked to', () => {
    expect(() => parseMissionOrThrow({ id: 'bad' })).toThrow(MissionValidationError);
  });

  it('rejects an objective pointing at a landing zone that does not exist', () => {
    const broken = clone();
    (broken.objectives as Array<Record<string, unknown>>)[1] = {
      id: 'return_home',
      kind: 'primary',
      label: 'Return',
      goal: { type: 'reachZone', zoneId: 'nowhere' },
      requires: [],
    };
    const result = parseMission(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('nowhere'))).toBe(true);
  });

  it('rejects a prerequisite pointing at a missing objective', () => {
    const broken = clone();
    (broken.objectives as Array<Record<string, unknown>>)[1] = {
      id: 'return_home',
      kind: 'primary',
      label: 'Return',
      goal: { type: 'reachZone', zoneId: 'home' },
      requires: ['does_not_exist'],
    };
    const result = parseMission(broken);
    expect(result.ok).toBe(false);
  });

  it('rejects a director phase keyed to an unknown objective', () => {
    const broken = clone();
    (broken.directorPhases as Array<Record<string, unknown>>)[3] = {
      id: 'phase_radar_down',
      tier: 3,
      trigger: { type: 'objective', objectiveId: 'ghost' },
      threatPoints: 1,
      maxConcurrentAir: 1,
      maxConcurrentGround: 1,
      reinforcementCooldown: 10,
    };
    const result = parseMission(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('ghost'))).toBe(true);
  });

  it('rejects a mission that asks for more rescues than it places civilians', () => {
    const broken = clone();
    broken.requiredRescues = 99;
    const result = parseMission(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === 'requiredRescues')).toBe(true);
  });

  it('rejects a gap in the terrain', () => {
    const broken = clone();
    const segments = broken.terrainSegments as Array<Record<string, number>>;
    const first = segments[0];
    if (first) first.endX = 400; // leaves 400..460 unauthored
    const result = parseMission(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('gap'))).toBe(true);
  });

  it('rejects terrain that stops short of the map length', () => {
    const broken = clone();
    const segments = broken.terrainSegments as Array<Record<string, number>>;
    segments.pop();
    const result = parseMission(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('short of'))).toBe(true);
  });

  it('rejects a director with no mission-start phase, which would never begin', () => {
    const broken = clone();
    const phases = broken.directorPhases as Array<Record<string, unknown>>;
    const first = phases[0];
    if (first) first.trigger = { type: 'unloadCount', count: 1 };
    const result = parseMission(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('missionStart'))).toBe(true);
  });
});

describe('Operation Open Sky content', () => {
  const mission = loadMission(OPEN_SKY_ID);

  it('loads from the mission index', () => {
    expect(loadMissions()).toHaveLength(1);
    expect(mission.name).toBe('Operation Open Sky');
  });

  it('matches the PRD vertical slice: 6 km, 24 civilians, 18 required', () => {
    expect(mission.lengthMeters).toBe(6000);
    expect(mission.altitudeCeiling).toBe(500);
    expect(civilianTotal(mission)).toBe(24);
    expect(mission.requiredRescues).toBe(18);
  });

  it('targets the PRD 10-12 minute duration', () => {
    expect(mission.targetSeconds).toBeGreaterThanOrEqual(600);
    expect(mission.targetSeconds).toBeLessThanOrEqual(720);
  });

  it('places three civilian sites of eight, as the PRD specifies', () => {
    expect(mission.civilianGroups).toHaveLength(3);
    for (const group of mission.civilianGroups) expect(group.count).toBe(8);
  });

  it('has a home base offering every service', () => {
    const home = homeZone(mission);
    expect(home?.kind).toBe('base');
    expect(home?.services).toEqual(expect.arrayContaining(['refuel', 'rearm', 'repair', 'unload']));
  });

  it('has a forward refuel pad, per the required vertical-slice content', () => {
    const forward = mission.landingZones.find((zone) => zone.kind === 'forward');
    expect(forward).toBeDefined();
    expect(forward?.services).toContain('refuel');
  });

  it('covers all five escalation tiers, ending in a bounded climax', () => {
    const tiers = mission.directorPhases.map((phase) => phase.tier).sort();
    expect(tiers).toEqual([0, 1, 2, 3, 4]);
    const climax = mission.directorPhases.find((phase) => phase.tier === 4);
    // Tier 4 is an authored climax: a wave budget is what stops it spawning forever.
    expect(climax?.maxWaves).toBeGreaterThan(0);
  });

  it('introduces jets only after the first unload, and drones later still', () => {
    const jets = mission.enemySockets.filter((socket) => socket.kind === 'jet');
    const drones = mission.enemySockets.filter((socket) => socket.kind === 'drone');
    expect(jets.length).toBeGreaterThan(0);
    expect(drones.length).toBeGreaterThan(0);
    for (const jet of jets) expect(jet.minTier).toBeGreaterThanOrEqual(1);
    for (const drone of drones) expect(drone.minTier).toBeGreaterThanOrEqual(2);
  });

  it('fields all five vertical-slice enemy types', () => {
    const kinds = new Set(mission.enemySockets.map((socket) => socket.kind));
    for (const kind of ['rifleInfantry', 'rpgInfantry', 'lightTank', 'aaGun', 'jet'] as const) {
      expect(kinds.has(kind)).toBe(true);
    }
  });

  it('puts wind gusts in the canyon, where the PRD asks for them', () => {
    expect(weatherAt(mission, 5300).gust).toBeGreaterThan(0);
    expect(weatherAt(mission, 200).gust).toBe(0);
    expect(weatherAt(mission, 200).visibility).toBe(1);
  });
});

describe('terrain compilation', () => {
  const mission = loadMission(OPEN_SKY_ID);

  it('interpolates a ramp linearly', () => {
    const ramp = { type: 'ramp', startX: 0, endX: 100, height: 0, endHeight: 10 } as const;
    expect(segmentHeightAt(ramp, 0)).toBe(0);
    expect(segmentHeightAt(ramp, 50)).toBeCloseTo(5, 6);
    expect(segmentHeightAt(ramp, 100)).toBe(10);
  });

  it('clamps a ramp sampled outside its own span', () => {
    const ramp = { type: 'ramp', startX: 0, endX: 100, height: 0, endHeight: 10 } as const;
    expect(segmentHeightAt(ramp, -50)).toBe(0);
    expect(segmentHeightAt(ramp, 500)).toBe(10);
  });

  it('keeps hills within their stated amplitude', () => {
    const hills = {
      type: 'hills',
      startX: 0,
      endX: 500,
      height: 20,
      amplitude: 5,
      frequency: 0.02,
    } as const;
    for (let x = 0; x <= 500; x += 7) {
      const height = segmentHeightAt(hills, x);
      expect(Math.abs(height - 20)).toBeLessThanOrEqual(5 * 1.4);
    }
  });

  it('produces a heightfield spanning the whole map', () => {
    const terrain = compileTerrain(mission);
    expect(terrain.minX).toBe(0);
    expect(terrain.maxX).toBeGreaterThanOrEqual(mission.lengthMeters);
  });

  it('matches the authored heights at zone boundaries', () => {
    const terrain = compileTerrain(mission, { spacing: 2 });
    expect(terrain.heightAt(100)).toBeCloseTo(0, 3);
    expect(terrain.heightAt(1500)).toBeCloseTo(2, 3);
    expect(terrain.heightAt(3000)).toBeCloseTo(0, 3);
  });

  it('gives the canyon a genuinely higher floor than the dry lake', () => {
    const terrain = compileTerrain(mission);
    expect(terrain.heightAt(5300)).toBeGreaterThan(terrain.heightAt(3000) + 15);
  });

  it('is identical on every load — no RNG in level compilation', () => {
    const a = compileTerrain(mission);
    const b = compileTerrain(mission);
    for (const x of [0, 500, 1234, 3000, 4800, 5999]) {
      expect(a.heightAt(x)).toBe(b.heightAt(x));
    }
  });

  it('keeps every landing zone on ground the aircraft can actually reach', () => {
    const terrain = compileTerrain(mission);
    for (const zone of mission.landingZones) {
      expect(Number.isFinite(terrain.heightAt(zone.x))).toBe(true);
      expect(terrain.heightAt(zone.x)).toBeLessThan(mission.altitudeCeiling);
    }
  });

  it('keeps the base pad flat enough to land on', () => {
    const terrain = compileTerrain(mission);
    const home = homeZone(mission);
    expect(home).toBeDefined();
    if (!home) return;
    expect(Math.abs(terrain.slopeDegreesAt(home.x))).toBeLessThan(7);
  });
});
