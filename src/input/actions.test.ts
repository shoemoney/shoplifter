import { describe, expect, it } from 'vitest';
import { ActionMap, defaultAxisTuning, isBuffered, shapeAxis } from './actions.js';

describe('shapeAxis', () => {
  it('zeroes input inside the dead zone', () => {
    const tuning = { deadZone: 0.2, invert: false, curve: 1 };
    expect(shapeAxis(0.15, tuning)).toBe(0);
    expect(shapeAxis(-0.2, tuning)).toBe(0);
  });

  it('renormalizes so full deflection still reaches 1', () => {
    const tuning = { deadZone: 0.25, invert: false, curve: 1 };
    expect(shapeAxis(1, tuning)).toBeCloseTo(1, 6);
    expect(shapeAxis(-1, tuning)).toBeCloseTo(-1, 6);
  });

  it('applies the response curve without losing sign', () => {
    const tuning = { deadZone: 0, invert: false, curve: 2 };
    expect(shapeAxis(0.5, tuning)).toBeCloseTo(0.25, 6);
    expect(shapeAxis(-0.5, tuning)).toBeCloseTo(-0.25, 6);
  });

  it('inverts when asked — the 1982 axis-reversal option', () => {
    const tuning = { deadZone: 0, invert: true, curve: 1 };
    expect(shapeAxis(0.5, tuning)).toBeCloseTo(-0.5, 6);
  });

  it('clamps out-of-range device values', () => {
    expect(shapeAxis(3, defaultAxisTuning())).toBeLessThanOrEqual(1);
    expect(shapeAxis(-3, defaultAxisTuning())).toBeGreaterThanOrEqual(-1);
  });
});

describe('ActionMap', () => {
  it('reports pressed only on the tick of the press', () => {
    const map = new ActionMap();
    map.setButton('firePrimary', true);
    let state = map.snapshot(1);
    expect(state.buttons.firePrimary.pressed).toBe(true);
    expect(state.buttons.firePrimary.down).toBe(true);

    state = map.snapshot(2);
    expect(state.buttons.firePrimary.pressed).toBe(false);
    expect(state.buttons.firePrimary.down).toBe(true);
  });

  it('reports released once', () => {
    const map = new ActionMap();
    map.setButton('flares', true);
    map.snapshot(1);
    map.setButton('flares', false);
    expect(map.snapshot(2).buttons.flares.released).toBe(true);
    expect(map.snapshot(3).buttons.flares.released).toBe(false);
  });

  it('never loses a press that begins and ends between ticks', () => {
    const map = new ActionMap();
    map.setButton('yawLeft', true);
    map.setButton('yawLeft', false);
    const state = map.snapshot(10);
    expect(state.buttons.yawLeft.pressed).toBe(true);
    expect(map.snapshot(11).buttons.yawLeft.down).toBe(false);
  });

  it('records the press tick for input buffering', () => {
    const map = new ActionMap();
    map.setButton('yawRight', true);
    const state = map.snapshot(240);
    expect(state.buttons.yawRight.pressTick).toBe(240);
    // 100 ms at 120 Hz is 12 ticks.
    expect(isBuffered(state.buttons.yawRight, 250, 120)).toBe(true);
    expect(isBuffered(state.buttons.yawRight, 260, 120)).toBe(false);
  });

  it('shapes axes through the per-axis tuning', () => {
    const map = new ActionMap();
    map.tuning.thrustY.invert = true;
    map.tuning.thrustY.curve = 1;
    map.tuning.thrustY.deadZone = 0;
    map.setAxis('thrustY', 0.5);
    expect(map.snapshot(1).axes.thrustY).toBeCloseTo(-0.5, 6);
  });

  it('clear() drops held state so a blurred window cannot pin the throttle', () => {
    const map = new ActionMap();
    map.setAxis('thrustX', 1);
    map.setButton('boost', true);
    map.snapshot(1);
    map.clear();
    const state = map.snapshot(2);
    expect(state.axes.thrustX).toBe(0);
    expect(state.buttons.boost.down).toBe(false);
  });

  it('reuses the snapshot object to avoid per-tick allocation', () => {
    const map = new ActionMap();
    expect(map.snapshot(1)).toBe(map.snapshot(2));
  });
});
