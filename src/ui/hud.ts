import { clamp } from '@/core/math.js';
import type { Vec2 } from '@/core/math.js';

/**
 * The HUD model. Deliberately a pure data structure computed from simulation state, with the
 * DOM rendering kept separate — the layout rules (what counts as off-screen, when the landing
 * aid appears, how extraction progress reads) are gameplay decisions and need to be testable
 * without a browser.
 *
 * The three civilian counters echo the original's killed / aboard / safely returned display.
 * There is deliberately no large running score during play.
 */
export interface CivilianCounters {
  rescued: number;
  total: number;
  dead: number;
  aboard: number;
  capacity: number;
}

export interface AircraftStatus {
  hull: number;
  engine: number;
  rotor: number;
  /** 0..1 of tank capacity. */
  fuel: number;
  /** True once fuel would not cover the trip home, so the HUD can warn early. */
  fuelCritical: boolean;
}

export interface WeaponStatus {
  /** 0..1; at 1 the gun is locked out until it cools to the reset threshold. */
  heat: number;
  overheated: boolean;
  rockets: number;
  flares: number;
  /** Seconds until the next flare charge, or null when charges are full. */
  flareRecharge: number | null;
}

export interface ObjectiveLine {
  label: string;
  /** 0..1 for the extraction progress bar. */
  progress: number;
}

export type EdgeMarkerKind = 'threat' | 'missile' | 'civilian' | 'objective' | 'base';

export interface EdgeMarker {
  kind: EdgeMarkerKind;
  /** Which screen edge the marker sits on. */
  side: 'left' | 'right' | 'top' | 'bottom';
  /** 0..1 position along that edge, from left/top. */
  position: number;
  /** Metres away, for size or urgency. */
  distance: number;
  /** True for a threat actively tracking the player. */
  urgent: boolean;
}

export interface LandingAid {
  visible: boolean;
  verticalSpeed: number;
  horizontalSpeed: number;
  slopeDegrees: number;
  leftSkidContact: boolean;
  rightSkidContact: boolean;
  /** Set when a civilian stands inside the rotor or skid zone. */
  civilianDanger: boolean;
  /** What the touchdown would be graded as if it happened right now. */
  projected: 'safe' | 'hard' | 'crash';
}

export interface TacticalMark {
  kind: 'player' | 'base' | 'objective' | 'threat' | 'refuel';
  /** 0..1 along the map length. */
  position: number;
}

export interface HudModel {
  civilians: CivilianCounters;
  aircraft: AircraftStatus;
  weapons: WeaponStatus;
  objective: ObjectiveLine | null;
  edgeMarkers: EdgeMarker[];
  landingAid: LandingAid;
  tacticalStrip: TacticalMark[];
}

export interface Viewport {
  centerX: number;
  centerY: number;
  halfWidth: number;
  halfHeight: number;
}

export interface TrackedEntity {
  position: Vec2;
  kind: EdgeMarkerKind;
  urgent?: boolean;
}

/**
 * Turns off-screen entities into edge markers. This is the direct answer to the documented
 * complaint that later Choplifter entries framed the action so tightly that attacks had to be
 * memorised: anything dangerous that cannot be seen must still be readable.
 */
export const buildEdgeMarkers = (
  entities: readonly TrackedEntity[],
  view: Viewport,
  playerPosition: Vec2,
): EdgeMarker[] => {
  const markers: EdgeMarker[] = [];
  for (const entity of entities) {
    const dx = entity.position.x - view.centerX;
    const dy = entity.position.y - view.centerY;
    const onScreen = Math.abs(dx) <= view.halfWidth && Math.abs(dy) <= view.halfHeight;
    if (onScreen) continue;

    const distance = Math.hypot(
      entity.position.x - playerPosition.x,
      entity.position.y - playerPosition.y,
    );

    // Pick the edge the entity is furthest past, so a target beyond a corner lands on the side
    // the player would actually turn toward.
    const overX = Math.abs(dx) / view.halfWidth;
    const overY = Math.abs(dy) / view.halfHeight;
    const side: EdgeMarker['side'] =
      overX >= overY ? (dx < 0 ? 'left' : 'right') : dy > 0 ? 'top' : 'bottom';

    const position =
      side === 'left' || side === 'right'
        ? clamp(0.5 - dy / (view.halfHeight * 2), 0, 1)
        : clamp(0.5 + dx / (view.halfWidth * 2), 0, 1);

    markers.push({
      kind: entity.kind,
      side,
      position,
      distance,
      urgent: entity.urgent ?? false,
    });
  }
  // Urgent first, then nearest, so the most dangerous marker is never buried in a crowd.
  markers.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.distance - b.distance);
  return markers;
};

