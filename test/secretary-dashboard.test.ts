import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer } from 'node:net';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForProcessIdentity } from '../scripts/process-identity';
import { stopSecretaryDashboard, waitForSecretaryDashboard } from './helpers/secretary-guard';
import {
  createSecretaryState,
  itemFromIntake,
  nextRunnableItem,
  type SecretaryState,
} from '../scripts/secretary-state';
import {
  addDecisionGate,
  advanceVersion,
  createFormalVersion,
  recordApproval,
  resolveDecisionGate,
  setNodeEvidence,
  type FormalVersion,
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

interface IntakeCompletion {
  id: string;
  status: string;
  response: string;
}

async function waitForIntakeCompletion(
  secretaryState: string,
  requestId: string,
): Promise<IntakeCompletion> {
  const responsePath = resolve(secretaryState, 'responses', `${requestId}.json`);
  // The guard is intentionally asynchronous; full-suite Windows I/O can delay
  // an otherwise healthy response beyond ten seconds while other child tests run.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(responsePath, 'utf8')) as IntakeCompletion;
    } catch {
      // The response file is atomically published only after the guard saves its state.
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    }
  }
  throw new Error(`秘书未完成收件请求：${requestId}`);
}

async function startReviewGuard(
  secretaryState: string,
  releaseState: string,
  fixtureRoot = root,
  dispatch = false,
): Promise<string> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    [tsxCliPath, resolve(fixtureRoot, 'scripts/project-secretary.ts'), 'run'],
    {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        DAOYAN_SECRETARY_STATE_DIR: secretaryState,
        DAOYAN_RELEASE_STATE_DIR: releaseState,
        DAOYAN_SECRETARY_HTTP_PORT: String(port),
        DAOYAN_SECRETARY_LOCAL_ONLY: '1',
        DAOYAN_SECRETARY_NO_DISPATCH: dispatch ? '0' : '1',
        DAOYAN_SECRETARY_WEBHOOK_URL: '',
        DAOYAN_DINGTALK_CLIENT_ID: '',
        DAOYAN_DINGTALK_CLIENT_SECRET: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  await waitForSecretaryDashboard(child, url);
  return url;
}

