import { expect, test, type Page } from '@playwright/test';

interface Sim {
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
  lastTouchdown: string | null;
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

/** Holds a key for a number of simulation ticks, which is frame-rate independent. */
const holdForTicks = async (page: Page, key: string, ticks: number): Promise<void> => {
  const start = (await page.evaluate(() => window.shoplifter?.stats()?.tick)) ?? 0;
  await page.keyboard.down(key);
  await page.waitForFunction((t) => (window.shoplifter?.stats()?.tick ?? 0) > t, start + ticks, {
    timeout: 20_000,
  });
  await page.keyboard.up(key);
};

test.describe('flight sandbox', () => {
  test('starts parked on the pad with both skids down', async ({ page }) => {
    await boot(page);
    const state = await sim(page);
    expect(state.grounded).toBe(true);
    expect(state.contacts).toBe(2);
    expect(state.hull).toBe(1);
    expect(Math.abs(state.velocityY)).toBeLessThan(0.01);
  });

  test('climbs on lift input and settles back down when released', async ({ page }) => {
    await boot(page);
    await holdForTicks(page, 'KeyW', 180);
    const airborne = await sim(page);
    expect(airborne.grounded).toBe(false);
    expect(airborne.heightAboveGround).toBeGreaterThan(2);

    await page.waitForFunction(() => window.shoplifter?.stats()?.sim.grounded === true, undefined, {
      timeout: 25_000,
    });
    const landed = await sim(page);
    expect(landed.grounded).toBe(true);
    expect(landed.lastTouchdown).not.toBeNull();
  });

  test('translates horizontally and pitches into the acceleration', async ({ page }) => {
    await boot(page);
    await page.keyboard.down('KeyW');
    await holdForTicks(page, 'KeyD', 150);
    const moving = await sim(page);
    await page.keyboard.up('KeyW');

    expect(moving.velocityX).toBeGreaterThan(2);
    // The nose drops into a rightward acceleration, so pitch goes negative.
    expect(moving.pitchDegrees).toBeLessThan(0);
  });

  test('yaws through the foreground plane without changing course', async ({ page }) => {
    await boot(page);
    await page.keyboard.down('KeyW');
    await holdForTicks(page, 'KeyD', 150);

    const before = await sim(page);
    expect(before.facing).toBe(1);

    await page.keyboard.press('KeyQ');
    await page.waitForFunction(() => window.shoplifter?.stats()?.sim.facing === 0, undefined, {
      timeout: 10_000,
    });
    const turned = await sim(page);
    await page.keyboard.up('KeyW');

    // Facing changed; the aircraft is still travelling the way it was — the 1982 rule.
    expect(turned.facing).toBe(0);
    expect(turned.velocityX).toBeGreaterThan(0);
  });

  test('burns fuel while flying', async ({ page }) => {
    await boot(page);
    const start = await sim(page);
    await holdForTicks(page, 'KeyW', 240);
    const later = await sim(page);
    expect(later.fuel).toBeLessThan(start.fuel);
  });

  test('the debug overlay reports live flight telemetry', async ({ page }) => {
    await boot(page);
    const overlay = page.getByTestId('debug-overlay');
    await expect(overlay).toContainText('altitude');
    await expect(overlay).toContainText('attitude');
    await expect(overlay).toContainText('contact');
    await expect(overlay).toContainText('hull');
  });
});