export interface LandingAidInput {
  heightAboveGround: number;
  verticalSpeed: number;
  horizontalSpeed: number;
  slopeDegrees: number;
  leftSkidContact: boolean;
  rightSkidContact: boolean;
  civilianDanger: boolean;
  grounded: boolean;
  /** Safe landings completed this mission. */
  safeLandings: number;
  alwaysShow: boolean;
  tolerances: {
    safeVerticalSpeed: number;
    crashVerticalSpeed: number;
    safeHorizontalSpeed: number;
    safeSlopeDegrees: number;
  };
}

/** Metres within which the landing aid appears, per the PRD. */
export const LANDING_AID_RANGE = 12;
/** Safe landings after which the aid stops appearing, unless the player pinned it on. */
export const LANDING_AID_MASTERY = 3;

export const buildLandingAid = (input: LandingAidInput): LandingAid => {
  const inRange = input.heightAboveGround <= LANDING_AID_RANGE && !input.grounded;
  const mastered = input.safeLandings >= LANDING_AID_MASTERY && !input.alwaysShow;
  // The civilian-danger warning ignores mastery. Knowing the aid by heart does not make the
  // person standing under the rotor any less in danger.
  const visible = inRange && (!mastered || input.civilianDanger);

  const descent = Math.abs(Math.min(0, input.verticalSpeed));
  const projected: LandingAid['projected'] =
    descent > input.tolerances.crashVerticalSpeed ||
    input.slopeDegrees > input.tolerances.safeSlopeDegrees * 2
      ? 'crash'
      : descent > input.tolerances.safeVerticalSpeed ||
          Math.abs(input.horizontalSpeed) > input.tolerances.safeHorizontalSpeed ||
          input.slopeDegrees > input.tolerances.safeSlopeDegrees
        ? 'hard'
        : 'safe';

  return {
    visible,
    verticalSpeed: input.verticalSpeed,
    horizontalSpeed: input.horizontalSpeed,
    slopeDegrees: input.slopeDegrees,
    leftSkidContact: input.leftSkidContact,
    rightSkidContact: input.rightSkidContact,
    civilianDanger: input.civilianDanger,
    projected,
  };
};

export interface TacticalStripInput {
  mapLength: number;
  playerX: number;
  baseX: number;
  objectiveXs: readonly number[];
  threatXs: readonly number[];
  refuelXs: readonly number[];
}

export const buildTacticalStrip = (input: TacticalStripInput): TacticalMark[] => {
  const scale = (x: number): number =>
    input.mapLength <= 0 ? 0 : clamp(x / input.mapLength, 0, 1);
  return [
    { kind: 'player' as const, position: scale(input.playerX) },
    { kind: 'base' as const, position: scale(input.baseX) },
    ...input.objectiveXs.map((x) => ({ kind: 'objective' as const, position: scale(x) })),
    ...input.refuelXs.map((x) => ({ kind: 'refuel' as const, position: scale(x) })),
    ...input.threatXs.map((x) => ({ kind: 'threat' as const, position: scale(x) })),
  ];
};

/** Fuel is critical when there is not enough to fly home with a reserve. */
export const fuelIsCritical = (
  fuelRemaining: number,
  burnPerSecond: number,
  distanceHome: number,
  cruiseSpeed: number,
  reserveFactor = 1.25,
): boolean => {
  if (burnPerSecond <= 0 || cruiseSpeed <= 0) return false;
  const secondsHome = distanceHome / cruiseSpeed;
  return fuelRemaining < secondsHome * burnPerSecond * reserveFactor;
};
