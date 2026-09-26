import { beforeEach, describe, expect, it } from 'vitest';
import type { DamagePacket } from '../combat/types.js';
import {
  BoardingBay,
  applyContact,
  beginDisembark,
  capacityCost,
  contactZone,
  createCivilian,
  damageCivilian,
  defaultCivilianTuning,
  isExposed,
  isResolved,
  panic,
  pathIsBlocked,
  releaseCivilian,
  rotorContactIsLethal,
  stepCivilian,
  tally,
  type Civilian,
  type CivilianWorldView,
  type Difficulty,
} from './civilians.js';

const tuning = defaultCivilianTuning();
const DT = 1 / 120;

const view = (overrides: Partial<CivilianWorldView> = {}): CivilianWorldView => ({
  dt: DT,
  tick: 0,
  helicopter: {
    position: { x: 0, y: 0 },
    grounded: true,
    stable: true,
    destroyed: false,
    freeCapacity: 8,
  },
  threatLevel: 0,
  coverPoints: [],
  hazards: [],
  difficulty: 'standard',
  ...overrides,
});

const runFor = (
  civilian: Civilian,
  worldView: CivilianWorldView,
  seconds: number,
  bay = new BoardingBay(),
): string[] => {
  const events: string[] = [];
  const steps = Math.round(seconds / worldView.dt);
  for (let i = 0; i < steps; i++) {
    events.push(...stepCivilian(civilian, worldView, tuning, bay).events);
  }
  return events;
};

let civilian: Civilian;

beforeEach(() => {
  civilian = createCivilian({ id: 1, position: { x: 12, y: 0 } });
});

describe('state predicates', () => {
  it('knows which states leave a civilian out in the open', () => {
    expect(isExposed('released')).toBe(true);
    expect(isExposed('boarding')).toBe(true);
    expect(isExposed('aboard')).toBe(false);
    expect(isExposed('captive')).toBe(false);
  });

  it('treats rescued and dead as the only terminal outcomes', () => {
    expect(isResolved('rescued')).toBe(true);
    expect(isResolved('dead')).toBe(true);
    expect(isResolved('injured')).toBe(false);
  });
});

describe('release and approach', () => {
  it('stays put while captive', () => {
    runFor(civilian, view(), 2);
    expect(civilian.state).toBe('captive');
  });

  it('only releases from captivity', () => {
    expect(releaseCivilian(civilian)).toBe(true);
    expect(civilian.state).toBe('released');
    expect(releaseCivilian(civilian)).toBe(false);
  });

  it('approaches a safe landed helicopter inside 24 metres', () => {
    releaseCivilian(civilian);
    runFor(civilian, view(), 0.1);
    expect(civilian.state).toBe('approachLz');
  });

  it('ignores a helicopter further away than the approach radius', () => {
    civilian.position.x = tuning.approachRadius + 10;
    releaseCivilian(civilian);
    runFor(civilian, view(), 0.5);
    expect(civilian.state).toBe('released');
  });

  it('ignores a helicopter that is still airborne', () => {
    releaseCivilian(civilian);
    const airborne = view();
    airborne.helicopter.grounded = false;
    runFor(civilian, airborne, 0.5);
    expect(civilian.state).toBe('released');
  });

  it('takes cover first when under fire', () => {
    releaseCivilian(civilian);
    const hot = view({ threatLevel: 0.9, coverPoints: [{ x: 30, quality: 0.8 }] });
    hot.helicopter.grounded = false;
    const events = runFor(civilian, hot, 0.2);
    expect(civilian.state).toBe('seekCover');
    expect(events).toContain('civilian:tookCover');
    expect(civilian.coverX).toBe(30);
  });

  it('walks to cover at walking pace', () => {
    releaseCivilian(civilian);
    const hot = view({ threatLevel: 0.9, coverPoints: [{ x: 22, quality: 0.5 }] });
    hot.helicopter.grounded = false;
    runFor(civilian, hot, 1);
    expect(civilian.position.x).toBeGreaterThan(12);
    expect(civilian.position.x).toBeLessThanOrEqual(12 + tuning.walkSpeed * 1.05);
  });

  it('picks the nearest cover, breaking ties toward better cover', () => {
    releaseCivilian(civilian);
    const hot = view({
      threatLevel: 0.9,
      coverPoints: [
        { x: 12 - 5, quality: 0.2 },
        { x: 12 + 5, quality: 0.9 },
      ],
    });
    hot.helicopter.grounded = false;
    runFor(civilian, hot, 0.02);
    expect(civilian.coverX).toBe(17);
  });
});

