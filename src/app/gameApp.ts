import { FixedClock } from '@/core/clock.js';
import { Rng } from '@/core/rng.js';
import { clamp } from '@/core/math.js';
import { ActionMap } from '@/input/actions.js';
import { GamepadSource } from '@/input/gamepad.js';
import { KeyboardMouseSource } from '@/input/keyboardMouse.js';
import { defaultBindings } from '@/input/rebinding.js';
import { Camera, defaultCameraTuning } from '@/render/camera.js';
import { RenderHost, type RecoveryEvent } from '@/render/webgpu/deviceRecovery.js';
import { SpriteBatch, type Sprite } from '@/render/webgpu/spriteBatch.js';
import { loadAtlas, type LoadedAtlas } from '@/render/webgpu/textures.js';
import { loadCoreAtlasManifest } from '@/content/loaders/atlasLoader.js';
import { BalanceStore } from '@/content/loaders/balanceLoader.js';
import { DebugOverlay, FrameTimeline } from '@/debug/overlay.js';

export interface GameAppElements {
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
}

export interface GameStats {
  frames: number;
  tick: number;
  droppedTicks: number;
  fps: number;
  frameMeanMs: number;
  frameP99Ms: number;
  simMs: number;
  renderPrepMs: number;
  sprites: number;
  draws: number;
  adapter: string;
  recoveryPhase: string;
  recoveryAttempts: number;
  placeholderAssets: boolean;
  resolution: { width: number; height: number; dpr: number };
}

/**
 * Milestone 0 scene. Its job is to prove the pipeline end to end — instanced textured sprites,
 * fixed-step simulation, interpolated rendering, live input, camera framing — not to be the
 * game. The flight model in Milestone 1 replaces `stepDemo` outright.
 */
interface DemoState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface BackgroundSprite {
  /** Position inside the layer's repeating field, not a world position. */
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  alpha: number;
  region: 'star' | 'ground' | 'white' | 'glow';
  tint: [number, number, number];
  parallax: number;
  /**
   * Width of the repeating field, metres. Must exceed the widest viewport (~67 m at full
   * zoom-out) or wrapping leaves a bare strip at the screen edge.
   */
  fieldWidth: number;
}

const GROUND_Y = 0;
const DEMO_SEED = 0x63686f70; // "chop"

export class GameApp {
  private readonly host: RenderHost;
  private readonly balance: BalanceStore;
  private readonly clock: FixedClock;
  private readonly camera: Camera;
  private readonly actions: ActionMap;
  private readonly keyboard: KeyboardMouseSource;
  private readonly gamepad: GamepadSource;
  private readonly overlay: DebugOverlay;
  private readonly frameTimeline = new FrameTimeline(240);
  private readonly background: BackgroundSprite[] = [];

  private batch: SpriteBatch | null = null;
  private atlas: LoadedAtlas | null = null;
  private rafId = 0;
  private running = false;
  private lastFrameMs = 0;
  private frames = 0;
  private droppedTicks = 0;
  private simMs = 0;
  private renderPrepMs = 0;
  private sprites = 0;
  private draws = 0;
  private recovery: RecoveryEvent = { phase: 'ready', attempt: 0 };
  private paused = false;

  private previous: DemoState = { x: 0, y: 14, vx: 0, vy: 0 };
  private current: DemoState = { x: 0, y: 14, vx: 0, vy: 0 };
  private rotorAngle = 0;

  private constructor(host: RenderHost, elements: GameAppElements, balance: BalanceStore) {
    this.host = host;

    this.balance = balance;

    const values = balance.value;
    this.clock = new FixedClock({
      tickHz: values.sim.tickHz,
      maxTicksPerFrame: values.sim.maxTicksPerFrame,
    });
    this.camera = new Camera({ ...defaultCameraTuning(), ...values.camera });
    this.actions = new ActionMap();
    for (const axis of ['thrustX', 'thrustY', 'aimX', 'aimY'] as const) {
      this.actions.tuning[axis].deadZone = values.input.deadZone;
      this.actions.tuning[axis].curve = values.input.axisCurve;
    }

    const bindings = defaultBindings();
    this.keyboard = new KeyboardMouseSource(this.actions, {
      target: elements.canvas,
      bindings: bindings.keyboard,
      onPause: () => this.togglePause(),
    });
    this.gamepad = new GamepadSource(this.actions, bindings.gamepad);
    this.overlay = new DebugOverlay(elements.overlay);

    this.buildBackground();
  }

