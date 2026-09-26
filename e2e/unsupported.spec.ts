import { expect, test } from '@playwright/test';

test.describe('unsupported browser', () => {
  test('explains the problem instead of showing a blank canvas', async ({ page }) => {
    // Runs before any page script, so bootstrap sees a browser with no WebGPU at all.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
    });
    await page.goto('/');

    await page.waitForFunction(() => window.shoplifter?.status === 'unsupported', undefined, {
      timeout: 15_000,
    });

    const fallback = page.getByTestId('fallback');
    await expect(fallback).toBeVisible();
    await expect(fallback).toHaveAttribute('data-reason', 'no-navigator-gpu');
    await expect(fallback.getByRole('alert')).toContainText('WebGPU');
    await expect(fallback).toContainText('Chrome');
    await expect(page.getByTestId('stage')).toBeHidden();
  });

  test('reports a refused adapter as its own case', async ({ page }) => {
    await page.addInitScript(() => {
      const gpu = {
        requestAdapter: () => Promise.resolve(null),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      };
      Object.defineProperty(navigator, 'gpu', { value: gpu, configurable: true });
    });
    await page.goto('/');

    await page.waitForFunction(() => window.shoplifter?.status === 'unsupported', undefined, {
      timeout: 15_000,
    });
    await expect(page.getByTestId('fallback')).toHaveAttribute('data-reason', 'no-adapter');
    await expect(page.getByTestId('fallback')).toContainText('hardware acceleration');
  });
});
