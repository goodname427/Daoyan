import { defineConfig, devices } from '@playwright/test';

/**
 * E2E 测试配置。
 *
 * 自动拉起 Vite（端口 5180，与开发用的 5173 隔离），用 chromium 跑用例。
 * 关键价值：覆盖单元测试覆盖不到的「页面加载 / 交互产生未捕获异常」，
 * 即 jsdom 抓不到的 React Flow 测量、Canvas、真实布局路径。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5180',
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 6000,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite --port 5180 --strictPort',
    url: 'http://localhost:5180',
    reuseExistingServer: !process.env.CI,
    timeout: 40_000,
  },
});
