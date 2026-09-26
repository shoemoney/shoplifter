import type { UnsupportedReason } from '@/render/webgpu/context.js';

interface Guidance {
  title: string;
  lead: string;
  steps: string[];
}

const GUIDANCE: Record<UnsupportedReason, Guidance> = {
  'no-navigator-gpu': {
    title: 'This browser cannot run Shoplifter yet',
    lead: 'The game renders with WebGPU, which this browser does not expose.',
    steps: [
      'Use a current desktop Chrome or Edge (version 113 or newer).',
      'Firefox and Safari support is arriving but is not enabled in every build yet.',
      'On Linux, WebGPU may need to be enabled explicitly in your browser flags.',
    ],
  },
  'insecure-context': {
    title: 'Shoplifter needs a secure connection',
    lead: 'WebGPU is only available in a secure context.',
    steps: ['Open the game over https://.', 'Or run it locally from http://localhost.'],
  },
  'no-adapter': {
    title: 'No usable GPU was found',
    lead: 'The browser has WebGPU but could not give the game a graphics adapter.',
    steps: [
      'Close other GPU-heavy tabs or applications and reload.',
      'Check that hardware acceleration is enabled in your browser settings.',
      'Update your graphics driver — some older drivers are blocklisted.',
    ],
  },
  'no-device': {
    title: 'The GPU refused to start a session',
    lead: 'An adapter was found, but requesting a device failed.',
    steps: ['Reload the page.', 'Restart the browser if it keeps happening.'],
  },
  'no-canvas-context': {
    title: 'The game canvas could not be initialised',
    lead: 'The page could not obtain a WebGPU canvas context.',
    steps: ['Reload the page.', 'Disable extensions that modify canvas rendering.'],
  },
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });

/**
 * An unsupported browser gets an explanation and a route forward. A blank canvas is the one
 * outcome that is never acceptable — the player cannot tell it from a broken build.
 */
export const showUnsupportedScreen = (
  host: HTMLElement,
  reason: UnsupportedReason,
  detail?: string,
): void => {
  const guidance = GUIDANCE[reason];
  host.innerHTML = `
    <div class="fallback-card" role="alert">
      <h1>${escapeHtml(guidance.title)}</h1>
      <p>${escapeHtml(guidance.lead)}</p>
      <ul>${guidance.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ul>
      ${detail ? `<p><code data-testid="fallback-detail">${escapeHtml(detail)}</code></p>` : ''}
    </div>
  `;
  host.dataset.reason = reason;
  host.hidden = false;
};

export const hideUnsupportedScreen = (host: HTMLElement): void => {
  host.hidden = true;
  host.innerHTML = '';
  delete host.dataset.reason;
};
