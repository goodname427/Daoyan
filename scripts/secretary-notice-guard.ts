import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, watch, type FSWatcher } from 'node:fs';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLocalPlan, classifyAgentFailure, preferredWindowsExecutable } from './agent-routing';
import {
  externalRequestId,
  type SecretaryChannelHub,
  type SecretaryInboundMessage,
  type SecretaryInboundReceipt,
  type SecretaryNotice,
} from './secretary-channel';
import { secretaryChannelHubFromEnvironment } from './secretary-channels';
import {
  getProcessIdentity,
  isOwnedProcessAlive,
  waitForProcessIdentity,
} from './process-identity';
import {
  applyWaitingReply,
  createSecretaryState,
  inferMessageIntent,
  isRunEligibleForAdoption,
  itemFromIntake,
  nextRunnableItem,
  projectFactsFromItems,
  projectFactsFromStatus,
  publicSecretaryState,
  taskCompletionKey,
  unrecordedTaskCompletions,
  type IntakeRequest,
  type ProjectFact,
  type SecretaryItem,
  type SecretaryMessageIntent,
  type SecretaryScope,
  type SecretaryState,
  type SecretaryTaskCompletion,
} from './secretary-state';
import {
  advanceVersion,
  listFormalVersions,
  normalizeFormalVersion,
  publicVersionState,
  readFormalVersion,
  readFormalVersionById,
  recordApproval,
  writeFormalVersion,
  type FormalVersion,
  type VersionTodo,
} from './version-lifecycle';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentRoot = resolve(root, '.daoyan-agent');
const secretaryRoot = resolve(
  root,
  process.env.DAOYAN_SECRETARY_STATE_DIR ?? '.daoyan-agent/secretary',
);
const secretaryRelativePrefix = relative(agentRoot, secretaryRoot).replace(/\\/g, '/');
const inboxRoot = resolve(secretaryRoot, 'inbox');
const responseRoot = resolve(secretaryRoot, 'responses');
const noticeOutboxRoot = resolve(secretaryRoot, 'notice-outbox');
const stateFile = resolve(secretaryRoot, 'state.json');
const channelsFile = resolve(secretaryRoot, 'channels.json');
const lockFile = resolve(secretaryRoot, 'notice-guard.lock');
const eventsFile = resolve(secretaryRoot, 'events.jsonl');
const versionsRoot = resolve(agentRoot, 'versions');
const runsRoot = resolve(agentRoot, 'runs');
const tsxCliPath = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const agentDispatcherPath = resolve(root, 'scripts/agent-dispatcher.ts');
const versionDispatcherPath = resolve(root, 'scripts/version-dispatcher.ts');
const triageSchemaPath = resolve(root, 'agents/secretary-triage.schema.json');
const dashboardRoot = resolve(root, 'secretary-dashboard');

interface SecretaryConfig {
  version: 1;
  triage: {
    enabled: boolean;
    model: string;
    reasoning: 'low' | 'medium' | 'high';
    timeoutSeconds: number;
  };
  guard: {
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
  taskCompletions: SecretaryTaskCompletion[];
}

interface TriageResult {
  intent: SecretaryMessageIntent;
  disposition: 'completed' | 'active' | 'scheduled' | 'new' | 'waiting-producer';
  response: string;
  direction: string;
  scope: SecretaryScope;
  taskTitles: string[];
}

interface DashboardDocument {
  path: string;
  title: string;
  stages: string[];
}

interface DashboardAgent {
  id: string;
  role: string;
  type: string;
  status: 'running' | 'sleeping' | 'waiting' | 'paused';
  running: boolean;
  model: string;
  phase: string;
  objective: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  elapsedSeconds: number;
  runDirectory: string;
  retryAt: string;
  error: string;
  context: {
    direction: string;
    acceptanceCriteria: string[];
    nonGoals: string[];
    tasks: Array<{ id: string; title: string; objective: string; status: string }>;
  };
  recentOutput: string[];
}

let state = createSecretaryState(new Date().toISOString());
let config: SecretaryConfig;
let activeChild: ChildProcess | null = null;
let inboxWatcher: FSWatcher | null = null;
let runWatcher: FSWatcher | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let noticeRetryTimer: NodeJS.Timeout | null = null;
let orphanTimer: NodeJS.Timeout | null = null;
let httpServer: Server | null = null;
let processingInbox = false;
let inboxPending = false;
let coordinating = false;
let coordinatePending = false;
let stopping = false;
let stateWrites = Promise.resolve();
let noticeDeliveries = Promise.resolve();
let channelHub: SecretaryChannelHub | null = null;
const acceptedRequestIds = new Set<string>();
const recordedCorrelationIds = new Set<string>();
const processExitNotices = new Map<number, ChildProcess>();
const workerExitTimers = new Map<number, ReturnType<typeof setTimeout>>();

function workerEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('DAOYAN_DINGTALK_')) delete environment[key];
  }
  delete environment.DAOYAN_SECRETARY_TOKEN;
  delete environment.DAOYAN_SECRETARY_WEBHOOK_URL;
  return environment;
}

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
    const current = { ...value } as Partial<SecretaryState> & { reviewRequired?: boolean };
    delete current.reviewRequired;
    return {
      ...createSecretaryState(new Date().toISOString()),
      ...current,
      processIdentity: getProcessIdentity(process.pid),
      items: value.items.map((item) => ({
        ...item,
        processIdentity: item.processIdentity ?? '',
        completedTasks: Array.isArray(item.completedTasks) ? item.completedTasks : [],
      })),
      messages: Array.isArray(value.messages) ? value.messages : [],
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
    typeof guard.executionRetryMinutes !== 'number' ||
    typeof guard.orphanRecoveryMinutes !== 'number' ||
    typeof guard.maxRecoveryAttempts !== 'number'
  ) {
    throw new Error('agents/secretary.json 缺少必要配置');
  }
  return value as unknown as SecretaryConfig;
}

