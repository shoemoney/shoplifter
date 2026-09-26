import { describe, expect, it } from 'vitest';
import type { CombatWorldView, PlayerView } from '../combat/types.js';
import {
  canLightTankEngage,
  computeLeadAimpoint,
  createAaGun,
  createDrone,
  createJet,
  createLightTank,
  createRifleInfantry,
  createRpgInfantry,
  defaultEnemyTuning,
  lightTankDamageMultiplier,
  stepEnemy,
  type FireIntent,
} from './enemies.js';

const DT = 1 / 60;

const makeView = (
  playerOverrides: Partial<PlayerView> = {},
  viewOverrides: Partial<
    Pick<CombatWorldView, 'tick' | 'dt' | 'groundHeightAt' | 'hasLineOfSight'>
  > = {},
): CombatWorldView => ({
  tick: 0,
  dt: DT,
  groundHeightAt: () => 0,
  hasLineOfSight: () => true,
  ...viewOverrides,
  player: {
    id: 999,
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    heightAboveGround: 0,
    grounded: true,
    destroyed: false,
    facing: 1,
    passengers: 0,
    ...playerOverrides,
  },
});

describe('the 700ms no-lethal-attack-without-warning floor', () => {
  const tuning = defaultEnemyTuning();

  it('every firing enemy exposes a telegraph or warning window of at least 700ms', () => {
    expect(tuning.rifle.telegraphSeconds).toBeGreaterThanOrEqual(0.7);
    expect(tuning.rpg.telegraphSeconds).toBeGreaterThanOrEqual(0.7);
    expect(tuning.tank.telegraphSeconds).toBeGreaterThanOrEqual(0.7);
    expect(tuning.aa.telegraphSeconds).toBeGreaterThanOrEqual(0.7);
    expect(tuning.jet.warningSeconds).toBeGreaterThanOrEqual(0.7);
    expect(tuning.drone.gunTelegraphSeconds).toBeGreaterThanOrEqual(0.7);
  });
});

describe('rifle infantry', () => {
  const tuning = defaultEnemyTuning();

  it('never fires before its telegraph window elapses', () => {
    const rifle = createRifleInfantry(1, { x: 0, y: 0 });
    const view = makeView({ heightAboveGround: 2, position: { x: 5, y: 0 } });
    let fired = false;
    let elapsed = 0;
    while (elapsed < tuning.rifle.telegraphSeconds - DT) {
      const result = stepEnemy(rifle, view, tuning);
      if (result.fire) fired = true;
      elapsed += DT;
    }
    expect(fired).toBe(false);
  });

  it('fires once the telegraph completes, but only while the helicopter is at low altitude', () => {
    const rifle = createRifleInfantry(2, { x: 0, y: 0 });
    const view = makeView({ heightAboveGround: 2, position: { x: 5, y: 0 } });
    let fired = false;
    for (let i = 0; i < 200 && !fired; i++) {
      const result = stepEnemy(rifle, view, tuning);
      if (result.fire) fired = true;
    }
    expect(fired).toBe(true);
  });

  it('will not engage a helicopter above its low-altitude threshold', () => {
    const rifle = createRifleInfantry(3, { x: 0, y: 0 });
    const view = makeView({ heightAboveGround: 50, position: { x: 5, y: 0 } });
    for (let i = 0; i < 200; i++) stepEnemy(rifle, view, tuning);
    expect(rifle.state).not.toBe('aiming');
  });

  it('is suppressed into cover by a near miss regardless of its current state', () => {
    const rifle = createRifleInfantry(4, { x: 0, y: 0 });
    rifle.state = 'aiming';
    rifle.aimTimer = 0.5;
    rifle.pendingSuppression = true;
    const result = stepEnemy(
      rifle,
      makeView({ heightAboveGround: 2, position: { x: 5, y: 0 } }),
      tuning,
    );
    expect(rifle.state).toBe('suppressed');
    expect(result.stateChanged).toBe('suppressed');
    expect(result.fire).toBeNull();
  });

  it('holds suppression for its full duration, then returns to cover rather than firing immediately', () => {
    const rifle = createRifleInfantry(5, { x: 0, y: 0 });
    rifle.pendingSuppression = true;
    const view = makeView({ heightAboveGround: 2, position: { x: 5, y: 0 } });
    stepEnemy(rifle, view, tuning);
    expect(rifle.state).toBe('suppressed');
    let ticks = 0;
    while (rifle.state === 'suppressed' && ticks < 1000) {
      stepEnemy(rifle, view, tuning);
      ticks++;
    }
    expect(rifle.state).toBe('cover');
    expect(ticks * DT).toBeGreaterThanOrEqual(tuning.rifle.suppressionSeconds - DT);
  });
});