describe('boarding', () => {
  it('boards in 0.55 seconds once at the door', () => {
    civilian.position.x = 1;
    releaseCivilian(civilian);
    const events = runFor(civilian, view(), 1);
    expect(events).toContain('civilian:boardingStarted');
    expect(events).toContain('civilian:boarded');
    expect(civilian.state).toBe('aboard');
  });

  it('takes 1.5 seconds and two seats when wounded', () => {
    civilian.position.x = 1;
    civilian.wounded = true;
    expect(capacityCost(civilian, tuning)).toBe(2);
    releaseCivilian(civilian);

    const shortRun = runFor(civilian, view(), 0.9);
    expect(shortRun).not.toContain('civilian:boarded');
    const rest = runFor(civilian, view(), 1);
    expect(rest).toContain('civilian:boarded');
  });

  it('waves the helicopter off when it is full, and waits', () => {
    civilian.position.x = 1;
    releaseCivilian(civilian);
    const full = view();
    full.helicopter.freeCapacity = 0;
    const events = runFor(civilian, full, 0.5);
    expect(events).toContain('civilian:wavedOff');
    expect(civilian.state).toBe('waitForSpace');
    expect(civilian.wavedOff).toBe(true);
  });

  it('returns to the door once space opens up', () => {
    civilian.position.x = 1;
    releaseCivilian(civilian);
    const full = view();
    full.helicopter.freeCapacity = 0;
    runFor(civilian, full, 0.5);
    expect(civilian.state).toBe('waitForSpace');

    full.helicopter.freeCapacity = 4;
    runFor(civilian, full, 0.1);
    expect(civilian.wavedOff).toBe(false);
    expect(['approachLz', 'boarding']).toContain(civilian.state);
  });

  it('a wounded civilian refuses a single free seat', () => {
    civilian.position.x = 1;
    civilian.wounded = true;
    releaseCivilian(civilian);
    const tight = view();
    tight.helicopter.freeCapacity = 1;
    const events = runFor(civilian, tight, 0.5);
    expect(events).toContain('civilian:wavedOff');
  });

  it('cancels boarding and knocks the civilian down if the aircraft leaves', () => {
    civilian.position.x = 1;
    releaseCivilian(civilian);
    const bay = new BoardingBay();
    const grounded = view();
    runFor(civilian, grounded, 0.2, bay);
    expect(civilian.state).toBe('boarding');

    const leaving = view();
    leaving.helicopter.grounded = false;
    const events = runFor(civilian, leaving, 0.05, bay);
    expect(events).toContain('civilian:boardingCancelled');
    expect(events).toContain('civilian:knockedDown');
    // Knocked down, not killed — impatience must never silently kill someone.
    expect(civilian.state).toBe('released');
    expect(civilian.knockedDownFor).toBeGreaterThan(0);
  });

  it('disembarks into a rescue', () => {
    civilian.state = 'aboard';
    expect(beginDisembark(civilian)).toBe(true);
    const events = runFor(civilian, view(), 1);
    expect(events).toContain('civilian:rescued');
    expect(civilian.state).toBe('rescued');
  });

  it('cannot disembark someone who is not aboard', () => {
    expect(beginDisembark(civilian)).toBe(false);
  });

  it('dies with the aircraft if it is destroyed while they are aboard', () => {
    civilian.state = 'aboard';
    const wreck = view();
    wreck.helicopter.destroyed = true;
    const events = runFor(civilian, wreck, 0.05);
    expect(events).toContain('civilian:died');
    expect(civilian.state).toBe('dead');
  });
});

