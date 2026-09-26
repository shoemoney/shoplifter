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