describe('RPG infantry', () => {
  const tuning = defaultEnemyTuning();

  it('telegraphs for exactly 1.1 seconds before firing', () => {
    expect(tuning.rpg.telegraphSeconds).toBeCloseTo(1.1, 5);
    const rpg = createRpgInfantry(10, { x: 0, y: 0 });
    const view = makeView({ grounded: true, position: { x: 10, y: 0 } });
    let ticks = 0;
    let fired = false;
    while (!fired) {
      const result = stepEnemy(rpg, view, tuning);
      if (result.fire) fired = true;
      ticks++;
      if (ticks > 500) throw new Error('RPG never fired');
    }
    const elapsedSeconds = ticks * DT;
    expect(elapsedSeconds).toBeGreaterThanOrEqual(1.1);
    expect(elapsedSeconds).toBeLessThan(1.1 + 4 * DT);
  });

  it('relocates away from the player after firing instead of standing still', () => {
    const rpg = createRpgInfantry(11, { x: 0, y: 0 });
    const view = makeView({ grounded: true, position: { x: 10, y: 0 } });
    let fired = false;
    for (let i = 0; i < 500 && !fired; i++) {
      const result = stepEnemy(rpg, view, tuning);
      if (result.fire) fired = true;
    }
    expect(fired).toBe(true);
    expect(rpg.state).toBe('relocating');
    const startX = rpg.position.x;
    for (let i = 0; i < 300 && (rpg.state as string) === 'relocating'; i++)
      stepEnemy(rpg, view, tuning);
    expect(rpg.state).toBe('seeking');
    expect(rpg.position.x).not.toBe(startX);
  });

  it('prioritises a hovering or grounded helicopter and ignores a fast-moving one', () => {
    const rpg = createRpgInfantry(12, { x: 0, y: 0 });
    const view = makeView({
      grounded: false,
      velocity: { x: 40, y: 0 },
      position: { x: 10, y: 0 },
    });
    for (let i = 0; i < 200; i++) stepEnemy(rpg, view, tuning);
    expect(rpg.state).toBe('seeking');
  });
});

describe('light tank', () => {
  const tuning = defaultEnemyTuning();

  it('cannot hit a high hover but can hit the same helicopter grounded', () => {
    const tank = createLightTank(20, { x: 0, y: 0 }, -50, 50);
    const highHover = makeView({
      position: { x: 20, y: 80 },
      heightAboveGround: 80,
      grounded: false,
    });
    expect(canLightTankEngage(tank, highHover, tuning.tank)).toBe(false);

    const grounded = makeView({ position: { x: 20, y: 0 }, heightAboveGround: 0, grounded: true });
    expect(canLightTankEngage(tank, grounded, tuning.tank)).toBe(true);
  });

  it('traverses its turret toward the target independently of the hull, exposing an observable firing line', () => {
    const tank = createLightTank(21, { x: 0, y: 0 }, -50, 50);
    const view = makeView({ position: { x: 20, y: 10 }, heightAboveGround: 10, grounded: false });
    stepEnemy(tank, view, tuning);
    expect(tank.turretAngle).toBeGreaterThan(0);
    expect(tank.firingLineClear).toBe(false);
    let ticks = 0;
    while (!tank.firingLineClear && ticks < 200) {
      stepEnemy(tank, view, tuning);
      ticks++;
    }
    expect(tank.firingLineClear).toBe(true);
  });

  it('eventually fires on a grounded in-range target and applies heavier damage from the rear arc', () => {
    const tank = createLightTank(22, { x: 0, y: 0 }, -50, 50);
    tank.hullFacing = 1;
    const view = makeView({ position: { x: 20, y: 0 }, grounded: true });
    let fired = false;
    for (let i = 0; i < 300 && !fired; i++) {
      const result = stepEnemy(tank, view, tuning);
      if (result.fire) fired = true;
    }
    expect(fired).toBe(true);

    const rearHit = lightTankDamageMultiplier(tank, { x: -1, y: 0 }, tuning.tank);
    const frontHit = lightTankDamageMultiplier(tank, { x: 1, y: 0 }, tuning.tank);
    expect(rearHit).toBeGreaterThan(frontHit);
  });
});

