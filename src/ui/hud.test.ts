import { describe, expect, it } from 'vitest';
import {
  LANDING_AID_MASTERY,
  LANDING_AID_RANGE,
  buildEdgeMarkers,
  buildLandingAid,
  buildTacticalStrip,
  fuelIsCritical,
  type LandingAidInput,
  type TrackedEntity,
  type Viewport,
} from './hud.js';

const view: Viewport = { centerX: 0, centerY: 0, halfWidth: 30, halfHeight: 17 };
const player = { x: 0, y: 0 };

const entity = (x: number, y: number, overrides: Partial<TrackedEntity> = {}): TrackedEntity => ({
  position: { x, y },
  kind: 'threat',
  ...overrides,
});

const landingInput = (overrides: Partial<LandingAidInput> = {}): LandingAidInput => ({
  heightAboveGround: 6,
  verticalSpeed: -1,
  horizontalSpeed: 0.5,
  slopeDegrees: 2,
  leftSkidContact: false,
  rightSkidContact: false,
  civilianDanger: false,
  grounded: false,
  safeLandings: 0,
  alwaysShow: false,
  tolerances: {
    safeVerticalSpeed: 3.2,
    crashVerticalSpeed: 6,
    safeHorizontalSpeed: 2.5,
    safeSlopeDegrees: 7,
  },
  ...overrides,
});

describe('edge markers', () => {
  it('ignores anything already on screen', () => {
    expect(buildEdgeMarkers([entity(10, 5)], view, player)).toEqual([]);
  });

  it('marks the edge an off-screen threat lies past', () => {
    const [left] = buildEdgeMarkers([entity(-200, 0)], view, player);
    const [right] = buildEdgeMarkers([entity(200, 0)], view, player);
    const [top] = buildEdgeMarkers([entity(0, 200)], view, player);
    const [bottom] = buildEdgeMarkers([entity(0, -200)], view, player);
    expect(left?.side).toBe('left');
    expect(right?.side).toBe('right');
    expect(top?.side).toBe('top');
    expect(bottom?.side).toBe('bottom');
  });

  it('puts a corner target on the edge the player would turn toward', () => {
    // Far further past the horizontal edge than the vertical one.
    const [marker] = buildEdgeMarkers([entity(-400, 25)], view, player);
    expect(marker?.side).toBe('left');
  });

  it('reports position along the edge, clamped to the screen', () => {
    const [marker] = buildEdgeMarkers([entity(-200, 0)], view, player);
    expect(marker?.position).toBeCloseTo(0.5, 6);
    const [high] = buildEdgeMarkers([entity(-200, 500)], view, player);
    expect(high?.position).toBe(0);
  });

  it('reports the real distance from the player, not from the camera', () => {
    const [marker] = buildEdgeMarkers([entity(-200, 0)], view, { x: -100, y: 0 });
    expect(marker?.distance).toBeCloseTo(100, 6);
  });

  it('sorts urgent threats first, then by proximity', () => {
    const markers = buildEdgeMarkers(
      [
        entity(-400, 0, { kind: 'civilian' }),
        entity(-200, 0, { kind: 'missile', urgent: true }),
        entity(-100, 0, { kind: 'threat' }),
      ],
      view,
      player,
    );
    expect(markers[0]?.kind).toBe('missile');
    expect(markers[1]?.kind).toBe('threat');
    expect(markers[2]?.kind).toBe('civilian');
  });

  it('tracks civilians in distress, not only threats', () => {
    const [marker] = buildEdgeMarkers([entity(400, 0, { kind: 'civilian' })], view, player);
    expect(marker?.kind).toBe('civilian');
  });
});

