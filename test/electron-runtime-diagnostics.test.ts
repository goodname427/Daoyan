import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

const { installRuntimeDiagnostics } = createRequire(import.meta.url)(
  '../electron/runtime-diagnostics.cjs',
) as {
  installRuntimeDiagnostics(options: {
    app: EventEmitter;
    processEvents: EventEmitter;
    logFile: string;
  }): void;
};
const directories: string[] = [];
function temporaryLog() {
  const directory = mkdtempSync(join(tmpdir(), 'daoyan-electron-diagnostics-'));
  directories.push(directory);
  return join(directory, 'events.jsonl');
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('leaves event handling untouched when diagnostics are disabled', () => {
  const app = new EventEmitter();
  const processEvents = new EventEmitter();
  installRuntimeDiagnostics({ app, processEvents, logFile: '' });
  expect(app.eventNames()).toEqual([]);
  expect(processEvents.eventNames()).toEqual([]);
});

it('distinguishes renderer failures, child exits, failed loads, and ordinary window closure', () => {
  const logFile = temporaryLog();
  const app = new EventEmitter();
  const processEvents = new EventEmitter();
  installRuntimeDiagnostics({ app, processEvents, logFile });
  const contents = Object.assign(new EventEmitter(), { id: 7 });
  const window = Object.assign(new EventEmitter(), { id: 3 });
  app.emit('web-contents-created', {}, contents);
  app.emit('browser-window-created', {}, window);
  contents.emit(
    'did-fail-load',
    {},
    -102,
    'private description',
    'https://private/?token=secret',
    true,
  );
  contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 });
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 9 });
  window.emit('close');
  window.emit('closed');
  app.emit('quit', {}, 0);
  processEvents.emit('exit', 0);
  const raw = readFileSync(logFile, 'utf8');
  const records = raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: 'did-fail-load',
        webContentsId: 7,
        errorCode: -102,
        isMainFrame: true,
      }),
      expect.objectContaining({
        event: 'render-process-gone',
        webContentsId: 7,
        reason: 'crashed',
        exitCode: 5,
      }),
      expect.objectContaining({ event: 'child-process-gone', type: 'GPU', exitCode: 9 }),
      expect.objectContaining({ event: 'window-closed', windowId: 3 }),
      expect.objectContaining({ event: 'process-exit', exitCode: 0 }),
    ]),
  );
  expect(raw).not.toContain('private');
  expect(raw).not.toContain('secret');
});

it('does not prevent startup when the diagnostics destination is unusable', () => {
  const file = temporaryLog();
  writeFileSync(file, 'occupied');
  const app = new EventEmitter();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() =>
    installRuntimeDiagnostics({
      app,
      processEvents: new EventEmitter(),
      logFile: join(file, 'log'),
    }),
  ).not.toThrow();
  expect(app.eventNames()).toEqual([]);
  expect(readFileSync(file, 'utf8')).toBe('occupied');
});

it('records fatal main-process exceptions without swallowing their nonzero exit', () => {
  const logFile = temporaryLog();
  const helper = resolve('electron/runtime-diagnostics.cjs');
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const { EventEmitter } = require('node:events');
    require(${JSON.stringify(helper)}).installRuntimeDiagnostics({app:new EventEmitter(),logFile:${JSON.stringify(logFile)}});
    throw new Error('diagnostic-fatal-test');
  `,
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(1);
  expect(child.stderr).toContain('diagnostic-fatal-test');
  const records = readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event: 'uncaught-exception', origin: 'uncaughtException' }),
      expect.objectContaining({ event: 'process-exit', exitCode: 1 }),
    ]),
  );
});