describe('AA gun', () => {
  const tuning = defaultEnemyTuning();

  it('leads a constant-velocity target: the computed aimpoint is exactly where the target will be when a shell gets there', () => {
    const shooter = { x: 0, y: 0 };
    const target = { x: 100, y: 0 };
    const targetVelocity = { x: 0, y: 20 };
    const shellSpeed = 110;
    const aimpoint = computeLeadAimpoint(shooter, target, targetVelocity, shellSpeed);
    expect(aimpoint).not.toBeNull();
    if (!aimpoint) return;
    const travelTime = Math.hypot(aimpoint.x - shooter.x, aimpoint.y - shooter.y) / shellSpeed;
    const targetAtThatTime = {
      x: target.x + targetVelocity.x * travelTime,
      y: target.y + targetVelocity.y * travelTime,
    };
    expect(Math.abs(aimpoint.x - targetAtThatTime.x)).toBeLessThan(1e-6);
    expect(Math.abs(aimpoint.y - targetAtThatTime.y)).toBeLessThan(1e-6);
  });

  it('returns null rather than a nonsense aimpoint when the target outruns the shell', () => {
    const aimpoint = computeLeadAimpoint({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 1000, y: 0 }, 50);
    expect(aimpoint).toBeNull();
  });

  it('fires a burst that leads the target instead of aiming at its current position', () => {
    const aa = createAaGun(30, { x: 0, y: 0 });
    const view = makeView({
      position: { x: 100, y: 0 },
      velocity: { x: 0, y: 25 },
      grounded: false,
      heightAboveGround: 60,
    });
    let fire: FireIntent | null = null;
    for (let i = 0; i < 300 && !fire; i++) {
      const result = stepEnemy(aa, view, tuning);
      if (result.fire) fire = result.fire;
    }
    expect(fire).not.toBeNull();
    if (!fire) return;
    const firedAngle = Math.atan2(fire.direction.y, fire.direction.x);
    // The target sits due east and is climbing north, so a leading shot must aim above the
    // straight line (angle 0) toward where the target will be, not where it is now.
    expect(firedAngle).toBeGreaterThan(0);
  });

  it('is suppressed by a near miss and cannot fire during suppression', () => {
    const aa = createAaGun(31, { x: 0, y: 0 });
    aa.pendingSuppression = true;
    const view = makeView({ position: { x: 50, y: 0 } });
    const result = stepEnemy(aa, view, tuning);
    expect(aa.state).toBe('suppressed');
    expect(result.fire).toBeNull();
  });

  it('a radar variant cannot engage when terrain masks line of sight, even well within range', () => {
    const aa = createAaGun(32, { x: 0, y: 0 }, true);
    const maskedView = makeView({ position: { x: 30, y: 0 } }, { hasLineOfSight: () => false });
    for (let i = 0; i < 100; i++) stepEnemy(aa, maskedView, tuning);
    expect(aa.state).toBe('idle');
  });

  it('sweeps its scan cone continuously while the radar variant is active', () => {
    const aa = createAaGun(33, { x: 0, y: 0 }, true);
    const view = makeView();
    const start = aa.scanAngle;
    stepEnemy(aa, view, tuning);
    expect(aa.scanAngle).not.toBe(start);
  });
});

