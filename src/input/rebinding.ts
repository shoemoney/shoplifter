import type { Action, AxisAction, ButtonAction } from './actions.js';
import { AXIS_ACTIONS, BUTTON_ACTIONS } from './actions.js';

/** A keyboard/mouse binding. `code` is a KeyboardEvent.code or `Mouse0`..`Mouse4`. */
export interface KeyBinding {
  code: string;
  /** For axis actions: which direction this key drives. */
  axisDirection?: -1 | 1;
}

export interface KeyboardBindings {
  axes: Record<AxisAction, KeyBinding[]>;
  buttons: Record<ButtonAction, KeyBinding[]>;
  /** Axes driven by mouse position rather than keys. */
  mouseAxes: AxisAction[];
}

export interface GamepadBindings {
  /** Gamepad axis index per action, with direction. */
  axes: Partial<Record<AxisAction, { index: number; scale: 1 | -1 }>>;
  /** Gamepad button indices per action (standard mapping). */
  buttons: Partial<Record<ButtonAction, number[]>>;
}

export interface Bindings {
  keyboard: KeyboardBindings;
  gamepad: GamepadBindings;
}

export const defaultKeyboardBindings = (): KeyboardBindings => ({
  axes: {
    thrustX: [
      { code: 'KeyA', axisDirection: -1 },
      { code: 'KeyD', axisDirection: 1 },
    ],
    thrustY: [
      { code: 'KeyS', axisDirection: -1 },
      { code: 'KeyW', axisDirection: 1 },
    ],
    aimX: [],
    aimY: [],
  },
  buttons: {
    firePrimary: [{ code: 'Mouse0' }],
    fireSecondary: [{ code: 'Mouse2' }],
    yawLeft: [{ code: 'KeyQ' }],
    yawRight: [{ code: 'KeyE' }],
    interact: [{ code: 'KeyR' }],
    flares: [{ code: 'KeyF' }],
    boost: [{ code: 'Space' }],
    cycleSecondary: [{ code: 'Digit1' }, { code: 'Digit2' }, { code: 'Digit3' }],
    pause: [{ code: 'Escape' }],
  },
  mouseAxes: ['aimX', 'aimY'],
});

/** Standard gamepad mapping: https://w3c.github.io/gamepad/#remapping */
export const defaultGamepadBindings = (): GamepadBindings => ({
  axes: {
    thrustX: { index: 0, scale: 1 },
    thrustY: { index: 1, scale: -1 },
    aimX: { index: 2, scale: 1 },
    aimY: { index: 3, scale: -1 },
  },
  buttons: {
    firePrimary: [7],
    fireSecondary: [6],
    yawLeft: [4],
    yawRight: [5],
    interact: [0],
    flares: [1],
    boost: [2],
    cycleSecondary: [3],
    pause: [9],
  },
});

export const defaultBindings = (): Bindings => ({
  keyboard: defaultKeyboardBindings(),
  gamepad: defaultGamepadBindings(),
});

/**
 * "Classic controls" preset from the PRD: stick moves, one button fires, one button cycles
 * left/front/right orientation. Yaw collapses onto a single action so the original's
 * short-press/long-press orientation button has a modern equivalent.
 */
export const classicGamepadBindings = (): GamepadBindings => ({
  axes: {
    thrustX: { index: 0, scale: 1 },
    thrustY: { index: 1, scale: -1 },
  },
  buttons: {
    firePrimary: [0, 7],
    yawRight: [1, 5],
    pause: [9],
  },
});

export const ALL_ACTIONS: readonly Action[] = [...AXIS_ACTIONS, ...BUTTON_ACTIONS];

export interface BindingConflict {
  code: string;
  actions: Action[];
}

/** Reports codes bound to more than one action so the settings UI can warn instead of silently shadowing. */
export const findKeyboardConflicts = (bindings: KeyboardBindings): BindingConflict[] => {
  const byCode = new Map<string, Action[]>();
  const record = (code: string, action: Action): void => {
    const list = byCode.get(code);
    if (list) list.push(action);
    else byCode.set(code, [action]);
  };
  for (const action of AXIS_ACTIONS) {
    for (const binding of bindings.axes[action])
      record(`${binding.code}:${binding.axisDirection ?? 0}`, action);
  }
  for (const action of BUTTON_ACTIONS) {
    for (const binding of bindings.buttons[action]) record(binding.code, action);
  }
  const conflicts: BindingConflict[] = [];
  for (const [code, actions] of byCode) {
    if (actions.length > 1) conflicts.push({ code, actions });
  }
  return conflicts;
};

export const rebindButton = (
  bindings: KeyboardBindings,
  action: ButtonAction,
  code: string,
  { replace = true }: { replace?: boolean } = {},
): KeyboardBindings => {
  const next: KeyboardBindings = {
    axes: { ...bindings.axes },
    buttons: { ...bindings.buttons },
    mouseAxes: [...bindings.mouseAxes],
  };
  // Strip the code from every other action first; a code bound twice shadows unpredictably.
  for (const other of BUTTON_ACTIONS) {
    next.buttons[other] = next.buttons[other].filter((b) => b.code !== code);
  }
  next.buttons[action] = replace ? [{ code }] : [...next.buttons[action], { code }];
  return next;
};
