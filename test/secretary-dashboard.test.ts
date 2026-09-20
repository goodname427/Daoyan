import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForProcessIdentity } from '../scripts/process-identity';
import {
  advanceVersion,
  createFormalVersion,
  recordApproval,
  setNodeEvidence,
} from '../scripts/version-lifecycle';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCliPath = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const secretaryPath = resolve(root, 'scripts/project-secretary.ts');
let child: ChildProcess | null = null;
let nestedWorker: ChildProcess | null = null;
let temporary = '';
let artifactLink = '';
let webhookServer: HttpServer | null = null;

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
  if (nestedWorker && nestedWorker.exitCode === null) nestedWorker.kill('SIGTERM');
  nestedWorker = null;
  if (artifactLink) await rm(artifactLink, { recursive: true, force: true });
  artifactLink = '';
  if (webhookServer) {
    await new Promise<void>((resolveClose) => webhookServer?.close(() => resolveClose()));
    webhookServer = null;
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
  temporary = '';
});

describe('secretary dashboard server', () => {
  it('serves version state, protects artifacts and handles local conversation', async () => {
    temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-dashboard-'));
    const secretaryState = resolve(temporary, 'secretary');
    const releaseState = resolve(temporary, 'releases');
    const blockedRun = resolve(temporary, 'runs', 'blocked-feature');
    const runningRun = resolve(temporary, 'runs', 'running-feature');
    await mkdir(secretaryState, { recursive: true });
    await mkdir(releaseState, { recursive: true });
    await mkdir(blockedRun, { recursive: true });
    await mkdir(runningRun, { recursive: true });
    await writeFile(
      resolve(blockedRun, 'plan.validated.json'),
      JSON.stringify({
        summary: '继续迁移统一实体能力',
        acceptanceCriteria: ['旧元法术使用统一实体句柄'],
        nonGoals: ['本轮不调整画面表现'],
        tasks: [{ id: 'core', title: '迁移核心元法术', objective: '统一实体控制入口' }],
      }),
      'utf8',
    );
    await writeFile(
      resolve(blockedRun, 'recovery.json'),
      JSON.stringify({
        phase: 'delivery:gpt-5.6-sol',
        error: 'usage limit reached; try again at 4:31 AM',
        updatedAt: '2026-09-20T01:00:00.000Z',
      }),
      'utf8',
    );
    await writeFile(
      resolve(blockedRun, 'delivery.log'),
      'ERROR usage limit reached; try again at 4:31 AM\n',
      'utf8',
    );
    nestedWorker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const nestedWorkerIdentity = await waitForProcessIdentity(nestedWorker.pid ?? 0);
    if (!nestedWorkerIdentity) throw new Error('无法创建测试子 Agent 进程');
    await writeFile(
      resolve(runningRun, 'plan.validated.json'),
      JSON.stringify({
        summary: '实现看板交互',
        acceptanceCriteria: ['项目中枢可以展示嵌套 Agent'],
        nonGoals: [],
        tasks: [{ id: 'ui', title: '实现界面', objective: '完成项目中枢交互' }],
      }),
      'utf8',
    );
    await writeFile(
      resolve(runningRun, 'recovery.json'),
      JSON.stringify({
        version: 1,
        status: 'active',
        processPid: 2_147_000_000,
        processIdentity: 'dead-pm',
        phase: '深度规划',
        direction: '实现看板交互',
        resolvedDirection: '实现看板交互',
        baseline: 'test',
        workspaceFingerprint: 'test',
        plan: {
          summary: '实现看板交互',
          acceptanceCriteria: ['项目中枢可以展示嵌套 Agent'],
          nonGoals: [],
          tasks: [{ id: 'ui', title: '实现界面', objective: '完成项目中枢交互' }],
        },
        taskRuns: [],
        review: null,
        plannerTokens: 0,
        reviewerTokens: null,
        repairerTokens: null,
        noPush: false,
        error: '',
        updatedAt: '2026-09-20T01:01:00.000Z',
      }),
      'utf8',
    );
    await writeFile(
      resolve(runningRun, 'progress.json'),
      JSON.stringify({
        phase: '深度规划',
        status: 'running',
        startedAt: '2026-09-20T01:00:00.000Z',
        updatedAt: '2026-09-20T01:01:00.000Z',
        elapsedSeconds: 60,
        workerPid: nestedWorker.pid,
        workerProcessIdentity: nestedWorkerIdentity,
        workerModel: 'gpt-5.6-terra',
        workerRole: '规划 Agent',
      }),
      'utf8',
    );
    await writeFile(
      resolve(secretaryState, 'state.json'),
      JSON.stringify({
        version: 1,
        initializedAt: '2026-09-19T00:00:00.000Z',
        status: 'stopped',
        pid: 0,
        processIdentity: '',
        lastEventAt: '2026-09-19T00:00:00.000Z',
        activeItemId: 'running-feature',
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
          {
            id: 'blocked-feature',
            idea: '继续迁移旧元法术到统一实体能力',
            scope: 'feature',
            status: 'waiting-producer',
            summary: 'usage limit reached; try again at 4:31 AM',
            plannedTasks: [],
            matchedFact: null,
            runDirectory: blockedRun,
            processPid: 0,
            processIdentity: '',
            recoveryAttempts: 1,
            retryAt: '',
            producerGuidance: '',
            createdAt: '2026-09-20T00:30:00.000Z',
            updatedAt: '2026-09-20T01:00:00.000Z',
            completedAt: '',
          },
          {
            id: 'decision-item',
            idea: '选择存档兼容策略',
            scope: 'feature',
            status: 'waiting-producer',
            summary: '存在两个互斥产品方向，需要制作人决定。',
            plannedTasks: [],
            matchedFact: null,
            runDirectory: '',
            processPid: 0,
            processIdentity: '',
            recoveryAttempts: 0,
            retryAt: '',
            producerGuidance: '',
            createdAt: '2026-09-20T00:40:00.000Z',
            updatedAt: '2026-09-20T00:40:00.000Z',
            completedAt: '',
          },
          {
            id: 'running-feature',
            idea: '实现看板交互',
            scope: 'feature',
            status: 'tracking',
            summary: '深度规划',
            plannedTasks: [],
            matchedFact: null,
            runDirectory: runningRun,
            processPid: 2_147_000_000,
            processIdentity: 'dead-pm',
            recoveryAttempts: 0,
            retryAt: '',
            producerGuidance: '',
            createdAt: '2026-09-20T01:00:00.000Z',
            updatedAt: '2026-09-20T01:01:00.000Z',
            completedAt: '',
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
      documentRoot: 'docs/versions/workflow-foundation-2026-09-20',
      currentStage: 'development',
    });
    setNodeEvidence(version, 'charter-review', {
      artifact: 'docs/specs/2026-09-20-formal-version-and-secretary-dashboard.md',
      summary: '制作人已批准正式版本流程。',
    });
    await writeFile(resolve(releaseState, 'current.json'), JSON.stringify(version), 'utf8');
    const unsafeVersionDocs = resolve(temporary, 'unsafe-version-docs');
    await mkdir(unsafeVersionDocs, { recursive: true });
    await writeFile(resolve(unsafeVersionDocs, 'private.md'), 'should not be listed', 'utf8');
    const previous = createFormalVersion({
      id: 'previous-dashboard-test',
      title: '历史看板版本',
      direction: '验证历史查看',
      documentRoot: unsafeVersionDocs,
      currentStage: 'archived',
      now: '2026-09-19T00:00:00.000Z',
    });
    await mkdir(resolve(releaseState, 'versions'), { recursive: true });
    await writeFile(
      resolve(releaseState, 'versions', `${previous.id}.json`),
      JSON.stringify(previous),
      'utf8',
    );
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
        DAOYAN_SECRETARY_WEBHOOK_URL: '',
        DAOYAN_DINGTALK_CLIENT_ID: '',
        DAOYAN_DINGTALK_CLIENT_SECRET: '',
      },
      stdio: 'ignore',
      windowsHide: true,
    });

    let initial = await waitForDashboard(url);
    const workerReconcileDeadline = Date.now() + 8_000;
    while (
      Date.now() < workerReconcileDeadline &&
      !(initial.secretary as { items: Array<{ id: string; summary: string }> }).items
        .find((item) => item.id === 'running-feature')
        ?.summary.includes('子 Agent 仍在运行')
    ) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
      initial = (await (await fetch(`${url}/api/dashboard`)).json()) as Record<string, unknown>;
    }
    expect((initial.version as { title: string }).title).toBe('看板测试版本');
    expect(initial.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'dashboard-test', isCurrent: true }),
        expect.objectContaining({ id: 'previous-dashboard-test', isCurrent: false }),
      ]),
    );
    expect(initial.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: '常驻秘书', model: '无模型常驻' }),
        expect.objectContaining({
          id: 'blocked-feature',
          role: 'Feature PM',
          status: 'paused',
          running: false,
          model: 'gpt-5.6-sol',
        }),
        expect.objectContaining({
          id: 'running-feature',
          role: 'Feature PM',
          running: false,
          model: '内部调度',
        }),
        expect.objectContaining({
          id: 'running-feature:worker',
          role: '规划 Agent',
          running: true,
          model: 'gpt-5.6-terra',
        }),
      ]),
    );
    expect(
      (
        initial.secretary as {
          items: Array<{ id: string; summary: string }>;
        }
      ).items.find((item) => item.id === 'running-feature')?.summary,
    ).toContain('子 Agent 仍在运行');
    expect(initial.todos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'secretary',
          id: 'blocked-feature',
          recommendedAction: 'auto-retry',
        }),
      ]),
    );
    expect((initial.version as { documents: Array<{ path: string }> }).documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'docs/versions/workflow-foundation-2026-09-20/charter.md',
        }),
        expect.objectContaining({
          path: 'docs/specs/2026-09-20-formal-version-and-secretary-dashboard.md',
        }),
      ]),
    );
    expect(
      (initial.secretary as { items: Array<{ completedTasks: unknown[] }> }).items[0]
        .completedTasks,
    ).toEqual([]);
    const nestedExit = new Promise<void>((resolveExit) => nestedWorker?.once('close', resolveExit));
    nestedWorker.kill('SIGTERM');
    await nestedExit;
    nestedWorker = null;
    const workerExitDeadline = Date.now() + 8_000;
    let activeAfterWorkerExit = 'running-feature';
    while (Date.now() < workerExitDeadline) {
      const afterExit = (await (await fetch(`${url}/api/dashboard`)).json()) as {
        secretary: { activeItemId: string };
      };
      activeAfterWorkerExit = afterExit.secretary.activeItemId;
      if (!activeAfterWorkerExit) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    }
    expect(activeAfterWorkerExit).toBe('');
    expect(await (await fetch(url)).text()).toContain('道衍项目中枢');

    const versionDocument = await fetch(
      `${url}/api/artifact?version=dashboard-test&path=${encodeURIComponent(
        'docs/versions/workflow-foundation-2026-09-20/charter.md',
      )}`,
    );
    expect(versionDocument.status).toBe(200);
    expect(await versionDocument.text()).toContain('版本策划案');
    const linkedSpec = await fetch(
      `${url}/api/artifact?version=dashboard-test&path=${encodeURIComponent(
        'docs/specs/2026-09-20-formal-version-and-secretary-dashboard.md',
      )}`,
    );
    expect(linkedSpec.status).toBe(200);

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

    const historical = (await (
      await fetch(`${url}/api/dashboard?version=previous-dashboard-test`)
    ).json()) as {
      isCurrentVersion: boolean;
      version: { title: string; status: string; documents: unknown[] };
      todos: unknown[];
    };
    expect(historical.isCurrentVersion).toBe(false);
    expect(historical.version).toEqual(
      expect.objectContaining({ title: '历史看板版本', status: 'archived' }),
    );
    expect(historical.version.documents).toEqual([]);
    expect(historical.todos).toEqual([]);

    const deferResponse = await fetch(`${url}/api/todo-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'secretary', id: 'blocked-feature', action: 'defer' }),
    });
    expect(deferResponse.status).toBe(200);
    const deferred = (await (await fetch(`${url}/api/dashboard`)).json()) as {
      agents: Array<{ id: string }>;
      todos: Array<{ id: string }>;
      secretary: { items: Array<{ id: string; status: string }> };
    };
    expect(deferred.agents.some((agent) => agent.id === 'blocked-feature')).toBe(false);
    expect(deferred.todos.some((todo) => todo.id === 'blocked-feature')).toBe(false);
    expect(deferred.secretary.items.find((item) => item.id === 'blocked-feature')?.status).toBe(
      'backlog',
    );
    const decisionTodo = deferred.todos.find((todo) => todo.id === 'decision-item') as
      { recommendedAction: string; solutions: Array<{ id: string }> } | undefined;
    expect(decisionTodo).toEqual(
      expect.objectContaining({
        recommendedAction: 'defer',
        solutions: expect.arrayContaining([
          expect.objectContaining({ id: 'continue-with-guidance' }),
        ]),
      }),
    );
    expect(
      await fetch(`${url}/api/todo-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'secretary', id: 'decision-item', action: 'retry-now' }),
      }),
    ).toEqual(expect.objectContaining({ status: 400 }));
    const guided = await fetch(`${url}/api/todo-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'secretary',
        id: 'decision-item',
        action: 'continue-with-guidance',
        note: '兼容旧存档',
      }),
    });
    expect(guided.status).toBe(200);
    const guidedState = (await (await fetch(`${url}/api/dashboard`)).json()) as {
      secretary: {
        items: Array<{ id: string; status: string; producerGuidance: string }>;
      };
    };
    expect(guidedState.secretary.items.find((item) => item.id === 'decision-item')).toEqual(
      expect.objectContaining({ status: 'retry-wait', producerGuidance: '兼容旧存档' }),
    );

    const intake = await fetch(`${url}/api/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: '现在正式版本处于什么阶段？' }),
    });
    expect(intake.status).toBe(202);

    const deadline = Date.now() + 10_000;
    let messages: Array<{ role: string; content: string }> = [];
    let versionAnswer = '';
    while (Date.now() < deadline) {
      const state = (await (await fetch(`${url}/api/dashboard`)).json()) as {
        secretary: { recentMessages: typeof messages };
      };
      messages = state.secretary.recentMessages;
      versionAnswer =
        messages.find(
          (message) => message.role === 'secretary' && message.content.includes('当前正式版本'),
        )?.content ?? '';
      if (versionAnswer) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    }
    expect(versionAnswer).toContain('开发执行');

    await fetch(`${url}/api/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: '新增宗门经营系统' }),
    });
    let backlogStatus = '';
    const backlogDeadline = Date.now() + 10_000;
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
      version: {
        currentStage: string;
        approvals: unknown[];
        progress: number;
        nodes: Array<{ id: string; status: string }>;
      };
    };
    expect(gateState.version.currentStage).toBe('producer-acceptance');
    expect(gateState.version.approvals).toHaveLength(0);

    await fetch(`${url}/api/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: '另外新增炼丹系统，放到后续版本' }),
    });
    const directionDeadline = Date.now() + 10_000;
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

    const candidateDashboard = (await (await fetch(`${url}/api/dashboard`)).json()) as {
      todos: Array<{ source: string; id: string; recommendedAction: string }>;
    };
    const acceptanceTodo = candidateDashboard.todos.find((todo) => todo.source === 'version');
    expect(acceptanceTodo).toBeDefined();
    const approval = await fetch(`${url}/api/todo-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'version',
        id: acceptanceTodo?.id,
        action: acceptanceTodo?.recommendedAction,
      }),
    });
    expect(approval.status).toBe(200);
    const archiveDeadline = Date.now() + 10_000;
    while (Date.now() < archiveDeadline) {
      gateState = (await (await fetch(`${url}/api/dashboard`)).json()) as typeof gateState & {
        version: { progress: number; nodes: Array<{ id: string; status: string }> };
      };
      if (gateState.version.currentStage === 'archived') break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    }
    expect(gateState.version.currentStage).toBe('archived');
    expect(gateState.version.progress).toBe(100);
    expect(gateState.version.nodes.find((node) => node.id === 'archived')?.status).toBe(
      'completed',
    );
    expect(
      await fetch(`${url}/api/todo-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'unknown', id: 'anything', action: 'retry-now' }),
      }),
    ).toEqual(expect.objectContaining({ status: 400 }));
  }, 30_000);

  it('recovers inbox requests whose state changes were committed before a crash', async () => {
    temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-secretary-replay-'));
    const secretaryState = resolve(temporary, 'secretary');
    const releaseState = resolve(temporary, 'releases');
    await mkdir(resolve(secretaryState, 'inbox'), { recursive: true });
    await mkdir(releaseState, { recursive: true });
    const itemRequestId = 'dingtalk-item-replay';
    const approvalRequestId = 'dingtalk-approval-replay';
    await writeFile(
      resolve(secretaryState, 'state.json'),
      JSON.stringify({
        version: 1,
        initializedAt: '2026-09-20T00:00:00.000Z',
        status: 'stopped',
        pid: 0,
        processIdentity: '',
        lastEventAt: '2026-09-20T00:00:00.000Z',
        activeItemId: '',
        items: [
          {
            id: itemRequestId,
            idea: '新增宗门经营系统',
            scope: 'feature',
            status: 'backlog',
            summary: '已加入后续版本候选池。',
            plannedTasks: ['梳理宗门经营范围'],
            matchedFact: null,
            runDirectory: '',
            processPid: 0,
            processIdentity: '',
            recoveryAttempts: 0,
            retryAt: '',
            producerGuidance: '',
            createdAt: '2026-09-20T00:01:00.000Z',
            updatedAt: '2026-09-20T00:01:00.000Z',
            completedAt: '',
            completedTasks: [],
          },
        ],
        messages: [],
        updatedAt: '2026-09-20T00:01:00.000Z',
      }),
      'utf8',
    );
    for (const [id, idea] of [
      [itemRequestId, '新增宗门经营系统'],
      [approvalRequestId, '通过，可以归档'],
    ]) {
      await writeFile(
        resolve(secretaryState, 'inbox', `${id}.json`),
        JSON.stringify({ id, idea, createdAt: '2026-09-20T00:02:00.000Z' }),
        'utf8',
      );
    }
    const version = createFormalVersion({
      id: 'replay-version',
      title: '崩溃恢复版本',
      direction: '验证消息幂等',
      documentRoot: 'docs/versions/replay-version',
      currentStage: 'producer-acceptance',
      now: '2026-09-20T00:00:00.000Z',
    });
    recordApproval(version, {
      stage: 'producer-acceptance',
      reviewer: 'producer',
      decision: 'approved',
      documentRevision: '1',
      comment: '通过，可以归档',
      sourceRequestId: approvalRequestId,
      now: '2026-09-20T00:02:00.000Z',
    });
    advanceVersion(version, 'archived', '2026-09-20T00:03:00.000Z');
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
        DAOYAN_SECRETARY_WEBHOOK_URL: '',
        DAOYAN_DINGTALK_CLIENT_ID: '',
        DAOYAN_DINGTALK_CLIENT_SECRET: '',
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    await waitForDashboard(url);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const responsesReady = await Promise.all(
        [itemRequestId, approvalRequestId].map((id) =>
          readFile(resolve(secretaryState, 'responses', `${id}.json`), 'utf8')
            .then(() => true)
            .catch(() => false),
        ),
      );
      if (responsesReady.every(Boolean)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    }

    const recoveredState = JSON.parse(
      await readFile(resolve(secretaryState, 'state.json'), 'utf8'),
    ) as {
      items: Array<{ id: string }>;
      messages: Array<{ id: string }>;
    };
    const recoveredVersion = JSON.parse(
      await readFile(resolve(releaseState, 'current.json'), 'utf8'),
    ) as { currentStage: string; approvals: Array<{ sourceRequestId?: string }> };
    expect(recoveredState.items.filter((item) => item.id === itemRequestId)).toHaveLength(1);
    expect(recoveredState.messages.filter((message) => message.id === itemRequestId)).toHaveLength(
      1,
    );
    expect(
      recoveredState.messages.filter((message) => message.id === `${approvalRequestId}-response`),
    ).toHaveLength(1);
    expect(recoveredVersion.currentStage).toBe('archived');
    expect(
      recoveredVersion.approvals.filter(
        (approval) => approval.sourceRequestId === approvalRequestId,
      ),
    ).toHaveLength(1);
  }, 20_000);

  it('keeps failed channel notifications in a durable outbox and retries them', async () => {
    temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-secretary-outbox-'));
    const secretaryState = resolve(temporary, 'secretary');
    const port = await freePort();
    const webhookPort = await freePort();
    let webhookHealthy = false;
    let webhookCalls = 0;
    webhookServer = createHttpServer((_request, response) => {
      webhookCalls += 1;
      response.writeHead(webhookHealthy ? 204 : 500).end();
    });
    await new Promise<void>((resolveListen) =>
      webhookServer?.listen(webhookPort, '127.0.0.1', () => resolveListen()),
    );
    const url = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [tsxCliPath, secretaryPath, 'run'], {
      cwd: root,
      env: {
        ...process.env,
        DAOYAN_SECRETARY_STATE_DIR: secretaryState,
        DAOYAN_SECRETARY_HTTP_PORT: String(port),
        DAOYAN_SECRETARY_LOCAL_ONLY: '1',
        DAOYAN_SECRETARY_NO_DISPATCH: '1',
        DAOYAN_SECRETARY_WEBHOOK_URL: `http://127.0.0.1:${webhookPort}`,
        DAOYAN_SECRETARY_WEBHOOK_KIND: 'generic',
        DAOYAN_SECRETARY_NOTICE_RETRY_MS: '50',
        DAOYAN_DINGTALK_CLIENT_ID: '',
        DAOYAN_DINGTALK_CLIENT_SECRET: '',
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    await waitForDashboard(url);
    const intake = await fetch(`${url}/api/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: '现在正式版本处于什么阶段？' }),
    });
    expect(intake.status).toBe(202);
    const outbox = resolve(secretaryState, 'notice-outbox');
    const failureDeadline = Date.now() + 8_000;
    while (Date.now() < failureDeadline) {
      if (webhookCalls > 0 && (await readdir(outbox)).some((name) => name.endsWith('.json'))) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    }
    expect(webhookCalls).toBeGreaterThan(0);
    expect((await readdir(outbox)).some((name) => name.endsWith('.json'))).toBe(true);

    webhookHealthy = true;
    const successDeadline = Date.now() + 8_000;
    while (Date.now() < successDeadline) {
      if (!(await readdir(outbox)).some((name) => name.endsWith('.json'))) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    }
    expect(webhookCalls).toBeGreaterThanOrEqual(2);
    expect((await readdir(outbox)).filter((name) => name.endsWith('.json'))).toEqual([]);
  }, 20_000);
});