async function emitNotice(
  kind: string,
  message: string,
  item?: SecretaryItem,
  task?: SecretaryTaskCompletion,
  correlationId = '',
): Promise<void> {
  if (correlationId && recordedCorrelationIds.has(correlationId)) return;
  const event = {
    id: randomUUID(),
    kind,
    message,
    itemId: item?.id ?? '',
    correlationId,
    ...(task
      ? {
          taskKey: task.key,
          taskId: task.taskId,
          taskTitle: task.taskTitle,
          parentScope: task.parentScope,
          parentTitle: task.parentTitle,
          versionTitle: task.versionTitle,
          completedAt: task.completedAt,
          runDirectory: task.runDirectory,
        }
      : {}),
    createdAt: new Date().toISOString(),
  };
  const notice: SecretaryNotice = {
    id: event.id,
    kind,
    message,
    correlationId,
    itemId: item?.id ?? '',
    createdAt: event.createdAt,
    ...(task
      ? {
          taskId: task.taskId,
          taskTitle: task.taskTitle,
          parentScope: task.parentScope,
          parentTitle: task.parentTitle,
          versionTitle: task.versionTitle,
          completedAt: task.completedAt,
        }
      : {}),
  };
  const pendingChannelIds = channelHub?.configuredChannelIds() ?? [];
  const outboxPath = resolve(noticeOutboxRoot, `${notice.id}.json`);
  if (pendingChannelIds.length > 0) {
    await writeJsonAtomic(outboxPath, {
      notice,
      pendingChannelIds,
      attempts: 0,
      updatedAt: notice.createdAt,
    } satisfies NoticeOutboxEntry);
  }
  await appendFile(eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
  if (correlationId) recordedCorrelationIds.add(correlationId);
  console.log(`[常驻秘书] ${message}`);
  if (pendingChannelIds.length > 0) {
    void queueNoticeDelivery(() => deliverNotice(outboxPath)).catch((error) =>
      console.error(`[notice guard] 通知投递失败：${String(error)}`),
    );
  }
}

interface NoticeOutboxEntry {
  notice: SecretaryNotice;
  pendingChannelIds: string[];
  attempts: number;
  updatedAt: string;
}

function queueNoticeDelivery(action: () => Promise<void>): Promise<void> {
  noticeDeliveries = noticeDeliveries.catch(() => undefined).then(action);
  return noticeDeliveries;
}

function scheduleNoticeRetry(): void {
  if (noticeRetryTimer || stopping) return;
  const configuredDelay = Number(process.env.DAOYAN_SECRETARY_NOTICE_RETRY_MS ?? 60_000);
  const delay = Number.isFinite(configuredDelay) && configuredDelay > 0 ? configuredDelay : 60_000;
  noticeRetryTimer = setTimeout(() => {
    noticeRetryTimer = null;
    void processNoticeOutbox().catch((error) =>
      console.error(`[notice guard] 待发通知重试失败：${String(error)}`),
    );
  }, delay);
}

function validNoticeOutboxEntry(value: unknown): value is NoticeOutboxEntry {
  return (
    isRecord(value) &&
    isRecord(value.notice) &&
    typeof value.notice.id === 'string' &&
    typeof value.notice.message === 'string' &&
    Array.isArray(value.pendingChannelIds) &&
    value.pendingChannelIds.every((item) => typeof item === 'string') &&
    typeof value.attempts === 'number'
  );
}

async function deliverNotice(path: string): Promise<void> {
  const raw = await readJson(path);
  if (!validNoticeOutboxEntry(raw)) {
    await rm(path, { force: true });
    return;
  }
  if (!channelHub) return;
  const result = await channelHub.publish(raw.notice as SecretaryNotice, raw.pendingChannelIds);
  const attempted = new Set(result.attemptedChannelIds);
  const failed = new Set(result.failedChannelIds);
  const remaining = raw.pendingChannelIds.filter(
    (channelId) => !attempted.has(channelId) || failed.has(channelId),
  );
  if (remaining.length === 0) {
    await rm(path, { force: true });
    return;
  }
  await writeJsonAtomic(path, {
    ...raw,
    pendingChannelIds: remaining,
    attempts: raw.attempts + 1,
    updatedAt: new Date().toISOString(),
  } satisfies NoticeOutboxEntry);
  scheduleNoticeRetry();
}

async function processNoticeOutbox(): Promise<void> {
  await channelHub?.retryInactive();
  await writeChannelStatus();
  await queueNoticeDelivery(async () => {
    const names = (await readdir(noticeOutboxRoot)).filter((name) => name.endsWith('.json')).sort();
    for (const name of names) await deliverNotice(resolve(noticeOutboxRoot, name));
  });
}

async function writeChannelStatus(): Promise<void> {
  await writeJsonAtomic(channelsFile, {
    status: stopping ? 'stopped' : 'running',
    activeChannelIds: channelHub?.activeChannelIds() ?? [],
    configuredChannelIds: channelHub?.configuredChannelIds() ?? [],
    updatedAt: new Date().toISOString(),
  });
}

async function loadRecordedCorrelations(): Promise<void> {
  recordedCorrelationIds.clear();
  try {
    const content = await readFile(eventsFile, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as { correlationId?: unknown };
      if (typeof event.correlationId === 'string' && event.correlationId) {
        recordedCorrelationIds.add(event.correlationId);
      }
    }
  } catch {
    // A fresh secretary has no event history yet.
  }
}

interface ProcessInvocation {
  command: string;
  args: string[];
}

export function windowsCodexInvocation(
  candidates: string[],
  args: string[],
  nodeExecutable = process.execPath,
  pathExists: (path: string) => boolean = existsSync,
): ProcessInvocation | null {
  const selected = preferredWindowsExecutable(candidates);
  if (!selected) return null;
  if (selected.toLowerCase().endsWith('.exe')) return { command: selected, args };
  const entry = win32.resolve(
    win32.dirname(selected),
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js',
  );
  if (pathExists(entry)) return { command: nodeExecutable, args: [entry, ...args] };
  return { command: selected, args };
}

function codexInvocation(args: string[]): ProcessInvocation | null {
  const configured = process.env.CODEX_BIN?.trim();
  if (process.platform !== 'win32') return { command: configured || 'codex', args };
  const found = spawnSync('where.exe', ['codex'], { encoding: 'utf8' });
  const candidates = configured
    ? [configured]
    : found.status === 0
      ? found.stdout.split(/\r?\n/).filter(Boolean)
      : [];
  return windowsCodexInvocation(candidates, args);
}

function validateTriage(value: unknown): TriageResult | null {
  if (!isRecord(value)) return null;
  const intents = ['question', 'direction', 'reply', 'continue'];
  const dispositions = ['completed', 'active', 'scheduled', 'new', 'waiting-producer'];
  if (
    !intents.includes(String(value.intent)) ||
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
  waiting: SecretaryItem | null,
): Promise<TriageResult | null> {
  if (!config.triage.enabled || process.env.DAOYAN_SECRETARY_LOCAL_ONLY === '1') return null;
  const outputFile = resolve(secretaryRoot, `triage-${request.id}.json`);
  const factText = facts
    .map((fact) => `- [${fact.kind}] ${fact.text} (${fact.reference})`)
    .join('\n');
  const waitingText = waiting
    ? `当前正等待制作人回复：${waiting.idea}\n等待原因：${waiting.summary}`
    : '当前没有等待制作人回复的事项。';
  const recentConversation = state.messages
    .slice(-12)
    .map((message) => `- ${message.role === 'producer' ? '制作人' : '秘书'}：${message.content}`)
    .join('\n');
  const prompt = `你是道衍项目的常驻制作人秘书。你只在收到 notice guard 事件时运行，本次只理解一条自然语言消息，不修改文件、不执行代码。\n\n先结合上下文判断消息意图：question 是询问项目情况；direction 是新的产品方向；reply 是对当前等待事项的回复；continue 是要求继续现有排期。制作人不会提供类型参数，你必须自行判断。然后根据项目事实回答：已完成则说明现状；正在执行则关联当前任务；已有排期则避免重复；新方向才形成后续任务。scope 也由你内部决定：只有消息本身明确包含多个独立 Feature 的阶段目标时才选 version，否则选 feature。只有确实需要产品取舍时才 waiting-producer，不要把技术实现选择交还制作人。\n\n制作人消息：${request.idea}\n\n当前等待事项：\n${waitingText}\n\n近期对话：\n${recentConversation || '- 暂无历史对话'}\n\n项目事实：\n${factText || '- 暂无匹配事实'}\n`;
  const args = [
    'exec',
    '--ephemeral',
    '--color',
    'never',
    '--sandbox',
    'read-only',
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
  const invocation = codexInvocation(args);
  if (!invocation) return null;
  const code = await new Promise<number>((resolveCode) => {
    let child: ChildProcess;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: root,
        env: workerEnvironment(),
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolveCode(1);
      return;
    }
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(1);
    }, config.triage.timeoutSeconds * 1000);
    const finish = (result: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveCode(result);
    };
    timeout.unref();
    child.on('error', () => finish(1));
    child.on('close', (result) => finish(result ?? 1));
    child.stdin?.on('error', () => finish(1));
    child.stdin?.end(prompt);
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

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function documentTitle(path: string): string {
  const known: Record<string, string> = {
    'charter.md': '版本策划案',
    'plan.md': '执行计划',
    'qa-plan.md': '测试计划',
    'report.md': '测试与交付报告',
    'release-notes.md': '候选版本说明',
  };
  return known[basename(path)] ?? basename(path, extname(path));
}

function inferredDocumentStages(path: string): string[] {
  const name = basename(path).toLowerCase();
  if (name.includes('charter')) return ['direction', 'charter-draft', 'charter-review'];
  if (name === 'plan.md') return ['task-breakdown', 'version-planning', 'development'];
  if (name.includes('qa')) return ['qa', 'bugfix'];
  if (name.includes('report'))
    return ['qa', 'bugfix', 'candidate', 'producer-acceptance', 'archived'];
  if (name.includes('release')) return ['candidate', 'producer-acceptance', 'archived'];
  return [];
}

async function walkVersionDocuments(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await walkVersionDocuments(path)));
    else if (
      entry.isFile() &&
      ['.md', '.txt', '.json'].includes(extname(entry.name).toLowerCase())
    ) {
      paths.push(relative(root, path).replace(/\\/g, '/'));
    }
  }
  return paths;
}

