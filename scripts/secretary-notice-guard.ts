import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, watch, type FSWatcher } from 'node:fs';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLocalPlan, classifyAgentFailure, preferredWindowsExecutable } from './agent-routing';
import {
  getProcessIdentity,
  isOwnedProcessAlive,
  waitForProcessIdentity,
} from './process-identity';
import {
  createSecretaryState,
  itemFromIntake,
  nextRunnableItem,
  projectFactsFromItems,
  projectFactsFromStatus,
  publicSecretaryState,
  type IntakeRequest,
  type ProjectFact,
  type SecretaryItem,
  type SecretaryScope,
  type SecretaryState,
} from './secretary-state';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentRoot = resolve(root, '.daoyan-agent');
const secretaryRoot = resolve(
  root,
  process.env.DAOYAN_SECRETARY_STATE_DIR ?? '.daoyan-agent/secretary',
);
const secretaryRelativePrefix = relative(agentRoot, secretaryRoot).replace(/\\/g, '/');
const inboxRoot = resolve(secretaryRoot, 'inbox');
const responseRoot = resolve(secretaryRoot, 'responses');
const stateFile = resolve(secretaryRoot, 'state.json');
const lockFile = resolve(secretaryRoot, 'notice-guard.lock');
const eventsFile = resolve(secretaryRoot, 'events.jsonl');
const versionsRoot = resolve(agentRoot, 'versions');
const runsRoot = resolve(agentRoot, 'runs');
const tsxCliPath = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const agentDispatcherPath = resolve(root, 'scripts/agent-dispatcher.ts');
const versionDispatcherPath = resolve(root, 'scripts/version-dispatcher.ts');
const triageSchemaPath = resolve(root, 'agents/secretary-triage.schema.json');

interface SecretaryConfig {
  version: 1;
  triage: {
    enabled: boolean;
    model: string;
    reasoning: 'low' | 'medium' | 'high';
    timeoutSeconds: number;
  };
  guard: {
    externalRetryMinutes: number;
    executionRetryMinutes: number;
    orphanRecoveryMinutes: number;
    maxRecoveryAttempts: number;
  };
}

interface RunSnapshot {
  scope: SecretaryScope;
  directory: string;
  objective: string;
  status: string;
  processPid: number;
  processIdentity: string;
  error: string;
  updatedAt: string;
}

interface TriageResult {
  disposition: 'completed' | 'active' | 'scheduled' | 'new' | 'waiting-producer';
  response: string;
  direction: string;
  scope: SecretaryScope;
  taskTitles: string[];
}

let state = createSecretaryState(new Date().toISOString());
let config: SecretaryConfig;
let activeChild: ChildProcess | null = null;
let inboxWatcher: FSWatcher | null = null;
let runWatcher: FSWatcher | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let orphanTimer: NodeJS.Timeout | null = null;
let httpServer: Server | null = null;
let processingInbox = false;
let inboxPending = false;
let coordinating = false;
let coordinatePending = false;
let stopping = false;
let stateWrites = Promise.resolve();
const processExitNotices = new Map<number, ChildProcess>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function loadState(): Promise<SecretaryState> {
  try {
    const value = JSON.parse(await readFile(stateFile, 'utf8')) as Partial<SecretaryState>;
    if (value.version !== 1 || !Array.isArray(value.items)) throw new Error('invalid state');
    return {
      ...createSecretaryState(new Date().toISOString()),
      ...value,
      processIdentity: getProcessIdentity(process.pid),
      items: value.items.map((item) => ({
        ...item,
        processIdentity: item.processIdentity ?? '',
      })),
      status: 'running',
      pid: process.pid,
    } as SecretaryState;
  } catch {
    return {
      ...createSecretaryState(new Date().toISOString()),
      pid: process.pid,
      processIdentity: getProcessIdentity(process.pid),
    };
  }
}