  static async start(elements: GameAppElements): Promise<GameApp> {
    const balance = new BalanceStore();
    const values = balance.value;

    let app: GameApp | null = null;
    const host = await RenderHost.start({
      canvas: elements.canvas,
      maxDevicePixelRatio: values.render.maxDevicePixelRatio,
      onRecovery: (event) => app?.onRecovery(event),
      onUncapturedError: (error) => {
        // Never swallow a GPU validation error: it means a pipeline or buffer is wrong.
        console.error('[webgpu] uncaptured error', error);
      },
    });

    app = new GameApp(host, elements, balance);
    await app.buildGpuResources();
    app.attach();
    return app;
  }

  private async buildGpuResources(): Promise<void> {
    const manifest = loadCoreAtlasManifest();
    this.atlas = await loadAtlas(this.host.gpu, manifest);
    this.batch = new SpriteBatch(this.host.gpu, {
      capacity: this.balance.value.render.spriteCapacity,
      texture: this.atlas.texture,
      label: 'world-sprites',
    });
  }

  private onRecovery(event: RecoveryEvent): void {
    this.recovery = event;
    if (event.phase === 'ready' && event.attempt > 0) {
      // Every GPU object died with the old device; rebuild from the CPU-side descriptions.
      void this.buildGpuResources();
    }
  }

  private buildBackground(): void {
    const rng = new Rng(DEMO_SEED);
    this.background.length = 0;

    for (let i = 0; i < 260; i++) {
      const size = rng.range(0.25, 0.7);
      this.background.push({
        x: rng.range(0, 240),
        y: rng.range(26, 120),
        width: size,
        height: size,
        depth: 0.95,
        alpha: rng.range(0.3, 1),
        region: 'star',
        tint: [1, 1, 1],
        parallax: 0.08,
        fieldWidth: 240,
      });
    }
    // Ridge line: silhouettes sitting on the horizon, not full-screen quads. Width and height
    // are independent because deriving one from the other blanketed the viewport.
    for (let i = 0; i < 110; i++) {
      const height = rng.range(7, 22);
      this.background.push({
        x: rng.range(0, 320),
        y: height / 2,
        width: rng.range(16, 44),
        height,
        depth: 0.86,
        alpha: 1,
        region: 'white',
        // One flat tint, not a per-ridge shade: overlapping silhouettes must read as a
        // single ridge mass rather than a patchwork of rectangles.
        tint: [0.075, 0.085, 0.125],
        parallax: 0.35,
        fieldWidth: 320,
      });
    }
    // Dust motes: the instancing stress load, sized to the PRD's 2,000-particle perf target.
    // They live in an 88 m field kept centred on the camera, so the count on screen is a real
    // per-frame instance count rather than a number that culls away to nothing.
    for (let i = 0; i < 2600; i++) {
      const size = rng.range(0.06, 0.22);
      this.background.push({
        x: rng.range(0, 88),
        y: rng.range(0.3, 19),
        width: size,
        height: size,
        depth: 0.4,
        alpha: rng.range(0.15, 0.45),
        region: 'glow',
        tint: [1, 0.88, 0.7],
        parallax: 1,
        fieldWidth: 88,
      });
    }
  }