async function versionDocuments(version: FormalVersion): Promise<DashboardDocument[]> {
  const stagesByPath = new Map<string, Set<string>>();
  for (const node of version.nodes) {
    if (!node.artifact) continue;
    const stages = stagesByPath.get(node.artifact) ?? new Set<string>();
    stages.add(node.id);
    stagesByPath.set(node.artifact, stages);
  }
  const docsRoot = await realpath(resolve(root, 'docs'));
  const documentRoot = await realpath(resolve(root, version.documentRoot)).catch(() => '');
  if (documentRoot === docsRoot || documentRoot.startsWith(`${docsRoot}${sep}`)) {
    for (const path of await walkVersionDocuments(documentRoot)) {
      const stages = stagesByPath.get(path) ?? new Set<string>();
      for (const stage of inferredDocumentStages(path)) stages.add(stage);
      stagesByPath.set(path, stages);
    }
  }
  return [...stagesByPath.entries()]
    .map(([path, stages]) => ({ path, title: documentTitle(path), stages: [...stages] }))
    .sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'));
}

async function dashboardVersion(version: FormalVersion): Promise<object> {
  const documents = await versionDocuments(version);
  const base = publicVersionState(version) as FormalVersion & Record<string, unknown>;
  return {
    ...base,
    documents,
    nodes: version.nodes.map((node) => ({
      ...node,
      documents: documents.filter((document) => document.stages.includes(node.id)),
    })),
  };
}

async function readLatestLogSummary(directory: string): Promise<string[]> {
  if (!directory || !existsSync(directory)) return [];
  try {
    const logs = await Promise.all(
      (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
        .map(async (entry) => {
          const path = resolve(directory, entry.name);
          return { path, changedAt: (await stat(path)).mtimeMs };
        }),
    );
    const latest = logs.sort((left, right) => right.changedAt - left.changedAt)[0];
    if (!latest) return [];
    const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
    const lines = (await readFile(latest.path, 'utf8'))
      .replace(ansiPattern, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) =>
          line &&
          (/^(?:\[[^\]]+\]|error:|fatal:|failed\b|failure\b|tokens used\b)/i.test(line) ||
            /(usage limit|try again at|账号.*阻塞|鉴权.*阻塞|额度.*(?:不足|用尽))/i.test(line)),
      );
    return lines.slice(-12);
  } catch {
    return [];
  }
}

function modelFromPhase(phase: string): string {
  return phase.match(/gpt-[a-z0-9.-]+/i)?.[0] ?? '';
}

async function dashboardAgentForItem(item: SecretaryItem): Promise<DashboardAgent> {
  const recovery = item.runDirectory
    ? await readJson(resolve(item.runDirectory, 'recovery.json'))
    : null;
  const progress = item.runDirectory
    ? await readJson(resolve(item.runDirectory, 'progress.json'))
    : null;
  const diskPlan = item.runDirectory
    ? ((await readJson(resolve(item.runDirectory, 'plan.validated.json'))) ??
      (await readJson(resolve(item.runDirectory, 'plan.json'))))
    : null;
  const plan = isRecord(recovery?.plan) ? recovery.plan : diskPlan;
  const phase = String(progress?.phase ?? recovery?.phase ?? item.summary ?? '等待调度');
  const alive = isOwnedProcessAlive(item.processPid, item.processIdentity);
  const status: DashboardAgent['status'] = alive
    ? 'running'
    : item.status === 'retry-wait'
      ? 'waiting'
      : item.status === 'waiting-producer'
        ? 'paused'
        : 'waiting';
  const taskRuns = new Map(
    recordArray(recovery?.taskRuns).map((run) => [
      String((run.task as Record<string, unknown>)?.id),
      run,
    ]),
  );
  const tasks = recordArray(plan?.tasks).map((task) => ({
    id: String(task.id ?? ''),
    title: String(task.title ?? task.id ?? '未命名任务'),
    objective: String(task.objective ?? ''),
    status: String(
      taskRuns.get(String(task.id ?? ''))?.result ??
        (alive && phase.includes(String(task.id ?? '')) ? 'running' : 'pending'),
    ),
  }));
  const recentOutput = [
    progress ? `运行阶段：${String(progress.phase ?? '')} / ${String(progress.status ?? '')}` : '',
    recovery?.error ? `阻塞：${String(recovery.error)}` : '',
    ...(await readLatestLogSummary(item.runDirectory)),
  ].filter(Boolean);
  return {
    id: item.id,
    role: item.scope === 'version' ? 'Version PM' : 'Feature PM',
    type: item.scope === 'version' ? '版本调度' : 'Feature 交付',
    status,
    running: alive,
    model: modelFromPhase(phase) || '尚未分配',
    phase,
    objective: String(recovery?.resolvedDirection ?? recovery?.direction ?? item.idea),
    pid: alive ? item.processPid : 0,
    startedAt: String(progress?.startedAt ?? item.createdAt),
    updatedAt: String(progress?.updatedAt ?? recovery?.updatedAt ?? item.updatedAt),
    elapsedSeconds: Number(progress?.elapsedSeconds ?? 0),
    runDirectory: item.runDirectory,
    retryAt: item.retryAt,
    error: String(recovery?.error ?? (item.status === 'waiting-producer' ? item.summary : '')),
    context: {
      direction: String(plan?.summary ?? item.idea),
      acceptanceCriteria: stringArray(plan?.acceptanceCriteria),
      nonGoals: stringArray(plan?.nonGoals),
      tasks,
    },
    recentOutput,
  };
}

async function activeWorkerProcess(
  item: SecretaryItem,
  fresh = false,
): Promise<{ pid: number; identity: string; model: string; role: string } | null> {
  if (!item.runDirectory) return null;
  const progress = await readJson(resolve(item.runDirectory, 'progress.json'));
  const pid = Number(progress?.workerPid ?? 0);
  const identity = String(progress?.workerProcessIdentity ?? '');
  return isOwnedProcessAlive(pid, identity, fresh ? 0 : undefined)
    ? {
        pid,
        identity,
        model: String(progress?.workerModel ?? ''),
        role: String(progress?.workerRole ?? ''),
      }
    : null;
}

async function dashboardAgents(): Promise<DashboardAgent[]> {
  const guardBusy = processingInbox || coordinating;
  const agents: DashboardAgent[] = [
    {
      id: 'notice-guard',
      role: '常驻秘书',
      type: '事件守卫',
      status: guardBusy ? 'running' : 'sleeping',
      running: guardBusy,
      model: '无模型常驻',
      phase: guardBusy ? '正在处理项目事件' : '事件休眠，等待消息或运行状态变化',
      objective: '维护项目总状态、对话、通知和调度。',
      pid: state.pid,
      startedAt: state.initializedAt,
      updatedAt: state.lastEventAt,
      elapsedSeconds: 0,
      runDirectory: secretaryRoot,
      retryAt: '',
      error: '',
      context: { direction: '常驻项目协调', acceptanceCriteria: [], nonGoals: [], tasks: [] },
      recentOutput: [],
    },
  ];
  const visibleItems = state.items.filter((item) =>
    ['active', 'tracking', 'retry-wait', 'waiting-producer'].includes(item.status),
  );
  for (const item of visibleItems) {
    const pm = await dashboardAgentForItem(item);
    const worker = await activeWorkerProcess(item);
    if (worker) {
      const activeModel = worker.model || modelFromPhase(pm.phase) || '未记录模型';
      const activeRole =
        worker.role ||
        (/review|审查/i.test(pm.phase)
          ? '审查 Agent'
          : /plan|规划/i.test(pm.phase)
            ? '规划 Agent'
            : '执行 Agent');
      pm.model = '内部调度';
      agents.push(pm, {
        ...pm,
        id: `${pm.id}:worker`,
        role: activeRole,
        type: activeRole === '审查 Agent' ? '独立复审' : '模型执行',
        status: 'running',
        running: true,
        model: activeModel,
        objective:
          pm.context.tasks.find((task) => task.status === 'running')?.objective || pm.objective,
        pid: worker.pid,
      });
    } else {
      agents.push(pm);
    }
  }
  return agents;
}