describe('landing aid', () => {
  it('appears within 12 metres of the ground', () => {
    expect(
      buildLandingAid(landingInput({ heightAboveGround: LANDING_AID_RANGE - 1 })).visible,
    ).toBe(true);
    expect(
      buildLandingAid(landingInput({ heightAboveGround: LANDING_AID_RANGE + 1 })).visible,
    ).toBe(false);
  });

  it('hides once already landed', () => {
    expect(buildLandingAid(landingInput({ grounded: true })).visible).toBe(false);
  });

  it('fades away after three safe landings', () => {
    expect(buildLandingAid(landingInput({ safeLandings: LANDING_AID_MASTERY - 1 })).visible).toBe(
      true,
    );
    expect(buildLandingAid(landingInput({ safeLandings: LANDING_AID_MASTERY })).visible).toBe(
      false,
    );
  });

  it('stays pinned when the player asks for it', () => {
    expect(buildLandingAid(landingInput({ safeLandings: 10, alwaysShow: true })).visible).toBe(
      true,
    );
  });

  it('overrides mastery when a civilian is in danger', () => {
    const aid = buildLandingAid(landingInput({ safeLandings: 10, civilianDanger: true }));
    expect(aid.visible).toBe(true);
    expect(aid.civilianDanger).toBe(true);
  });

  it('projects the landing the player is currently flying', () => {
    expect(buildLandingAid(landingInput({ verticalSpeed: -1 })).projected).toBe('safe');
    expect(buildLandingAid(landingInput({ verticalSpeed: -4 })).projected).toBe('hard');
    expect(buildLandingAid(landingInput({ verticalSpeed: -9 })).projected).toBe('crash');
  });

  it('calls out excess lateral speed and slope as a hard landing', () => {
    expect(buildLandingAid(landingInput({ horizontalSpeed: 6 })).projected).toBe('hard');
    expect(buildLandingAid(landingInput({ slopeDegrees: 9 })).projected).toBe('hard');
    expect(buildLandingAid(landingInput({ slopeDegrees: 20 })).projected).toBe('crash');
  });

  it('ignores climb rate — going up is never an impact', () => {
    expect(buildLandingAid(landingInput({ verticalSpeed: 12 })).projected).toBe('safe');
  });

  it('reports each skid separately', () => {
    const aid = buildLandingAid(landingInput({ leftSkidContact: true, rightSkidContact: false }));
    expect(aid.leftSkidContact).toBe(true);
    expect(aid.rightSkidContact).toBe(false);
  });
});

describe('tactical strip', () => {
  it('normalises every mark to 0..1 of the map', () => {
    const marks = buildTacticalStrip({
      mapLength: 6000,
      playerX: 3000,
      baseX: 200,
      objectiveXs: [4200],
      threatXs: [1500],
      refuelXs: [2800],
    });
    expect(marks.find((m) => m.kind === 'player')?.position).toBeCloseTo(0.5, 6);
    expect(marks.find((m) => m.kind === 'base')?.position).toBeCloseTo(200 / 6000, 6);
    expect(marks).toHaveLength(5);
  });

  it('clamps a player who has flown past the map edge', () => {
    const marks = buildTacticalStrip({
      mapLength: 6000,
      playerX: 9999,
      baseX: 0,
      objectiveXs: [],
      threatXs: [],
      refuelXs: [],
    });
    expect(marks[0]?.position).toBe(1);
  });

  it('survives a zero-length map without dividing by zero', () => {
    const marks = buildTacticalStrip({
      mapLength: 0,
      playerX: 10,
      baseX: 0,
      objectiveXs: [],
      threatXs: [],
      refuelXs: [],
    });
    expect(marks[0]?.position).toBe(0);
  });
});

describe('fuel warning', () => {
  it('warns while there is still time to act, not at empty', () => {
    // 3 km home at 40 m/s is 75 s of flying, 12 litres at 0.16/s, so 20 is comfortable.
    expect(fuelIsCritical(20, 0.16, 3000, 40)).toBe(false);
    expect(fuelIsCritical(10, 0.16, 3000, 40)).toBe(true);
  });

  it('accounts for distance, not just the gauge', () => {
    expect(fuelIsCritical(10, 0.16, 300, 40)).toBe(false);
  });

  it('does not warn when the numbers are meaningless', () => {
    expect(fuelIsCritical(10, 0, 3000, 40)).toBe(false);
    expect(fuelIsCritical(10, 0.16, 3000, 0)).toBe(false);
  });
});