describe('interceptor jet', () => {
  const tuning = defaultEnemyTuning();

  it('performs exactly one attack pass with a bounded missile volley, then returns to cooldown', () => {
    const jet = createJet(40, 1, tuning.jet);
    const view = makeView({ position: { x: 0, y: 90 }, grounded: false, heightAboveGround: 90 });
    let attackPassEntries = 0;
    let firesDuringThisPass = 0;
    let sawCooldownAfterPass = false;
    const totalTicks = Math.ceil(
      (tuning.jet.warningSeconds + tuning.jet.attackPassSeconds + 0.5) / DT,
    );
    for (let i = 0; i < totalTicks; i++) {
      const result = stepEnemy(jet, view, tuning);
      if (result.stateChanged === 'attackPass') attackPassEntries++;
      if (jet.state === 'attackPass' && result.fire) firesDuringThisPass++;
      if (result.stateChanged === 'cooldown') sawCooldownAfterPass = true;
    }
    expect(attackPassEntries).toBe(1);
    expect(firesDuringThisPass).toBeGreaterThan(0);
    expect(firesDuringThisPass).toBeLessThanOrEqual(tuning.jet.missileVolleyCount);
    expect(sawCooldownAfterPass).toBe(true);
    expect(jet.state).toBe('cooldown');
  });

  it('never fires before the warning period ends', () => {
    const jet = createJet(41, 1, tuning.jet);
    const view = makeView({ position: { x: 0, y: 90 }, grounded: false, heightAboveGround: 90 });
    const ticksInWarning = Math.floor(tuning.jet.warningSeconds / DT);
    let fired = false;
    for (let i = 0; i < ticksInWarning; i++) {
      const result = stepEnemy(jet, view, tuning);
      if (result.fire) fired = true;
    }
    expect(fired).toBe(false);
    expect(jet.state).not.toBe('attackPass');
  });

  it('does not re-enter (start a second warning) until the full cooldown has elapsed', () => {
    const jet = createJet(42, 1, tuning.jet);
    const view = makeView({ position: { x: 0, y: 90 }, grounded: false, heightAboveGround: 90 });
    const oneCycleTicks =
      Math.ceil(tuning.jet.warningSeconds / DT) + Math.ceil(tuning.jet.attackPassSeconds / DT) + 5;
    for (let i = 0; i < oneCycleTicks; i++) stepEnemy(jet, view, tuning);
    expect(jet.state).toBe('cooldown');

    const ticksBeforeCooldownEnds = Math.max(0, Math.floor(tuning.jet.cooldownSeconds / DT) - 3);
    for (let i = 0; i < ticksBeforeCooldownEnds; i++) {
      const result = stepEnemy(jet, view, tuning);
      expect(result.stateChanged).not.toBe('warning');
    }
    expect(jet.state).toBe('cooldown');

    let sawSecondWarning = false;
    for (let i = 0; i < 10; i++) {
      const result = stepEnemy(jet, view, tuning);
      if (result.stateChanged === 'warning') sawSecondWarning = true;
    }
    expect(sawSecondWarning).toBe(true);
  });
});

describe('homing drone', () => {
  const tuning = defaultEnemyTuning();

  it('refuses to acquire the player without line-of-sight exposure, even well within range', () => {
    const drone = createDrone(50, { x: 0, y: 0 });
    const blockedView = makeView({ position: { x: 30, y: 0 } }, { hasLineOfSight: () => false });
    for (let i = 0; i < 50; i++) stepEnemy(drone, blockedView, tuning);
    expect(drone.acquired).toBe(false);
    expect(drone.state).toBe('dormant');
  });

  it('acquires once exposed to line of sight, then pursues persistently across the base boundary', () => {
    const drone = createDrone(51, { x: 0, y: 0 });
    const baseBoundaryX = -20;
    const acquireView = makeView({ position: { x: 30, y: 0 } });
    stepEnemy(drone, acquireView, tuning);
    expect(drone.acquired).toBe(true);

    const retreatingView = makeView({ position: { x: baseBoundaryX - 10, y: 0 } });
    for (let i = 0; i < 2000 && drone.position.x > baseBoundaryX; i++) {
      stepEnemy(drone, retreatingView, tuning);
    }
    expect(drone.position.x).toBeLessThanOrEqual(baseBoundaryX);
  });

  it('gains its short-range gun only once unlocked, and still telegraphs before firing', () => {
    const drone = createDrone(52, { x: 0, y: 0 });
    drone.acquired = true;
    drone.state = 'pursuing';
    const closeView = makeView({ position: { x: 5, y: 0 } });

    for (let i = 0; i < 30; i++) stepEnemy(drone, closeView, tuning);
    expect(drone.gunState).toBe('idle');

    drone.gunUnlocked = true;
    let fired = false;
    let ticksToFire = 0;
    for (let i = 0; i < 300 && !fired; i++) {
      const result = stepEnemy(drone, closeView, tuning);
      if (result.fire) fired = true;
      ticksToFire++;
    }
    expect(fired).toBe(true);
    expect(ticksToFire * DT).toBeGreaterThanOrEqual(tuning.drone.gunTelegraphSeconds);
  });
});