function versionCatalogEntry(version: FormalVersion, currentId: string): object {
  return {
    id: version.id,
    title: version.title,
    status: version.status,
    currentStage: version.currentStage,
    updatedAt: version.updatedAt,
    completedAt: version.completedAt,
    isCurrent: version.id === currentId,
  };
}

function dashboardTodos(version: FormalVersion | null, isCurrent: boolean): object[] {
  const versionTodos = isCurrent
    ? (version?.todos ?? [])
        .filter((todo) => todo.assignee === 'producer' && todo.status === 'open')
        .map((todo) => ({
          source: 'version',
          id: todo.id,
          title: todo.title,
          detail: todo.detail,
          retryAt: '',
          recommendedAction: 'approve',
          recommendedLabel: '按建议通过',
          solutions: [
            { id: 'approve', label: '通过并继续' },
            { id: 'request-changes', label: '退回修正' },
          ],
        }))
    : [];
  const secretaryTodos = isCurrent
    ? state.items
        .filter((item) => item.status === 'waiting-producer')
        .map((item) => {
          const recoverable = externalBlocker(item.summary);
          return {
            source: 'secretary',
            id: item.id,
            title: item.idea,
            detail: item.summary,
            retryAt: item.retryAt,
            recommendedAction: recoverable ? 'auto-retry' : 'defer',
            recommendedLabel: recoverable ? '恢复后自动重试' : '先放入后续排期',
            solutions: recoverable
              ? [
                  { id: 'auto-retry', label: '恢复后自动重试' },
                  { id: 'retry-now', label: '立即重试' },
                  { id: 'defer', label: '移到后续排期' },
                ]
              : [
                  { id: 'continue-with-guidance', label: '按补充决定继续' },
                  { id: 'defer', label: '移到后续排期' },
                ],
          };
        })
    : [];
  return [...versionTodos, ...secretaryTodos];
}

function retryTimeFromOutput(lines: string[]): string {
  const hint = lines.join('\n').match(/try again at\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!hint)
    return new Date(Date.now() + config.guard.executionRetryMinutes * 60_000).toISOString();
  let hour = Number(hint[1]) % 12;
  if (hint[3].toUpperCase() === 'PM') hour += 12;
  const candidate = new Date();
  candidate.setHours(hour, Number(hint[2]) + 5, 0, 0);
  if (candidate.getTime() <= Date.now()) candidate.setDate(candidate.getDate() + 1);
  return candidate.toISOString();
}

