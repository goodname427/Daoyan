import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createFormalVersion } from '../scripts/version-lifecycle';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCliPath = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const secretaryPath = resolve(root, 'scripts/project-secretary.ts');
let child: ChildProcess | null = null;
let temporary = '';
let artifactLink = '';

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.on('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        rejectPort(new Error('无法分配测试端口'));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForDashboard(url: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/dashboard`);
      if (response.ok) return (await response.json()) as Record<string, unknown>;
    } catch {
      // The detached guard needs a short startup window on Windows.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  throw new Error('测试 notice guard 未按时启动');
}

afterEach(async () => {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  child = null;
  if (artifactLink) await rm(artifactLink, { recursive: true, force: true });
  artifactLink = '';
  if (temporary) await rm(temporary, { recursive: true, force: true });
  temporary = '';
});

describe('secretary dashboard server', () => {
  it('serves version state, protects artifacts and handles local conversation', async () => {
    temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-dashboard-'));
    const secretaryState = resolve(temporary, 'secretary');
    const releaseState = resolve(temporary, 'releases');
    await mkdir(secretaryState, { recursive: true });
    await mkdir(releaseState, { recursive: true });
    await writeFile(
      resolve(secretaryState, 'state.json'),
      JSON.stringify({
        version: 1,
        initializedAt: '2026-09-19T00:00:00.000Z',
        status: 'stopped',
        pid: 0,
        processIdentity: '',
        lastEventAt: '2026-09-19T00:00:00.000Z',
        activeItemId: '',
        items: [
          {
            id: 'legacy',
            idea: '旧秘书记录',
            scope: 'feature',
            status: 'answered',
            summary: '已回答',
            plannedTasks: [],
            matchedFact: null,
            runDirectory: '',
            processPid: 0,
            recoveryAttempts: 0,
            retryAt: '',
            producerGuidance: '',
            createdAt: '2026-09-19T00:00:00.000Z',
            updatedAt: '2026-09-19T00:00:00.000Z',
            completedAt: '2026-09-19T00:00:00.000Z',
          },
        ],
        updatedAt: '2026-09-19T00:00:00.000Z',
      }),
      'utf8',
    );
    const version = createFormalVersion({
      id: 'dashboard-test',
      title: '看板测试版本',
      direction: '验证项目中枢',
      documentRoot: 'docs/versions/dashboard-test',
      currentStage: 'development',
    });
    await writeFile(resolve(releaseState, 'current.json'), JSON.stringify(version), 'utf8');
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [tsxCliPath, secretaryPath, 'run'], {
      cwd: root,
      env: {
        ...process.env,
        DAOYAN_SECRETARY_STATE_DIR: secretaryState,
        DAOYAN_RELEASE_STATE_DIR: releaseState,
        DAOYAN_SECRETARY_HTTP_PORT: String(port),
        DAOYAN_SECRETARY_LOCAL_ONLY: '1',
        DAOYAN_SECRETARY_NO_DISPATCH: '1',
      },
      stdio: 'ignore',
      windowsHide: true,
    });

    const initial = await waitForDashboard(url);
    expect((initial.version as { title: string }).title).toBe('看板测试版本');
    expect(
      (initial.secretary as { items: Array<{ completedTasks: unknown[] }> }).items[0]
        .completedTasks,
    ).toEqual([]);
    expect(await (await fetch(url)).text()).toContain('道衍项目中枢');

    const denied = await fetch(`${url}/api/artifact?path=package.json`);
    expect(denied.status).toBe(403);
    const outsideDocs = resolve(temporary, 'outside-docs');
    await mkdir(outsideDocs);
    await writeFile(resolve(outsideDocs, 'secret.md'), 'outside', 'utf8');
    artifactLink = resolve(root, 'docs/versions', `.dashboard-test-link-${process.pid}`);
    await symlink(outsideDocs, artifactLink, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await fetch(
      `${url}/api/artifact?path=${encodeURIComponent(`docs/versions/${artifactLink.split(/[\\/]/).pop()}/secret.md`)}`,
    );
    expect(linked.status).toBe(403);

    const intake = await fetch(`${url}/api/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: '现在正式版本处于什么阶段？' }),
    });
    expect(intake.status).toBe(202);

    const deadline = Date.now() + 5_000;
    let messages: Array<{ role: string; content: string }> = [];
    while (Date.now() < deadline) {
      const state = (await (await fetch(`${url}/api/dashboard`)).json()) as {
        secretary: { recentMessages: typeof messages };
      };
      messages = state.secretary.recentMessages;
      if (messages.length >= 2) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    }
    expect(messages.map((message) => message.role)).toEqual(['producer', 'secretary']);
    expect(messages[1].content).toContain('开发执行');

    await fetch(`${url}/api/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: '新增宗门经营系统' }),
    });
    let backlogStatus = '';
    const backlogDeadline = Date.now() + 5_000;
    while (Date.now() < backlogDeadline) {
      const state = (await (await fetch(`${url}/api/dashboard`)).json()) as {
        secretary: { items: Array<{ idea: string; status: string }> };
      };
      backlogStatus =
        state.secretary.items.find((item) => item.idea.includes('宗门经营'))?.status ?? '';
      if (backlogStatus) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    }
    expect(backlogStatus).toBe('backlog');

    const acceptance = createFormalVersion({
      id: 'candidate-test',
      title: '候选版本',
      direction: '验证制作人门禁',
      documentRoot: 'docs/versions/candidate-test',
      currentStage: 'producer-acceptance',
    });
    await writeFile(resolve(releaseState, 'current.json'), JSON.stringify(acceptance), 'utf8');
    await fetch(`${url}/api/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: '我再看看，晚点回复' }),
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    let gateState = (await (await fetch(`${url}/api/dashboard`)).json()) as {
      version: { currentStage: string; approvals: unknown[] };
    };
    expect(gateState.version.currentStage).toBe('producer-acceptance');
    expect(gateState.version.approvals).toHaveLength(0);

    await fetch(`${url}/api/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: '另外新增炼丹系统，放到后续版本' }),
    });
    const directionDeadline = Date.now() + 5_000;
    let deferredDirection = '';
    while (Date.now() < directionDeadline) {
      const state = (await (await fetch(`${url}/api/dashboard`)).json()) as {
        version: { currentStage: string };
        secretary: { items: Array<{ idea: string; status: string }> };
      };
      deferredDirection =
        state.secretary.items.find((item) => item.idea.includes('炼丹系统'))?.status ?? '';
      gateState.version.currentStage = state.version.currentStage;
      if (deferredDirection) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    }
    expect(deferredDirection).toBe('backlog');
    expect(gateState.version.currentStage).toBe('producer-acceptance');

    await fetch(`${url}/api/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: '通过，可以归档' }),
    });
    const archiveDeadline = Date.now() + 5_000;
    while (Date.now() < archiveDeadline) {
      gateState = (await (await fetch(`${url}/api/dashboard`)).json()) as typeof gateState;
      if (gateState.version.currentStage === 'archived') break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    }
    expect(gateState.version.currentStage).toBe('archived');
  }, 15_000);
});
