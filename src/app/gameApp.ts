import { FixedClock } from '@/core/clock.js';
import { clamp, lerp, radToDeg } from '@/core/math.js';
import { Rng } from '@/core/rng.js';
import { ActionMap, type ActionState } from '@/input/actions.js';
import { GamepadSource } from '@/input/gamepad.js';
import { KeyboardMouseSource } from '@/input/keyboardMouse.js';
import { defaultBindings } from '@/input/rebinding.js';
import { Camera, defaultCameraTuning } from '@/render/camera.js';
import { RenderHost, type RecoveryEvent } from '@/render/webgpu/deviceRecovery.js';
import { SpriteBatch } from '@/render/webgpu/spriteBatch.js';
import { loadAtlas, type LoadedAtlas } from '@/render/webgpu/textures.js';
import { loadCoreAtlasManifest } from '@/content/loaders/atlasLoader.js';
import { BalanceStore, loadFlightBalance } from '@/content/loaders/balanceLoader.js';
import { DebugOverlay, FrameTimeline } from '@/debug/overlay.js';
import { neutralInput, type FlightInput } from '@/sim/components.js';
import { createTestRange } from '@/sim/terrain.js';
import { World } from '@/sim/world.js';

export interface GameAppElements {
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
}

export interface SimSnapshot {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  heightAboveGround: number;
  pitchDegrees: number;
  facing: number;
  grounded: boolean;
  contacts: number;
  hull: number;
  fuel: number;
  passengers: number;
  lastTouchdown: string | null;
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
  sim: SimSnapshot;
}

interface Interpolated {
  x: number;
  y: number;
  pitch: number;
}

interface BackgroundSprite {
  /** Position inside the layer's repeating field, not a world position. */
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  alpha: number;
  region: 'star' | 'white' | 'glow';
  tint: [number, number, number];
  parallax: number;
  /**
   * Width of the repeating field, metres. Must exceed the widest viewport (~67 m at full
   * zoom-out) or wrapping leaves a bare strip at the screen edge.
   */
  fieldWidth: number;
}

