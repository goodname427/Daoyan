/**
 * 一键启动桌面窗口：先起 Vite，再拉起 Electron 指向它。
 *
 *   npm run desktop
 *
 * 不需要 concurrently / wait-on，避免额外依赖。
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = 'http://localhost:5173';

const vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
});

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(URL_);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const ok = await waitForServer();
if (!ok) {
  console.error('✖ Vite 未能在 30s 内启动');
  vite.kill();
  process.exit(1);
}

const electron = spawn('npx', ['electron', '.'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DAOYAN_DEV_URL: URL_ },
});

const shutdown = () => {
  electron.kill();
  vite.kill();
  process.exit(0);
};
electron.on('exit', shutdown);
process.on('SIGINT', shutdown);