async function saveState(): Promise<void> {
  state.lastEventAt = new Date().toISOString();
  state.updatedAt = state.lastEventAt;
  const snapshot = structuredClone(state);
  // A transient failed write must reject its caller without poisoning every
  // later state update in this long-lived process.
  stateWrites = stateWrites.catch(() => undefined).then(() => writeJsonAtomic(stateFile, snapshot));
  await stateWrites;
}

function validateConfig(value: unknown): SecretaryConfig {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.triage) ||
    !isRecord(value.guard)
  ) {
    throw new Error('agents/secretary.json 格式无效');
  }
  const triage = value.triage;
  const guard = value.guard;
  if (
    typeof triage.enabled !== 'boolean' ||
    typeof triage.model !== 'string' ||
    !['low', 'medium', 'high'].includes(String(triage.reasoning)) ||
    typeof triage.timeoutSeconds !== 'number' ||
    typeof guard.externalRetryMinutes !== 'number' ||
    typeof guard.executionRetryMinutes !== 'number' ||
    typeof guard.orphanRecoveryMinutes !== 'number' ||
    typeof guard.maxRecoveryAttempts !== 'number'
  ) {
    throw new Error('agents/secretary.json 缺少必要配置');
  }
  return value as unknown as SecretaryConfig;
}

async function emitNotice(kind: string, message: string, item?: SecretaryItem): Promise<void> {
  const event = {
    id: randomUUID(),
    kind,
    message,
    itemId: item?.id ?? '',
    createdAt: new Date().toISOString(),
  };
  await appendFile(eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
  console.log(`[常驻秘书] ${message}`);
  const url = process.env.DAOYAN_SECRETARY_WEBHOOK_URL;
  if (!url) return;
  const provider = (process.env.DAOYAN_SECRETARY_WEBHOOK_KIND ?? 'generic').toLowerCase();
  const body =
    provider === 'feishu'
      ? { msg_type: 'text', content: { text: message } }
      : provider === 'wecom'
        ? { msgtype: 'text', text: { content: message } }
        : provider === 'discord'
          ? { content: message }
          : event;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) console.error(`[notice guard] webhook 返回 ${response.status}`);
  } catch (error) {
    console.error(`[notice guard] webhook 发送失败：${String(error)}`);
  }
}

function codexExecutable(): string | null {
  if (process.platform !== 'win32') return 'codex';
  const found = spawnSync('where.exe', ['codex'], { encoding: 'utf8' });
  if (found.status !== 0) return null;
  return preferredWindowsExecutable(found.stdout.split(/\r?\n/).filter(Boolean));
}

function validateTriage(value: unknown): TriageResult | null {
  if (!isRecord(value)) return null;
  const dispositions = ['completed', 'active', 'scheduled', 'new', 'waiting-producer'];
  if (
    !dispositions.includes(String(value.disposition)) ||
    typeof value.response !== 'string' ||
    typeof value.direction !== 'string' ||
    !['feature', 'version'].includes(String(value.scope)) ||
    !Array.isArray(value.taskTitles) ||
    !value.taskTitles.every((item) => typeof item === 'string')
  ) {
    return null;
  }
  return value as unknown as TriageResult;
}

