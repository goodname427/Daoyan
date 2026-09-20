import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportsDirectory = resolve(root, 'coverage', `.run-${process.pid}-${randomUUID()}`);
const vitest = resolve(root, 'node_modules', 'vitest', 'vitest.mjs');

try {
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const child = spawn(process.execPath, [vitest, 'run', '--coverage'], {
      cwd: root,
      env: { ...process.env, DAOYAN_COVERAGE_REPORTS_DIRECTORY: reportsDirectory },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => {
      if (signal) rejectExit(new Error(`覆盖率进程被信号 ${signal} 终止`));
      else resolveExit(code ?? 1);
    });
  });
  process.exitCode = exitCode;
} finally {
  await rm(reportsDirectory, { recursive: true, force: true });
}