describe('BoardingBay', () => {
  it('runs two doors when both sides are clear', () => {
    const bay = new BoardingBay();
    expect(bay.capacity).toBe(2);
    expect(bay.claim(1)).toBe(0);
    expect(bay.claim(2)).toBe(1);
    expect(bay.claim(3)).toBeNull();
    expect(bay.occupied).toBe(2);
  });

  it('drops to one door when a side is blocked', () => {
    const bay = new BoardingBay();
    bay.setBothSidesClear(false);
    expect(bay.capacity).toBe(1);
    expect(bay.claim(1)).toBe(0);
    expect(bay.claim(2)).toBeNull();
  });

  it('evicts the far-side boarder when that side becomes blocked', () => {
    const bay = new BoardingBay();
    bay.claim(1);
    bay.claim(2);
    bay.setBothSidesClear(false);
    expect(bay.occupied).toBe(1);
  });

  it('returns the same slot for a repeated claim', () => {
    const bay = new BoardingBay();
    expect(bay.claim(9)).toBe(0);
    expect(bay.claim(9)).toBe(0);
  });

  it('frees a slot on release', () => {
    const bay = new BoardingBay();
    bay.claim(1);
    bay.release(1);
    expect(bay.occupied).toBe(0);
  });

  it('queues a third civilian rather than letting them clip through', () => {
    const bay = new BoardingBay();
    const crowd = [2, 3, 4].map((id) => createCivilian({ id, position: { x: 1, y: 0 } }));
    for (const person of crowd) releaseCivilian(person);
    const world = view();
    for (let i = 0; i < 12; i++) {
      for (const person of crowd) stepCivilian(person, world, tuning, bay);
    }
    expect(crowd.filter((c) => c.state === 'boarding')).toHaveLength(2);
    expect(bay.occupied).toBe(2);
  });
});

describe('hazards and panic', () => {
  it('refuses to walk through fire', () => {
    expect(
      pathIsBlocked(0, 20, view({ hazards: [{ x: 10, radius: 3, kind: 'fire' }] }), tuning),
    ).toBe(true);
    expect(
      pathIsBlocked(0, 20, view({ hazards: [{ x: 40, radius: 3, kind: 'fire' }] }), tuning),
    ).toBe(false);
  });

  it('holds position rather than crossing a blast marker', () => {
    civilian.position.x = 1;
    releaseCivilian(civilian);
    const blocked = view({ hazards: [{ x: 6, radius: 2, kind: 'blast' }] });
    blocked.helicopter.position.x = 20;
    runFor(civilian, blocked, 1);
    expect(civilian.position.x).toBe(1);
  });

  it('panicking overrides careful behaviour and is time-limited', () => {
    releaseCivilian(civilian);
    expect(panic(civilian, tuning)).toBe(true);
    expect(civilian.state).toBe('panic');
    runFor(civilian, view(), tuning.panicSeconds + 0.2);
    expect(civilian.state).not.toBe('panic');
  });

  it('cannot panic someone who is already aboard', () => {
    civilian.state = 'aboard';
    expect(panic(civilian, tuning)).toBe(false);
  });

  it('cannot act while knocked down', () => {
    civilian.position.x = 1;
    releaseCivilian(civilian);
    civilian.knockedDownFor = 1;
    runFor(civilian, view(), 0.5);
    expect(civilian.state).toBe('released');
    expect(civilian.position.x).toBe(1);
  });
});

