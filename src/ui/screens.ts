import type { DebriefModel } from './debrief.js';
import { formatDuration } from './debrief.js';
import type { Settings } from '@/save/schema.js';

/**
 * Pause and debrief screens. Plain DOM over the canvas: they are text and buttons, they need to
 * be keyboard- and screen-reader-navigable, and rendering them as sprites would cost draw calls
 * and legibility for nothing.
 */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) =>
    char === '&'
      ? '&amp;'
      : char === '<'
        ? '&lt;'
        : char === '>'
          ? '&gt;'
          : char === '"'
            ? '&quot;'
            : '&#39;',
  );

export interface PauseActions {
  resume: () => void;
  restart: () => void;
  onSettingChange: (mutate: (settings: Settings) => void) => void;
}

/** Settings worth reaching mid-mission. The full menu belongs on the title screen. */
interface QuickToggle {
  id: string;
  label: string;
  read: (settings: Settings) => boolean;
  write: (settings: Settings, value: boolean) => void;
}

const QUICK_TOGGLES: readonly QuickToggle[] = [
  {
    id: 'landing-aid',
    label: 'Always show landing aid',
    read: (s) => s.accessibility.alwaysShowLandingAid,
    write: (s, v) => (s.accessibility.alwaysShowLandingAid = v),
  },
  {
    id: 'reduced-motion',
    label: 'Reduced motion',
    read: (s) => s.accessibility.reducedMotion,
    write: (s, v) => (s.accessibility.reducedMotion = v),
  },
  {
    id: 'reduced-flashes',
    label: 'Reduced flashes',
    read: (s) => s.accessibility.reducedFlashes,
    write: (s, v) => (s.accessibility.reducedFlashes = v),
  },
  {
    id: 'subtitles',
    label: 'Subtitles',
    read: (s) => s.accessibility.subtitles,
    write: (s, v) => (s.accessibility.subtitles = v),
  },
  {
    id: 'civilian-friendly',
    label: 'Civilian-friendly fire',
    read: (s) => s.accessibility.civilianFriendlyMode,
    write: (s, v) => (s.accessibility.civilianFriendlyMode = v),
  },
];

export class PauseScreen {
  private readonly root: HTMLElement;
  private readonly actions: PauseActions;
  private visible = false;

  constructor(root: HTMLElement, actions: PauseActions) {
    this.root = root;
    this.actions = actions;
    root.classList.add('screen', 'screen--pause');
    root.hidden = true;
    root.addEventListener('click', this.onClick);
  }

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.action;
    if (action === 'resume') this.actions.resume();
    else if (action === 'restart') this.actions.restart();
    else if (action === 'toggle') {
      const toggle = QUICK_TOGGLES.find((candidate) => candidate.id === target.dataset.toggle);
      if (toggle) {
        this.actions.onSettingChange((settings) => {
          toggle.write(settings, !toggle.read(settings));
        });
      }
    }
  };

  get isVisible(): boolean {
    return this.visible;
  }

  show(settings: Settings): void {
    this.visible = true;
    this.root.hidden = false;
    this.root.innerHTML = `
      <div class="screen__card" role="dialog" aria-modal="true" aria-label="Paused">
        <h2>Paused</h2>
        <div class="screen__buttons">
          <button type="button" data-action="resume" data-testid="resume">Resume</button>
          <button type="button" data-action="restart" data-testid="restart">Restart mission</button>
        </div>
        <h3>Accessibility</h3>
        <ul class="toggles">
          ${QUICK_TOGGLES.map(
            (toggle) => `
            <li>
              <button
                type="button"
                data-action="toggle"
                data-toggle="${toggle.id}"
                data-testid="toggle-${toggle.id}"
                aria-pressed="${toggle.read(settings) ? 'true' : 'false'}"
              >${escapeHtml(toggle.label)}<span>${toggle.read(settings) ? 'on' : 'off'}</span></button>
            </li>`,
          ).join('')}
        </ul>
        <p class="screen__hint">Esc resumes &middot; backquote toggles the debug overlay</p>
      </div>
    `;
  }

  hide(): void {
    this.visible = false;
    this.root.hidden = true;
    this.root.innerHTML = '';
  }

  dispose(): void {
    this.root.removeEventListener('click', this.onClick);
    this.hide();
    this.root.classList.remove('screen', 'screen--pause');
  }
}

export interface DebriefActions {
  retry: () => void;
}

const FATE_LABEL: Record<string, string> = {
  rescued: 'returned',
  dead: 'killed',
  stranded: 'left behind',
};

export class DebriefScreen {
  private readonly root: HTMLElement;
  private readonly actions: DebriefActions;
  private visible = false;

  constructor(root: HTMLElement, actions: DebriefActions) {
    this.root = root;
    this.actions = actions;
    root.classList.add('screen', 'screen--debrief');
    root.hidden = true;
    root.addEventListener('click', this.onClick);
  }

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (target instanceof HTMLElement && target.dataset.action === 'retry') this.actions.retry();
  };

  get isVisible(): boolean {
    return this.visible;
  }

  show(model: DebriefModel): void {
    this.visible = true;
    this.root.hidden = false;
    const { grade } = model;

    this.root.innerHTML = `
      <div class="screen__card screen__card--wide" role="dialog" aria-modal="true" aria-label="Debrief">
        <header class="debrief__head">
          <h2>${escapeHtml(model.missionName)}</h2>
          <div class="debrief__rank" data-rank="${grade.rank}">
            <b data-testid="debrief-rank">${grade.rank}</b>
            <span>${grade.score.toFixed(0)}</span>
          </div>
        </header>

        ${
          grade.failed
            ? `<p class="debrief__failed" data-testid="debrief-failed">Mission failed &mdash; ${
                grade.failureReason === 'aircraft-lost'
                  ? 'aircraft lost'
                  : 'extraction threshold not met'
              }</p>`
            : ''
        }

        <ul class="debrief__counts" data-testid="debrief-counts">
          <li><b>${model.counts.rescued}</b> returned</li>
          <li><b>${model.counts.dead}</b> killed</li>
          <li><b>${model.counts.stranded}</b> left behind</li>
          <li><b>${formatDuration(model.flightTimeSeconds)}</b> flight time</li>
        </ul>

        <h3>Every civilian</h3>
        <ol class="debrief__roster" data-testid="debrief-roster">
          ${model.civilians
            .map(
              (row) =>
                `<li class="fate fate--${row.fate}">${escapeHtml(row.name)}<span>${
                  FATE_LABEL[row.fate] ?? row.fate
                }${row.wounded ? ', wounded' : ''}</span></li>`,
            )
            .join('')}
        </ol>

        ${
          model.tips.length > 0
            ? `<h3>Next time</h3>
               <ul class="debrief__tips" data-testid="debrief-tips">
                 ${model.tips.map((tip) => `<li>${escapeHtml(tip.message)}</li>`).join('')}
               </ul>`
            : ''
        }

        <p class="debrief__neutral">
          Aircraft damage ${(model.aircraftDamage * 100).toFixed(0)}% &middot;
          collateral incidents ${model.collateralIncidents} &middot;
          threats neutralised ${model.threatsNeutralised}
        </p>

        <div class="screen__buttons">
          <button type="button" data-action="retry" data-testid="debrief-retry">Fly it again</button>
        </div>
      </div>
    `;
  }

  hide(): void {
    this.visible = false;
    this.root.hidden = true;
    this.root.innerHTML = '';
  }

  dispose(): void {
    this.root.removeEventListener('click', this.onClick);
    this.hide();
    this.root.classList.remove('screen', 'screen--debrief');
  }
}
