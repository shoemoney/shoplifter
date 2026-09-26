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
import { ParticleKind, ParticleSystem, type ParticleAtlasUv } from '@/render/webgpu/particles.js';
import { createAudioEngine, type AudioEnginePort } from '@/audio/engine.js';
import { loadAtlas, loadImageTexture, type LoadedAtlas } from '@/render/webgpu/textures.js';
import { loadCoreAtlasManifest } from '@/content/loaders/atlasLoader.js';
import { BalanceStore, loadFlightBalance } from '@/content/loaders/balanceLoader.js';
import { loadMission, OPEN_SKY_ID } from '@/content/missions/index.js';
import { DebugOverlay, FrameTimeline } from '@/debug/overlay.js';
import { MissionWorld, neutralMissionInput, type MissionInput } from '@/sim/mission.js';
import { tally } from '@/sim/systems/civilians.js';
import { gradeMission } from '@/sim/systems/scoring.js';
import {
  buildEdgeMarkers,
  buildLandingAid,
  buildTacticalStrip,
  fuelIsCritical,
  type HudModel,
  type TrackedEntity,
} from '@/ui/hud.js';
import { HudView } from '@/ui/hudView.js';
import { DebriefScreen, PauseScreen } from '@/ui/screens.js';
import { buildDebrief } from '@/ui/debrief.js';
import type { SaveStore } from '@/save/store.js';
import type { Settings } from '@/save/schema.js';
import {
  applyCameraSettings,
  applyInputSettings,
  cameraShakeScale,
  devicePixelRatioCeiling,
  difficultyOf,
  simSpeed,
} from './settingsRuntime.js';

export interface GameAppElements {
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  hud: HTMLElement;
  pause: HTMLElement;
  debrief: HTMLElement;
}

export interface GameAppOptions {
  elements: GameAppElements;
  /** Persisted settings and progress. Defaults are used when storage is unavailable. */
  save: SaveStore;
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
  rescued: number;
  dead: number;
  enemies: number;
  projectiles: number;
  phase: string;
  objective: string | null;
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
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  alpha: number;
  region: 'star' | 'white' | 'glow';
  tint: [number, number, number];
  parallax: number;
  fieldWidth: number;
}

const SCENE_SEED = 0x63686f70; // "chop"
const TERRAIN_COLUMNS = 168;
/** Layer depth of the ground. Anything numerically smaller draws in front of it. */
const TERRAIN_DEPTH = 0.7;
const TERRAIN_DEPTH_METRES = 26;
/** Vertical slices of the ground sprite, cycled across columns to break up the grain. */
const TERRAIN_SLICES = 8;
/** Painterly backdrop for the Salt Flats biome. */
const SKY_IMAGE = '/assets/sky_salt_flats.jpg';
/**
 * World height the backdrop spans, metres. Deliberately short: the ridge line and horizon glow
 * live in the bottom quarter of the image, and at 110 m that quarter sat below the visible band
 * while the plain sky above it stretched into mush.
 */
const SKY_HEIGHT_METRES = 46;
/** How much the backdrop drifts with the camera. Near zero reads as genuinely distant. */
const SKY_PARALLAX = 0.04;
/** How much ground the camera may show below the local terrain, metres. */
const GROUND_MARGIN_METRES = 7;
/** Seconds between rotor-wash bursts. Every frame floods the pool and buries the terrain. */
const WASH_INTERVAL_SECONDS = 0.09;

export class GameApp {
  private readonly host: RenderHost;
  private readonly balance: BalanceStore;
  private readonly clock: FixedClock;
  private readonly camera: Camera;
  private readonly actions: ActionMap;
  private readonly keyboard: KeyboardMouseSource;
  private readonly gamepad: GamepadSource;
  private readonly overlay: DebugOverlay;
  private readonly hud: HudView;
  private readonly frameTimeline = new FrameTimeline(240);
  private readonly background: BackgroundSprite[] = [];
  private readonly tracked: TrackedEntity[] = [];
  private readonly save: SaveStore;
  private readonly particles: ParticleSystem;
  private particleUv: ParticleAtlasUv | null = null;
  private washCooldown = 0;
  private skyAspect = 6;
  private readonly audio: AudioEnginePort;
  private gunCueCooldown = 0;
  private readonly mission: ReturnType<typeof loadMission>;
  private readonly pauseScreen: PauseScreen;
  private readonly debriefScreen: DebriefScreen;

  private world: MissionWorld;
  private shakeScale = 1;
  private debriefRecorded = false;

  private batch: SpriteBatch | null = null;
  private skyBatch: SpriteBatch | null = null;
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

  private previous: Interpolated = { x: 0, y: 0, pitch: 0 };
  private current: Interpolated = { x: 0, y: 0, pitch: 0 };
  private rotorAngle = 0;
  private renderFacing = 1;

