import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * The arcade mounts each game at `https://arcade.shoemoney.com/<slug>/`, so "boots at the root"
 * is a weaker claim than "boots deployed". This suite loads the SAME production build from a
 * sub-path and proves it still finds its own assets.
 *
 * Without it the failure is quiet and remote-only: a site-absolute `/assets/atlas.png` resolves
 * against the arcade's root instead of the game's directory, the atlas 404s, the loader falls
 * back to its magenta placeholder, and the game looks broken in a way that never reproduces
 * locally. `placeholderAssets` is the assertion that catches exactly that.
 */
const SUBPATH = 'http://127.0.0.1:4291/shoplifter/';

const collect = (page: Page): { errors: string[]; notFound: string[] } => {
  const errors: string[] = [];
  const notFound: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() === 404) notFound.push(response.url());
  });
  return { errors, notFound };
};

test.describe('served from a sub-path, as the arcade serves it', () => {
  test('boots and reaches the running state', async ({ page }) => {
    await page.goto(SUBPATH);
    await page.waitForFunction(() => window.shoplifter?.status !== 'booting', undefined, {
      timeout: 20_000,
    });
    expect(await page.evaluate(() => window.shoplifter?.status)).toBe('running');
  });

  test('loads its real atlas rather than falling back to the placeholder', async ({ page }) => {
    await page.goto(SUBPATH);
    await page.waitForFunction(() => window.shoplifter?.status === 'running', undefined, {
      timeout: 20_000,
    });
    const stats = await page.evaluate(() => window.shoplifter?.stats());
    // The whole point: a mis-resolved atlas URL degrades silently to magenta placeholder art.
    expect(stats?.placeholderAssets, 'atlas resolved to the wrong directory').toBe(false);
    expect(stats?.sprites ?? 0).toBeGreaterThan(200);
  });

  test('requests nothing that 404s', async ({ page }) => {
    const { errors, notFound } = collect(page);
    await page.goto(SUBPATH);
    await page.waitForFunction(() => window.shoplifter?.status === 'running', undefined, {
      timeout: 20_000,
    });
    await page.waitForTimeout(700);
    expect(notFound, `404s under the sub-path: ${notFound.join(', ')}`).toEqual([]);
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('loads the generated backdrop, not just the atlas', async ({ page }) => {
    const responses: string[] = [];
    page.on('response', (response) => {
      if (response.ok()) responses.push(new URL(response.url()).pathname);
    });
    await page.goto(SUBPATH);
    await page.waitForFunction(() => window.shoplifter?.status === 'running', undefined, {
      timeout: 20_000,
    });
    await page.waitForTimeout(700);
    expect(responses.some((path) => path.endsWith('sky_salt_flats.jpg'))).toBe(true);
    expect(responses.every((path) => path.startsWith('/shoplifter/'))).toBe(true);
  });

  test('plays the mission the same way it does at the root', async ({ page }) => {
    await page.goto(SUBPATH);
    await page.waitForFunction(() => window.shoplifter?.status === 'running', undefined, {
      timeout: 20_000,
    });
    await page.getByTestId('stage').click({ position: { x: 20, y: 20 } });
    await page.keyboard.down('KeyW');
    await page.waitForFunction(
      () => (window.shoplifter?.stats()?.sim.heightAboveGround ?? 0) > 3,
      undefined,
      { timeout: 20_000 },
    );
    await page.keyboard.up('KeyW');
    await expect(page.getByTestId('hud-objective')).toContainText('Rescue 18 civilians');
  });
});
