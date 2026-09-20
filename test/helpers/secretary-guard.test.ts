import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForSecretaryDashboard } from './secretary-guard';

let server = createServer();

interface ChildProcessDouble extends EventEmitter {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stderr: PassThrough;
  stdout: PassThrough;
}

function childProcessDouble(): ChildProcessDouble {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    stderr: new PassThrough(),
    stdout: new PassThrough(),
  }) as ChildProcessDouble;
}

afterEach(async () => {
  if (server.listening) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  server = createServer();
});

describe('waitForSecretaryDashboard', () => {
  it('keeps waiting through unsuccessful HTTP responses until the dashboard is ready', async () => {
    let requests = 0;
    server = createServer((_request, response) => {
      requests += 1;
      if (requests < 3) {
        response.writeHead(503);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ready: true }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无法启动测试 HTTP 服务');

    await expect(
      waitForSecretaryDashboard(
        childProcessDouble() as unknown as ChildProcess,
        `http://127.0.0.1:${address.port}`,
      ),
    ).resolves.toEqual({ ready: true });
    expect(requests).toBe(3);
  });

  it('waits for a successful dashboard HTTP response', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ready: true }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无法启动测试 HTTP 服务');

    await expect(
      waitForSecretaryDashboard(
        childProcessDouble() as unknown as ChildProcess,
        `http://127.0.0.1:${address.port}`,
      ),
    ).resolves.toEqual({ ready: true });
  });

  it('reports an early child exit immediately with captured diagnostics', async () => {
    const child = childProcessDouble();
    const waiting = waitForSecretaryDashboard(
      child as unknown as ChildProcess,
      'http://127.0.0.1:1',
      20_000,
    );
    child.stderr.write('配置无效');
    child.exitCode = 17;
    child.emit('exit', 17, null);

    await expect(waiting).rejects.toThrow(/退出码 17[\s\S]*配置无效/);
  });
});