  private constructor(host: RenderHost, options: GameAppOptions, balance: BalanceStore) {
    const elements = options.elements;
    this.host = host;
    this.balance = balance;
    this.save = options.save;

    const values = balance.value;
    this.clock = new FixedClock({
      tickHz: values.sim.tickHz,
      maxTicksPerFrame: values.sim.maxTicksPerFrame,
    });
    const settings = this.save.current.settings;
    this.camera = new Camera(
      applyCameraSettings(settings, { ...defaultCameraTuning(), ...values.camera }),
    );
    this.actions = new ActionMap();
    // Balance data supplies the defaults; the player's saved settings override them.
    for (const axis of ['thrustX', 'thrustY', 'aimX', 'aimY'] as const) {
      this.actions.tuning[axis].deadZone = values.input.deadZone;
      this.actions.tuning[axis].curve = values.input.axisCurve;
    }
    applyInputSettings(settings, this.actions);
    this.shakeScale = cameraShakeScale(settings);

    const mission = loadMission(OPEN_SKY_ID);
    this.mission = mission;
    this.world = this.createWorld();
    this.camera.bounds = {
      minX: 0,
      maxX: mission.lengthMeters,
      minY: -40,
      maxY: mission.altitudeCeiling,
    };
    this.syncInterpolation(true);

    const bindings = defaultBindings();
    this.keyboard = new KeyboardMouseSource(this.actions, {
      target: elements.canvas,
      bindings: bindings.keyboard,
      onPause: () => this.togglePause(),
    });
    this.gamepad = new GamepadSource(this.actions, bindings.gamepad);
    this.overlay = new DebugOverlay(elements.overlay);
    this.hud = new HudView(elements.hud);
    // Its own RNG stream: particles are presentation, and must never consume draws the
    // simulation's determinism depends on.
    this.particles = new ParticleSystem({ rng: new Rng(SCENE_SEED ^ 0x9e3779b9) });
    // Falls back to a silent engine when there is no AudioContext — the game runs, quietly.
    this.audio = createAudioEngine({ audio: settings.audio, seed: SCENE_SEED });
    this.pauseScreen = new PauseScreen(elements.pause, {
      resume: () => this.togglePause(),
      restart: () => this.restart(),
      onSettingChange: (mutate) => this.changeSettings(mutate),
    });
    this.debriefScreen = new DebriefScreen(elements.debrief, { retry: () => this.restart() });

    this.buildBackground();
  }

  /**
   * Builds a fresh mission world. Restarting rebuilds rather than resetting: the systems own a
   * lot of state between them, and a missed field in a reset is a bug that only appears on the
   * player's second attempt.
   */
  private createWorld(): MissionWorld {
    const world = new MissionWorld({
      mission: this.mission,
      flight: loadFlightBalance(),
      dt: this.clock.dt,
      difficulty: difficultyOf(this.save.current.settings),
    });
    // Taking a hit shakes the frame. Scaled — or zeroed — by the accessibility setting, which
    // is why the scale is applied here rather than baked into the camera.
    world.events.on('mission:playerHit', () => {
      this.audio.playCue('explosion', { position: world.player.position.x, level: 0.5 });
      this.camera.addShake(0.25 * this.shakeScale);
      this.particles.emitImpactSparks(world.player.position.x, world.player.position.y);
      this.particles.emitSmokeTrail(world.player.position.x, world.player.position.y);
    });
    world.events.on('mission:enemyDestroyed', (event) => {
      this.camera.addShake(0.08 * this.shakeScale);
      const payload = event.payload as { id?: number };
      const runtime = world.liveEnemies.find((candidate) => candidate.enemy.id === payload.id);
      const at = runtime?.enemy.position ?? world.player.position;
      this.particles.emitExplosion(at.x, at.y);
      this.particles.emitDebris(at.x, at.y);
      this.audio.playCue('explosion', { position: at.x });
    });
    world.events.on('mission:unloaded', () =>
      this.audio.playCue('boarding', { position: world.player.position.x }),
    );
    world.events.on('mission:weaponOverheated', () => this.audio.playCue('ui'));
    return world;
  }

  private changeSettings(mutate: (settings: Settings) => void): void {
    this.save.updateSettings(mutate);
    const settings = this.save.current.settings;
    applyInputSettings(settings, this.actions);
    this.camera.tuning = applyCameraSettings(settings, this.camera.tuning);
    this.shakeScale = cameraShakeScale(settings);
    this.audio.setAudioSettings(settings.audio);
    if (this.pauseScreen.isVisible) this.pauseScreen.show(settings);
  }

  /** Throws the current attempt away and flies the mission again from the pad. */
  restart(): void {
    this.world = this.createWorld();
    this.clock.reset();
    this.droppedTicks = 0;
    this.debriefRecorded = false;
    this.paused = false;
    this.pauseScreen.hide();
    this.debriefScreen.hide();
    this.syncInterpolation(true);
    this.camera.snapTo({
      x: this.world.player.position.x,
      y: this.world.player.position.y,
      velocityX: 0,
      velocityY: 0,
    });
    this.lastFrameMs = performance.now();
  }