  private attach(): void {
    this.keyboard.attach();
    this.overlay.toggle(true);
    this.camera.setAspect(this.host.gpu.aspect);
    this.camera.snapTo({ x: this.current.x, y: this.current.y, velocityX: 0, velocityY: 0 });
    this.running = true;
    this.lastFrameMs = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  private readonly frame = (nowMs: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);

    const frameMs = nowMs - this.lastFrameMs;
    this.lastFrameMs = nowMs;
    this.frameTimeline.push(frameMs);
    this.frames++;

    if (this.host.gpu.resizeToDisplay()) this.camera.setAspect(this.host.gpu.aspect);
    this.gamepad.poll();

    const simStart = performance.now();
    const step = this.clock.advance(Math.min(frameMs, 250) / 1000);
    this.droppedTicks += step.droppedTicks;
    for (let i = 0; i < step.ticks; i++) this.stepDemo();
    this.simMs = performance.now() - simStart;

    this.render(step.alpha, nowMs);
    this.paintOverlay(nowMs);
  };

  /** Placeholder kinematics. Milestone 1 replaces this with the PRD flight model. */
  private stepDemo(): void {
    const dt = this.clock.dt;
    const input = this.actions.snapshot(this.clock.tick);
    this.previous = { ...this.current };

    const boost = input.buttons.boost.down ? 1.38 : 1;
    this.current.vx += input.axes.thrustX * 22 * boost * dt;
    this.current.vy += (input.axes.thrustY * 26 - 14) * dt;
    this.current.vx -= 0.32 * this.current.vx * Math.abs(this.current.vx) * dt;
    this.current.vy -= 0.48 * this.current.vy * Math.abs(this.current.vy) * dt;
    this.current.x += this.current.vx * dt;
    this.current.y += this.current.vy * dt;

    if (this.current.y <= GROUND_Y + 1.2) {
      this.current.y = GROUND_Y + 1.2;
      this.current.vy = Math.max(0, this.current.vy);
    }
    this.current.x = clamp(this.current.x, -120, 2400);
    this.rotorAngle = (this.rotorAngle + 46 * dt) % (Math.PI * 2);
  }

