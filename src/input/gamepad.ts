import { AXIS_ACTIONS, BUTTON_ACTIONS, type ActionMap } from './actions.js';
import type { GamepadBindings } from './rebinding.js';

export interface GamepadStatus {
  connected: boolean;
  id: string | null;
  index: number | null;
  mapping: string | null;
}

/**
 * Polled per frame — the Gamepad API deliberately gives no events for axis/button state, and
 * `navigator.getGamepads()` returns fresh snapshot objects each call rather than live ones.
 */
export class GamepadSource {
  private bindings: GamepadBindings;
  private readonly actionMap: ActionMap;
  private activeIndex: number | null = null;
  private lastId: string | null = null;
  private lastMapping: string | null = null;

  constructor(actionMap: ActionMap, bindings: GamepadBindings) {
    this.actionMap = actionMap;
    this.bindings = bindings;
  }

  setBindings(bindings: GamepadBindings): void {
    this.bindings = bindings;
  }

  status(): GamepadStatus {
    return {
      connected: this.activeIndex !== null,
      id: this.lastId,
      index: this.activeIndex,
      mapping: this.lastMapping,
    };
  }

  /** Returns true when a pad supplied input this frame. Safe to call with no Gamepad API. */
  poll(): boolean {
    const pads =
      typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = this.pickPad(pads);
    if (!pad) {
      if (this.activeIndex !== null) {
        // Disconnect mid-mission must not leave thrust pinned.
        this.zeroBoundInputs();
        this.activeIndex = null;
      }
      return false;
    }

    this.activeIndex = pad.index;
    this.lastId = pad.id;
    this.lastMapping = pad.mapping;

    for (const action of AXIS_ACTIONS) {
      const binding = this.bindings.axes[action];
      if (!binding) continue;
      const raw = pad.axes[binding.index];
      if (raw === undefined) continue;
      this.actionMap.setAxis(action, raw * binding.scale);
    }
    for (const action of BUTTON_ACTIONS) {
      const indices = this.bindings.buttons[action];
      if (!indices) continue;
      let down = false;
      for (const index of indices) {
        const button = pad.buttons[index];
        // Triggers are analog: treat past half travel as pressed.
        if (button && (button.pressed || button.value > 0.5)) down = true;
      }
      this.actionMap.setButton(action, down);
    }
    return true;
  }

  private pickPad(pads: ReadonlyArray<Gamepad | null>): Gamepad | null {
    if (this.activeIndex !== null) {
      const current = pads[this.activeIndex];
      if (current?.connected) return current;
    }
    for (const pad of pads) {
      if (pad?.connected) return pad;
    }
    return null;
  }

  private zeroBoundInputs(): void {
    for (const action of AXIS_ACTIONS) {
      if (this.bindings.axes[action]) this.actionMap.setAxis(action, 0);
    }
    for (const action of BUTTON_ACTIONS) {
      if (this.bindings.buttons[action]) this.actionMap.setButton(action, false);
    }
  }
}