  static async start(options: GameAppOptions): Promise<GameApp> {
    const balance = new BalanceStore();
    const elements = options.elements;

    let app: GameApp | null = null;
    const host = await RenderHost.start({
      canvas: elements.canvas,
      maxDevicePixelRatio: devicePixelRatioCeiling(options.save.current.settings),
      onRecovery: (event) => app?.onRecovery(event),
      onUncapturedError: (error) => {
        console.error('[webgpu] uncaptured error', error);
      },
    });

    app = new GameApp(host, options, balance);
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
    // The backdrop is its own texture and its own batch: it is a smooth photographic
    // gradient, so it wants linear sampling, while every sprite wants nearest. One extra draw
    // call, against a budget of 150.
    const sky = await loadImageTexture(this.host.gpu, SKY_IMAGE);
    if (sky) {
      this.skyBatch = new SpriteBatch(this.host.gpu, {
        capacity: 8,
        texture: sky.texture,
        sampler: this.host.gpu.device.createSampler({
          label: 'sky-sampler',
          magFilter: 'linear',
          minFilter: 'linear',
          addressModeU: 'clamp-to-edge',
          addressModeV: 'clamp-to-edge',
        }),
        label: 'sky',
      });
      this.skyAspect = sky.width / sky.height;
    }

    // Each particle kind gets art that matches what it is, now that the atlas has it.
    this.particleUv = {
      [ParticleKind.Dust]: this.atlas.uv('glow'),
      [ParticleKind.Smoke]: this.atlas.uv('smoke'),
      [ParticleKind.Flash]: this.atlas.uv('glow'),
      [ParticleKind.Spark]: this.atlas.uv('spark'),
      [ParticleKind.Debris]: this.atlas.uv('white'),
    };
  }

