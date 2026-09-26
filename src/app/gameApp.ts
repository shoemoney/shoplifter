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

export interface GameAppElements {
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  hud: HTMLElement;
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
const TERRAIN_DEPTH_METRES = 80;
/** How much ground the camera may show below the local terrain, metres. */
const GROUND_MARGIN_METRES = 7;

/** Colour per enemy kind, so threats stay distinguishable at a glance. */
const ENEMY_TINT: Record<string, [number, number, number]> = {
  rifleInfantry: [0.95, 0.42, 0.35],
  rpgInfantry: [1, 0.55, 0.2],
  lightTank: [0.72, 0.4, 0.32],
  aaGun: [0.85, 0.35, 0.55],
  jet: [0.8, 0.85, 1],
  drone: [1, 0.72, 0.3],
};

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
  private readonly world: MissionWorld;
  private readonly tracked: TrackedEntity[] = [];

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

  private previous: Interpolated = { x: 0, y: 0, pitch: 0 };
  private current: Interpolated = { x: 0, y: 0, pitch: 0 };
  private rotorAngle = 0;
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

    const mission = loadMission(OPEN_SKY_ID);
    this.world = new MissionWorld({
      mission,
      flight: loadFlightBalance(),
      dt: this.clock.dt,
    });
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
        // One flat tint so overlapping silhouettes read as a single ridge mass.
        tint: [0.075, 0.085, 0.125],
        parallax: 0.35,
        fieldWidth: 320,
      });
    }
    for (let i = 0; i < 1800; i++) {
      const size = rng.range(0.05, 0.16);
      const height = rng.range(0.2, 9);
      this.background.push({
        x: rng.range(0, 88),
        y: height,
        width: size,
        height: size,
        depth: 0.4,
        alpha: rng.range(0.1, 0.3) * (1 - height / 12),
        region: 'glow',
        tint: [1, 0.88, 0.7],
        parallax: 1,
        fieldWidth: 88,
      });
    }

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
      this.world.step(this.paused ? neutralMissionInput() : input);
      this.syncInterpolation(false);
    }
    this.world.events.drain();
    this.simMs = performance.now() - simStart;

    this.render(step.alpha);
    this.paintUi(nowMs);
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

    batch.begin();
    this.drawBackgroundRange(batch, atlas, view, 0, this.foregroundStart);
    this.drawTerrain(batch, atlas, view);
    this.drawLandingZones(batch, atlas, view);
    this.drawBackgroundRange(batch, atlas, view, this.foregroundStart, this.background.length);
    this.drawCivilians(batch, atlas, view);
    this.drawEnemies(batch, atlas, view);
    this.drawProjectiles(batch, atlas, view);
    this.drawPlayer(batch, atlas, x, y, pitch);

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
    for (let i = 0; i < TERRAIN_COLUMNS; i++) {
      const columnX = view.centerX - view.halfWidth - 2 + (i + 0.5) * columnWidth;
      const height = this.world.terrain.heightAt(columnX);
      batch.draw({
        x: columnX,
        y: height - TERRAIN_DEPTH_METRES / 2,
        width: columnWidth * 1.04,
        height: TERRAIN_DEPTH_METRES,
        depth: TERRAIN_DEPTH,
        uv: groundUv,
      });
    }
  }

  /** Authored pads get a visible marker; a level surface you cannot see is not an affordance. */
  private drawLandingZones(
    batch: SpriteBatch,
    atlas: LoadedAtlas,
    view: { centerX: number; halfWidth: number },
  ): void {
    for (const zone of this.world.mission.landingZones) {
      if (Math.abs(zone.x - view.centerX) > view.halfWidth + zone.width) continue;
      const base = zone.kind === 'base';
      batch.draw({
        x: zone.x,
        y: this.world.terrain.heightAt(zone.x) + 0.18,
        width: zone.width,
        height: 0.36,
        depth: 0.68,
        uv: atlas.uv('white'),
        r: base ? 0.45 : 0.38,
        g: base ? 0.95 : 0.72,
        b: base ? 0.75 : 0.95,
        a: 0.55,
      });
    }
  }

  private drawCivilians(
    batch: SpriteBatch,
    atlas: LoadedAtlas,
    view: { centerX: number; halfWidth: number },
  ): void {
    const uv = atlas.uv('civilian');
    for (const civilian of this.world.civilians) {
      if (civilian.state === 'rescued' || civilian.state === 'aboard') continue;
      if (Math.abs(civilian.position.x - view.centerX) > view.halfWidth + 2) continue;
      const dead = civilian.state === 'dead';
      const down = civilian.knockedDownFor > 0;
      batch.draw({
        x: civilian.position.x,
        y: civilian.position.y + (dead || down ? 0.35 : 0.9),
        width: dead || down ? 1.6 : 0.8,
        height: dead || down ? 0.5 : 1.8,
        rotation: dead || down ? Math.PI / 2 : 0,
        depth: 0.3,
        uv,
        r: dead ? 0.4 : civilian.wounded ? 1 : 0.85,
        g: dead ? 0.22 : civilian.wounded ? 0.55 : 1,
        b: dead ? 0.2 : civilian.wounded ? 0.45 : 0.9,
        a: dead ? 0.7 : 1,
      });
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
      const tint = ENEMY_TINT[enemy.kind] ?? [1, 1, 1];
      const air = enemy.kind === 'jet' || enemy.kind === 'drone';
      const size = enemy.kind === 'lightTank' || enemy.kind === 'aaGun' ? 3.4 : air ? 4.2 : 1.2;
      batch.draw({
        x: enemy.position.x,
        y: enemy.position.y + size * 0.3,
        width: size,
        height: air ? size * 0.4 : size * 0.6,
        depth: 0.26,
        uv: atlas.uv(air ? 'helicopter' : 'white'),
        r: tint[0],
        g: tint[1],
        b: tint[2],
        // A suppressed enemy is visibly out of the fight — that is the point of suppressing it.
        a: runtime.morale.suppressedFor > 0 ? 0.45 : 1,
      });
    }
  }

  private drawProjectiles(
    batch: SpriteBatch,
    atlas: LoadedAtlas,
    view: { centerX: number; halfWidth: number },
  ): void {
    const uv = atlas.uv('glow');
    const pool = this.world.projectiles;
    for (let i = 0; i < pool.capacity; i++) {
      if (!pool.isActive(i)) continue;
      const px = pool.positionX(i);
      if (Math.abs(px - view.centerX) > view.halfWidth + 4) continue;
      const hostile = pool.teamAt(i) === 'hostile';
      const kind = pool.kindAt(i);
      const big = kind === 'rocket' || kind === 'rpg' || kind === 'jetMissile';
      batch.draw({
        x: px,
        y: pool.positionY(i),
        width: big ? 1.1 : 0.45,
        height: big ? 0.45 : 0.28,
        rotation: Math.atan2(pool.velocityY(i), pool.velocityX(i)),
        depth: 0.24,
        uv,
        r: hostile ? 1 : 0.7,
        g: hostile ? 0.5 : 1,
        b: hostile ? 0.3 : 0.75,
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
    const bodyUv = atlas.uv('helicopter');
    const facingScale = this.renderFacing;
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
    this.paused = !this.paused;
    if (!this.paused) this.lastFrameMs = performance.now();
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
    this.batch?.destroy();
    this.host.dispose();
  }
}
