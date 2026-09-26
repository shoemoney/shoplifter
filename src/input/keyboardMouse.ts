import { AXIS_ACTIONS, BUTTON_ACTIONS, type ActionMap, type AxisAction } from './actions.js';
import type { KeyboardBindings } from './rebinding.js';

export interface KeyboardMouseOptions {
  target: HTMLElement;
  bindings: KeyboardBindings;
  /** Called when Escape is pressed, so the app can pause even while pointer-locked. */
  onPause?: () => void;
}

/**
 * Translates DOM keyboard/mouse events into the ActionMap. Nothing here touches the
 * simulation; the sim only ever sees the per-tick snapshot.
 */
export class KeyboardMouseSource {
  private readonly held = new Set<string>();
  private readonly listeners: Array<() => void> = [];
  private bindings: KeyboardBindings;
  private readonly actionMap: ActionMap;
  private readonly target: HTMLElement;
  /** Pointer position in [-1, 1] canvas space, y up. */
  private pointer = { x: 0, y: 0 };
  private attached = false;

  constructor(actionMap: ActionMap, options: KeyboardMouseOptions) {
    this.actionMap = actionMap;
    this.bindings = options.bindings;
    this.target = options.target;
    this.onPause = options.onPause;
  }

  private readonly onPause: (() => void) | undefined;

  setBindings(bindings: KeyboardBindings): void {
    this.bindings = bindings;
    this.held.clear();
    this.apply();
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;

    const keyDown = (event: KeyboardEvent): void => {
      if (event.repeat) return;
      this.held.add(event.code);
      if (event.code === 'Escape') this.onPause?.();
      if (this.isBound(event.code)) event.preventDefault();
      this.apply();
    };
    const keyUp = (event: KeyboardEvent): void => {
      this.held.delete(event.code);
      this.apply();
    };
    // A blurred window never delivers keyup, so held keys would stick on forever.
    const blur = (): void => {
      this.held.clear();
      this.actionMap.clear();
      this.apply();
    };
    const mouseDown = (event: MouseEvent): void => {
      this.held.add(`Mouse${event.button}`);
      this.apply();
    };
    const mouseUp = (event: MouseEvent): void => {
      this.held.delete(`Mouse${event.button}`);
      this.apply();
    };
    const mouseMove = (event: MouseEvent): void => {
      const rect = this.target.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      this.apply();
    };
    const contextMenu = (event: MouseEvent): void => event.preventDefault();

    const bind = <K extends keyof WindowEventMap>(
      node: Window | HTMLElement,
      type: K,
      handler: (event: WindowEventMap[K]) => void,
    ): void => {
      node.addEventListener(type, handler as EventListener);
      this.listeners.push(() => node.removeEventListener(type, handler as EventListener));
    };

    bind(window, 'keydown', keyDown);
    bind(window, 'keyup', keyUp);
    bind(window, 'blur', blur);
    bind(this.target, 'mousedown', mouseDown);
    bind(window, 'mouseup', mouseUp);
    bind(window, 'mousemove', mouseMove);
    bind(this.target, 'contextmenu', contextMenu);
  }

  detach(): void {
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.held.clear();
    this.attached = false;
  }

  private isBound(code: string): boolean {
    for (const action of BUTTON_ACTIONS) {
      if (this.bindings.buttons[action].some((b) => b.code === code)) return true;
    }
    for (const action of AXIS_ACTIONS) {
      if (this.bindings.axes[action].some((b) => b.code === code)) return true;
    }
    return false;
  }

  private apply(): void {
    for (const action of AXIS_ACTIONS) {
      if (this.bindings.mouseAxes.includes(action)) {
        this.actionMap.setAxis(action, action === 'aimX' ? this.pointer.x : this.pointer.y);
        continue;
      }
      let value = 0;
      for (const binding of this.bindings.axes[action]) {
        if (this.held.has(binding.code)) value += binding.axisDirection ?? 1;
      }
      this.actionMap.setAxis(action, value < -1 ? -1 : value > 1 ? 1 : value);
    }
    for (const action of BUTTON_ACTIONS) {
      const down = this.bindings.buttons[action].some((b) => this.held.has(b.code));
      this.actionMap.setButton(action, down);
    }
  }

  /** Exposed for the debug overlay and tests. */
  pointerPosition(): { x: number; y: number } {
    return { ...this.pointer };
  }

  /** Keyboard axes are digital, so no dead zone should eat the first frame of input. */
  static digitalAxes(): AxisAction[] {
    return ['thrustX', 'thrustY'];
  }
}