  private onRecovery(event: RecoveryEvent): void {
    this.recovery = event;

    if (event.phase === 'lost') {
      // Drop every GPU handle immediately. They belong to a device that no longer exists, and
      // the rebuild below is async: `phase` flips back to 'ready' the moment a new device
      // arrives, which is BEFORE the new batch and textures are built. Without this, frames in
      // that window submit work against the dead device and raise GPUValidationError — which
      // is exactly what the device-loss test kept catching as an intermittent failure.
      this.batch = null;
      this.skyBatch = null;
      this.atlas = null;
      this.particleUv = null;
      return;
    }

    if (event.phase === 'ready' && event.attempt > 0) {
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
        y: rng.range(60, 220),
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
    // The ridge-silhouette and ground-haze layers that used to live here are gone. They were
    // scene padding: fixed-height quads at a world Y unrelated to the local terrain, which read
    // as distant hills from cruise altitude and as grey rectangles and falling snow from ten
    // metres up. The terrain and the real particle system carry the scene now, and the sprite
    // count is honest content rather than a number inflated to look busy.

    // No depth buffer yet, so draw order is the sort. Far to near, split at the terrain.
    this.background.sort((a, b) => b.depth - a.depth);
    this.foregroundStart = this.background.findIndex((item) => item.depth < TERRAIN_DEPTH);
    if (this.foregroundStart < 0) this.foregroundStart = this.background.length;
  }

  private foregroundStart = 0;

  private syncInterpolation(snap: boolean): void {
    const player = this.world.player;
    this.current = { x: player.position.x, y: player.position.y, pitch: player.pitch };
    if (snap) this.previous = { ...this.current };
  }

  private attach(): void {
    this.keyboard.attach();
    this.overlay.toggle(false);
    this.camera.setAspect(this.host.gpu.aspect);
    this.camera.snapTo({ x: this.current.x, y: this.current.y, velocityX: 0, velocityY: 0 });
    // Browsers keep an AudioContext suspended until a gesture; the first click or key unlocks it.
    const unlock = (): void => {
      void this.audio.resume();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

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
    // Reduced game speed slows how much real time reaches the clock. Scaling dt instead would
    // change the physics, which is the one thing an accessibility option must never do.
    const speed = simSpeed(this.save.current.settings);
    const step = this.clock.advance((Math.min(frameMs, 250) / 1000) * speed);
    this.droppedTicks += step.droppedTicks;
    for (let i = 0; i < step.ticks; i++) {
      this.previous = { ...this.current };
      const input = this.readInput(this.actions.snapshot(this.clock.tick));
      this.world.step(this.paused ? neutralMissionInput() : input);
      this.syncInterpolation(false);
    }
    this.world.events.drain();
    this.simMs = performance.now() - simStart;

    this.render(step.alpha);
    this.updateAudio(Math.min(frameMs, 250) / 1000);
    this.paintUi(nowMs);
    this.maybeDebrief();
  };

  /** Named actions to mission input. The simulation never learns that a keyboard exists. */
  private readInput(state: ActionState): MissionInput {
    // The aim reticle drives weapon angle independently of the direction of travel.
    const aimAngle = Math.atan2(state.axes.aimY, state.axes.aimX || 1e-6);
    return {
      thrustX: state.axes.thrustX,
      thrustY: state.axes.thrustY,
      boost: state.buttons.boost.down,
      yawLeft: state.buttons.yawLeft.pressed,
      yawRight: state.buttons.yawRight.pressed,
      firePrimary: state.buttons.firePrimary.down,
      fireSecondary: state.buttons.fireSecondary.pressed,
      deployFlare: state.buttons.flares.pressed,
      interact: state.buttons.interact.down,
      aimAngle,
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
    this.camera.decayShake(frameSeconds);
    const facingTarget = player.yawTarget ?? player.facing;
    this.renderFacing += (facingTarget - this.renderFacing) * clamp(frameSeconds * 9, 0, 1);

    // Keep the frame off the dirt. The vertical bias puts the aircraft above centre, which at
    // low altitude spends more than half the screen below ground level. Raising the camera's
    // floor to just under the local terrain buys that space back for the sky the threats are in.
    const bounds = this.camera.bounds;
    if (bounds) bounds.minY = this.world.terrain.heightAt(x) - GROUND_MARGIN_METRES;

    this.camera.update(
      {
        x,
        y,
        velocityX: player.velocity.x,
        velocityY: player.velocity.y,
        threat: clamp(this.world.liveEnemies.length / 4, 0, 1),
      },
      frameSeconds,
    );
    const view = this.camera.view();

    this.drawSky(view);

    batch.begin();
    this.drawBackgroundRange(batch, atlas, view, 0, this.foregroundStart);
    this.drawTerrain(batch, atlas, view);
    this.drawLandingZones(batch, atlas, view);
    this.drawBackgroundRange(batch, atlas, view, this.foregroundStart, this.background.length);
    this.drawCivilians(batch, atlas, view);
    this.drawEnemies(batch, atlas, view);
    this.drawProjectiles(batch, atlas, view);
    this.drawPlayer(batch, atlas, x, y, pitch);

    // Rotor wash while hovering low — the effect that makes the ground read as ground.
    const groundY = this.world.terrain.heightAt(x);
    this.washCooldown -= frameSeconds;
    if (player.destroyedFor === null && y - groundY < 12 && this.washCooldown <= 0) {
      this.particles.emitRotorWash(x, groundY, y - groundY);
      this.washCooldown = WASH_INTERVAL_SECONDS;
    }
    this.particles.step(frameSeconds, {
      groundHeightAt: (worldX) => this.world.terrain.heightAt(worldX),
    });
    if (this.particleUv) this.particles.collect(batch, this.particleUv);

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
    const camera = {
      centerX: view.centerX,
      centerY: view.centerY,
      halfWidth: view.halfWidth,
      halfHeight: view.halfHeight,
      pixelWidth: this.host.gpu.currentSize.pixelWidth,
      pixelHeight: this.host.gpu.currentSize.pixelHeight,
      timeSeconds: this.world.elapsed,
    };
    this.skyBatch?.flush(pass, camera);
    batch.flush(pass, camera);
    pass.end();
    this.host.gpu.device.queue.submit([encoder.finish()]);

    const stats = batch.lastStats();
    const skyStats = this.skyBatch?.lastStats();
    this.sprites = stats.sprites + (skyStats?.sprites ?? 0);
    this.draws = stats.draws + (skyStats?.draws ?? 0);
    this.renderPrepMs = performance.now() - prepStart;
  }

  /**
   * Queues the painterly backdrop. Anchored so its base sits on the nominal ground line and
   * drifts at a near-zero parallax, which is what makes it read as distant rather than as
   * wallpaper glued to the camera.
   */
  private drawSky(view: { centerX: number; centerY: number; halfWidth: number }): void {
    const batch = this.skyBatch;
    if (!batch) return;
    batch.begin();

    const height = SKY_HEIGHT_METRES;
    const width = height * this.skyAspect;
    const drift = view.centerX * SKY_PARALLAX;
    // Anchored to the ground under the camera rather than to a fixed world height: the ridge
    // line and horizon glow live at the bottom of the image, and a fixed anchor buries them
    // under the terrain wherever the ground rises — which is most of this map.
    const horizon = this.world.terrain.heightAt(view.centerX) - 1.5;
    // Tile across the viewport; the asset is mirror-extended so the seam is invisible.
    const first = Math.floor((view.centerX - drift - view.halfWidth) / width) - 1;
    const last = Math.ceil((view.centerX - drift + view.halfWidth) / width) + 1;
    for (let i = first; i <= last; i++) {
      batch.draw({
        x: drift + (i + 0.5) * width,
        y: horizon + height / 2,
        width,
        height,
        depth: 0.99,
      });
    }
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

  private drawTerrain(
    batch: SpriteBatch,
    atlas: LoadedAtlas,
    view: { centerX: number; halfWidth: number },
  ): void {
    const groundUv = atlas.uv('ground');
    const columnWidth = (view.halfWidth * 2 + 4) / TERRAIN_COLUMNS;
    // Each column samples a different vertical slice of the ground sprite. Sampling the whole
    // 32-pixel-wide texture into a 7-pixel column squashed the grain into a single pattern that
    // then repeated at column frequency — visible as vertical banding across the terrain.
    const sliceWidth = (groundUv.u1 - groundUv.u0) / TERRAIN_SLICES;
    for (let i = 0; i < TERRAIN_COLUMNS; i++) {
      const columnX = view.centerX - view.halfWidth - 2 + (i + 0.5) * columnWidth;
      const height = this.world.terrain.heightAt(columnX);
      // Keyed to world position, not column index, so the grain stays put as the camera pans
      // instead of crawling along with it.
      const slice = Math.abs(Math.round(columnX / columnWidth)) % TERRAIN_SLICES;
      batch.draw({
        x: columnX,
        y: height - TERRAIN_DEPTH_METRES / 2,
        width: columnWidth * 1.04,
        height: TERRAIN_DEPTH_METRES,
        depth: TERRAIN_DEPTH,
        uv: {
          u0: groundUv.u0 + slice * sliceWidth,
          v0: groundUv.v0,
          u1: groundUv.u0 + (slice + 1) * sliceWidth,
          v1: groundUv.v1,
        },
      });
    }
  }

  /** Authored pads get a visible marker; a level surface you cannot see is not an affordance. */
  /**
   * Draws an atlas sprite at the world size it was authored for. Every sprite goes through
   * here so nothing is ever scaled by a number typed at the call site — that is how a sprite
   * ends up subtly the wrong shape in one place and right in another.
   */
  private sprite(
    batch: SpriteBatch,
    atlas: LoadedAtlas,
    name: string,
    x: number,
    y: number,
    options: {
      depth: number;
      rotation?: number;
      mirrored?: boolean;
      scale?: number;
      width?: number;
      height?: number;
      r?: number;
      g?: number;
      b?: number;
      a?: number;
    },
  ): void {
    const uv = atlas.uv(name);
    const size = atlas.size(name);
    const scale = options.scale ?? 1;
    batch.draw({
      x,
      y,
      width: options.width ?? size.width * scale,
      height: options.height ?? size.height * scale,
      rotation: options.rotation ?? 0,
      depth: options.depth,
      uv: options.mirrored ? { u0: uv.u1, v0: uv.v0, u1: uv.u0, v1: uv.v1 } : uv,
      ...(options.r === undefined ? {} : { r: options.r }),
      ...(options.g === undefined ? {} : { g: options.g }),
      ...(options.b === undefined ? {} : { b: options.b }),
      ...(options.a === undefined ? {} : { a: options.a }),
    });
  }

  private drawLandingZones(
    batch: SpriteBatch,
    atlas: LoadedAtlas,
    view: { centerX: number; halfWidth: number },
  ): void {
    for (const zone of this.world.mission.landingZones) {
      if (Math.abs(zone.x - view.centerX) > view.halfWidth + zone.width) continue;
      const base = zone.kind === 'base';
      const pad = atlas.size('landing_pad');
      const groundY = this.world.terrain.heightAt(zone.x) + pad.height / 2;
      // Tiled at the marking's own size rather than stretched across the zone: a 90 m pad
      // scaled from a 4 m sprite turns the painted dashes into 9 m bars.
      const tiles = Math.max(1, Math.round(zone.width / pad.width));
      for (let i = 0; i < tiles; i++) {
        const tileX = zone.x - zone.width / 2 + (i + 0.5) * (zone.width / tiles);
        this.sprite(batch, atlas, 'landing_pad', tileX, groundY, {
          depth: 0.68,
          width: zone.width / tiles,
          r: base ? 1 : 0.82,
          g: base ? 0.92 : 0.9,
          b: base ? 0.7 : 1,
          a: 0.95,
        });
      }
    }
  }

  /** Civilian state to sprite pose. The pose has to read at 28 pixels without colour. */
  private civilianSprite(civilian: (typeof this.world.civilians)[number]): string {
    const variant = civilian.id % 4;
    if (civilian.state === 'dead' || civilian.knockedDownFor > 0) {
      return `civilian_${variant}_down`;
    }
    if (civilian.wounded) return 'civilian_wounded';
    switch (civilian.state) {
      case 'boarding':
        return `civilian_${variant}_board`;
      case 'waitForSpace':
        return `civilian_${variant}_wave`;
      case 'seekCover':
      case 'panic':
      case 'approachLz':
        // Two-frame walk cycle on simulated time, so it reads as movement, not a slide.
        return `civilian_${variant}_${Math.floor(this.world.elapsed * 6) % 2 === 0 ? 'run_a' : 'run_b'}`;
      case 'released':
        return `civilian_${variant}_wave`;
      default:
        return `civilian_${variant}_idle`;
    }
  }

  private drawCivilians(
    batch: SpriteBatch,
    atlas: LoadedAtlas,
    view: { centerX: number; halfWidth: number },
  ): void {
    for (const civilian of this.world.civilians) {
      if (civilian.state === 'rescued' || civilian.state === 'aboard') continue;
      if (Math.abs(civilian.position.x - view.centerX) > view.halfWidth + 2) continue;

      const name = this.civilianSprite(civilian);
      const size = atlas.size(name);
      const dead = civilian.state === 'dead';
      // Sprites are drawn from their centre, so a standing figure is lifted half its height to
      // put its feet on the ground rather than its waist.
      const grounded = civilian.state === 'dead' || civilian.knockedDownFor > 0;
      this.sprite(batch, atlas, name, civilian.position.x, civilian.position.y + size.height / 2, {
        depth: 0.3,
        mirrored: civilian.position.x > this.world.player.position.x,
        ...(dead ? { r: 0.55, g: 0.4, b: 0.38, a: 0.8 } : {}),
      });
      void grounded;
    }
  }

  private drawEnemies(
    batch: SpriteBatch,
    atlas: LoadedAtlas,
    view: { centerX: number; halfWidth: number },
  ): void {
    for (const runtime of this.world.liveEnemies) {
      const enemy = runtime.enemy;
      if (Math.abs(enemy.position.x - view.centerX) > view.halfWidth + 8) continue;

      const suppressed = runtime.morale.suppressedFor > 0;
      const facePlayer = enemy.position.x > this.world.player.position.x;
      // A suppressed enemy is visibly out of the fight — that is the point of suppressing it
      // instead of killing it, and the player has to be able to see that it worked.
      const alpha = suppressed ? 0.45 : 1;

      switch (enemy.kind) {
        case 'lightTank': {
          const hull = atlas.size('tank_hull');
          this.sprite(
            batch,
            atlas,
            'tank_hull',
            enemy.position.x,
            enemy.position.y + hull.height / 2,
            {
              depth: 0.27,
              mirrored: facePlayer,
              a: alpha,
            },
          );
          // The turret traverses independently, which is what makes its firing line readable.
          const turret = atlas.size('tank_turret');
          this.sprite(
            batch,
            atlas,
            'tank_turret',
            enemy.position.x,
            enemy.position.y + hull.height + turret.height * 0.1,
            {
              depth: 0.26,
              mirrored: facePlayer,
              rotation: (facePlayer ? -1 : 1) * enemy.turretAngle,
              a: alpha,
            },
          );
          break;
        }
        case 'aaGun': {
          const size = atlas.size('aa_gun');
          this.sprite(
            batch,
            atlas,
            'aa_gun',
            enemy.position.x,
            enemy.position.y + size.height / 2,
            {
              depth: 0.27,
              mirrored: facePlayer,
              a: alpha,
            },
          );
          break;
        }
        case 'jet':
          this.sprite(batch, atlas, 'jet', enemy.position.x, enemy.position.y, {
            depth: 0.24,
            mirrored: facePlayer,
            a: alpha,
          });
          break;
        case 'drone':
          this.sprite(batch, atlas, 'drone', enemy.position.x, enemy.position.y, {
            depth: 0.24,
            a: alpha,
          });
          break;
        default: {
          const name = enemy.kind === 'rpgInfantry' ? 'infantry_rpg' : 'infantry_rifle';
          const size = atlas.size(name);
          this.sprite(batch, atlas, name, enemy.position.x, enemy.position.y + size.height / 2, {
            depth: 0.28,
            mirrored: facePlayer,
            a: alpha,
          });
          break;
        }
      }
    }
  }

  private drawProjectiles(
    batch: SpriteBatch,
    atlas: LoadedAtlas,
    view: { centerX: number; halfWidth: number },
  ): void {
    const pool = this.world.projectiles;
    for (let i = 0; i < pool.capacity; i++) {
      if (!pool.isActive(i)) continue;
      const px = pool.positionX(i);
      if (Math.abs(px - view.centerX) > view.halfWidth + 4) continue;

      const kind = pool.kindAt(i);
      const heavy = kind === 'rocket' || kind === 'rpg' || kind === 'jetMissile';
      const hostile = pool.teamAt(i) === 'hostile';
      const rotation = Math.atan2(pool.velocityY(i), pool.velocityX(i));
      const flying = Math.abs(rotation) > Math.PI / 2;

      this.sprite(batch, atlas, heavy ? 'rocket' : 'bullet', px, pool.positionY(i), {
        depth: 0.23,
        rotation: flying ? rotation + Math.PI : rotation,
        mirrored: flying,
        // Hostile fire reads red, the player's own reads pale — the PRD wants threat colour
        // to be redundant with shape, not the only signal.
        ...(hostile ? { r: 1, g: 0.55, b: 0.4 } : {}),
      });
    }
  }

  private drawPlayer(
    batch: SpriteBatch,
    atlas: LoadedAtlas,
    x: number,
    y: number,
    pitch: number,
  ): void {
    const player = this.world.player;
    const destroyed = player.destroyedFor !== null;
    const facing = this.renderFacing;
    const mirrored = facing < 0;
    // Near the foreground plane the aircraft is drawn head on rather than squashed sideways.
    const headOn = Math.abs(facing) < 0.45;
    const name = destroyed ? 'helicopter_wreck' : headOn ? 'helicopter_front' : 'helicopter';

    this.sprite(batch, atlas, name, x, y, {
      depth: 0.2,
      rotation: headOn ? 0 : pitch * (mirrored ? -1 : 1),
      mirrored: mirrored && !headOn,
      ...(destroyed ? {} : {}),
    });

    if (destroyed) return;

    // Rotor disc: width pulses with the blade cycle so it reads as turning rather than as a bar.
    const disc = atlas.size('rotor');
    const spin = Math.abs(Math.cos(this.rotorAngle));
    this.sprite(batch, atlas, 'rotor', x, y + (headOn ? 1.55 : 1.5), {
      depth: 0.18,
      rotation: headOn ? 0 : pitch * 0.35,
      width: disc.width * (0.45 + 0.55 * spin),
      height: disc.height,
      a: 0.55 + 0.3 * (1 - spin),
    });
    if (!headOn) {
      this.sprite(batch, atlas, 'tail_rotor', x + (mirrored ? 2.55 : -2.55), y + 0.5, {
        depth: 0.19,
        a: 0.8,
      });
    }
  }

  // --- UI -----------------------------------------------------------------

  private buildHudModel(): HudModel {
    const player = this.world.player;
    const counts = tally(this.world.civilians);
    const view = this.camera.view();
    this.tracked.length = 0;
    for (const runtime of this.world.liveEnemies) {
      this.tracked.push({
        position: runtime.enemy.position,
        kind: 'threat',
        urgent: runtime.enemy.kind === 'jet',
      });
    }
    for (const civilian of this.world.civilians) {
      if (
        civilian.state === 'released' ||
        civilian.state === 'panic' ||
        civilian.state === 'injured'
      ) {
        this.tracked.push({ position: civilian.position, kind: 'civilian' });
      }
    }
    const pool = this.world.projectiles;
    for (let i = 0; i < pool.capacity; i++) {
      if (!pool.isActive(i) || pool.teamAt(i) !== 'hostile') continue;
      const kind = pool.kindAt(i);
      if (kind !== 'jetMissile' && kind !== 'rpg') continue;
      this.tracked.push({
        position: { x: pool.positionX(i), y: pool.positionY(i) },
        kind: 'missile',
        urgent: true,
      });
    }

    const home = this.world.mission.landingZones.find((zone) => zone.kind === 'base');
    const groundHeight = this.world.terrain.heightAt(player.position.x);
    const agl = player.position.y - groundHeight;
    const current = this.world.objectives.current();
    const objectiveDefinition = this.world.mission.objectives.find((o) => o.id === current?.id);

    return {
      civilians: {
        rescued: counts.rescued,
        total: counts.total,
        dead: counts.dead,
        aboard: player.passengers.length,
        capacity: player.capacity,
      },
      aircraft: {
        hull: player.hull,
        engine: player.engine,
        rotor: player.rotor,
        fuel: player.fuel / 100,
        fuelCritical: fuelIsCritical(
          player.fuel,
          0.16,
          Math.abs(player.position.x - (home?.x ?? 0)),
          34,
        ),
      },
      weapons: {
        heat: this.world.weapons.heat,
        overheated: this.world.weapons.overheated,
        rockets: this.world.weapons.rockets,
        flares: this.world.weapons.flares,
        flareRecharge: null,
      },
      objective:
        current && objectiveDefinition
          ? { label: objectiveDefinition.label, progress: current.progress }
          : null,
      edgeMarkers: buildEdgeMarkers(this.tracked, view, player.position),
      landingAid: buildLandingAid({
        heightAboveGround: agl,
        verticalSpeed: player.velocity.y,
        horizontalSpeed: player.velocity.x,
        slopeDegrees: Math.abs(this.world.terrain.slopeDegreesAt(player.position.x)),
        leftSkidContact: player.landingContactCount > 0,
        rightSkidContact: player.landingContactCount === 2,
        civilianDanger: this.world.civilians.some(
          (civilian) =>
            civilian.state !== 'dead' &&
            civilian.state !== 'aboard' &&
            civilian.state !== 'rescued' &&
            Math.abs(civilian.position.x - player.position.x) < 4.2,
        ),
        grounded: player.grounded,
        safeLandings: this.world.stats.safeLandings,
        alwaysShow: false,
        tolerances: {
          safeVerticalSpeed: 3.2,
          crashVerticalSpeed: 6,
          safeHorizontalSpeed: 2.5,
          safeSlopeDegrees: 7,
        },
      }),
      tacticalStrip: buildTacticalStrip({
        mapLength: this.world.mission.lengthMeters,
        playerX: player.position.x,
        baseX: home?.x ?? 0,
        objectiveXs: this.world.mission.civilianGroups.map((group) => group.x),
        threatXs: this.world.liveEnemies.map((runtime) => runtime.enemy.position.x),
        refuelXs: this.world.mission.landingZones
          .filter((z) => z.services.includes('refuel'))
          .map((z) => z.x),
      }),
    };
  }

  private paintUi(nowMs: number): void {
    this.hud.update(this.buildHudModel(), nowMs);

    if (!this.overlay.isVisible) return;
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
          mission: `${sim.phase} rescued ${sim.rescued} dead ${sim.dead}`,
          world: `${sim.enemies} enemies, ${sim.projectiles} shots`,
        },
      },
      nowMs,
    );
  }

  /**
   * Keeps the rotor stack and the ducking envelope in step with the simulation. Ducking counts
   * the cues the PRD says must cut through the mix: an incoming missile, and a civilian in
   * danger under the aircraft.
   */
  private updateAudio(dt: number): void {
    const player = this.world.player;
    const view = this.camera.view();

    let ducking = 0;
    const pool = this.world.projectiles;
    for (let i = 0; i < pool.capacity; i++) {
      if (!pool.isActive(i) || pool.teamAt(i) !== 'hostile') continue;
      const kind = pool.kindAt(i);
      if (kind === 'jetMissile' || kind === 'rpg') ducking++;
    }
    const civilianInDanger =
      player.grounded &&
      this.world.civilians.some(
        (civilian) =>
          civilian.state !== 'dead' &&
          civilian.state !== 'rescued' &&
          civilian.state !== 'aboard' &&
          Math.abs(civilian.position.x - player.position.x) < 4.2,
      );
    if (civilianInDanger) ducking++;

    this.audio.update(dt, {
      rotor: {
        collective: clamp(this.actions.current.axes.thrustY, 0, 1),
        engine: player.engine,
        rotor: player.rotor,
        load: player.capacity > 0 ? player.passengers.length / player.capacity : 0,
        grounded: player.grounded,
      },
      listenerX: view.centerX,
      halfWidth: view.halfWidth,
      activeDuckingCues: ducking,
    });

    // The gun fires every tick it is held; cueing every shot would be a buzzsaw of voices.
    this.gunCueCooldown -= dt;
    if (this.world.weapons.burstElapsed > 0 && this.gunCueCooldown <= 0) {
      this.audio.playCue('weapon', { position: player.position.x, level: 0.55 });
      this.gunCueCooldown = 0.09;
    }
  }

  private simSnapshot(): SimSnapshot {
    const player = this.world.player;
    const counts = tally(this.world.civilians);
    const current = this.world.objectives.current();
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
      rescued: counts.rescued,
      dead: counts.dead,
      enemies: this.world.liveEnemies.length,
      projectiles: this.world.projectiles.liveCount,
      phase: this.world.phase,
      objective: current?.id ?? null,
    };
  }

