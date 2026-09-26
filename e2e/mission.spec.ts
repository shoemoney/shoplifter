import { expect, test, type Page } from '@playwright/test';

interface Sim {
  x: number;
  rescued: number;
  dead: number;
  enemies: number;
  projectiles: number;
  phase: string;
  objective: string | null;
  fuel: number;
  hull: number;
  passengers: number;
}

const boot = async (page: Page): Promise<void> => {
  await page.goto('/');
  await page.waitForFunction(() => window.shoplifter?.status !== 'booting', undefined, {
    timeout: 20_000,
  });
  expect(await page.evaluate(() => window.shoplifter?.status)).toBe('running');
  await page.getByTestId('stage').click({ position: { x: 20, y: 20 } });
};

const sim = (page: Page): Promise<Sim> =>
  page.evaluate(() => window.shoplifter?.stats()?.sim as unknown as Sim);

test.describe('Operation Open Sky in the browser', () => {
  test('loads the authored mission rather than a sandbox', async ({ page }) => {
    await boot(page);
    const state = await sim(page);
    expect(state.phase).toBe('active');
    expect(state.objective).toBe('rescue_quota');
    // The mission spawns the player on the home pad at 200 m, not at the origin.
    expect(state.x).toBeGreaterThan(150);
    expect(state.x).toBeLessThan(260);
  });

  test('shows the three civilian counters and the objective line', async ({ page }) => {
    await boot(page);
    await expect(page.getByTestId('hud-counters')).toContainText('24');
    await expect(page.getByTestId('hud-objective')).toContainText('Rescue 18 civilians');
  });

  test('shows aircraft and weapon status without a running score', async ({ page }) => {
    await boot(page);
    const status = page.getByTestId('hud-status');
    await expect(status).toContainText('hull');
    await expect(status).toContainText('fuel');

    const weapons = page.getByTestId('hud-weapons');
    await expect(weapons).toContainText('rockets');
    await expect(weapons).toContainText('flares');

    // The PRD forbids a large traditional score during play.
    await expect(page.getByTestId('hud')).not.toContainText('Score');
  });

  test('draws the tactical strip with the player and the base', async ({ page }) => {
    await boot(page);
    const strip = page.getByTestId('hud-strip');
    await expect(strip.locator('.mark--player')).toHaveCount(1);
    await expect(strip.locator('.mark--base')).toHaveCount(1);
  });

  test('spawns threats from the authored sockets as the mission runs', async ({ page }) => {
    await boot(page);
    await page.keyboard.down('KeyW');
    await page.waitForFunction(
      () => (window.shoplifter?.stats()?.sim.enemies ?? 0) > 0,
      undefined,
      { timeout: 30_000 },
    );
    await page.keyboard.up('KeyW');
    expect((await sim(page)).enemies).toBeGreaterThan(0);
  });

  test('marks off-screen threats on the screen edge', async ({ page }) => {
    await boot(page);
    await page.keyboard.down('KeyW');
    await page.waitForFunction(
      () => (window.shoplifter?.stats()?.sim.enemies ?? 0) > 0,
      undefined,
      { timeout: 30_000 },
    );
    await page.keyboard.up('KeyW');
    await expect(page.getByTestId('hud-edges').locator('.edge')).not.toHaveCount(0);
  });

  test('burns fuel and keeps the HUD gauge in step with the simulation', async ({ page }) => {
    await boot(page);
    const start = await sim(page);
    await page.keyboard.down('KeyW');
    await page.waitForFunction(
      (fuel) => (window.shoplifter?.stats()?.sim.fuel ?? fuel) < fuel - 0.4,
      start.fuel,
      { timeout: 20_000 },
    );
    await page.keyboard.up('KeyW');
    await expect(page.getByTestId('hud-status')).toContainText('%');
  });
});

test.describe('pause, restart and debrief', () => {
  test('Esc opens the pause screen with accessibility toggles', async ({ page }) => {
    await boot(page);
    await page.keyboard.press('Escape');

    const pause = page.getByTestId('pause-screen');
    await expect(pause).toBeVisible();
    await expect(pause.getByTestId('resume')).toBeVisible();
    await expect(pause.getByTestId('toggle-reduced-motion')).toBeVisible();

    await pause.getByTestId('resume').click();
    await expect(pause).toBeHidden();
  });

  test('an accessibility toggle sticks and reports its state', async ({ page }) => {
    await boot(page);
    await page.keyboard.press('Escape');
    const toggle = page.getByTestId('toggle-reduced-motion');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(page.getByTestId('toggle-reduced-motion')).toHaveAttribute('aria-pressed', 'true');
  });

  test('restart puts the aircraft back on the pad with everyone still to rescue', async ({
    page,
  }) => {
    await boot(page);
    await page.evaluate(() => window.shoplifter?.debug?.releaseAllCivilians());
    // Get airborne first — skid friction means the aircraft barely slides on the pad.
    await page.keyboard.down('KeyW');
    await page.keyboard.down('KeyD');
    await page.waitForFunction(() => (window.shoplifter?.stats()?.sim.x ?? 0) > 260, undefined, {
      timeout: 20_000,
    });
    await page.keyboard.up('KeyD');
    await page.keyboard.up('KeyW');

    await page.evaluate(() => window.shoplifter?.restart());
    await page.waitForFunction(() => (window.shoplifter?.stats()?.sim.x ?? 9999) < 260, undefined, {
      timeout: 10_000,
    });

    const state = await sim(page);
    expect(state.rescued).toBe(0);
    expect(state.phase).toBe('active');
    expect(state.hull).toBe(1);
  });

  test('the debrief names every civilian and never celebrates kills', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.shoplifter?.debug?.forcePhase('complete'));

    const debrief = page.getByTestId('debrief-screen');
    await expect(debrief).toBeVisible();
    await expect(debrief.getByTestId('debrief-rank')).toBeVisible();
    // Every one of the 24 authored civilians is accounted for by name.
    await expect(debrief.getByTestId('debrief-roster').locator('li')).toHaveCount(24);
    await expect(debrief.getByTestId('debrief-counts')).toContainText('left behind');
    // Threats appear only as a neutral statistic, never as a score.
    await expect(debrief).toContainText('threats neutralised');
    await expect(debrief).not.toContainText('Kills');
  });

  test('a failed mission says why it failed', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.shoplifter?.debug?.forcePhase('failed'));
    const debrief = page.getByTestId('debrief-screen');
    await expect(debrief).toBeVisible();
    await expect(debrief.getByTestId('debrief-failed')).toContainText('aircraft lost');
    await expect(debrief.getByTestId('debrief-rank')).toContainText('F');
  });

  test('flying it again from the debrief resets the mission', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.shoplifter?.debug?.forcePhase('failed'));
    await page.getByTestId('debrief-retry').click();
    await expect(page.getByTestId('debrief-screen')).toBeHidden();
    expect((await sim(page)).phase).toBe('active');
  });

  test('the debug command spawns every authored enemy kind', async ({ page }) => {
    await boot(page);
    const spawned = await page.evaluate(() => window.shoplifter?.debug?.spawnAll() ?? 0);
    expect(spawned).toBeGreaterThanOrEqual(5);
    expect((await sim(page)).enemies).toBeGreaterThanOrEqual(5);
  });
});
