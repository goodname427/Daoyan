import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'node_modules', 'playwright', 'cli.js');
const env = { ...process.env };

if (!env.DAOYAN_E2E_PORT) {
  env.DAOYAN_E2E_PORT = String(
    await new Promise((resolvePort, rejectPort) => {
      const server = createServer();
      server.on('error', rejectPort);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          rejectPort(new Error('无法分配 E2E 测试端口'));
          return;
        }
        server.close(() => resolvePort(address.port));
      });
    }),
  );
}

// Playwright sets FORCE_COLOR=1 for its WebServer and worker processes.  Do
// not forward an external NO_COLOR as well: current Node reports that conflict
// as a warning for each child, even though the test run itself is healthy.
delete env.NO_COLOR;

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (error) => {
  console.error(`无法启动 Playwright：${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