  private render(alpha: number, nowMs: number): void {
    const batch = this.batch;
    const atlas = this.atlas;
    if (!batch || !atlas || this.host.currentPhase !== 'ready') return;

    const prepStart = performance.now();
    const x = this.previous.x + (this.current.x - this.previous.x) * alpha;
    const y = this.previous.y + (this.current.y - this.previous.y) * alpha;

    this.camera.update(
      { x, y, velocityX: this.current.vx, velocityY: this.current.vy },
      Math.min(0.05, (nowMs - this.lastFrameMs + 16.7) / 1000),
    );
    const view = this.camera.view();

    batch.begin();

    const groundUv = atlas.uv('ground');
    for (let tile = -2; tile <= 2; tile++) {
      const tileWidth = view.halfWidth;
      batch.draw({
        x: Math.round(view.centerX / tileWidth) * tileWidth + tile * tileWidth,
        y: GROUND_Y - 9,
        width: tileWidth + 0.5,
        height: 20,
        depth: 0.7,
        uv: groundUv,
      });
    }

    // Each layer wraps inside its own repeating field, which is what makes the parallax
    // continuous over a 6 km map without holding 6 km of sprites.
    for (const item of this.background) {
      const left = view.centerX - view.halfWidth - 2;
      const scrolled = item.x - view.centerX * item.parallax - left;
      const wrapped = ((scrolled % item.fieldWidth) + item.fieldWidth) % item.fieldWidth;
      const drawX = left + wrapped;
      if (Math.abs(drawX - view.centerX) > view.halfWidth + item.width) continue;
      batch.draw({
        x: drawX,
        y: item.y,
        width: item.width,
        height: item.height,
        depth: item.depth,
        uv: atlas.uv(item.region),
        r: item.tint[0],
        g: item.tint[1],
        b: item.tint[2],
        a: item.alpha,
      });
    }

    const heli: Sprite = {
      x,
      y,
      width: 6,
      height: 3,
      rotation: clamp(-this.current.vx * 0.006, -0.22, 0.22),
      depth: 0.2,
      uv: atlas.uv('helicopter'),
    };
    batch.draw(heli);
    batch.draw({
      x,
      y: y + 1.5,
      width: 8 * Math.abs(Math.cos(this.rotorAngle)) + 0.6,
      height: 0.35,
      depth: 0.18,
      uv: atlas.uv('rotor'),
      a: 0.75,
    });

    const encoder = this.host.gpu.device.createCommandEncoder({ label: 'frame' });
    const clear = this.balance.value.render.clearColor;
    const pass = encoder.beginRenderPass({
      label: 'world-pass',
      colorAttachments: [
        {
          view: this.host.gpu.context.getCurrentTexture().createView(),
          clearValue: { r: clear[0], g: clear[1], b: clear[2], a: clear[3] },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    batch.flush(pass, {
      centerX: view.centerX,
      centerY: view.centerY,
      halfWidth: view.halfWidth,
      halfHeight: view.halfHeight,
      pixelWidth: this.host.gpu.currentSize.pixelWidth,
      pixelHeight: this.host.gpu.currentSize.pixelHeight,
      timeSeconds: this.clock.elapsed,
    });
    pass.end();
    this.host.gpu.device.queue.submit([encoder.finish()]);

    const stats = batch.lastStats();
    this.sprites = stats.sprites;
    this.draws = stats.draws;
    this.renderPrepMs = performance.now() - prepStart;
  }

  private paintOverlay(nowMs: number): void {
    const size = this.host.gpu.currentSize;
    const pad = this.gamepad.status();
    this.overlay.update(
      {
        frame: this.frameTimeline,
        simMs: this.simMs,
        renderPrepMs: this.renderPrepMs,
        tick: this.clock.tick,
        droppedTicks: this.droppedTicks,
        sprites: this.sprites,
        draws: this.draws,
        resolution: `${size.pixelWidth}x${size.pixelHeight}`,
        devicePixelRatio: size.devicePixelRatio,
        adapter: this.host.gpu.adapterInfo,
        recoveryPhase: this.paused ? `${this.recovery.phase} (paused)` : this.recovery.phase,
        recoveryAttempts: this.host.recoveryAttempts,
        gamepad: pad.connected ? `${pad.id ?? 'pad'} [${pad.mapping ?? '?'}]` : 'none',
        placeholderAssets: this.atlas?.placeholder ?? false,
        thrust: { x: this.actions.current.axes.thrustX, y: this.actions.current.axes.thrustY },
      },
      nowMs,
    );
  }

  togglePause(): void {
    this.paused = !this.paused;
    // Resetting the accumulator is what stops a pause from queueing thousands of catch-up ticks.
    if (!this.paused) this.lastFrameMs = performance.now();
  }

  stats(): GameStats {
    const size = this.host.gpu.currentSize;
    return {
      frames: this.frames,
      tick: this.clock.tick,
      droppedTicks: this.droppedTicks,
      fps: this.frameTimeline.fps(),
      frameMeanMs: this.frameTimeline.mean(),
      frameP99Ms: this.frameTimeline.percentile(0.99),
      simMs: this.simMs,
      renderPrepMs: this.renderPrepMs,
      sprites: this.sprites,
      draws: this.draws,
      adapter: this.host.gpu.adapterInfo,
      recoveryPhase: this.host.currentPhase,
      recoveryAttempts: this.host.recoveryAttempts,
      placeholderAssets: this.atlas?.placeholder ?? false,
      resolution: {
        width: size.pixelWidth,
        height: size.pixelHeight,
        dpr: size.devicePixelRatio,
      },
    };
  }

  /** Test hook for the device-loss integration test. */
  simulateDeviceLoss(): void {
    this.host.simulateDeviceLoss();
  }

  toggleOverlay(force?: boolean): void {
    this.overlay.toggle(force);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.keyboard.detach();
    this.overlay.dispose();
    this.batch?.destroy();
    this.host.dispose();
  }
}
