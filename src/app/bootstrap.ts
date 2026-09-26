import { GameApp, type GameStats } from './gameApp.js';
import { WebGpuUnsupportedError, probeWebGpuSupport } from '@/render/webgpu/context.js';
import { showUnsupportedScreen } from '@/ui/unsupported.js';
import { IndexedDbBackend, MemoryBackend, SaveStore } from '@/save/store.js';

/** Test/debug surface. Playwright drives the app through this instead of guessing at pixels. */
export interface ShoplifterTestHooks {
  version: string;
  status: 'booting' | 'running' | 'unsupported' | 'error';
  reason?: string | undefined;
  stats: () => GameStats | null;
  simulateDeviceLoss: () => void;
  toggleOverlay: (force?: boolean) => void;
  togglePause: () => void;
  restart: () => void;
  /** Debug commands: force a mission phase, spawn every actor, jump the aircraft. */
  debug: {
    forcePhase: (phase: 'active' | 'complete' | 'failed') => void;
    spawnAll: () => number;
    releaseAllCivilians: () => void;
    teleport: (x: number, y?: number) => void;
  } | null;
}

declare global {
  interface Window {
    shoplifter?: ShoplifterTestHooks;
  }
}

const requireElement = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`bootstrap: #${id} is missing from index.html`);
  return element as T;
};

const boot = async (): Promise<void> => {
  const canvas = requireElement<HTMLCanvasElement>('stage');
  const overlay = requireElement('overlay');
  const hud = requireElement('hud');
  const pause = requireElement('pause');
  const debrief = requireElement('debrief');
  const fallback = requireElement('fallback');

  let app: GameApp | null = null;
  const hooks: ShoplifterTestHooks = {
    version: '0.0.1',
    status: 'booting',
    stats: () => app?.stats() ?? null,
    simulateDeviceLoss: () => app?.simulateDeviceLoss(),
    toggleOverlay: (force) => app?.toggleOverlay(force),
    togglePause: () => app?.togglePause(),
    restart: () => app?.restart(),
    debug: null,
  };
  window.shoplifter = hooks;

  const probe = probeWebGpuSupport();
  if (!probe.supported) {
    hooks.status = 'unsupported';
    hooks.reason = probe.reason;
    showUnsupportedScreen(fallback, probe.reason ?? 'no-navigator-gpu', probe.detail);
    canvas.hidden = true;
    hud.hidden = true;
    return;
  }

  try {
    const save = new SaveStore({
      backend: IndexedDbBackend.isAvailable() ? new IndexedDbBackend() : new MemoryBackend(),
    });
    // A save that will not load is a first run, never a crash — the mission still has to fly.
    const report = await save.load();
    if (report.result === 'recovered') {
      console.warn('[shoplifter] recovered a damaged save', report.issues);
    }

    app = await GameApp.start({ elements: { canvas, overlay, hud, pause, debrief }, save });
    hooks.debug = app.debug;
    hooks.status = 'running';
  } catch (error) {
    canvas.hidden = true;
    hud.hidden = true;
    if (error instanceof WebGpuUnsupportedError) {
      hooks.status = 'unsupported';
      hooks.reason = error.reason;
      showUnsupportedScreen(fallback, error.reason, error.message);
      return;
    }
    hooks.status = 'error';
    hooks.reason = error instanceof Error ? error.message : String(error);
    showUnsupportedScreen(
      fallback,
      'no-device',
      error instanceof Error ? error.message : String(error),
    );
    // Rethrow so the failure is visible in the console and in CI, not silently absorbed.
    throw error;
  }
};

// An unhandled rejection anywhere in boot must still produce a readable screen.
window.addEventListener('unhandledrejection', (event) => {
  console.error('[shoplifter] unhandled rejection', event.reason);
});

void boot();