const SCENE_SEED = 0x63686f70; // "chop"
/** Terrain columns drawn across the viewport. 160 over ~60 m is well under a pixel of stepping. */
const TERRAIN_COLUMNS = 160;
/** Layer depth of the ground. Everything numerically smaller draws in front of it. */
const TERRAIN_DEPTH = 0.7;
/** How far the ground quads extend below the surface, metres. */
const TERRAIN_DEPTH_METRES = 60;

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
  /** Index into `background` where layers in front of the terrain begin. */
  private foregroundStart = 0;
  private readonly world: World;

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
  private lastTouchdown: string | null = null;

  private previous: Interpolated = { x: 0, y: 0, pitch: 0 };
  private current: Interpolated = { x: 0, y: 0, pitch: 0 };
  private rotorAngle = 0;
  /** Smoothed facing for rendering, so a yaw reads as a turn rather than a snap. */
  private renderFacing = 1;

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

    const terrain = createTestRange();
    this.world = new World({
      balance: loadFlightBalance(),
      terrain,
      dt: this.clock.dt,
      spawn: { x: 90 },
    });
    this.camera.bounds = { minX: terrain.minX, maxX: terrain.maxX, minY: -40, maxY: 260 };
    this.syncInterpolation(true);

    const bindings = defaultBindings();
    this.keyboard = new KeyboardMouseSource(this.actions, {
      target: elements.canvas,
      bindings: bindings.keyboard,
      onPause: () => this.togglePause(),
    });
    this.gamepad = new GamepadSource(this.actions, bindings.gamepad);
    this.overlay = new DebugOverlay(elements.overlay);

    this.world.events.on('flight:touchdown', (event) => {
      this.lastTouchdown = String((event.payload as { quality?: string }).quality ?? 'unknown');
    });

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
    const rng = new Rng(SCENE_SEED);
    this.background.length = 0;

    for (let i = 0; i < 260; i++) {
      const size = rng.range(0.25, 0.7);
      this.background.push({
        x: rng.range(0, 240),
        y: rng.range(40, 170),
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
    // Ridge line: silhouettes on the horizon, with one flat tint so overlapping quads read as
    // a single mass rather than a patchwork of rectangles.
    for (let i = 0; i < 46; i++) {
      const height = rng.range(14, 46);
      this.background.push({
        x: rng.range(0, 320),
        y: height / 2 - 4,
        width: rng.range(34, 96),
        height,
        depth: 0.86,
        alpha: 1,
        region: 'white',
        tint: [0.075, 0.085, 0.125],
        parallax: 0.35,
        fieldWidth: 320,
      });
    }
    // Ground haze: the instancing load, sized to the PRD's 2,000-particle performance target.
    // Kept low and faint on purpose — the PRD is explicit that modern graphics should increase
    // readability rather than bury it under particles, and a full-height dust field reads as
    // snow over the terrain the player is trying to land on.
    for (let i = 0; i < 2200; i++) {
      const size = rng.range(0.05, 0.16);
      const height = rng.range(0.2, 9);
      this.background.push({
        x: rng.range(0, 88),
        y: height,
        width: size,
        height: size,
        depth: 0.4,
        // Thins out with altitude, so the haze hugs the deck.
        alpha: rng.range(0.1, 0.3) * (1 - height / 12),
        region: 'glow',
        tint: [1, 0.88, 0.7],
        parallax: 1,
        fieldWidth: 88,
      });
    }

    // There is no depth buffer in Milestone 0/1, so draw order IS the sort. Sorting far-to-near
    // and splitting at the terrain's depth is what stops an opaque ridge from painting over the
    // ground the player is trying to land on.
    this.background.sort((a, b) => b.depth - a.depth);
    this.foregroundStart = this.background.findIndex((item) => item.depth < TERRAIN_DEPTH);
    if (this.foregroundStart < 0) this.foregroundStart = this.background.length;
  }

  private drawBackgroundRange(
    batch: SpriteBatch,
    atlas: LoadedAtlas,
    view: { centerX: number; halfWidth: number },
    from: number,
    to: number,
  ): void {
    for (let i = from; i < to; i++) {
      const item = this.background[i];
      if (!item) continue;
      // Each layer wraps inside its own repeating field, which is what makes the parallax
      // continuous over a 6 km map without holding 6 km of sprites.
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
  }

  private syncInterpolation(snap: boolean): void {
    const player = this.world.player;
    this.current = { x: player.position.x, y: player.position.y, pitch: player.pitch };
    if (snap) this.previous = { ...this.current };
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
    for (let i = 0; i < step.ticks; i++) {
      this.previous = { ...this.current };
      const input = this.readInput(this.actions.snapshot(this.clock.tick));
      this.world.step(this.paused ? neutralInput() : input);
      this.syncInterpolation(false);
    }
    this.world.events.drain();
    this.simMs = performance.now() - simStart;

    this.render(step.alpha);
    this.paintOverlay(nowMs);
  };

  /** Named actions to flight input. The simulation never learns that a keyboard exists. */
  private readInput(state: ActionState): FlightInput {
    return {
      thrustX: state.axes.thrustX,
      thrustY: state.axes.thrustY,
      boost: state.buttons.boost.down,
      yawLeft: state.buttons.yawLeft.pressed,
      yawRight: state.buttons.yawRight.pressed,
    };
  }

  private render(alpha: number): void {
    const batch = this.batch;
    const atlas = this.atlas;
    if (!batch || !atlas || this.host.currentPhase !== 'ready') return;

    const prepStart = performance.now();
    const player = this.world.player;
    const x = lerp(this.previous.x, this.current.x, alpha);
    const y = lerp(this.previous.y, this.current.y, alpha);
    const pitch = lerp(this.previous.pitch, this.current.pitch, alpha);

    const frameSeconds = clamp(this.frameTimeline.mean() / 1000, 1 / 480, 1 / 20);
    this.rotorAngle = (this.rotorAngle + 46 * frameSeconds) % (Math.PI * 2);
    // Facing eases toward its target so a yaw reads as the aircraft turning through the
    // foreground plane rather than mirroring between frames.
    const facingTarget = player.yawTarget ?? player.facing;
    this.renderFacing += (facingTarget - this.renderFacing) * clamp(frameSeconds * 9, 0, 1);

    this.camera.update(
      { x, y, velocityX: player.velocity.x, velocityY: player.velocity.y, threat: 0 },
      frameSeconds,
    );
    const view = this.camera.view();

    batch.begin();

    // Far layers first (stars, ridges), then the terrain, then everything in front of it.
    this.drawBackgroundRange(batch, atlas, view, 0, this.foregroundStart);

    // --- Terrain: sampled into columns so one heightfield draws in the shared batch --------
    const groundUv = atlas.uv('ground');
    const columnWidth = (view.halfWidth * 2 + 4) / TERRAIN_COLUMNS;
    for (let i = 0; i < TERRAIN_COLUMNS; i++) {
      const columnX = view.centerX - view.halfWidth - 2 + (i + 0.5) * columnWidth;
      const height = this.world.terrain.heightAt(columnX);
      batch.draw({
        x: columnX,
        // The quad hangs below the sampled height so the top edge sits exactly on the ground.
        y: height - TERRAIN_DEPTH_METRES / 2,
        width: columnWidth * 1.04,
        height: TERRAIN_DEPTH_METRES,
        depth: TERRAIN_DEPTH,
        uv: groundUv,
      });
    }

    this.drawBackgroundRange(batch, atlas, view, this.foregroundStart, this.background.length);

    // --- Landing aid ----------------------------------------------------------------------
    // Reads slope straight off the terrain: green where the aircraft could actually set down,
    // red where it could not. Guessing landability from the art is how a player learns by
    // crashing, which is the trial-and-error loop the PRD calls out as a failure.
    const destroyed = player.destroyedFor !== null;
    if (!player.grounded && !destroyed) {
      const groundY = this.world.terrain.heightAt(x);
      const slope = Math.abs(this.world.terrain.slopeDegreesAt(x));
      const landable =
        slope <= this.world.balance.landing.safeSlopeDegrees &&
        Math.abs(player.velocity.y) <= this.world.balance.landing.crashVerticalSpeed;
      batch.draw({
        x,
        y: groundY + 0.2,
        width: this.world.balance.landing.skidHalfWidth * 2.4,
        height: 0.32,
        depth: 0.22,
        uv: atlas.uv('white'),
        r: landable ? 0.4 : 1,
        g: landable ? 1 : 0.42,
        b: landable ? 0.6 : 0.3,
        a: clamp(1 - (y - groundY) / 40, 0.12, 0.75),
      });
    }

    // --- The aircraft ---------------------------------------------------------------------
    const bodyUv = atlas.uv('helicopter');
    const facingScale = this.renderFacing;
    // |facing| near 0 is the foreground plane: the fuselage foreshortens toward the camera.
    const foreshorten = 0.34 + 0.66 * Math.abs(facingScale);
    const mirrored = facingScale < 0;
    batch.draw({
      x,
      y,
      width: 6 * foreshorten,
      height: 3,
      rotation: pitch * (mirrored ? -1 : 1),
      depth: 0.2,
      uv: mirrored ? { u0: bodyUv.u1, v0: bodyUv.v0, u1: bodyUv.u0, v1: bodyUv.v1 } : bodyUv,
      r: destroyed ? 0.45 : 1,
      g: destroyed ? 0.3 : 1,
      b: destroyed ? 0.28 : 1,
    });
    if (!destroyed) {
      batch.draw({
        x,
        y: y + 1.5,
        width: 8 * Math.abs(Math.cos(this.rotorAngle)) + 0.6,
        height: 0.35,
        rotation: pitch * 0.4,
        depth: 0.18,
        uv: atlas.uv('rotor'),
        a: 0.75,
      });
    }

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
      timeSeconds: this.world.elapsed,
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
    const sim = this.simSnapshot();
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
        flight: {
          velocity: `${sim.velocityX.toFixed(1)}, ${sim.velocityY.toFixed(1)} m/s`,
          altitude: `${sim.heightAboveGround.toFixed(1)} m agl`,
          attitude: `pitch ${sim.pitchDegrees.toFixed(1)}deg facing ${sim.facing}`,
          contact: sim.grounded ? `grounded (${sim.contacts} skid)` : 'airborne',
          condition: `hull ${(sim.hull * 100).toFixed(0)}% fuel ${sim.fuel.toFixed(0)}`,
          'last landing': sim.lastTouchdown ?? '-',
        },
      },
      nowMs,
    );
  }

  private simSnapshot(): SimSnapshot {
    const player = this.world.player;
    return {
      x: player.position.x,
      y: player.position.y,
      velocityX: player.velocity.x,
      velocityY: player.velocity.y,
      heightAboveGround: player.position.y - this.world.terrain.heightAt(player.position.x),
      pitchDegrees: radToDeg(player.pitch),
      facing: player.facing,
      grounded: player.grounded,
      contacts: player.landingContactCount,
      hull: player.hull,
      fuel: player.fuel,
      passengers: player.passengers.length,
      lastTouchdown: this.lastTouchdown,
    };
  }

  togglePause(): void {
    this.paused = !this.paused;
    // Resetting the frame timer is what stops a pause from queueing thousands of catch-up ticks.
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
      resolution: { width: size.pixelWidth, height: size.pixelHeight, dpr: size.devicePixelRatio },
      sim: this.simSnapshot(),
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