  togglePause(): void {
    // The debrief is its own modal; Esc must not drop a pause menu on top of it.
    if (this.debriefScreen.isVisible) return;
    this.paused = !this.paused;
    if (this.paused) this.pauseScreen.show(this.save.current.settings);
    else {
      this.pauseScreen.hide();
      this.lastFrameMs = performance.now();
    }
  }

  /** Shows the debrief once, the first frame after the mission resolves. */
  private maybeDebrief(): void {
    if (this.debriefRecorded || this.world.phase === 'active') return;
    this.debriefRecorded = true;

    const outcome = this.world.outcome();
    const grade = gradeMission(outcome);
    this.debriefScreen.show(
      buildDebrief({
        missionName: this.mission.name,
        outcome,
        grade,
        civilians: this.world.civilians,
      }),
    );

    this.save.recordMission({
      missionId: this.mission.id,
      rank: grade.rank,
      score: grade.score,
      rescued: outcome.civilians.rescued,
      dead: outcome.civilians.dead,
      elapsedSeconds: outcome.elapsedSeconds,
      difficulty: difficultyOf(this.save.current.settings),
      completedAt: Date.now(),
    });
    for (let i = 0; i < this.world.stats.safeLandings; i++) this.save.recordSafeLanding();
    void this.save.flush();
  }

  /** The finished mission's grade, or null while it is still being flown. */
  grade(): ReturnType<typeof gradeMission> | null {
    if (this.world.phase === 'active') return null;
    return gradeMission(this.world.outcome());
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

  /**
   * Debug command surface, per the PRD's requirement to force every mission phase and spawn
   * every actor. Exposed through the app's test hooks, never through gameplay input.
   */
  readonly debug = {
    forcePhase: (phase: 'active' | 'complete' | 'failed'): void =>
      this.world.debugForcePhase(phase),
    spawnAll: (): number => this.world.debugSpawnAll(),
    releaseAllCivilians: (): void => this.world.debugReleaseAllCivilians(),
    teleport: (x: number, y?: number): void => this.world.debugTeleport(x, y),
  };

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
    this.hud.dispose();
    this.pauseScreen.dispose();
    this.debriefScreen.dispose();
    this.audio.dispose();
    this.batch?.destroy();
    this.skyBatch?.destroy();
    this.host.dispose();
  }
}
