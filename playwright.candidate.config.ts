import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'candidate.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: process.env.CANDIDATE_BROWSER_REPORT ?? 'test-results/candidate.json' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4197',
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 6000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4197 --strictPort',
    url: 'http://127.0.0.1:4197',
    reuseExistingServer: false,
    timeout: 40_000,
  },
});
