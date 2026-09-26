import { defineConfig, devices } from '@playwright/test';
import process from 'node:process';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: true,
  // Each test drives a real WebGPU context. Seven at once on one GPU starve each other, and
  // several tests wait on SIMULATED progress — which stalls when the page is not getting frames.
  // Four workers keeps the suite fast without making the waits racy.
  workers: 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : 'line',
  use: {
    baseURL: 'http://127.0.0.1:4290',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-webgpu',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan',
            '--use-angle=metal',
            '--use-gl=angle',
          ],
        },
      },
    },
  ],
  // Port 4290 with --strictPort and an explicit IPv4 host: a preview server from another
  // project squatting on the default 4173 (on ::1) silently served the wrong app instead of
  // failing, which reads as a broken build.
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://127.0.0.1:4290',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
