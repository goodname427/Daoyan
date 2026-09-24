import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.DAOYAN_E2E_PORT || '5180');

/**
 * E2E 测试配置。
 *
 * 自动拉起 Vite（npm 脚本分配独立端口），用 chromium 跑用例。
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
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 6000,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 40_000,
  },
});
