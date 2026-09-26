import type { EdgeMarker, HudModel, TacticalMark } from './hud.js';

/**
 * Renders the HUD model into the DOM. Kept out of the sprite batch on purpose: text and gauges
 * stay crisp at any device pixel ratio, cost no draw calls against the PRD's budget, and are
 * readable by a screen reader, which an SDF-text quad would not be.
 */
const EDGE_GLYPH: Record<EdgeMarker['kind'], string> = {
  threat: '▲',
  missile: '◆',
  civilian: '●',
  objective: '◇',
  base: '⌂',
};

const MARK_GLYPH: Record<TacticalMark['kind'], string> = {
  player: '▲',
  base: '⌂',
  objective: '◇',
  threat: '×',
  refuel: '⛽',
};

const pct = (value: number): string => `${Math.round(value * 100)}%`;

const gauge = (label: string, value: number, danger: boolean): string =>
  `<div class="gauge${danger ? ' gauge--danger' : ''}">
     <span class="gauge__label">${label}</span>
     <span class="gauge__bar"><i style="width:${Math.max(0, Math.min(100, value * 100))}%"></i></span>
     <span class="gauge__value">${pct(value)}</span>
   </div>`;

export class HudView {
  private readonly root: HTMLElement;
  private readonly counters: HTMLElement;
  private readonly status: HTMLElement;
  private readonly weapons: HTMLElement;
  private readonly objective: HTMLElement;
  private readonly edges: HTMLElement;
  private readonly landing: HTMLElement;
  private readonly strip: HTMLElement;
  private lastPaint = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    root.classList.add('hud');
    root.innerHTML = `
      <div class="hud__counters" data-testid="hud-counters" role="status" aria-live="polite"></div>
      <div class="hud__objective" data-testid="hud-objective"></div>
      <div class="hud__status" data-testid="hud-status"></div>
      <div class="hud__weapons" data-testid="hud-weapons"></div>
      <div class="hud__edges" data-testid="hud-edges" aria-hidden="true"></div>
      <div class="hud__landing" data-testid="hud-landing" hidden></div>
      <div class="hud__strip" data-testid="hud-strip" aria-hidden="true"></div>
    `;
    const find = (selector: string): HTMLElement => {
      const element = root.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`HudView: missing ${selector}`);
      return element;
    };
    this.counters = find('.hud__counters');
    this.objective = find('.hud__objective');
    this.status = find('.hud__status');
    this.weapons = find('.hud__weapons');
    this.edges = find('.hud__edges');
    this.landing = find('.hud__landing');
    this.strip = find('.hud__strip');
  }

  /**
   * Repaints at 20 Hz. The HUD changes far slower than the frame rate, and writing innerHTML
   * every frame is a measurable cost that shows up in the frame-time budget for nothing.
   */
  update(model: HudModel, nowMs: number, force = false): void {
    if (!force && nowMs - this.lastPaint < 50) return;
    this.lastPaint = nowMs;

    const { civilians, aircraft, weapons } = model;
    this.counters.innerHTML = `
      <span class="counter counter--saved" title="Safely returned">${civilians.rescued}<small>/${civilians.total}</small></span>
      <span class="counter counter--lost" title="Killed">${civilians.dead}</span>
      <span class="counter counter--aboard" title="Aboard">${civilians.aboard}<small>/${civilians.capacity}</small></span>
    `;

    this.objective.innerHTML = model.objective
      ? `<span class="objective__label">${model.objective.label}</span>
         <span class="objective__bar"><i style="width:${Math.round(model.objective.progress * 100)}%"></i></span>`
      : '';

    this.status.innerHTML = [
      gauge('hull', aircraft.hull, aircraft.hull < 0.3),
      gauge('engine', aircraft.engine, aircraft.engine < 0.4),
      gauge('fuel', aircraft.fuel, aircraft.fuelCritical),
    ].join('');

    this.weapons.innerHTML = `
      ${gauge('heat', weapons.heat, weapons.overheated)}
      <div class="ammo"><span>rockets</span><b>${weapons.rockets}</b></div>
      <div class="ammo"><span>flares</span><b>${weapons.flares}</b>${
        weapons.flareRecharge === null ? '' : `<i>${weapons.flareRecharge.toFixed(1)}s</i>`
      }</div>
    `;

    // Only the closest few markers are drawn; a ring of arrows is noise, not information.
    this.edges.innerHTML = model.edgeMarkers
      .slice(0, 6)
      .map((marker) => {
        const along = `${(marker.position * 100).toFixed(1)}%`;
        const style =
          marker.side === 'left' || marker.side === 'right'
            ? `top:${along};${marker.side}:4px`
            : `left:${along};${marker.side}:4px`;
        return `<span class="edge edge--${marker.kind}${marker.urgent ? ' edge--urgent' : ''}" style="${style}">${
          EDGE_GLYPH[marker.kind]
        }</span>`;
      })
      .join('');

    const aid = model.landingAid;
    this.landing.hidden = !aid.visible;
    if (aid.visible) {
      this.landing.dataset.projected = aid.projected;
      this.landing.innerHTML = `
        <div class="landing__row"><span>vs</span><b>${aid.verticalSpeed.toFixed(1)}</b></div>
        <div class="landing__row"><span>hs</span><b>${aid.horizontalSpeed.toFixed(1)}</b></div>
        <div class="landing__row"><span>slope</span><b>${aid.slopeDegrees.toFixed(1)}&deg;</b></div>
        <div class="landing__skids">
          <i class="${aid.leftSkidContact ? 'on' : ''}"></i>
          <i class="${aid.rightSkidContact ? 'on' : ''}"></i>
        </div>
        ${aid.civilianDanger ? '<div class="landing__warning">CIVILIAN UNDER ROTOR</div>' : ''}
      `;
    }

    this.strip.innerHTML = model.tacticalStrip
      .map(
        (mark) =>
          `<span class="mark mark--${mark.kind}" style="left:${(mark.position * 100).toFixed(2)}%">${
            MARK_GLYPH[mark.kind]
          }</span>`,
      )
      .join('');
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  dispose(): void {
    this.root.innerHTML = '';
    this.root.classList.remove('hud');
  }
}
