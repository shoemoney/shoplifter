/**
 * Input is abstracted into named actions before the simulation ever sees it. Systems read
 * `ActionState`; they never read a key code. That is what makes full remapping, gamepad
 * parity, replay playback and synthetic test input all the same code path.
 */
export const AXIS_ACTIONS = ['thrustX', 'thrustY', 'aimX', 'aimY'] as const;
export type AxisAction = (typeof AXIS_ACTIONS)[number];

export const BUTTON_ACTIONS = [
  'firePrimary',
  'fireSecondary',
  'yawLeft',
  'yawRight',
  'interact',
  'flares',
  'boost',
  'cycleSecondary',
  'pause',
] as const;
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];

export type Action = AxisAction | ButtonAction;

export interface ButtonState {
  /** True for every tick the button is held. */
  down: boolean;
  /** True only on the tick the press was consumed. */
  pressed: boolean;
  released: boolean;
  /** Sim tick the press was registered on, for the 100 ms input buffer. */
  pressTick: number;
}

export interface ActionState {
  axes: Record<AxisAction, number>;
  buttons: Record<ButtonAction, ButtonState>;
}

export const createActionState = (): ActionState => ({
  axes: { thrustX: 0, thrustY: 0, aimX: 0, aimY: 0 },
  buttons: Object.fromEntries(
    BUTTON_ACTIONS.map((action) => [
      action,
      { down: false, pressed: false, released: false, pressTick: -1 },
    ]),
  ) as Record<ButtonAction, ButtonState>,
});

export interface AxisTuning {
  /** Radial dead zone applied before normalization, in [0, 0.9]. */
  deadZone: number;
  invert: boolean;
  /** 1 = linear, >1 = finer control near centre. */
  curve: number;
}

export const defaultAxisTuning = (): AxisTuning => ({ deadZone: 0.12, invert: false, curve: 1.6 });

/** Applies dead zone, response curve and inversion. Output stays in [-1, 1]. */
export const shapeAxis = (raw: number, tuning: AxisTuning): number => {
  const clamped = raw < -1 ? -1 : raw > 1 ? 1 : raw;
  const magnitude = Math.abs(clamped);
  if (magnitude <= tuning.deadZone) return 0;
  const normalized = (magnitude - tuning.deadZone) / (1 - tuning.deadZone);
  const curved = Math.pow(normalized, tuning.curve);
  const signed = curved * Math.sign(clamped);
  return tuning.invert ? -signed : signed;
};

/**
 * Accumulates raw device input, then produces one immutable snapshot per simulation tick.
 * Edge flags are computed at snapshot time so a press that happens between ticks is never
 * lost and never double-counted.
 */
export class ActionMap {
  private readonly axisRaw: Record<AxisAction, number>;
  private readonly held: Record<ButtonAction, boolean>;
  private readonly buffered: Record<ButtonAction, boolean>;
  private readonly state: ActionState;
  readonly tuning: Record<AxisAction, AxisTuning>;

  constructor() {
    this.axisRaw = { thrustX: 0, thrustY: 0, aimX: 0, aimY: 0 };
    this.held = Object.fromEntries(BUTTON_ACTIONS.map((a) => [a, false])) as Record<
      ButtonAction,
      boolean
    >;
    this.buffered = Object.fromEntries(BUTTON_ACTIONS.map((a) => [a, false])) as Record<
      ButtonAction,
      boolean
    >;
    this.tuning = Object.fromEntries(AXIS_ACTIONS.map((a) => [a, defaultAxisTuning()])) as Record<
      AxisAction,
      AxisTuning
    >;
    this.state = createActionState();
  }

  setAxis(action: AxisAction, raw: number): void {
    this.axisRaw[action] = raw;
  }

  /** Devices report edges; `buffered` survives until the next snapshot consumes it. */
  setButton(action: ButtonAction, down: boolean): void {
    if (down && !this.held[action]) this.buffered[action] = true;
    this.held[action] = down;
  }

  clear(): void {
    for (const action of AXIS_ACTIONS) this.axisRaw[action] = 0;
    for (const action of BUTTON_ACTIONS) {
      this.held[action] = false;
      this.buffered[action] = false;
    }
  }

  /** Builds the per-tick snapshot. Mutates and returns the same object to avoid allocating. */
  snapshot(tick: number): ActionState {
    for (const action of AXIS_ACTIONS) {
      this.state.axes[action] = shapeAxis(this.axisRaw[action], this.tuning[action]);
    }
    for (const action of BUTTON_ACTIONS) {
      const button = this.state.buttons[action];
      const wasDown = button.down;
      const isDown = this.held[action] || this.buffered[action];
      button.pressed = isDown && !wasDown;
      button.released = !isDown && wasDown;
      button.down = isDown;
      if (button.pressed) button.pressTick = tick;
      this.buffered[action] = false;
    }
    return this.state;
  }

  get current(): ActionState {
    return this.state;
  }
}

/** PRD requires a 100 ms buffer on yaw and countermeasures. */
export const isBuffered = (
  button: ButtonState,
  tick: number,
  tickHz: number,
  windowMs = 100,
): boolean => button.pressTick >= 0 && (tick - button.pressTick) * (1000 / tickHz) <= windowMs;