async function reviewIntake(
  url: string,
  secretaryState: string,
  idea: string,
): Promise<IntakeCompletion> {
  const response = await fetch(`${url}/api/intake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idea }),
  });
  const receipt = (await response.json()) as { id: string };
  return waitForIntakeCompletion(secretaryState, receipt.id);
}

afterEach(async () => {
  // A failed assertion may bypass the explicit shutdown in a test body.  Wait
  // for the guard here as well: on Windows its tsx child can otherwise keep
  // the fixture (and its node_modules junction) open while cleanup removes it.
  if (child && child.exitCode === null) await stopSecretaryDashboard(child);
  child = null;
  if (nestedWorker && nestedWorker.exitCode === null) {
    await new Promise<void>((resolveExit) => {
      nestedWorker!.once('exit', () => resolveExit());
      nestedWorker!.kill('SIGTERM');
    });
  }
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
  it('retains ambiguous local input and punctuated replies without creating a version', async () => {
    temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-review-intake-'));
    const secretaryState = resolve(temporary, 'secretary');
    const releaseState = resolve(temporary, 'releases');
    await mkdir(releaseState, { recursive: true });
    const version = createFormalVersion({
      id: 'past',
      title: '旧版本',
      direction: '历史目标',
      documentRoot: 'docs/versions/past',
      currentStage: 'archived',
    });
    const versionPath = resolve(releaseState, 'current.json');
    await writeFile(versionPath, JSON.stringify(version));
    const url = await startReviewGuard(secretaryState, releaseState);
    const original = await readFile(versionPath, 'utf8');
    for (const idea of ['好的。', '收到，谢谢', '明白了！辛苦']) {
      const response = await reviewIntake(url, secretaryState, idea);
      expect(response.status).toBe('answered');
      expect(response.response).toContain('保留这条回复');
    }
    const ambiguous = await reviewIntake(url, secretaryState, '那件事情再考虑一下');
    expect(ambiguous.response).toContain('待确认');
    expect(await readFile(versionPath, 'utf8')).toBe(original);
    const state = JSON.parse(
      await readFile(resolve(secretaryState, 'state.json'), 'utf8'),
    ) as SecretaryState;
    expect(
      state.orchestration!.intakes.find((entry) => entry.requestId === ambiguous.id),
    ).toMatchObject({ disposition: 'needs-confirmation', targetVersionId: '' });
    expect(state.items.every((item) => item.status === 'answered')).toBe(true);
    const direction = await reviewIntake(
      url,
      secretaryState,
      '新增装备交易系统，允许玩家相互交易装备',
    );
    expect(direction.response).toContain('建立正式版本草案');
  }, 20_000);

  it.each(['active', 'backlog'] as const)(
    'requires a scope gate despite an opposite %s fact',
    async (status) => {
      temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-review-scope-'));
      const secretaryState = resolve(temporary, 'secretary');
      const releaseState = resolve(temporary, 'releases');
      await mkdir(releaseState, { recursive: true });
      const version = createFormalVersion({
        id: 'trade',
        title: '装备交易',
        direction: '新增装备交易系统，允许玩家相互交易装备',
        documentRoot: 'docs/versions/trade',
        currentStage: 'charter-review',
      });
      recordApproval(version, {
        stage: 'charter-review',
        reviewer: 'producer',
        decision: 'approved',
        documentRevision: '1',
        comment: '批准方向',
      });
      advanceVersion(version, 'module-design');
      const versionPath = resolve(releaseState, 'current.json');
      await writeFile(versionPath, JSON.stringify(version));
      await mkdir(secretaryState, { recursive: true });
      const seed = createSecretaryState('2026-09-21T00:00:00.000Z');
      const existing = itemFromIntake(
        { id: 'existing', idea: version.direction, createdAt: seed.initializedAt },
        [],
      ).item;
      existing.status = status;
      seed.items.push(existing);
      await writeFile(resolve(secretaryState, 'state.json'), JSON.stringify(seed));
      const url = await startReviewGuard(secretaryState, releaseState);
      const response = await reviewIntake(
        url,
        secretaryState,
        '取消装备交易系统，禁止玩家相互交易装备',
      );
      expect(response.response).toContain('范围修订评审');
      const updated = JSON.parse(await readFile(versionPath, 'utf8')) as FormalVersion;
      expect(updated.orchestration!.scopeRevisions.at(-1)).toMatchObject({
        disposition: 'scope-review',
        status: 'pending',
      });
      expect(updated.orchestration!.decisionGates.at(-1)).toMatchObject({
        kind: 'scope-change',
        status: 'open',
      });
      expect(updated.approvals).toEqual(version.approvals);
      expect(updated.direction).toBe(version.direction);
      // Once frozen, another commitment change must reach the next-version pool.
      updated.scopeFrozen = true;
      await writeFile(versionPath, JSON.stringify(updated));
      const frozen = await reviewIntake(url, secretaryState, '将装备交易系统替换为装备赠送系统');
      const saved = JSON.parse(
        await readFile(resolve(secretaryState, 'state.json'), 'utf8'),
      ) as SecretaryState;
      expect(
        saved.orchestration!.nextVersionCandidates.some((entry) => entry.requestId === frozen.id),
      ).toBe(true);
    },
    20_000,
  );

  it.each([
    ['waiting-producer', 'reply'],
    ['waiting-producer', 'continue-with-guidance'],
    ['recoverable', 'reply'],
    ['recoverable', 'retry-now'],
    ['recoverable', 'auto-retry'],
  ] as const)(
    'resumes the acknowledged %s snapshot via %s after restart',
    async (snapshotStatus, action) => {
      temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-acknowledged-wait-'));
      const fixture = resolve(temporary, 'fixture');
      const secretaryState = resolve(fixture, '.daoyan-agent/secretary');
      const releaseState = resolve(fixture, '.daoyan-agent/releases');
      const runDirectory = resolve(fixture, '.daoyan-agent/runs/recovery');
      await mkdir(runDirectory, { recursive: true });
      await mkdir(secretaryState, { recursive: true });
      await mkdir(releaseState, { recursive: true });
      await cp(resolve(root, 'scripts'), resolve(fixture, 'scripts'), { recursive: true });
      await cp(resolve(root, 'agents'), resolve(fixture, 'agents'), { recursive: true });
      await cp(resolve(root, 'docs'), resolve(fixture, 'docs'), { recursive: true });
      await symlink(resolve(root, 'node_modules'), resolve(fixture, 'node_modules'), 'junction');
      await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
      // Exercise the real coordinator and spawn boundary without launching a model
      // or allowing the fixture Feature PM to edit the user's workspace.
      await writeFile(
        resolve(fixture, 'scripts/agent-dispatcher.ts'),
        `
      import { readFile, writeFile } from 'node:fs/promises';
      import { resolve } from 'node:path';
      const args = process.argv.slice(2);
      const path = resolve(process.cwd(), args.at(-1), 'recovery.json');
      const snapshot = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(resolve(process.cwd(), 'launched.json'), JSON.stringify(args));
      await writeFile(path, JSON.stringify({ ...snapshot, attempt: 2,
        status: 'waiting-producer', error: '新的产品取舍，需要再次决定',
        updatedAt: new Date().toISOString() }));
    `,
      );
      const version = createFormalVersion({
        id: 'resume-fixture',
        title: '恢复测试',
        direction: '测试恢复',
        documentRoot: 'docs/versions/resume-fixture',
        currentStage: 'development',
      });
      await writeFile(resolve(releaseState, 'current.json'), JSON.stringify(version));
      const seed = createSecretaryState(new Date().toISOString());
      const item = itemFromIntake(
        { id: 'resume', idea: '恢复既有任务', createdAt: seed.initializedAt },
        [],
      ).item;
      item.status = 'tracking';
      item.runDirectory = runDirectory;
      seed.items.push(item);
      seed.activeItemId = item.id;
      await writeFile(resolve(secretaryState, 'state.json'), JSON.stringify(seed));
      await writeFile(
        resolve(runDirectory, 'recovery.json'),
        JSON.stringify({
          status: snapshotStatus,
          runId: 'recovery',
          attempt: 1,
          error: snapshotStatus === 'recoverable' ? 'usage limit reached' : '请选择兼容方案',
          updatedAt: seed.initializedAt,
        }),
      );
      let url = await startReviewGuard(secretaryState, releaseState, fixture);
      const statePath = resolve(secretaryState, 'state.json');
      const readState = async () => JSON.parse(await readFile(statePath, 'utf8')) as SecretaryState;
      expect((await readState()).items[0].status).toBe('waiting-producer');
      if (action === 'reply') {
        await reviewIntake(url, secretaryState, '采用方案 A，兼容已有存档');
      } else {
        const result = await fetch(`${url}/api/todo-action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: 'secretary', id: item.id, action, note: '兼容已有存档' }),
        });
        expect(result.status).toBe(200);
      }
      const acknowledged = (await readState()).items[0];
      // The semantic triage path also sees this reply.  A decision without an
      // explicit commitment change must remain attached to the waiting
      // snapshot rather than being reclassified as a fresh direction.
      expect(acknowledged.status).toBe('retry-wait');
      expect(acknowledged.orchestration!.acknowledgedWaitingSnapshot).toBe(
        acknowledged.orchestration!.waitingSnapshot,
      );
      expect(acknowledged.retryAt).not.toBe('');
      await stopSecretaryDashboard(child!);
      child = null;
      // Windows terminates the test child without running its signal handler;
      // mirror project-secretary stop, which removes the lock after exit.
      await rm(resolve(secretaryState, 'notice-guard.lock'), { force: true });
      if (action === 'auto-retry') {
        const saved = await readState();
        saved.items[0].retryAt = '2026-01-01T00:00:00.000Z';
        await writeFile(statePath, JSON.stringify(saved));
      }
      url = await startReviewGuard(secretaryState, releaseState, fixture, true);
      let args: string[] = [];
      await expect
        .poll(
          async () => {
            try {
              args = JSON.parse(
                await readFile(resolve(fixture, 'launched.json'), 'utf8'),
              ) as string[];
              return args.length;
            } catch {
              return 0;
            }
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThan(0);
      expect(args).toContain('--resume');
      if (action === 'reply' || action === 'continue-with-guidance') {
        expect(args).toContain('--decision-confirmed');
        expect(args[args.indexOf('--producer-guidance') + 1]).toContain('兼容已有存档');
      }
      // A new snapshot must block again; approval of attempt 1 is not reusable.
      await reviewIntake(url, secretaryState, '现在进度如何？');
      await expect
        .poll(async () => (await readState()).items[0].summary, { timeout: 10_000 })
        .toContain('新的产品取舍');
      expect((await readState()).items[0].status).toBe('waiting-producer');
      await stopSecretaryDashboard(child!);
      child = null;
    },
    40_000,
  );

  it.each(['missing', 'corrupt', 'live-worker'] as const)(
    'blocks an overdue existing run with %s recovery evidence until a terminal snapshot is restored',
    async (mode) => {
      temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-review-recovery-'));
      const secretaryState = resolve(temporary, 'secretary');
      const releaseState = resolve(temporary, 'releases');
      const runDirectory = resolve(temporary, 'old-run');
      await mkdir(secretaryState, { recursive: true });
      await mkdir(runDirectory, { recursive: true });
      const now = new Date().toISOString();
      const state = createSecretaryState(now);
      const item = itemFromIntake({ id: 'old', idea: '已有独立工作', createdAt: now }, []).item;
      item.status = 'retry-wait';
      item.runDirectory = runDirectory;
      item.retryAt = '2026-01-01T00:00:00.000Z';
      item.recoveryAttempts = 2;
      state.items.push(item);
      if (mode === 'corrupt') {
        await writeFile(resolve(runDirectory, 'recovery.json'), '{broken');
        await writeFile(resolve(runDirectory, 'report.json'), '{broken');
      }
      if (mode === 'live-worker') {
        nestedWorker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        const identity = await waitForProcessIdentity(nestedWorker.pid!);
        expect(identity).not.toBe('');
        await writeFile(
          resolve(runDirectory, 'progress.json'),
          JSON.stringify({ workerPid: nestedWorker.pid, workerProcessIdentity: identity }),
        );
      }
      const statePath = resolve(secretaryState, 'state.json');
      await writeFile(statePath, JSON.stringify(state));
      const url = await startReviewGuard(secretaryState, releaseState);
      const blocked = JSON.parse(await readFile(statePath, 'utf8')) as SecretaryState;
      expect(blocked.items[0]).toMatchObject({
        status: 'tracking',
        runDirectory,
        recoveryAttempts: 2,
        retryAt: '',
        orchestration: {
          reconciliationOutcome: 'missing',
          processOccupied: mode === 'live-worker',
        },
      });
      expect(nextRunnableItem(blocked, now)).toBeNull();
      expect(
        blocked.orchestration!.reconciliations.filter((entry) => entry.outcome === 'missing'),
      ).toHaveLength(1);
      await reviewIntake(url, secretaryState, '好的。');
      await writeFile(
        resolve(runDirectory, 'recovery.json'),
        JSON.stringify({
          status: 'delivered',
          runId: 'old-run',
          attempt: 0,
          processPid: 0,
          processIdentity: '',
          updatedAt: now,
        }),
      );
      await reviewIntake(url, secretaryState, '现在正式版本处于什么阶段？');
      await expect
        .poll(
          async () => {
            const current = JSON.parse(await readFile(statePath, 'utf8')) as SecretaryState;
            return current.items[0].orchestration?.reconciliationOutcome;
          },
          { timeout: 10_000 },
        )
        .toBe('delivered');
      const reconciled = JSON.parse(await readFile(statePath, 'utf8')) as SecretaryState;
      expect(reconciled.items[0]).toMatchObject({
        status: mode === 'live-worker' ? 'tracking' : 'delivered',
        runDirectory,
        retryAt: '',
        orchestration: {
          reconciliationOutcome: 'delivered',
          processOccupied: mode === 'live-worker',
        },
      });
    },
    20_000,
  );

  it.each(['waiting-producer', 'tracking'] as const)(
    'keeps overdue retries asleep behind %s until an external event',
    async (blockerStatus) => {
      temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-blocked-retry-'));
      const secretaryState = resolve(temporary, 'secretary');
      const releaseState = resolve(temporary, 'releases');
      const runDirectory = resolve(temporary, 'retry-run');
      await mkdir(secretaryState, { recursive: true });
      await mkdir(releaseState, { recursive: true });
      await mkdir(runDirectory, { recursive: true });
      const now = new Date().toISOString();
      const seed = createSecretaryState(now);
      const retry = itemFromIntake({ id: 'retry', idea: '完成已有修复', createdAt: now }, []).item;
      retry.status = 'retry-wait';
      retry.runDirectory = runDirectory;
      retry.retryAt = '2026-01-01T00:00:00.000Z';
      const blocker = itemFromIntake(
        { id: 'blocker', idea: '决定存档兼容方案', createdAt: now },
        [],
      ).item;
      blocker.status = blockerStatus;
      if (blockerStatus === 'tracking') {
        nestedWorker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        blocker.processPid = nestedWorker.pid!;
        blocker.processIdentity = await waitForProcessIdentity(blocker.processPid);
        expect(blocker.processIdentity).not.toBe('');
      }
      seed.items.push(blocker, retry);
      seed.activeItemId = blocker.id;
      seed.orchestration!.reconciliations.push({
        itemId: retry.id,
        runId: 'retry-run',
        attempt: 0,
        snapshotStatus: 'recoverable',
        outcome: 'retry-wait',
        reason: '等待重试',
        evidence: [],
        reconciledAt: now,
      });
      await writeFile(
        resolve(runDirectory, 'recovery.json'),
        JSON.stringify({
          status: 'recoverable',
          runId: 'retry-run',
          attempt: 0,
          processPid: 0,
          processIdentity: '',
          error: '临时网络中断',
          updatedAt: now,
        }),
      );
      const statePath = resolve(secretaryState, 'state.json');
      await writeFile(statePath, JSON.stringify(seed));
      await writeFile(
        resolve(releaseState, 'current.json'),
        JSON.stringify(
          createFormalVersion({
            id: 'blocked-retry-version',
            title: '已冻结版本',
            direction: '验证秘书恢复',
            documentRoot: 'docs/versions/blocked-retry-version',
            currentStage: 'development',
          }),
        ),
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
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      await waitForSecretaryDashboard(child, url);
      // Let startup events settle, then prove the overdue snapshot does not write-loop.
      await new Promise((done) => setTimeout(done, 300));
      const idleState = await readFile(statePath, 'utf8');
      await new Promise((done) => setTimeout(done, 300));
      expect(await readFile(statePath, 'utf8')).toBe(idleState);

      if (blockerStatus === 'waiting-producer') {
        const intake = await fetch(`${url}/api/intake`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ idea: '新增宗门系统' }),
        });
        const request = (await intake.json()) as { id: string };
        expect((await waitForIntakeCompletion(secretaryState, request.id)).status).toBe('backlog');
        const saved = JSON.parse(await readFile(statePath, 'utf8')) as typeof seed;
        expect(saved.items.find((item) => item.id === blocker.id)).toEqual(
          expect.objectContaining({
            status: 'waiting-producer',
            producerGuidance: '',
            retryAt: '',
          }),
        );
        expect(saved.orchestration?.nextVersionCandidates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ requestId: request.id, direction: '新增宗门系统' }),
          ]),
        );
        const resolved = await fetch(`${url}/api/todo-action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: 'secretary', id: blocker.id, action: 'defer' }),
        });
        expect(resolved.status).toBe(200);
        const afterEvent = JSON.parse(await readFile(statePath, 'utf8')) as typeof seed;
        expect(afterEvent.items.find((item) => item.id === retry.id)).toEqual(
          expect.objectContaining({
            status: 'retry-wait',
            retryAt: retry.retryAt,
            recoveryAttempts: 0,
          }),
        );
        expect(afterEvent.activeItemId).toBe('');
      }
    },
    20_000,
  );

  it('keeps a terminal run occupied while its child Agent is still alive', async () => {
    temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-terminal-worker-'));
    const secretaryState = resolve(temporary, 'secretary');
    const releaseState = resolve(temporary, 'releases');
    const runDirectory = resolve(temporary, 'runs', 'terminal-run');
    await mkdir(secretaryState, { recursive: true });
    await mkdir(releaseState, { recursive: true });
    await mkdir(runDirectory, { recursive: true });
    nestedWorker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const identity = await waitForProcessIdentity(nestedWorker.pid ?? 0);
    if (!identity) throw new Error('无法创建测试子 Agent 进程');
    await writeFile(
      resolve(runDirectory, 'recovery.json'),
      JSON.stringify({
        version: 1,
        status: 'delivered',
        processPid: 2_147_000_000,
        processIdentity: 'dead-pm',
        phase: '交付完成',
        direction: '验证终态占用',
        resolvedDirection: '验证终态占用',
        baseline: 'test',
        workspaceFingerprint: 'test',
        plan: { summary: '终态占用', acceptanceCriteria: [], nonGoals: [], tasks: [] },
        taskRuns: [],
        review: null,
        plannerTokens: null,
        reviewerTokens: null,
        repairerTokens: null,
        noPush: false,
        error: '',
        updatedAt: '2026-09-21T02:00:00.000Z',
      }),
      'utf8',
    );
    await writeFile(
      resolve(runDirectory, 'progress.json'),
      JSON.stringify({
        phase: '收束输出',
        status: 'running',
        updatedAt: '2026-09-21T02:00:00.000Z',
        workerPid: nestedWorker.pid,
        workerProcessIdentity: identity,
        workerModel: 'gpt-5.6-sol',
        workerRole: '执行 Agent',
      }),
      'utf8',
    );
    await writeFile(
      resolve(secretaryState, 'state.json'),
      JSON.stringify({
        version: 1,
        initializedAt: '2026-09-21T01:59:00.000Z',
        status: 'stopped',
        pid: 0,
        processIdentity: '',
        lastEventAt: '2026-09-21T02:00:00.000Z',
        activeItemId: 'terminal-item',
        items: [
          {
            id: 'terminal-item',
            idea: '验证终态子进程',
            scope: 'feature',
            status: 'tracking',
            summary: '交付完成',
            plannedTasks: [],
            matchedFact: null,
            runDirectory,
            processPid: 2_147_000_000,
            processIdentity: 'dead-pm',
            recoveryAttempts: 0,
            retryAt: '',
            producerGuidance: '',
            createdAt: '2026-09-21T01:59:00.000Z',
            updatedAt: '2026-09-21T02:00:00.000Z',
            completedAt: '',
          },
        ],
        messages: [],
        updatedAt: '2026-09-21T02:00:00.000Z',
      }),
      'utf8',
    );
    await writeFile(
      resolve(releaseState, 'current.json'),
      JSON.stringify(
        createFormalVersion({
          id: 'terminal-version',
          title: '终态占用测试',
          direction: '验证子 Agent 占用',
          documentRoot: 'docs/versions/terminal-version',
        }),
      ),
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
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    await waitForSecretaryDashboard(child, url);
    const dashboard = (await (await fetch(`${url}/api/dashboard`)).json()) as {
      secretary: { activeItemId: string; items: Array<{ id: string; status: string }> };
      agents: Array<{ id: string; running: boolean }>;
    };
    expect(dashboard.secretary.activeItemId).toBe('terminal-item');
    expect(dashboard.secretary.items.find((item) => item.id === 'terminal-item')?.status).toBe(
      'tracking',
    );
    expect(dashboard.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'terminal-item:worker', running: true }),
      ]),
    );
  }, 20_000);

  it('resolves linked decision todos through HTTP without recording stage approvals', async () => {
    temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-dashboard-decisions-'));
    const secretaryState = resolve(temporary, 'secretary');
    const releaseState = resolve(temporary, 'releases');
    await mkdir(releaseState, { recursive: true });
    const versionPath = resolve(releaseState, 'current.json');
    const seed = createFormalVersion({
      id: 'decision-seed',
      title: '决策看板',
      direction: '验证决策待办',
      documentRoot: 'docs/versions/decision-seed',
    });
    await writeFile(versionPath, JSON.stringify(seed));
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
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    await waitForSecretaryDashboard(child, url);
    for (const stage of ['module-design', 'charter-review'] as const) {
      for (const action of ['approve', 'request-changes']) {
        const version = createFormalVersion({
          id: `decision-${stage}-${action}`,
          title: '决策待办',
          direction: '决策不得替代阶段评审',
          documentRoot: 'docs/versions/decision-todo',
          currentStage: stage,
        });
        const gate = addDecisionGate(version, {
          kind: 'scope-change',
          stage,
          summary: '范围修订',
          sourceRequestId: 'scope',
        });
        const other = addDecisionGate(version, {
          kind: 'irreversible-decision',
          stage,
          summary: '另一个决策',
          sourceRequestId: 'architecture',
        });
        const todo = version.todos.find((entry) => entry.decisionGateId === gate.id)!;
        // Exercise read-time compatibility for old todo snapshots as well.
        if (action === 'request-changes') delete todo.decisionGateId;
        await writeFile(versionPath, JSON.stringify(version));
        const dashboard = (await (await fetch(`${url}/api/dashboard`)).json()) as {
          todos: Array<{ id: string }>;
        };
        expect(dashboard.todos.some((entry) => entry.id === todo.id)).toBe(true);
        const response = await fetch(`${url}/api/todo-action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: 'version', id: todo.id, action, note: '制作人决定' }),
        });
        expect(await response.json()).toEqual(
          expect.objectContaining({ message: expect.any(String) }),
        );
        expect(response.status).toBe(200);
        const saved = JSON.parse(await readFile(versionPath, 'utf8')) as FormalVersion;
        expect(saved.currentStage).toBe(stage);
        expect(saved.approvals).toHaveLength(0);
        expect(saved.todos.find((entry) => entry.id === todo.id)?.status).toBe('done');
        expect(
          saved.orchestration?.decisionGates.find((entry) => entry.id === gate.id)?.status,
        ).toBe(action === 'approve' ? 'approved' : 'rejected');
        expect(
          saved.orchestration?.decisionGates.find((entry) => entry.id === other.id)?.status,
        ).toBe('open');
        expect(saved.status).toBe('waiting-producer');
        expect(
          saved.todos.filter((entry) => !entry.decisionGateId && entry.status === 'open'),
        ).toHaveLength(stage === 'charter-review' ? 1 : 0);
      }
    }
  }, 30_000);

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
      '<think>private preface</think>\nprivate-log-sentinel usage limit reached\n',
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
        phase: '<think>private chain of thought</think>',
        direction: '实现看板交互',
        resolvedDirection: '实现看板交互',
        baseline: 'test',
        workspaceFingerprint: 'test',
        plan: {
          summary: '实现看板交互',
          acceptanceCriteria: ['项目中枢可以展示嵌套 Agent'],
          nonGoals: [],
          tasks: [
            {
              id: 'ui',
              title: '实现界面',
              objective: '<think>不要显示这段私有推理</think>完成项目中枢交互',
            },
            {
              id: 'private-task',
              title: '私有推理：不应出现在动作标题',
              objective: '思维链：不应出现在动作详情',
            },
          ],
        },
        taskRuns: [
          {
            result: 'passed',
            task: { id: 'ui', title: '实现界面' },
            changedFiles: ['secretary-dashboard/dashboard.js'],
            tests: ['npm test -- secretary-dashboard'],
          },
        ],
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
      resolve(runningRun, 'public-events.jsonl'),
      `${JSON.stringify({
        schemaVersion: 1,
        eventId: 'delivery-check',
        sequence: 1,
        requestId: '',
        versionId: '',
        itemId: 'running-feature',
        runId: 'running-feature',
        agentId: 'feature-pm',
        kind: 'progress',
        payload: { stage: 'verification', summary: '首轮交付检查完成', completed: 1, total: 2 },
        createdAt: '2026-09-20T01:00:30.000Z',
        durationMs: null,
        tokenUsage: { input: null, output: null, total: null, source: 'unavailable' },
      })}\n`,
      'utf8',
    );
    await writeFile(resolve(runningRun, 'ui.log'), `[等待] ${'公开进度'.repeat(100)}\n`, 'utf8');
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
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let initial = await waitForSecretaryDashboard(child, url);
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
    expect((initial.secretary as { activeItemId: string }).activeItemId).toBe('running-feature');
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
        initial.agents as Array<{ id: string; activity: Array<{ kind: string; label: string }> }>
      ).find((agent) => agent.id === 'running-feature')?.activity,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'stage',
          label: '阶段说明',
          // progress.json is the current, public operational source and therefore
          // takes precedence over a stale private phase in recovery.json.
          detail: '深度规划',
        }),
        expect.objectContaining({ kind: 'stage', label: 'progress' }),
        expect.objectContaining({ kind: 'action', label: expect.stringContaining('实现界面') }),
        expect.objectContaining({ kind: 'output', label: '运行输出（已截断）' }),
        expect.objectContaining({
          kind: 'file',
          label: '修改文件',
          detail: 'secretary-dashboard/dashboard.js',
        }),
        expect.objectContaining({
          kind: 'test',
          label: '测试',
          detail: 'npm test -- secretary-dashboard',
        }),
      ]),
    );
    expect(JSON.stringify(initial.agents)).not.toContain('不要显示这段私有推理');
    expect(JSON.stringify(initial.agents)).not.toContain('private chain of thought');
    expect(JSON.stringify(initial.agents)).not.toContain('不应出现在动作标题');
    expect(JSON.stringify(initial.agents)).not.toContain('不应出现在动作详情');
    expect(JSON.stringify(initial.agents)).not.toContain('private preface');
    expect(JSON.stringify(initial.agents)).not.toContain('private-log-sentinel');
    expect(
      (
        initial.agents as Array<{
          id: string;
          activity: Array<{ detail: string }>;
        }>
      )
        .find((agent) => agent.id === 'running-feature')
        ?.activity.every((event) => event.detail.length <= 240),
    ).toBe(true);
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
    const reconciled = (await (await fetch(`${url}/api/dashboard`)).json()) as {
      secretary: {
        activeItemId: string;
        items: Array<{
          id: string;
          status: string;
          orchestration: { processOccupied: boolean };
        }>;
      };
      todos: Array<{ id: string }>;
    };
    expect(reconciled.secretary.activeItemId).toBe('');
    expect(reconciled.secretary.items.find((item) => item.id === 'running-feature')).toEqual(
      expect.objectContaining({
        status: 'retry-wait',
        orchestration: expect.objectContaining({ processOccupied: false }),
      }),
    );
    expect(reconciled.todos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'blocked-feature' }),
        expect.objectContaining({ id: 'decision-item' }),
      ]),
    );
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
    const versionRequest = (await intake.json()) as { id: string };
    const versionCompletion = await waitForIntakeCompletion(secretaryState, versionRequest.id);
    expect(versionCompletion.response).toContain('开发执行');

    const backlogIntake = await fetch(`${url}/api/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: '新增宗门经营系统' }),
    });
    expect(backlogIntake.status).toBe(202);
    const backlogRequest = (await backlogIntake.json()) as { id: string };
    const backlogCompletion = await waitForIntakeCompletion(secretaryState, backlogRequest.id);
    expect(backlogCompletion.status).toBe('backlog');
    const backlogState = (await (await fetch(`${url}/api/dashboard`)).json()) as {
      secretary: { items: Array<{ idea: string; status: string }> };
    };
    expect(backlogState.secretary.items.find((item) => item.idea.includes('宗门经营'))).toEqual(
      expect.objectContaining({ status: 'backlog' }),
    );

    const acceptance = createFormalVersion({
      id: 'candidate-test',
      title: '候选版本',
      direction: '验证制作人门禁',
      documentRoot: 'docs/versions/candidate-test',
      currentStage: 'producer-acceptance',
    });
    const wordingGate = addDecisionGate(acceptance, {
      kind: 'scope-change',
      stage: 'producer-acceptance',
      summary: '确认当前候选范围',
      sourceRequestId: 'wording-gate',
    });
    await writeFile(resolve(releaseState, 'current.json'), JSON.stringify(acceptance), 'utf8');
    const directionWithApprovalWord = await fetch(`${url}/api/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: '新增审批确认功能' }),
    });
    expect(directionWithApprovalWord.status).toBe(202);
    const directionWithApprovalWordReceipt = (await directionWithApprovalWord.json()) as {
      id: string;
    };
    await waitForIntakeCompletion(secretaryState, directionWithApprovalWordReceipt.id);
    let persistedAcceptance = JSON.parse(
      await readFile(resolve(releaseState, 'current.json'), 'utf8'),
    ) as FormalVersion;
    expect(
      persistedAcceptance.orchestration?.decisionGates.find((gate) => gate.id === wordingGate.id)
        ?.status,
    ).toBe('open');

    const explicitChangeRequest = await fetch(`${url}/api/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: '这里有问题，需要调整范围' }),
    });
    expect(explicitChangeRequest.status).toBe(202);
    const explicitChangeRequestReceipt = (await explicitChangeRequest.json()) as { id: string };
    await waitForIntakeCompletion(secretaryState, explicitChangeRequestReceipt.id);
    persistedAcceptance = JSON.parse(
      await readFile(resolve(releaseState, 'current.json'), 'utf8'),
    ) as FormalVersion;
    expect(
      persistedAcceptance.orchestration?.decisionGates.find((gate) => gate.id === wordingGate.id)
        ?.status,
    ).toBe('rejected');

    const producerComment = await fetch(`${url}/api/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: '我再看看，晚点回复' }),
    });
    expect(producerComment.status).toBe(202);
    const producerCommentReceipt = (await producerComment.json()) as { id: string };
    await waitForIntakeCompletion(secretaryState, producerCommentReceipt.id);
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

    const deferredDirectionIntake = await fetch(`${url}/api/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: '另外新增炼丹系统，放到后续版本' }),
    });
    expect(deferredDirectionIntake.status).toBe(202);
    const deferredDirectionReceipt = (await deferredDirectionIntake.json()) as { id: string };
    expect(
      (await waitForIntakeCompletion(secretaryState, deferredDirectionReceipt.id)).status,
    ).toBe('backlog');
    const completedGateState = (await (await fetch(`${url}/api/dashboard`)).json()) as {
      version: { currentStage: string };
      secretary: { items: Array<{ idea: string; status: string }> };
    };
    expect(
      completedGateState.secretary.items.find((item) => item.idea.includes('炼丹系统'))?.status,
    ).toBe('backlog');
    expect(completedGateState.version.currentStage).toBe('producer-acceptance');

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
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    await waitForSecretaryDashboard(child, url);
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

  it('replays a persisted decision reply without approving the next gate', async () => {
    temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-secretary-decision-replay-'));
    const secretaryState = resolve(temporary, 'secretary');
    const releaseState = resolve(temporary, 'releases');
    const inbox = resolve(secretaryState, 'inbox');
    await mkdir(inbox, { recursive: true });
    await mkdir(releaseState, { recursive: true });
    const requestId = 'dingtalk-decision-replay';
    await writeFile(
      resolve(inbox, `${requestId}.json`),
      JSON.stringify({
        id: requestId,
        idea: '通过',
        createdAt: '2026-09-21T01:00:00.000Z',
      }),
      'utf8',
    );
    const version = createFormalVersion({
      id: 'decision-replay-version',
      title: '决策重放版本',
      direction: '验证决策回复中断恢复',
      documentRoot: 'docs/versions/decision-replay-version',
    });
    const resolved = addDecisionGate(version, {
      kind: 'irreversible-decision',
      stage: 'direction',
      summary: '第一个决策',
      sourceRequestId: 'first-direction',
    });
    resolveDecisionGate(version, resolved.id, 'approved', '2026-09-21T01:00:00.000Z', requestId);
    const pending = addDecisionGate(version, {
      kind: 'irreversible-decision',
      stage: 'direction',
      summary: '第二个决策',
      sourceRequestId: 'second-direction',
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
        DAOYAN_SECRETARY_WEBHOOK_URL: '',
        DAOYAN_DINGTALK_CLIENT_ID: '',
        DAOYAN_DINGTALK_CLIENT_SECRET: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    await waitForSecretaryDashboard(child, url);
    const responsePath = resolve(secretaryState, 'responses', `${requestId}.json`);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (
        await readFile(responsePath, 'utf8')
          .then(() => true)
          .catch(() => false)
      )
        break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    }
    const saved = JSON.parse(
      await readFile(resolve(releaseState, 'current.json'), 'utf8'),
    ) as FormalVersion;
    expect(saved.orchestration?.decisionGates.find((gate) => gate.id === resolved.id)?.status).toBe(
      'approved',
    );
    expect(saved.orchestration?.decisionGates.find((gate) => gate.id === pending.id)?.status).toBe(
      'open',
    );
    expect(
      saved.orchestration?.decisionGates
        .find((gate) => gate.id === resolved.id)
        ?.resolutionHistory?.filter((entry) => entry.requestId === requestId),
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
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    await waitForSecretaryDashboard(child, url);
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