async function modelTriage(
  request: IntakeRequest,
  facts: ProjectFact[],
): Promise<TriageResult | null> {
  if (!config.triage.enabled || process.env.DAOYAN_SECRETARY_LOCAL_ONLY === '1') return null;
  const executable = codexExecutable();
  if (!executable) return null;
  const outputFile = resolve(secretaryRoot, `triage-${request.id}.json`);
  const factText = facts
    .map((fact) => `- [${fact.kind}] ${fact.text} (${fact.reference})`)
    .join('\n');
  const prompt = `你是道衍项目的常驻制作人秘书。你只在收到 notice guard 事件时运行，本次只处理一条制作人想法，不修改文件、不执行代码。\n\n根据项目事实判断：已经完成则回答现状；正在执行则关联当前任务；已经排期则避免重复；尚未安排则形成后续方向和简短任务标题。只有确实需要产品取舍时才 waiting-producer。不要把技术细节选择交还制作人。\n\n制作人消息：${request.idea}\n期望范围：${request.scope}\n\n项目事实：\n${factText || '- 暂无匹配事实'}\n`;
  const args = [
    'exec',
    '--ephemeral',
    '--color',
    'never',
    '--sandbox',
    'read-only',
    '--ask-for-approval',
    'never',
    '--model',
    config.triage.model,
    '-c',
    `model_reasoning_effort="${config.triage.reasoning}"`,
    '--output-schema',
    triageSchemaPath,
    '--output-last-message',
    outputFile,
    '-',
  ];
  const code = await new Promise<number>((resolveCode) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: process.env,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    const timeout = setTimeout(() => child.kill(), config.triage.timeoutSeconds * 1000);
    timeout.unref();
    child.stdin.end(prompt);
    child.on('error', () => resolveCode(1));
    child.on('close', (result) => {
      clearTimeout(timeout);
      resolveCode(result ?? 1);
    });
  });
  if (code !== 0) return null;
  try {
    const result = validateTriage(JSON.parse(await readFile(outputFile, 'utf8')));
    await rm(outputFile, { force: true });
    return result;
  } catch {
    return null;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function scanRuns(): Promise<RunSnapshot[]> {
  const snapshots: RunSnapshot[] = [];
  if (existsSync(versionsRoot)) {
    for (const entry of await readdir(versionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = resolve(versionsRoot, entry.name);
      const manifest = await readJson(resolve(directory, 'version.json'));
      if (!manifest || typeof manifest.status !== 'string') continue;
      const status =
        manifest.status === 'planned' && existsSync(resolve(directory, 'report.md'))
          ? 'preview'
          : manifest.status;
      snapshots.push({
        scope: 'version',
        directory,
        objective: String(manifest.objective ?? entry.name),
        status,
        processPid: Number.isInteger(manifest.processPid) ? Number(manifest.processPid) : 0,
        processIdentity: String(manifest.processIdentity ?? ''),
        error: String(manifest.error ?? ''),
        updatedAt: String(manifest.updatedAt ?? ''),
      });
    }
  }
  if (existsSync(runsRoot)) {
    for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = resolve(runsRoot, entry.name);
      const recovery = await readJson(resolve(directory, 'recovery.json'));
      const plan = await readJson(resolve(directory, 'plan.validated.json'));
      const report = await readJson(resolve(directory, 'report.json'));
      if ((!recovery || typeof recovery.status !== 'string') && !report) continue;
      const reportStatus = String(report?.status ?? '');
      const status = recovery?.status
        ? String(recovery.status)
        : reportStatus === '等待制作人决策'
          ? 'waiting-producer'
          : reportStatus === '已交付'
            ? 'delivered'
            : reportStatus === '规划完成'
              ? 'preview'
              : 'failed';
      snapshots.push({
        scope: 'feature',
        directory,
        objective: String(plan?.summary ?? entry.name),
        status,
        processPid: Number.isInteger(recovery?.processPid) ? Number(recovery?.processPid) : 0,
        processIdentity: String(recovery?.processIdentity ?? ''),
        error: String(recovery?.error ?? report?.extra ?? ''),
        updatedAt: String(recovery?.updatedAt ?? ''),
      });
    }
  }
  return snapshots;
}

async function projectFacts(): Promise<{ facts: ProjectFact[]; runs: RunSnapshot[] }> {
  const markdown = await readFile(resolve(root, 'docs/status.md'), 'utf8');
  const runs = await scanRuns();
  const activeFacts = runs
    .filter((run) =>
      ['planned', 'running', 'recoverable', 'waiting-producer', 'active'].includes(run.status),
    )
    .map<ProjectFact>((run) => ({ kind: 'active', text: run.objective, reference: run.directory }));
  const queueFacts = projectFactsFromItems(state.items);
  return { facts: [...activeFacts, ...queueFacts, ...projectFactsFromStatus(markdown)], runs };
}

function applyModelTriage(item: SecretaryItem, result: TriageResult): string {
  item.idea = result.direction || item.idea;
  item.scope = result.scope;
  item.plannedTasks = result.taskTitles.length > 0 ? result.taskTitles : item.plannedTasks;
  item.summary = result.response;
  if (result.disposition === 'completed') {
    item.status = 'answered';
    item.completedAt = new Date().toISOString();
  } else if (result.disposition === 'active') {
    item.status = 'answered';
    item.completedAt = new Date().toISOString();
  } else if (result.disposition === 'waiting-producer') item.status = 'waiting-producer';
  else item.status = 'queued';
  return result.response;
}

async function processInbox(): Promise<void> {
  if (processingInbox) {
    inboxPending = true;
    return;
  }
  if (stopping) return;
  processingInbox = true;
  try {
    do {
      inboxPending = false;
      const names = (await readdir(inboxRoot)).filter((name) => name.endsWith('.json')).sort();
      for (const name of names) {
        const path = resolve(inboxRoot, name);
        const raw = await readJson(path);
        if (
          !raw ||
          typeof raw.id !== 'string' ||
          typeof raw.idea !== 'string' ||
          !['feature', 'version'].includes(String(raw.scope)) ||
          typeof raw.createdAt !== 'string'
        ) {
          await rm(path, { force: true });
          continue;
        }
        const request = { ...raw, decision: raw.decision === true } as unknown as IntakeRequest;
        const waiting = state.items.find(
          (item) => item.id === state.activeItemId && item.status === 'waiting-producer',
        );
        if (waiting && request.decision) {
          waiting.producerGuidance = request.idea;
          waiting.status = 'retry-wait';
          waiting.retryAt = request.createdAt;
          waiting.summary = '已收到制作人决策，将从原恢复点继续。';
          state.activeItemId = '';
          await saveState();
          await writeJsonAtomic(resolve(responseRoot, `${request.id}.json`), {
            id: request.id,
            response: waiting.summary,
            status: waiting.status,
            plannedTasks: waiting.plannedTasks,
          });
          await rm(path, { force: true });
          await emitNotice('decision-accepted', waiting.summary, waiting);
          continue;
        }
        const known = await projectFacts();
        const local = itemFromIntake(request, known.facts);
        const model = local.item.matchedFact ? null : await modelTriage(request, known.facts);
        let response = model ? applyModelTriage(local.item, model) : local.response;
        if (local.item.matchedFact?.reference.startsWith('secretary:')) {
          local.item.status = 'answered';
          local.item.completedAt = request.createdAt;
          response = `该方向已经在秘书队列中，不会重复派发：${local.item.idea}`;
          local.item.summary = response;
        }
        state.items.push(local.item);
        if (local.item.status === 'queued') state.reviewRequired = false;
        if (local.item.status === 'waiting-producer') state.activeItemId = local.item.id;
        await saveState();
        await writeJsonAtomic(resolve(responseRoot, `${request.id}.json`), {
          id: request.id,
          response,
          status: local.item.status,
          plannedTasks: local.item.plannedTasks,
        });
        await rm(path, { force: true });
        await emitNotice('intake', response, local.item);
      }
    } while (inboxPending || (await readdir(inboxRoot)).some((name) => name.endsWith('.json')));
  } finally {
    processingInbox = false;
  }
  await coordinate();
}

function unfinished(run: RunSnapshot): boolean {
  return ['planned', 'running', 'recoverable', 'waiting-producer', 'active'].includes(run.status);
}

async function adoptExistingRun(): Promise<boolean> {
  if (state.activeItemId) return false;
  const knownDirectories = new Set(state.items.map((item) => item.runDirectory).filter(Boolean));
  const runs = (await scanRuns())
    .filter((run) => unfinished(run) && !knownDirectories.has(run.directory))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const version = runs.find((run) => run.scope === 'version');
  const selected = version ?? runs[0];
  if (!selected) return false;
  const now = new Date().toISOString();
  const plan = buildLocalPlan(selected.objective);
  const item: SecretaryItem = {
    id: `adopted-${basename(selected.directory)}`,
    idea: selected.objective,
    scope: selected.scope,
    status: 'tracking',
    summary: '已接管现有调度运行。',
    plannedTasks: plan.tasks.map((task) => task.title),
    matchedFact: null,
    runDirectory: selected.directory,
    processPid: selected.processPid,
    processIdentity: selected.processIdentity,
    recoveryAttempts: 0,
    retryAt: '',
    producerGuidance: '',
    createdAt: now,
    updatedAt: now,
    completedAt: '',
  };
  state.items.unshift(item);
  state.activeItemId = item.id;
  await reconcileItem(item, selected);
  if (isOwnedProcessAlive(item.processPid, item.processIdentity)) attachProcessExitNotice(item);
  await saveState();
  return true;
}

function externalBlocker(message: string): boolean {
  return (
    classifyAgentFailure(message, 1) === 'external-blocker' ||
    /账号|鉴权|额度|用量|登录|credit/i.test(message)
  );
}

function terminateProcessTree(pid: number, identity: string): void {
  if (!isOwnedProcessAlive(pid, identity)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else process.kill(pid, 'SIGTERM');
}

function attachProcessExitNotice(item: SecretaryItem): void {
  const pid = item.processPid;
  if (!isOwnedProcessAlive(pid, item.processIdentity) || processExitNotices.has(pid)) return;
  if (process.platform !== 'win32') {
    scheduleOrphanRecovery(item);
    return;
  }
  const waiter = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  processExitNotices.set(pid, waiter);
  waiter.on('close', () => {
    processExitNotices.delete(pid);
    if (stopping || item.processPid !== pid) return;
    item.processPid = 0;
    item.processIdentity = '';
    void reconcileItem(item, undefined, true)
      .then(() => saveState())
      .then(() => coordinate())
      .catch((error) => console.error(`[notice guard] 进程退出通知处理失败：${String(error)}`));
  });
}

function isCleanWorktree(): boolean {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 && !result.stdout.trim();
}

function scheduleOrphanRecovery(item: SecretaryItem): void {
  if (orphanTimer) return;
  orphanTimer = setTimeout(() => {
    orphanTimer = null;
    if (item.status !== 'tracking' || state.activeItemId !== item.id) return;
    const canProveExited =
      item.processPid > 0 &&
      Boolean(item.processIdentity) &&
      !isOwnedProcessAlive(item.processPid, item.processIdentity);
    item.status = canProveExited ? 'retry-wait' : 'waiting-producer';
    item.retryAt = canProveExited ? new Date().toISOString() : '';
    item.summary = canProveExited
      ? '原 PM 已退出，notice guard 将从持久恢复点接管。'
      : '这是旧格式的外部 PM 运行，恢复点没有进程标识；为避免并发编辑，秘书不会自动抢占，需要确认原进程已停止后再接管。';
    item.processPid = 0;
    item.processIdentity = '';
    state.activeItemId = canProveExited ? '' : item.id;
    void saveState()
      .then(() =>
        canProveExited ? coordinate() : emitNotice('producer-decision', item.summary, item),
      )
      .catch((error) => console.error(`[notice guard] 孤儿运行处理失败：${String(error)}`));
  }, config.guard.orphanRecoveryMinutes * 60_000);
}

async function markMissingSnapshot(item: SecretaryItem, exitCode: number): Promise<void> {
  item.processPid = 0;
  item.processIdentity = '';
  if (isCleanWorktree()) {
    item.status = 'retry-wait';
    item.summary = `PM 以代码 ${exitCode} 退出且未留下恢复点，将作为新运行重试。`;
    item.retryAt = new Date(Date.now() + config.guard.executionRetryMinutes * 60_000).toISOString();
    item.runDirectory = '';
    state.activeItemId = '';
    scheduleRetry();
    return;
  }
  item.status = 'waiting-producer';
  item.summary = 'PM 未留下恢复点但工作区已经变化，秘书无法安全判断改动归属，需要制作人确认接管。';
  state.activeItemId = item.id;
  await emitNotice('unsafe-recovery', item.summary, item);
}

async function reconcileItem(
  item: SecretaryItem,
  supplied?: RunSnapshot,
  processEnded = false,
): Promise<boolean> {
  let run = supplied;
  if (!run && item.runDirectory) {
    run = (await scanRuns()).find((candidate) => candidate.directory === item.runDirectory);
  }
  if (!run) return false;
  item.updatedAt = new Date().toISOString();
  if (run.status === 'review-ready' || run.status === 'delivered') {
    const firstDelivery = item.status !== 'delivered';
    item.status = 'delivered';
    item.completedAt = item.updatedAt;
    item.processPid = 0;
    item.processIdentity = '';
    state.activeItemId = '';
    const queued = state.items.some((candidate) => candidate.status === 'queued');
    if (item.scope === 'version') state.reviewRequired = true;
    if (orphanTimer) clearTimeout(orphanTimer);
    orphanTimer = null;
    if (firstDelivery)
      await emitNotice(
        'delivery-complete',
        `${item.scope === 'version' ? '版本' : 'Feature'} 已完成，可以 Review：${item.idea}。${item.scope === 'version' ? '秘书已暂停后续排期，等待你的 Review 或新方向。' : queued ? '队列中的下一项将自动开始。' : '当前队列已空，秘书等待你的新方向。'}`,
        item,
      );
    return true;
  }
  if (run.status === 'waiting-producer') {
    if (orphanTimer) clearTimeout(orphanTimer);
    orphanTimer = null;
    const firstRequest = item.status !== 'waiting-producer';
    item.status = 'waiting-producer';
    item.summary = run.error || '当前任务需要制作人决定产品方向。';
    item.processPid = 0;
    item.processIdentity = '';
    state.activeItemId = item.id;
    if (firstRequest) await emitNotice('producer-decision', item.summary, item);
    return true;
  }
  if (run.status === 'recoverable') {
    if (orphanTimer) clearTimeout(orphanTimer);
    orphanTimer = null;
    item.processPid = 0;
    item.processIdentity = '';
    if (item.recoveryAttempts >= config.guard.maxRecoveryAttempts) {
      item.status = 'waiting-producer';
      item.summary = `自动恢复已达到 ${config.guard.maxRecoveryAttempts} 次：${run.error}`;
      await emitNotice('recovery-exhausted', item.summary, item);
      return true;
    }
    const minutes = externalBlocker(run.error)
      ? config.guard.externalRetryMinutes
      : config.guard.executionRetryMinutes;
    item.status = 'retry-wait';
    item.summary = run.error || '调度运行可恢复，等待下一次自动接管。';
    item.retryAt = new Date(Date.now() + minutes * 60_000).toISOString();
    state.activeItemId = '';
    scheduleRetry();
    return true;
  }
  if (run.status === 'failed') {
    await markMissingSnapshot(item, 1);
    return true;
  }
  if (processEnded) {
    item.status = 'retry-wait';
    item.summary = 'PM 已退出但恢复点仍标记为运行中，将立即从该恢复点接管。';
    item.retryAt = new Date().toISOString();
    item.processPid = 0;
    item.processIdentity = '';
    state.activeItemId = '';
    return true;
  }
  item.status = 'tracking';
  state.activeItemId = item.id;
  if (!isOwnedProcessAlive(item.processPid, item.processIdentity)) scheduleOrphanRecovery(item);
  return true;
}

function runArgs(item: SecretaryItem): string[] {
  if (item.runDirectory) {
    if (item.scope === 'feature' && !existsSync(resolve(item.runDirectory, 'recovery.json'))) {
      return [
        tsxCliPath,
        agentDispatcherPath,
        '--run-id',
        basename(item.runDirectory),
        ...(item.producerGuidance ? ['--decision-confirmed'] : []),
        item.idea,
      ];
    }
    return item.scope === 'version'
      ? [
          tsxCliPath,
          versionDispatcherPath,
          '--resume',
          relative(root, item.runDirectory),
          ...(item.producerGuidance ? [item.producerGuidance] : []),
        ]
      : [
          tsxCliPath,
          agentDispatcherPath,
          '--resume',
          ...(item.producerGuidance ? ['--decision-confirmed'] : []),
          relative(root, item.runDirectory),
        ];
  }
  if (item.scope === 'version') return [tsxCliPath, versionDispatcherPath, item.idea];
  const runId = `secretary-${item.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  item.runDirectory = resolve(runsRoot, runId);
  return [
    tsxCliPath,
    agentDispatcherPath,
    '--run-id',
    runId,
    ...(item.producerGuidance ? ['--decision-confirmed'] : []),
    item.idea,
  ];
}

async function locateVersionRun(item: SecretaryItem): Promise<void> {
  if (item.runDirectory || item.scope !== 'version') return;
  const matches = (await scanRuns())
    .filter((run) => run.scope === 'version' && run.objective === item.idea)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (matches[0]) item.runDirectory = matches[0].directory;
}

async function launch(item: SecretaryItem): Promise<void> {
  item.status = 'active';
  item.retryAt = '';
  item.updatedAt = new Date().toISOString();
  if (item.runDirectory) item.recoveryAttempts += 1;
  state.activeItemId = item.id;
  const log = openSync(resolve(secretaryRoot, `${item.id}.log`), 'a');
  const child = spawn(process.execPath, runArgs(item), {
    cwd: root,
    env: process.env,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  closeSync(log);
  activeChild = child;
  item.processPid = child.pid ?? 0;
  item.processIdentity = item.processPid ? await waitForProcessIdentity(item.processPid) : '';
  await saveState();
  child.on('error', async (error) => {
    item.summary = `无法启动 PM 调度器：${error.message}`;
  });
  child.on('close', (code) => {
    void (async () => {
      activeChild = null;
      item.processPid = 0;
      item.processIdentity = '';
      await locateVersionRun(item);
      const found = await reconcileItem(item, undefined, true);
      if (!found) await markMissingSnapshot(item, code ?? 1);
      await saveState();
      await coordinate();
    })().catch((error) => console.error(`[notice guard] PM 退出处理失败：${String(error)}`));
  });
}

function scheduleRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  const candidates = state.items
    .filter((item) => item.status === 'retry-wait' && item.retryAt)
    .map((item) => Date.parse(item.retryAt))
    .filter((value) => Number.isFinite(value));
  if (candidates.length === 0) return;
  const delay = Math.max(0, Math.min(...candidates) - Date.now());
  retryTimer = setTimeout(() => void coordinate(), delay);
}

async function coordinateOnce(): Promise<void> {
  if (stopping || activeChild) return;
  if (state.reviewRequired) return;
  if (process.env.DAOYAN_SECRETARY_NO_DISPATCH === '1') return;
  const active = state.items.find((item) => item.id === state.activeItemId);
  if (active) {
    if (isOwnedProcessAlive(active.processPid, active.processIdentity)) {
      attachProcessExitNotice(active);
      return;
    }
    await reconcileItem(
      active,
      undefined,
      active.processPid > 0 && Boolean(active.processIdentity),
    );
    if (state.activeItemId) {
      await saveState();
      return;
    }
  }
  if (await adoptExistingRun()) return;
  const next = nextRunnableItem(state, new Date().toISOString());
  if (next) await launch(next);
  else scheduleRetry();
}

async function coordinate(): Promise<void> {
  if (coordinating) {
    coordinatePending = true;
    return;
  }
  coordinating = true;
  try {
    do {
      coordinatePending = false;
      await coordinateOnce();
    } while (coordinatePending && !stopping);
  } finally {
    coordinating = false;
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) request.destroy(new Error('request too large'));
      else chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', rejectBody);
  });
}

async function enqueueIdea(idea: string, scope: SecretaryScope, decision = false): Promise<string> {
  const request: IntakeRequest = {
    id: randomUUID(),
    idea,
    scope,
    decision,
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(resolve(inboxRoot, `${request.id}.json`), request);
  return request.id;
}

function startHttpServer(): void {
  const port = Number(process.env.DAOYAN_SECRETARY_HTTP_PORT ?? 0);
  if (!Number.isInteger(port) || port <= 0) return;
  const token = process.env.DAOYAN_SECRETARY_TOKEN ?? '';
  const host = process.env.DAOYAN_SECRETARY_HTTP_HOST ?? '127.0.0.1';
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (!token && !loopbackHosts.has(host.toLowerCase())) {
    throw new Error('秘书 HTTP 监听非本机地址时必须设置 DAOYAN_SECRETARY_TOKEN');
  }
  httpServer = createServer(async (request, response) => {
    const authorized = !token || request.headers.authorization === `Bearer ${token}`;
    if (!authorized) {
      response.writeHead(401).end('unauthorized');
      return;
    }
    if (request.method === 'GET' && request.url === '/status') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(publicSecretaryState(state)));
      return;
    }
    if (request.method === 'POST' && request.url === '/intake') {
      try {
        const value = JSON.parse(await readBody(request)) as unknown;
        if (!isRecord(value) || typeof value.idea !== 'string' || !value.idea.trim()) {
          throw new Error('idea is required');
        }
        const scope = value.scope === 'version' ? 'version' : 'feature';
        const id = await enqueueIdea(value.idea.trim(), scope, value.decision === true);
        response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ id, status: 'accepted' }));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }
    response.writeHead(404).end('not found');
  });
  httpServer.listen(port, host, () => console.log(`[notice guard] HTTP 监听 ${host}:${port}`));
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (retryTimer) clearTimeout(retryTimer);
  if (orphanTimer) clearTimeout(orphanTimer);
  inboxWatcher?.close();
  runWatcher?.close();
  httpServer?.close();
  for (const waiter of processExitNotices.values()) waiter.kill();
  processExitNotices.clear();
  const active = state.items.find((item) => item.id === state.activeItemId);
  const managedProcesses = [
    { pid: activeChild?.pid ?? 0, identity: active?.processIdentity ?? '' },
    { pid: active?.processPid ?? 0, identity: active?.processIdentity ?? '' },
  ];
  for (const managed of managedProcesses) {
    if (managed.pid > 0 && managed.pid !== process.pid) {
      terminateProcessTree(managed.pid, managed.identity);
    }
  }
  state.status = 'stopped';
  state.pid = 0;
  await saveState();
  await rm(lockFile, { force: true });
}

export async function runNoticeGuard(): Promise<void> {
  await mkdir(inboxRoot, { recursive: true });
  await mkdir(responseRoot, { recursive: true });
  const lock = await open(lockFile, 'wx').catch(() => null);
  if (!lock) throw new Error('notice guard 已经在运行，或存在未清理的锁文件');
  const guardProcessIdentity = getProcessIdentity(process.pid);
  if (!guardProcessIdentity) {
    await lock.close();
    await rm(lockFile, { force: true });
    throw new Error('无法读取 notice guard 进程启动标识');
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid, processIdentity: guardProcessIdentity }));
  await lock.close();
  config = validateConfig(
    JSON.parse(await readFile(resolve(root, 'agents/secretary.json'), 'utf8')),
  );
  state = await loadState();
  state.status = 'running';
  state.pid = process.pid;
  state.processIdentity = guardProcessIdentity;
  await saveState();
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  inboxWatcher = watch(inboxRoot, () => void processInbox());
  runWatcher = watch(agentRoot, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const normalized = filename.toString().replace(/\\/g, '/');
    if (
      normalized === secretaryRelativePrefix ||
      normalized.startsWith(`${secretaryRelativePrefix}/`)
    )
      return;
    void coordinate();
  });
  startHttpServer();
  await processInbox();
  await coordinate();
  console.log('[notice guard] 已进入事件休眠；空闲时不调用模型、不轮询项目。');
}
