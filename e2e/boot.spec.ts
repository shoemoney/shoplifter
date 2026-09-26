import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

interface Stats {
  frames: number;
  tick: number;
  droppedTicks: number;
  fps: number;
  frameP99Ms: number;
  sprites: number;
  draws: number;
  adapter: string;
  recoveryPhase: string;
  recoveryAttempts: number;
  placeholderAssets: boolean;
  resolution: { width: number; height: number; dpr: number };
}

const collectConsoleErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
};

const waitForRunning = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => window.shoplifter?.status !== 'booting', undefined, {
    timeout: 20_000,
  });
  const status = await page.evaluate(() => window.shoplifter?.status);
  // A CI runner without a software GPU cannot render; say so loudly rather than pass silently.
  expect(status, 'app should reach the running state').toBe('running');
};

const readStats = (page: Page): Promise<Stats> =>
  page.evaluate(() => window.shoplifter?.stats() as unknown as Stats);

test.describe('boot and render', () => {
  test('renders instanced sprites in a single draw call with no console errors', async ({
    page,
  }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/');
    await waitForRunning(page);

    await page.waitForFunction(() => (window.shoplifter?.stats()?.frames ?? 0) > 60, undefined, {
      timeout: 20_000,
    });
    const stats = await readStats(page);

    // The scene is real content now — terrain columns, civilians, threats, particles — so the
    // assertion is about batching, not about hitting an inflated sprite count.
    expect(stats.sprites, 'the world should batch hundreds of sprites').toBeGreaterThan(200);
    expect(stats.draws, 'one atlas should mean one draw call').toBeLessThanOrEqual(2);
    expect(stats.tick, 'the fixed-step sim should have advanced').toBeGreaterThan(60);
    expect(stats.placeholderAssets, 'the committed atlas should load').toBe(false);
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('debug overlay reports adapter and frame metrics', async ({ page }) => {
    await page.goto('/');
    await waitForRunning(page);
    // The overlay is a developer tool and ships hidden; backquote toggles it in a real session.
    await page.evaluate(() => window.shoplifter?.toggleOverlay(true));
    const overlay = page.getByTestId('debug-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('fps');
    await expect(overlay).toContainText('sprites / draws');
    await expect(overlay).toContainText('adapter');
  });

  test('keyboard thrust reaches the simulation', async ({ page }) => {
    await page.goto('/');
    await waitForRunning(page);
    const before = (await readStats(page)).tick;

    await page.keyboard.down('KeyD');
    await page.waitForFunction((t) => (window.shoplifter?.stats()?.tick ?? 0) > t + 30, before, {
      timeout: 10_000,
    });
    await page.keyboard.up('KeyD');

    // Read the thrust straight off the simulation rather than the optional debug overlay.
    const moved = await page.evaluate(() => window.shoplifter?.stats()?.sim.x ?? 0);
    expect(moved).toBeGreaterThan(0);
  });

  test('survives a resize and a device pixel ratio change', async ({ page }) => {
    await page.goto('/');
    await waitForRunning(page);

    // Wait for the backbuffer to match a SPECIFIC css width rather than merely "something
    // different from last time". The loose version races: a still-pending first resize
    // satisfies "different", so the second reading can be the first resize's value and come
    // out smaller than the one it is compared against. It passes alone and fails under load.
    const waitForCssWidth = (cssWidth: number): Promise<unknown> =>
      page.waitForFunction(
        (width) => {
          const stats = window.shoplifter?.stats();
          if (!stats) return false;
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          return stats.resolution.width === Math.round(width * dpr);
        },
        cssWidth,
        { timeout: 30_000 },
      );

    await page.setViewportSize({ width: 1024, height: 640 });
    await waitForCssWidth(1024);
    const small = await readStats(page);

    await page.setViewportSize({ width: 1440, height: 900 });
    await waitForCssWidth(1440);
    const large = await readStats(page);

    expect(large.resolution.width).toBeGreaterThan(small.resolution.width);
    expect(large.recoveryPhase).toBe('ready');
  });

  test('recovers from a lost GPU device and keeps rendering', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/');
    await waitForRunning(page);
    const before = await readStats(page);

    // Destroying the device crashes Chromium's software WebGPU backend outright, so on a
    // GPU-less CI runner this drill tests the backend, not our recovery path. Skip it there
    // and keep it strict everywhere a real adapter exists.
    const software = /swiftshader|llvmpipe|software|lavapipe/i.test(before.adapter);
    test.skip(software, `software WebGPU adapter (${before.adapter}) cannot survive device loss`);

    await page.evaluate(() => window.shoplifter?.simulateDeviceLoss());

    await page.waitForFunction(
      () => window.shoplifter?.stats()?.recoveryPhase === 'ready',
      undefined,
      {
        timeout: 25_000,
      },
    );
    await page.waitForFunction(
      (frames) => (window.shoplifter?.stats()?.frames ?? 0) > frames + 30,
      before.frames,
      { timeout: 20_000 },
    );

    const after = await readStats(page);
    expect(after.recoveryAttempts, 'recovery should have run at least once').toBeGreaterThan(0);
    expect(after.sprites, 'sprites should render again after the rebuild').toBeGreaterThan(200);
    // Device loss logs are expected; validation errors are not.
    expect(errors.filter((e) => e.includes('uncaptured'))).toEqual([]);
  });
});
