import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  publishApprovalRelay,
  startApprovalRelay,
  withoutApprovalRelay,
  redactApprovalFormUrls,
  deliverHumanApproval,
} from '../scripts/worker-approval-relay';
import { startApplicationApprovalServer } from '../scripts/worker-app-approval';
import { SecretaryChannelHub, type SecretaryNotice } from '../scripts/secretary-channel';

const threadId = '01a0fe61-f920-7df3-ab89-ef6707da36d6';
const request = {
  threadId,
  turnId: 'turn-1',
  serverName: 'node_repl',
  mode: 'openai/form',
  message: 'Allow Codex to use electron?',
  requestedSchema: { type: 'object', properties: {} },
  _meta: {
    connector_id: 'computer-use',
    codex_approval_kind: 'mcp_tool_call',
    tool_params: { app: 'electron' },
  },
};

describe('background approval delivery', () => {
  it('allows a legitimate sixteen-second human-channel delivery within the hub budget', async () => {
    const hub = new SecretaryChannelHub(
      [
        {
          id: 'slow-test-human',
          start: async () => {},
          stop: async () => {},
          publish: async () => {
            await new Promise((resolve) => setTimeout(resolve, 16_000));
          },
        },
      ],
      { info: () => {}, error: () => {} },
    );
    await hub.start(async () => ({ requestId: 'mock', accepted: true }));
    const relay = await startApprovalRelay({
      onPending: async (event, url, signal) => {
        await deliverHumanApproval(hub, event, url, 'slow-test');
        expect(signal.aborted).toBe(false);
      },
    });
    try {
      expect(
        await publishApprovalRelay(
          {
            id: randomUUID(),
            status: 'pending',
            request,
            url: `http://127.0.0.1:1234/${'a'.repeat(64)}/1`,
          },
          relay.environment,
        ),
      ).toBe(true);
    } finally {
      await relay.close();
      await hub.stop();
    }
  }, 25_000);
  it('transports a pending capability only through the private pipe and waits for a decision', async () => {
    let deliveredUrl = '';
    let formUrl = '';
    const id = randomUUID();
    const relay = await startApprovalRelay({
      onPending: async (_event, url) => {
        deliveredUrl = url;
      },
    });
    const host = await startApplicationApprovalServer({
      onPending: async (url) => {
        formUrl = url;
        await publishApprovalRelay({ id, status: 'pending', request, url }, relay.environment);
      },
      onResolved: async (_request, action) => {
        await publishApprovalRelay({ id, status: 'resolved', request, action }, relay.environment);
      },
    });
    try {
      let done = false;
      const pending = host.request(request).then((result) => {
        done = true;
        return result;
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('relay event missing')), 2000);
        const check = setInterval(() => {
          if (deliveredUrl) {
            clearInterval(check);
            clearTimeout(timeout);
            resolve();
          }
        }, 10);
      });
      expect(done).toBe(false);
      expect(deliveredUrl).toBe(formUrl);
      expect(JSON.stringify(relay.environment)).not.toContain(formUrl);
      expect(done).toBe(false);
      await fetch(formUrl, {
        method: 'POST',
        headers: {
          Origin: new URL(formUrl).origin,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'action=cancel',
      });
      expect(await pending).toEqual({ action: 'cancel', content: null });
      expect((await fetch(formUrl)).status).toBe(410);
    } finally {
      await host.close();
      await relay.close();
    }
  });

  it('rejects a forged sender and strips relay credentials from the model environment', async () => {
    let called = false;
    const relay = await startApprovalRelay({
      onPending: async () => {
        called = true;
      },
    });
    try {
      await expect(
        publishApprovalRelay(
          {
            id: randomUUID(),
            status: 'pending',
            request,
            url: `http://127.0.0.1:1234/${'a'.repeat(64)}/1`,
          },
          { ...relay.environment, DAOYAN_APPROVAL_RELAY_SECRET: 'wrong' },
        ),
      ).rejects.toThrow();
      expect(called).toBe(false);
      expect(withoutApprovalRelay({ ...relay.environment, PATH: 'retained' })).toEqual({
        PATH: 'retained',
      });
      expect(
        await publishApprovalRelay(
          { id: randomUUID(), status: 'resolved', request, action: 'cancel' },
          {},
        ),
      ).toBe(false);
      expect(
        redactApprovalFormUrls(
          `other http://127.0.0.1:5173\nhttp://127.0.0.1:1234/${'a'.repeat(64)}/1`,
        ),
      ).toBe('other http://127.0.0.1:5173\n[application approval form URL omitted]');
    } finally {
      await relay.close();
    }
  });

  it('requires an acknowledged human channel and stops when delivery fails or none is configured', async () => {
    const notices: SecretaryNotice[] = [];
    const event = { id: randomUUID(), status: 'pending' as const, request };
    const url = `http://127.0.0.1:1234/${'a'.repeat(64)}/1`;
    const hub = new SecretaryChannelHub(
      [
        {
          id: 'test-human',
          start: async () => {},
          stop: async () => {},
          publish: async (notice) => {
            notices.push(notice);
          },
        },
      ],
      { info: () => {}, error: () => {} },
    );
    await expect(deliverHumanApproval(null, event, url, 'test-task')).rejects.toThrow('没有已配置');
    await expect(deliverHumanApproval(hub, event, url, 'test-task')).rejects.toThrow('投递失败');
    await hub.start(async () => ({ requestId: 'mock', accepted: true }));
    await deliverHumanApproval(hub, event, url, 'test-task');
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain(url);
    await hub.stop();
  });

  it('delivers while the real host stdout is redirected and keeps the form URL out of that log', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'daoyan-approval-background-'));
    let announce!: (url: string) => void;
    const announcement = new Promise<string>((resolve) => {
      announce = resolve;
    });
    const relay = await startApprovalRelay({
      onPending: async (_event, url) => {
        announce(url);
      },
    });
    const fixture = resolve(dir, 'server.cjs');
    await writeFile(
      fixture,
      `
if(process.env.DAOYAN_APPROVAL_RELAY_SECRET||process.env.DAOYAN_APPROVAL_RELAY_PIPE)process.exit(8);
const rl=require('node:readline').createInterface({input:process.stdin});const send=x=>console.log(JSON.stringify(x));
rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{}});
if(m.method==='thread/resume')send({id:m.id,result:{thread:{id:${JSON.stringify(threadId)}}}});
if(m.method==='turn/start'){send({method:'turn/started',params:{threadId:${JSON.stringify(threadId)},turn:{id:'turn-1'}}});send({id:m.id,result:{turn:{id:'turn-1'}}});send({id:99,method:'mcpServer/elicitation/request',params:${JSON.stringify(request)}});}
if(m.id===99)send({method:'turn/completed',params:{threadId:${JSON.stringify(threadId)},turn:{id:'turn-1',status:'interrupted'}}});
});`,
    );
    const args = [
      'exec',
      'resume',
      '-m',
      'test-model',
      '-c',
      'model_reasoning_effort="low"',
      '-o',
      resolve(dir, 'result.md'),
      threadId,
      '-',
    ];
    const child = spawn(
      process.execPath,
      [
        resolve('node_modules/tsx/dist/cli.mjs'),
        resolve('scripts/codex-worker-host.ts'),
        process.execPath,
        JSON.stringify([fixture]),
        JSON.stringify(args),
      ],
      {
        cwd: dir,
        env: { ...process.env, ...relay.environment },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let log = '';
    child.stdout.on('data', (chunk) => {
      log += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      log += String(chunk);
    });
    child.stdin.end('Test-only approval fixture; do not use any actual application.');
    const completed = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    try {
      const formUrl = await Promise.race([
        announcement,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('background approval was not delivered')), 5000),
        ),
      ]);
      expect(await readFile(resolve(dir, 'application-approval.json'), 'utf8')).not.toContain(
        formUrl,
      );
      expect(log).not.toContain(formUrl);
      await fetch(formUrl, {
        method: 'POST',
        headers: {
          Origin: new URL(formUrl).origin,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'action=cancel',
      });
      expect(await completed).toBe(1);
      expect(log).toContain('[工作流工具审批阻断]');
      expect(log).not.toContain(formUrl);
      await expect(fetch(formUrl)).rejects.toThrow();
    } finally {
      if (child.exitCode === null && child.pid) {
        if (process.platform === 'win32')
          spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        else child.kill();
      }
      await relay.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
