import { describe, expect, it } from 'vitest';
import {
  classicGamepadBindings,
  defaultBindings,
  findKeyboardConflicts,
  rebindButton,
} from './rebinding.js';

describe('default bindings', () => {
  it('matches the PRD keyboard layout', () => {
    const { keyboard } = defaultBindings();
    expect(keyboard.axes.thrustX).toEqual([
      { code: 'KeyA', axisDirection: -1 },
      { code: 'KeyD', axisDirection: 1 },
    ]);
    expect(keyboard.buttons.boost[0]?.code).toBe('Space');
    expect(keyboard.buttons.flares[0]?.code).toBe('KeyF');
    expect(keyboard.mouseAxes).toContain('aimX');
  });

  it('ships without conflicts', () => {
    expect(findKeyboardConflicts(defaultBindings().keyboard)).toEqual([]);
  });

  it('maps gamepad triggers to fire actions under the standard mapping', () => {
    const { gamepad } = defaultBindings();
    expect(gamepad.buttons.firePrimary).toEqual([7]);
    expect(gamepad.buttons.fireSecondary).toEqual([6]);
    expect(gamepad.axes.thrustY).toEqual({ index: 1, scale: -1 });
  });
});

describe('classic preset', () => {
  it('collapses to stick, fire, and one orientation button', () => {
    const classic = classicGamepadBindings();
    expect(classic.axes.aimX).toBeUndefined();
    expect(classic.buttons.firePrimary).toContain(0);
    expect(classic.buttons.yawLeft).toBeUndefined();
    expect(classic.buttons.yawRight).toContain(1);
  });
});

describe('rebindButton', () => {
  it('replaces the binding for the target action', () => {
    const next = rebindButton(defaultBindings().keyboard, 'flares', 'KeyG');
    expect(next.buttons.flares).toEqual([{ code: 'KeyG' }]);
  });

  it('strips the code from every other action so nothing is shadowed', () => {
    const next = rebindButton(defaultBindings().keyboard, 'flares', 'Space');
    expect(next.buttons.boost).toEqual([]);
    expect(findKeyboardConflicts(next)).toEqual([]);
  });

  it('can append instead of replacing', () => {
    const next = rebindButton(defaultBindings().keyboard, 'interact', 'KeyG', { replace: false });
    expect(next.buttons.interact.map((b) => b.code)).toEqual(['KeyR', 'KeyG']);
  });

  it('does not mutate the input bindings', () => {
    const original = defaultBindings().keyboard;
    rebindButton(original, 'flares', 'KeyG');
    expect(original.buttons.flares).toEqual([{ code: 'KeyF' }]);
  });
});

describe('findKeyboardConflicts', () => {
  it('reports a code bound to two actions', () => {
    const bindings = defaultBindings().keyboard;
    bindings.buttons.interact = [{ code: 'Space' }];
    const conflicts = findKeyboardConflicts(bindings);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.actions.sort()).toEqual(['boost', 'interact']);
  });
});