function recordDashboardDecision(producerText: string, secretaryText: string): void {
  const id = `dashboard-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  state.messages.push(
    { id, role: 'producer', content: producerText, intent: 'reply', createdAt },
    {
      id: `${id}-response`,
      role: 'secretary',
      content: secretaryText,
      intent: 'reply',
      createdAt: new Date().toISOString(),
    },
  );
  if (state.messages.length > 200) state.messages.splice(0, state.messages.length - 200);
}

async function applySecretaryTodoAction(
  itemId: string,
  action: string,
  note: string,
): Promise<{ message: string }> {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item || item.status !== 'waiting-producer') throw new Error('待办已经处理或不存在');
  const recoverable = externalBlocker(item.summary);
  if (action === 'defer') {
    item.status = 'backlog';
    item.retryAt = '';
    item.summary = '已按制作人选择移到后续版本候选池。';
  } else if (action === 'continue-with-guidance') {
    if (!note.trim()) throw new Error('该待办需要先填写制作人决定');
    item.producerGuidance = note.trim();
    item.status = 'retry-wait';
    item.retryAt = new Date().toISOString();
    item.summary = '已记录制作人决定，将从原恢复点继续。';
  } else if (action === 'retry-now') {
    if (!recoverable) throw new Error('产品决策待办需要填写决定后继续');
    item.status = 'retry-wait';
    item.retryAt = new Date().toISOString();
    item.summary = '已确认立即从原恢复点重试。';
  } else if (action === 'auto-retry' || action === 'default') {
    if (!recoverable) throw new Error('产品决策待办不能自动重试');
    item.status = 'retry-wait';
    item.retryAt = retryTimeFromOutput(await readLatestLogSummary(item.runDirectory));
    item.summary = `已采用默认方案，将在 ${new Date(item.retryAt).toLocaleString('zh-CN', { hour12: false })} 自动重试。`;
  } else throw new Error('不支持的秘书待办方案');
  item.updatedAt = new Date().toISOString();
  state.activeItemId = '';
  recordDashboardDecision(`处理待办：${item.idea}`, item.summary);
  await saveState();
  await emitNotice('todo-resolved', item.summary, item);
  scheduleRetry();
  if (action === 'retry-now') void coordinate();
  return { message: item.summary };
}

async function applyVersionTodoAction(
  itemId: string,
  action: string,
  note: string,
): Promise<{ message: string }> {
  if (!['approve', 'request-changes'].includes(action)) throw new Error('不支持的版本待办方案');
  const version = await readFormalVersion(root);
  if (!version) throw new Error('当前没有正式版本');
  const todo = version.todos.find(
    (candidate) =>
      candidate.id === itemId && candidate.assignee === 'producer' && candidate.status === 'open',
  );
  if (!todo || todo.stage !== version.currentStage) throw new Error('版本待办已经处理或不存在');
  const decision = action === 'request-changes' ? 'changes-requested' : 'approved';
  recordApproval(version, {
    stage: version.currentStage,
    reviewer: 'producer',
    decision,
    documentRevision: version.charterRevision,
    comment: note || (decision === 'approved' ? '通过看板推荐方案。' : '请按制作人反馈修正。'),
  });
  if (decision === 'approved') {
    const currentIndex = version.nodes.findIndex((node) => node.id === version.currentStage);
    const next = version.nodes[currentIndex + 1];
    if (next) advanceVersion(version, next.id);
    if (version.currentStage === 'archived') {
      const archived = version.nodes.find((node) => node.id === 'archived');
      if (archived) archived.summary = '版本档案已保存，正式版本流程完成。';
    }
  }
  await writeFormalVersion(root, version);
  const message =
    version.status === 'archived'
      ? `版本“${version.title}”已完成归档。`
      : decision === 'approved'
        ? `已通过，版本进入“${version.nodes.find((node) => node.id === version.currentStage)?.title}”。`
        : `已退回“${version.nodes.find((node) => node.id === version.currentStage)?.title}”修正。`;
  recordDashboardDecision(`处理版本待办：${todo.title}`, message);
  await saveState();
  await emitNotice('version-todo-resolved', message);
  return { message };
}

async function applyTodoAction(value: unknown): Promise<{ message: string }> {
  if (
    !isRecord(value) ||
    typeof value.source !== 'string' ||
    typeof value.id !== 'string' ||
    typeof value.action !== 'string'
  ) {
    throw new Error('待办操作格式无效');
  }
  if (!['version', 'secretary'].includes(value.source)) throw new Error('待办来源无效');
  return value.source === 'version'
    ? await applyVersionTodoAction(value.id, value.action, String(value.note ?? ''))
    : await applySecretaryTodoAction(value.id, value.action, String(value.note ?? ''));
}

export function featureTaskCompletions(
  directory: string,
  parentTitle: string,
  versionTitle: string,
  recovery: Record<string, unknown> | null,
  report: Record<string, unknown> | null,
): SecretaryTaskCompletion[] {
  const source = recordArray(recovery?.taskRuns).length
    ? recordArray(recovery?.taskRuns)
    : recordArray(report?.tasks);
  const fallbackCompletedAt = String(report?.finishedAt ?? recovery?.updatedAt ?? '');
  return source.flatMap((entry) => {
    if (entry.result !== 'passed' || !isRecord(entry.task)) return [];
    const taskId = String(entry.task.id ?? '');
    const taskTitle = String(entry.task.title ?? taskId);
    if (!taskId || !taskTitle) return [];
    return [
      {
        key: taskCompletionKey(directory, taskId),
        taskId,
        taskTitle,
        parentScope: 'feature' as const,
        parentTitle,
        versionTitle,
        completedAt: String(entry.completedAt ?? fallbackCompletedAt),
        runDirectory: directory,
      },
    ];
  });
}

export async function versionTaskCompletions(
  directory: string,
  objective: string,
  manifest: Record<string, unknown>,
): Promise<SecretaryTaskCompletion[]> {
  const completions: SecretaryTaskCompletion[] = [];
  for (const feature of recordArray(manifest.features)) {
    const featureId = String(feature.id ?? '');
    const featureTitle = String(feature.direction ?? featureId);
    const childDirectory = String(feature.runDirectory ?? '');
    if (childDirectory) {
      const recovery = await readJson(resolve(childDirectory, 'recovery.json'));
      const report = await readJson(resolve(childDirectory, 'report.json'));
      completions.push(
        ...featureTaskCompletions(childDirectory, featureTitle, objective, recovery, report),
      );
    }
    if (feature.status !== 'delivered' || !featureId || !featureTitle) continue;
    completions.push({
      key: taskCompletionKey(directory, `feature:${featureId}`),
      taskId: featureId,
      taskTitle: featureTitle,
      parentScope: 'version',
      parentTitle: objective,
      versionTitle: objective,
      completedAt: String(feature.completedAt ?? manifest.updatedAt ?? ''),
      runDirectory: childDirectory || directory,
    });
  }
  return completions;
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
      const objective = String(manifest.objective ?? entry.name);
      snapshots.push({
        scope: 'version',
        directory,
        objective,
        status,
        processPid: Number.isInteger(manifest.processPid) ? Number(manifest.processPid) : 0,
        processIdentity: String(manifest.processIdentity ?? ''),
        error: String(manifest.error ?? ''),
        updatedAt: String(manifest.updatedAt ?? ''),
        taskCompletions: await versionTaskCompletions(directory, objective, manifest),
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
      const objective = String(plan?.summary ?? entry.name);
      const parentTitle = String(plan?.title ?? objective);
      snapshots.push({
        scope: 'feature',
        directory,
        objective,
        status,
        processPid: Number.isInteger(recovery?.processPid) ? Number(recovery?.processPid) : 0,
        processIdentity: String(recovery?.processIdentity ?? ''),
        error: String(recovery?.error ?? report?.extra ?? ''),
        updatedAt: String(recovery?.updatedAt ?? ''),
        taskCompletions: featureTaskCompletions(directory, parentTitle, '', recovery, report),
      });
    }
  }
  return snapshots;
}

async function snapshotForItem(item: SecretaryItem): Promise<RunSnapshot | null> {
  if (!item.runDirectory) return null;
  if (item.scope === 'version') {
    const manifest = await readJson(resolve(item.runDirectory, 'version.json'));
    if (!manifest || typeof manifest.status !== 'string') return null;
    const objective = String(manifest.objective ?? item.idea);
    return {
      scope: 'version',
      directory: item.runDirectory,
      objective,
      status: String(manifest.status),
      processPid: Number(manifest.processPid ?? 0),
      processIdentity: String(manifest.processIdentity ?? ''),
      error: String(manifest.error ?? ''),
      updatedAt: String(manifest.updatedAt ?? ''),
      taskCompletions: await versionTaskCompletions(item.runDirectory, objective, manifest),
    };
  }
  const recovery = await readJson(resolve(item.runDirectory, 'recovery.json'));
  const report = await readJson(resolve(item.runDirectory, 'report.json'));
  if ((!recovery || typeof recovery.status !== 'string') && !report) return null;
  const plan = await readJson(resolve(item.runDirectory, 'plan.validated.json'));
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
  const objective = String(plan?.summary ?? item.idea);
  return {
    scope: 'feature',
    directory: item.runDirectory,
    objective,
    status,
    processPid: Number(recovery?.processPid ?? 0),
    processIdentity: String(recovery?.processIdentity ?? ''),
    error: String(recovery?.error ?? report?.extra ?? ''),
    updatedAt: String(recovery?.updatedAt ?? ''),
    taskCompletions: featureTaskCompletions(
      item.runDirectory,
      String(plan?.title ?? objective),
      '',
      recovery,
      report,
    ),
  };
}

async function projectFacts(): Promise<{ facts: ProjectFact[]; runs: RunSnapshot[] }> {
  const markdown = await readFile(resolve(root, 'docs/status.md'), 'utf8');
  const runs = await scanRuns();
  const managedDirectories = new Set(state.items.map((item) => item.runDirectory).filter(Boolean));
  const activeFacts = runs
    .filter(
      (run) =>
        ['planned', 'running', 'recoverable', 'waiting-producer', 'active'].includes(run.status) &&
        (managedDirectories.has(run.directory) ||
          isRunEligibleForAdoption(
            run.updatedAt,
            state.initializedAt,
            isOwnedProcessAlive(run.processPid, run.processIdentity),
          )),
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
  if (result.intent === 'question' || result.intent === 'continue' || result.intent === 'reply') {
    item.status = 'answered';
    item.plannedTasks = [];
    item.completedAt = new Date().toISOString();
  } else if (result.disposition === 'completed') {
    item.status = 'answered';
    item.completedAt = new Date().toISOString();
  } else if (result.disposition === 'active') {
    item.status = 'answered';
    item.completedAt = new Date().toISOString();
  } else if (result.disposition === 'waiting-producer') item.status = 'waiting-producer';
  else item.status = 'queued';
  return result.response;
}

function localQuestionResponse(message: string, facts: ProjectFact[]): string {
  if (!/(进度|状态|做到|当前|现在|排期)/.test(message))
    return '当前项目记录里没有足够信息直接回答这个问题；秘书不会把它误排成开发任务。';
  const summarize = (fact: ProjectFact): string => {
    const text = fact.text.replace(/[。；，,.]+$/g, '');
    return text.length > 72 ? `${text.slice(0, 72)}...` : text;
  };
  const active = facts.filter((fact) => fact.kind === 'active').slice(0, 2);
  const scheduled = facts.filter((fact) => fact.kind === 'scheduled').slice(0, 2);
  const parts = [
    active.length > 0
      ? `正在推进：${active.map(summarize).join('；')}`
      : '当前没有登记中的运行任务',
    scheduled.length > 0
      ? `后续排期：${scheduled.map(summarize).join('；')}`
      : '项目状态中没有未承接的后续排期',
  ];
  return `根据当前项目记录，${parts.join('。')}。`;
}

async function localVersionQuestionResponse(message: string): Promise<string | null> {
  if (!/(正式版本|版本).*(阶段|环节|进度|状态)|(?:阶段|环节).*(版本)/.test(message)) {
    return null;
  }
  const version = await readFormalVersion(root);
  if (!version) return '当前尚未建立正式版本；秘书正在等待制作人给出下一版本方向。';
  const node = version.nodes.find((candidate) => candidate.id === version.currentStage);
  const openTodos = version.todos.filter(
    (todo) => todo.assignee === 'producer' && todo.status === 'open',
  ).length;
  const progress = (publicVersionState(version) as { progress: number }).progress;
  return `当前正式版本是“${version.title}”，位于“${node?.title ?? version.currentStage}”，总体进度 ${progress}%。${openTodos > 0 ? `你有 ${openTodos} 项待办。` : '目前没有需要你处理的事项。'}`;
}

async function writeInboxResponse(
  request: IntakeRequest,
  response: string,
  status: SecretaryItem['status'],
  intent: SecretaryMessageIntent,
  plannedTasks: string[] = [],
): Promise<void> {
  if (!state.messages.some((message) => message.id === request.id)) {
    state.messages.push({
      id: request.id,
      role: 'producer',
      content: request.idea,
      intent,
      createdAt: request.createdAt,
    });
  }
  if (!state.messages.some((message) => message.id === `${request.id}-response`)) {
    state.messages.push({
      id: `${request.id}-response`,
      role: 'secretary',
      content: response,
      intent,
      createdAt: new Date().toISOString(),
    });
  }
  if (state.messages.length > 200) state.messages.splice(0, state.messages.length - 200);
  await saveState();
  await writeJsonAtomic(resolve(responseRoot, `${request.id}.json`), {
    id: request.id,
    response,
    status,
    plannedTasks,
  });
}

async function resumeWaitingItem(
  request: IntakeRequest,
  intent: 'reply' | 'continue',
): Promise<void> {
  const waiting = applyWaitingReply(state, request, intent);
  if (!waiting) throw new Error('等待事项已变化，无法应用当前回复');
  await saveState();
  await writeInboxResponse(request, waiting.summary, waiting.status, intent, waiting.plannedTasks);
  await emitNotice('reply-accepted', waiting.summary, waiting, undefined, request.id);
}

export function versionProducerDecision(message: string): 'approved' | 'changes-requested' | null {
  const normalized = message.replace(/\s/g, '');
  if (/(不通过|不能通过|先别|不要继续|需要修改|需要调整|有问题|不行)/.test(normalized)) {
    return 'changes-requested';
  }
  if (/(通过|批准|确认|没问题|可以继续|可以推进|验收完成|同意|就这样)/.test(normalized)) {
    return 'approved';
  }
  return null;
}

export function versionMessageIsNewDirection(message: string): boolean {
  const normalized = message.replace(/\s/g, '');
  return /(新方向|新需求|新增.{0,12}(系统|功能|玩法|模块)|(?:另外|后续|以后).{0,12}(系统|功能|玩法|方向)|我希望.{0,12}(新增|增加|加入|开发|实现))/.test(
    normalized,
  );
}

async function currentProducerGate(): Promise<{
  version: FormalVersion;
  todo: VersionTodo;
} | null> {
  const version = await readFormalVersion(root);
  if (!version || version.status !== 'waiting-producer') return null;
  const todo = version.todos.find(
    (candidate) =>
      candidate.assignee === 'producer' &&
      candidate.status === 'open' &&
      candidate.stage === version.currentStage,
  );
  return todo ? { version, todo } : null;
}

async function handleVersionProducerReply(
  request: IntakeRequest,
  intent: SecretaryMessageIntent,
): Promise<boolean> {
  if (intent === 'question') return false;
  const gate = await currentProducerGate();
  if (!gate) return false;
  const decision = versionProducerDecision(request.idea);
  if (!decision && versionMessageIsNewDirection(request.idea)) return false;
  if (!decision) {
    const response =
      '已记录你的补充，当前评审保持等待。明确回复“通过”，或指出需要修改的内容后，秘书再推进版本。';
    await writeInboxResponse(request, response, 'answered', 'reply');
    await emitNotice('version-comment-recorded', response, undefined, undefined, request.id);
    return true;
  }
  const approved = decision === 'approved';
  recordApproval(gate.version, {
    stage: gate.version.currentStage,
    reviewer: 'producer',
    decision,
    documentRevision: gate.version.charterRevision,
    comment: request.idea,
    sourceRequestId: request.id,
  });
  if (approved) {
    const currentIndex = gate.version.nodes.findIndex(
      (node) => node.id === gate.version.currentStage,
    );
    const next = gate.version.nodes[currentIndex + 1];
    if (next) advanceVersion(gate.version, next.id);
    if (gate.version.currentStage === 'archived') {
      const archived = gate.version.nodes.find((node) => node.id === 'archived');
      if (archived) archived.summary = '版本档案已保存，正式版本流程完成。';
    }
  }
  await writeFormalVersion(root, gate.version);
  const stageTitle =
    gate.version.nodes.find((node) => node.id === gate.version.currentStage)?.title ??
    gate.version.currentStage;
  const response =
    gate.version.status === 'archived'
      ? `版本“${gate.version.title}”已完成归档。`
      : approved
        ? `已记录版本评审通过，当前进入“${stageTitle}”。`
        : `已记录你的反馈，版本已退回“${stageTitle}”调整。`;
  await writeInboxResponse(request, response, 'answered', 'reply');
  await emitNotice(
    approved ? 'version-approved' : 'version-changes-requested',
    response,
    undefined,
    undefined,
    request.id,
  );
  return true;
}

async function recoverProcessedRequest(
  request: IntakeRequest,
  inboxPath: string,
): Promise<boolean> {
  const producerMessage = state.messages.find((message) => message.id === request.id);
  const replyMessage = state.messages.find((message) => message.id === `${request.id}-response`);
  const item = state.items.find(
    (candidate) => candidate.id === request.id || candidate.lastProducerRequestId === request.id,
  );
  const version = await readFormalVersion(root);
  const approval = version?.approvals.find((candidate) => candidate.sourceRequestId === request.id);
  if (!producerMessage && !replyMessage && !item && !approval) return false;

  const stageTitle = version?.nodes.find((node) => node.id === version.currentStage)?.title;
  const approvalResponse = approval
    ? version?.status === 'archived'
      ? `版本“${version.title}”已完成归档。`
      : approval.decision === 'approved'
        ? `已记录版本评审通过，当前进入“${stageTitle ?? version?.currentStage}”。`
        : `已记录你的反馈，版本已退回“${stageTitle ?? version?.currentStage}”调整。`
    : '';
  const response = replyMessage?.content || item?.summary || approvalResponse || '已处理。';
  const intent = replyMessage?.intent ?? producerMessage?.intent ?? 'reply';
  await writeInboxResponse(
    request,
    response,
    item?.status ?? 'answered',
    intent,
    item?.plannedTasks ?? [],
  );
  await emitNotice('recovered-response', response, item, undefined, request.id);
  await rm(inboxPath, { force: true });
  return true;
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
          typeof raw.createdAt !== 'string'
        ) {
          await rm(path, { force: true });
          continue;
        }
        const request = raw as unknown as IntakeRequest;
        if (await recoverProcessedRequest(request, path)) continue;
        const waiting =
          state.items.find(
            (item) => item.id === state.activeItemId && item.status === 'waiting-producer',
          ) ?? null;
        const known = await projectFacts();
        const fallbackIntent = inferMessageIntent(request.idea, Boolean(waiting));
        const local = itemFromIntake(request, known.facts);
        const versionAnswer =
          fallbackIntent === 'question' ? await localVersionQuestionResponse(request.idea) : null;
        if (versionAnswer) {
          local.item.status = 'answered';
          local.item.plannedTasks = [];
          local.item.completedAt = request.createdAt;
          local.item.summary = versionAnswer;
          state.items.push(local.item);
          await writeInboxResponse(request, versionAnswer, local.item.status, fallbackIntent);
          await emitNotice('question-answered', versionAnswer, local.item, undefined, request.id);
          await rm(path, { force: true });
          continue;
        }
        if (await handleVersionProducerReply(request, fallbackIntent)) {
          await rm(path, { force: true });
          continue;
        }
        const needsSemanticTriage = !local.item.matchedFact || Boolean(waiting);
        let model: TriageResult | null = null;
        if (needsSemanticTriage) {
          try {
            model = await modelTriage(request, known.facts, waiting);
          } catch (error) {
            console.error(`[notice guard] 语义判断失败，使用本地规则：${String(error)}`);
          }
        }
        const intent = model?.intent ?? fallbackIntent;
        if (waiting && (intent === 'reply' || intent === 'continue')) {
          await resumeWaitingItem(request, intent);
          await rm(path, { force: true });
          continue;
        }
        if (intent === 'continue') {
          const response = '收到，我会继续推进当前正式版本已经批准的排期。';
          await saveState();
          await writeInboxResponse(request, response, 'answered', intent);
          await emitNotice('continue-accepted', response, undefined, undefined, request.id);
          await rm(path, { force: true });
          continue;
        }
        if (model) local.item.scope = model.scope;
        let response = model ? applyModelTriage(local.item, model) : local.response;
        if (!model && intent === 'question') {
          local.item.status = 'answered';
          local.item.plannedTasks = [];
          local.item.completedAt = request.createdAt;
          if (!local.item.matchedFact) response = localQuestionResponse(request.idea, known.facts);
          local.item.summary = response;
        }
        if (local.item.matchedFact?.reference.startsWith('secretary:')) {
          local.item.status = 'answered';
          local.item.completedAt = request.createdAt;
          response = `该方向已经在秘书队列中，不会重复派发：${local.item.idea}`;
          local.item.summary = response;
        }
        if (local.item.status === 'queued') {
          local.item.status = 'backlog';
          response = `已加入后续版本候选池，不会绕过正式立项直接开发：${local.item.idea}`;
          local.item.summary = response;
        }
        state.items.push(local.item);
        if (local.item.status === 'waiting-producer') state.activeItemId = local.item.id;
        await saveState();
        await writeInboxResponse(
          request,
          response,
          local.item.status,
          intent,
          local.item.status === 'backlog' || local.item.status === 'waiting-producer'
            ? local.item.plannedTasks
            : [],
        );
        await emitNotice('intake', response, local.item, undefined, request.id);
        await rm(path, { force: true });
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
    .filter(
      (run) =>
        unfinished(run) &&
        !knownDirectories.has(run.directory) &&
        isRunEligibleForAdoption(
          run.updatedAt,
          state.initializedAt,
          isOwnedProcessAlive(run.processPid, run.processIdentity),
        ),
    )
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
    completedTasks: [],
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
    { env: workerEnvironment(), stdio: 'ignore', windowsHide: true },
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

function attachWorkerExitNotice(
  item: SecretaryItem,
  worker: { pid: number; identity: string },
): void {
  if (processExitNotices.has(worker.pid) || workerExitTimers.has(worker.pid)) return;
  const resume = () => {
    if (stopping) return;
    void reconcileItem(item, undefined, true)
      .then(() => saveState())
      .then(() => coordinate())
      .catch((error) => console.error(`[notice guard] worker 退出处理失败：${String(error)}`));
  };
  if (process.platform === 'win32') {
    const waiter = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Wait-Process -Id ${worker.pid} -ErrorAction SilentlyContinue`,
      ],
      { env: workerEnvironment(), stdio: 'ignore', windowsHide: true },
    );
    processExitNotices.set(worker.pid, waiter);
    waiter.on('close', () => {
      processExitNotices.delete(worker.pid);
      resume();
    });
    return;
  }
  const poll = () => {
    if (stopping || !isOwnedProcessAlive(worker.pid, worker.identity, 0)) {
      workerExitTimers.delete(worker.pid);
      if (!stopping) resume();
      return;
    }
    workerExitTimers.set(worker.pid, setTimeout(poll, 1_000));
  };
  workerExitTimers.set(worker.pid, setTimeout(poll, 1_000));
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
    run =
      (await scanRuns()).find((candidate) => candidate.directory === item.runDirectory) ??
      (await snapshotForItem(item)) ??
      undefined;
  }
  if (!run) return false;
  item.updatedAt = new Date().toISOString();
  const completed = unrecordedTaskCompletions(item.completedTasks, run.taskCompletions);
  if (completed.length > 0) {
    item.completedTasks.push(...completed);
    await saveState();
    for (const task of completed) {
      const parent = task.parentScope === 'version' ? '版本' : 'Feature';
      await emitNotice(
        'task-complete',
        `任务完成：${task.taskTitle}（${parent}：${task.parentTitle}）。`,
        item,
        task,
      );
    }
  }
  if (run.status === 'review-ready' || run.status === 'delivered') {
    const firstDelivery = item.status !== 'delivered';
    item.status = 'delivered';
    item.completedAt = item.updatedAt;
    item.processPid = 0;
    item.processIdentity = '';
    state.activeItemId = '';
    const queued = state.items.some((candidate) => candidate.status === 'queued');
    if (orphanTimer) clearTimeout(orphanTimer);
    orphanTimer = null;
    if (firstDelivery)
      await emitNotice(
        'delivery-complete',
        `${item.scope === 'version' ? '版本' : 'Feature'} 已完成，可以 Review：${item.idea}。${queued ? '队列中的下一项将自动开始。' : '秘书会从项目状态承接下一项；没有待办时进入休眠。'}`,
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
    if (externalBlocker(run.error)) {
      const firstBlock = item.status !== 'waiting-producer';
      item.status = 'waiting-producer';
      item.retryAt = '';
      item.summary = `${run.error || '账号、鉴权或额度暂不可用'}。秘书已暂停当前工作；条件恢复后直接回复秘书即可继续。`;
      state.activeItemId = item.id;
      if (firstBlock) await emitNotice('external-blocker', item.summary, item);
      return true;
    }
    if (item.recoveryAttempts >= config.guard.maxRecoveryAttempts) {
      item.status = 'waiting-producer';
      item.summary = `自动恢复已达到 ${config.guard.maxRecoveryAttempts} 次：${run.error}`;
      await emitNotice('recovery-exhausted', item.summary, item);
      return true;
    }
    const minutes = config.guard.executionRetryMinutes;
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
    const worker = await activeWorkerProcess(item, true);
    if (worker) {
      if (orphanTimer) clearTimeout(orphanTimer);
      orphanTimer = null;
      item.status = 'tracking';
      item.summary =
        'PM 已退出，但其子 Agent 仍在运行；秘书会等待该进程结束后再恢复，避免重复编辑。';
      item.retryAt = '';
      item.processPid = 0;
      item.processIdentity = '';
      state.activeItemId = item.id;
      attachWorkerExitNotice(item, worker);
      return true;
    }
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
  const worker = await activeWorkerProcess(item);
  if (worker) {
    if (orphanTimer) clearTimeout(orphanTimer);
    orphanTimer = null;
    attachWorkerExitNotice(item, worker);
  } else if (!isOwnedProcessAlive(item.processPid, item.processIdentity)) {
    scheduleOrphanRecovery(item);
  }
  return true;
}

export function runArgs(
  item: SecretaryItem,
  hasRecovery = Boolean(
    item.runDirectory && existsSync(resolve(item.runDirectory, 'recovery.json')),
  ),
): string[] {
  if (item.runDirectory) {
    if (item.scope === 'feature' && !hasRecovery) {
      return [
        tsxCliPath,
        agentDispatcherPath,
        '--run-id',
        basename(item.runDirectory),
        ...(item.producerGuidance ? ['--decision-confirmed'] : []),
        ...(item.producerGuidance ? ['--producer-guidance', item.producerGuidance] : []),
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
          ...(item.producerGuidance ? ['--producer-guidance', item.producerGuidance] : []),
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
  if (orphanTimer) clearTimeout(orphanTimer);
  orphanTimer = null;
  item.status = 'active';
  item.retryAt = '';
  item.updatedAt = new Date().toISOString();
  if (item.runDirectory) item.recoveryAttempts += 1;
  state.activeItemId = item.id;
  const log = openSync(resolve(secretaryRoot, `${item.id}.log`), 'a');
  const child = spawn(process.execPath, runArgs(item), {
    cwd: root,
    env: workerEnvironment(),
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
  if (stopping) return;
  const active = state.items.find((item) => item.id === state.activeItemId);
  if (active) {
    if (!active.runDirectory && active.scope === 'version') await locateVersionRun(active);
    const processEnded =
      active.processPid > 0 &&
      Boolean(active.processIdentity) &&
      !isOwnedProcessAlive(active.processPid, active.processIdentity);
    await reconcileItem(active, undefined, processEnded);
    await saveState();
    if (activeChild) {
      return;
    }
    if (state.activeItemId) {
      if (isOwnedProcessAlive(active.processPid, active.processIdentity)) {
        attachProcessExitNotice(active);
      }
      return;
    }
  }
  if (process.env.DAOYAN_SECRETARY_NO_DISPATCH === '1') return;
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

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function dashboardPayload(selectedVersionId = ''): Promise<object> {
  const current = await readFormalVersion(root);
  const versions = await listFormalVersions(root);
  const version = selectedVersionId
    ? await readFormalVersionById(root, selectedVersionId)
    : current;
  const isCurrent = Boolean(version && current && version.id === current.id);
  return {
    generatedAt: new Date().toISOString(),
    secretary: publicSecretaryState(state),
    versions: versions.map((candidate) => versionCatalogEntry(candidate, current?.id ?? '')),
    version: version ? await dashboardVersion(version) : null,
    isCurrentVersion: isCurrent,
    agents: await dashboardAgents(),
    todos: dashboardTodos(version, isCurrent),
  };
}

async function serveDashboardAsset(pathname: string, response: ServerResponse): Promise<boolean> {
  const assets: Record<string, { file: string; type: string }> = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/dashboard.css': { file: 'dashboard.css', type: 'text/css; charset=utf-8' },
    '/dashboard.js': { file: 'dashboard.js', type: 'text/javascript; charset=utf-8' },
    '/manifest.webmanifest': {
      file: 'manifest.webmanifest',
      type: 'application/manifest+json; charset=utf-8',
    },
    '/app-icon.png': { file: 'app-icon.png', type: 'image/png' },
  };
  const asset = assets[pathname];
  if (!asset) return false;
  try {
    const content = await readFile(resolve(dashboardRoot, asset.file));
    response.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
    response.end(content);
  } catch {
    response.writeHead(503).end('dashboard unavailable');
  }
  return true;
}

async function serveArtifact(
  versionId: string,
  requestedPath: string,
  response: ServerResponse,
): Promise<void> {
  const version = versionId
    ? await readFormalVersionById(root, versionId)
    : await readFormalVersion(root);
  if (!version) {
    sendJson(response, 404, { error: '正式版本不存在' });
    return;
  }
  const allowed = new Set((await versionDocuments(version)).map((document) => document.path));
  if (!allowed.has(requestedPath)) {
    sendJson(response, 403, { error: '该文档未关联到所选正式版本' });
    return;
  }
  const docsRoot = resolve(root, 'docs');
  const absolute = resolve(root, requestedPath);
  const child = relative(docsRoot, absolute);
  if (!requestedPath || child.startsWith('..') || isAbsolute(child)) {
    sendJson(response, 403, { error: '只能查看正式版本关联的仓库文档' });
    return;
  }
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(docsRoot), realpath(absolute)]);
    const realChild = relative(realRoot, realTarget);
    if (realChild.startsWith('..') || isAbsolute(realChild)) {
      sendJson(response, 403, { error: '版本文档链接不能指向档案目录之外' });
      return;
    }
    const content = await readFile(realTarget, 'utf8');
    sendJson(response, 200, { path: requestedPath, content });
  } catch {
    sendJson(response, 404, { error: '节点文档不存在' });
  }
}

interface EnqueueResult {
  id: string;
  accepted: boolean;
}

function requestAlreadyKnown(id: string): boolean {
  return (
    acceptedRequestIds.has(id) ||
    existsSync(resolve(inboxRoot, `${id}.json`)) ||
    existsSync(resolve(responseRoot, `${id}.json`)) ||
    state.items.some((item) => item.id === id) ||
    state.messages.some((message) => message.id === id)
  );
}

async function enqueueIdea(idea: string, requestId: string = randomUUID()): Promise<EnqueueResult> {
  if (requestAlreadyKnown(requestId)) return { id: requestId, accepted: false };
  const request: IntakeRequest = {
    id: requestId,
    idea,
    createdAt: new Date().toISOString(),
  };
  acceptedRequestIds.add(request.id);
  try {
    await writeJsonAtomic(resolve(inboxRoot, `${request.id}.json`), request);
    return { id: request.id, accepted: true };
  } catch (error) {
    acceptedRequestIds.delete(request.id);
    throw error;
  }
}

async function acceptChannelMessage(
  message: SecretaryInboundMessage,
): Promise<SecretaryInboundReceipt> {
  const result = await enqueueIdea(
    message.text,
    externalRequestId(message.source, message.messageId),
  );
  return { requestId: result.id, accepted: result.accepted };
}

function startHttpServer(): void {
  const port = Number(process.env.DAOYAN_SECRETARY_HTTP_PORT ?? 4317);
  if (!Number.isInteger(port) || port <= 0) return;
  const token = process.env.DAOYAN_SECRETARY_TOKEN ?? '';
  const host = process.env.DAOYAN_SECRETARY_HTTP_HOST ?? '127.0.0.1';
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (!token && !loopbackHosts.has(host.toLowerCase())) {
    throw new Error('秘书 HTTP 监听非本机地址时必须设置 DAOYAN_SECRETARY_TOKEN');
  }
  httpServer = createServer((request, response) => {
    void (async () => {
      const authorized = !token || request.headers.authorization === `Bearer ${token}`;
      if (!authorized) {
        response.writeHead(401).end('unauthorized');
        return;
      }
      const target = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (request.method === 'GET' && (await serveDashboardAsset(target.pathname, response)))
        return;
      if (request.method === 'GET' && target.pathname === '/status') {
        sendJson(response, 200, publicSecretaryState(state));
        return;
      }
      if (request.method === 'GET' && target.pathname === '/api/dashboard') {
        sendJson(response, 200, await dashboardPayload(target.searchParams.get('version') ?? ''));
        return;
      }
      if (request.method === 'GET' && target.pathname === '/api/artifact') {
        await serveArtifact(
          target.searchParams.get('version') ?? '',
          target.searchParams.get('path') ?? '',
          response,
        );
        return;
      }
      if (request.method === 'POST' && target.pathname === '/api/todo-action') {
        try {
          sendJson(response, 200, await applyTodoAction(JSON.parse(await readBody(request))));
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      if (
        request.method === 'POST' &&
        (target.pathname === '/intake' || target.pathname === '/api/intake')
      ) {
        try {
          const value = JSON.parse(await readBody(request)) as unknown;
          if (!isRecord(value) || typeof value.idea !== 'string' || !value.idea.trim()) {
            throw new Error('idea is required');
          }
          const result = await enqueueIdea(value.idea.trim());
          sendJson(response, result.accepted ? 202 : 200, {
            id: result.id,
            status: result.accepted ? 'accepted' : 'duplicate',
          });
        } catch (error) {
          sendJson(response, 400, { error: String(error) });
        }
        return;
      }
      response.writeHead(404).end('not found');
    })().catch((error) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
      else response.end();
    });
  });
  httpServer.listen(port, host, () => console.log(`[notice guard] HTTP 监听 ${host}:${port}`));
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (retryTimer) clearTimeout(retryTimer);
  if (noticeRetryTimer) clearTimeout(noticeRetryTimer);
  if (orphanTimer) clearTimeout(orphanTimer);
  inboxWatcher?.close();
  runWatcher?.close();
  httpServer?.close();
  await channelHub?.stop();
  await writeChannelStatus();
  channelHub = null;
  for (const waiter of processExitNotices.values()) waiter.kill();
  processExitNotices.clear();
  for (const timer of workerExitTimers.values()) clearTimeout(timer);
  workerExitTimers.clear();
  const active = state.items.find((item) => item.id === state.activeItemId);
  const worker = active ? await activeWorkerProcess(active, true) : null;
  const managedProcesses = [
    { pid: activeChild?.pid ?? 0, identity: active?.processIdentity ?? '' },
    { pid: active?.processPid ?? 0, identity: active?.processIdentity ?? '' },
    { pid: worker?.pid ?? 0, identity: worker?.identity ?? '' },
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

async function synchronizeArchivedVersion(): Promise<void> {
  const version = await readFormalVersion(root);
  if (!version || version.status !== 'archived') return;
  normalizeFormalVersion(version);
  const archived = version.nodes.find((node) => node.id === 'archived');
  if (archived && !archived.summary) archived.summary = '版本档案已保存，正式版本流程完成。';
  await writeFormalVersion(root, version);
  const messageId = `version-archived-${version.id}`;
  if (state.messages.some((message) => message.id === messageId)) return;
  const leftAtArchive = state.messages.some(
    (message) => message.role === 'secretary' && message.content.includes('当前进入“版本归档”'),
  );
  if (!leftAtArchive) return;
  state.messages.push({
    id: messageId,
    role: 'secretary',
    content: `版本“${version.title}”归档已完成，当前没有归档 Agent 在运行。`,
    intent: 'reply',
    createdAt: new Date().toISOString(),
  });
}

export async function runNoticeGuard(): Promise<void> {
  await mkdir(inboxRoot, { recursive: true });
  await mkdir(responseRoot, { recursive: true });
  await mkdir(noticeOutboxRoot, { recursive: true });
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
  await synchronizeArchivedVersion();
  await saveState();
  await loadRecordedCorrelations();
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  channelHub = await secretaryChannelHubFromEnvironment(process.env, {
    info: (message) => console.log(message),
    error: (message) => console.error(message),
  });
  await writeChannelStatus();
  void channelHub
    .start(acceptChannelMessage)
    .then(() => writeChannelStatus())
    .then(() => processNoticeOutbox())
    .catch((error) => console.error(`[notice guard] 通讯通道后台启动失败：${String(error)}`));
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