describe('damage', () => {
  const packet = (amount: number): DamagePacket => ({
    amount,
    kind: 'bullet',
    sourceId: null,
    sourceTeam: 'hostile',
    at: { x: 0, y: 0 },
  });

  it('wounds before it kills', () => {
    releaseCivilian(civilian);
    const result = damageCivilian(civilian, packet(0.5), 'standard');
    expect(result.died).toBe(false);
    expect(result.injured).toBe(true);
    expect(civilian.wounded).toBe(true);
    expect(civilian.state).toBe('injured');
  });

  it('kills when health runs out, and says so', () => {
    releaseCivilian(civilian);
    const result = damageCivilian(civilian, packet(1), 'standard');
    expect(result.died).toBe(true);
    expect(result.events).toContain('civilian:died');
    expect(civilian.state).toBe('dead');
  });

  it('leaves the rescued and the dead alone', () => {
    civilian.state = 'rescued';
    expect(damageCivilian(civilian, packet(1), 'standard').died).toBe(false);
    expect(civilian.state).toBe('rescued');
  });

  it('makes survivors run, except on Story difficulty', () => {
    releaseCivilian(civilian);
    damageCivilian(civilian, packet(0.2), 'standard');
    expect(civilian.panicFor).toBeGreaterThan(0);

    const calm = createCivilian({ id: 2 });
    releaseCivilian(calm);
    damageCivilian(calm, packet(0.2), 'story');
    expect(calm.panicFor).toBe(0);
  });
});

describe('rotor, skids and downwash', () => {
  const lz = view().helicopter;

  it('separates the three contact zones', () => {
    expect(contactZone({ x: 0, y: 1 }, lz, tuning)).toBe('rotor');
    expect(contactZone({ x: 0, y: -1 }, lz, tuning)).toBe('skid');
    expect(contactZone({ x: 5.5, y: -1 }, lz, tuning)).toBe('downwash');
    expect(contactZone({ x: 40, y: 0 }, lz, tuning)).toBe('none');
  });

  it('downwash only knocks people over', () => {
    releaseCivilian(civilian);
    const result = applyContact(civilian, 'downwash', tuning, 'standard');
    expect(result.died).toBe(false);
    expect(result.events).toContain('civilian:knockedDown');
    expect(civilian.health).toBe(1);
  });

  it('injures rather than kills on the first rotor contact on Standard', () => {
    releaseCivilian(civilian);
    const result = applyContact(civilian, 'rotor', tuning, 'standard');
    expect(result.died).toBe(false);
    expect(result.injured).toBe(true);
    expect(civilian.wounded).toBe(true);
  });

  it('kills a second rotor contact even on Standard', () => {
    releaseCivilian(civilian);
    applyContact(civilian, 'rotor', tuning, 'standard');
    const second = applyContact(civilian, 'rotor', tuning, 'standard');
    expect(second.died).toBe(true);
  });

  it('keeps the original lethal skids on Veteran and Classic', () => {
    expect(rotorContactIsLethal('veteran')).toBe(true);
    expect(rotorContactIsLethal('classic')).toBe(true);
    expect(rotorContactIsLethal('standard')).toBe(false);

    for (const difficulty of ['veteran', 'classic'] as Difficulty[]) {
      const victim = createCivilian({ id: 5 });
      releaseCivilian(victim);
      expect(applyContact(victim, 'skid', tuning, difficulty).died).toBe(true);
    }
  });

  it('cannot hurt someone already aboard', () => {
    civilian.state = 'aboard';
    expect(applyContact(civilian, 'rotor', tuning, 'classic').died).toBe(false);
  });
});

describe('tally', () => {
  it('counts lives, not kills', () => {
    const people = [
      createCivilian({ id: 1, state: 'rescued' }),
      createCivilian({ id: 2, state: 'rescued' }),
      createCivilian({ id: 3, state: 'dead' }),
      createCivilian({ id: 4, state: 'aboard' }),
      createCivilian({ id: 5, state: 'captive' }),
    ];
    expect(tally(people)).toEqual({ total: 5, rescued: 2, dead: 1, aboard: 1, awaiting: 1 });
  });

  it('reports an empty roster without dividing by anything', () => {
    expect(tally([])).toEqual({ total: 0, rescued: 0, dead: 0, aboard: 0, awaiting: 0 });
  });
});
