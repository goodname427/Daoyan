import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  watch,
  type FSWatcher,
} from 'node:fs';
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
import {
  buildLocalPlan,
  classifyAgentFailure,
  isValidationTreePath,
  preferredWindowsExecutable,
} from './agent-routing';
import {
  externalRequestId,
  type SecretaryChannelHub,
  type SecretaryInboundMessage,
  type SecretaryInboundReceipt,
  type SecretaryNotice,
} from './secretary-channel';
import { secretaryChannelHubFromEnvironment } from './secretary-channels';
import {
  appendPublicWorkEvent,
  readPublicWorkEvents,
  summarizePublicTiming,
  type PublicWorkEvent,
} from './public-work-log';
import {
  getProcessIdentity,
  isOwnedProcessAlive,
  waitForProcessIdentity,
} from './process-identity';
import {
  applyContinueToSchedule,
  applyWaitingReply,
  acknowledgeWaitingSnapshot,
  createSecretaryState,
  directionDestination,
  inferMessageIntent,
  messageIsNewDirection,
  isRunEligibleForAdoption,
  itemFromIntake,
  isWorkflowControlPlaneRequest,
  nextRunnableItem,
  normalizeSecretaryState,
  pendingScheduleCorrections,
  projectFactsFromItems,
  projectFactsFromStatus,
  publicSecretaryState,
  taskCompletionKey,
  unrecordedTaskCompletions,
  reconciliationTargets,
  type DirectionDestination,
  type IntakeRequest,
  type IntakeDisposition,
  type ProjectFact,
  type SecretaryItem,
  type SecretaryItemResolution,
  type SecretaryMessageIntent,
  type SecretaryScope,
  type SecretaryState,
  type SecretaryTaskCompletion,
} from './secretary-state';
import {
  advanceVersion,
  applyVersionTodoDecision,
  addDecisionGate,
  createFormalVersion,
  currentVersionStagePolicy,
  decisionResolutionForRequest,
  listFormalVersions,
  normalizeFormalVersion,
  publicVersionState,
  readFormalVersion,
  readFormalVersionById,
  recordApproval,
  recordFeatureVerification,
  recordValidationEvidence,
  recordQaRun,
  recordScopeRevision,
  recordStagePolicy,
  resolveDecisionGate,
  setNodeEvidence,
  transitionVersionBug,
  reusableValidationEvidence,
  invalidateValidationEvidence,
  writeFormalVersion,
  type FormalVersion,
  type ValidationEvidence,
  type VersionWorkItem,
  type VersionStage,
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
const publicEventsFile = resolve(secretaryRoot, 'public-events.jsonl');
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
  runId: string;
  attempt: number;
  phase: string;
  elapsedSeconds: number;
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
  activity: Array<{
    kind: 'stage' | 'action' | 'file' | 'test' | 'output' | 'error';
    createdAt: string;
    label: string;
    detail: string;
  }>;
  timing?: ReturnType<typeof summarizePublicTiming>;
  executionMetrics?: {
    actualLaunchCount: number | null;
    abnormalRecoveryCount: number | null;
    localRepairRoundCount: number | null;
  };
}

let state = createSecretaryState(new Date().toISOString());
let config: SecretaryConfig;
let activeChild: ChildProcess | null = null;
let inboxWatcher: FSWatcher | null = null;
let runWatcher: FSWatcher | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let noticeRetryTimer: NodeJS.Timeout | null = null;
let coordinateRecoveryTimer: NodeJS.Timeout | null = null;
const orphanTimers = new Map<string, NodeJS.Timeout>();
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
const activeLaunchStartedAt = new Map<string, string>();
const progressNoticeIntervalMs = 30 * 60_000;

function progressNoticePhase(rawPhase: string): string {
  const phase = publicActivityText(rawPhase)
    .replace(/第\s*\d+\s*轮/g, '')
    .trim();
  if (/快速门禁/.test(phase)) return 'Feature 快速门禁';
  if (/独立审查|增量复审/.test(phase)) return '独立审查';
  if (/局部修复|finding|门禁失败/.test(phase)) return '自动修复';
  if (/完整门禁/.test(phase)) return 'Feature 完整门禁';
  if (/Git/.test(phase)) return 'Git 交付';
  if (/执行任务/.test(phase)) return '执行任务';
  return phase || '正在执行';
}

export function progressNoticeDecision(
  lastPhase: string,
  lastNoticeAt: string,
  rawPhase: string,
  now: string,
  intervalMs = progressNoticeIntervalMs,
): { notify: boolean; phase: string; heartbeat: boolean } {
  const phase = progressNoticePhase(rawPhase);
  if (phase !== lastPhase) return { notify: true, phase, heartbeat: false };
  const previous = Date.parse(lastNoticeAt);
  const current = Date.parse(now);
  return {
    notify:
      Number.isFinite(previous) && Number.isFinite(current) && current - previous >= intervalMs,
    phase,
    heartbeat: true,
  };
}

function publicEventContext(item?: SecretaryItem): {
  executionRound: number;
  codeRevision: string;
} {
  return {
    executionRound: Math.max(1, item?.orchestration?.attempt ?? 1),
    codeRevision: publicCodeRevision(),
  };
}

async function appendSecretaryTiming(
  eventId: string,
  category: 'waiting-producer' | 'waiting-quota' | 'recovery' | 'idle',
  startedAt: string,
  endedAt: string,
  item?: SecretaryItem,
): Promise<void> {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
  await appendPublicWorkEvent(publicEventsFile, {
    eventId,
    sequence: 0,
    itemId: item?.id ?? '',
    runId: item?.orchestration?.runId ?? 'secretary',
    agentId: 'secretary',
    ...publicEventContext(item),
    timeCategory: category,
    kind: 'action',
    payload: { action: category, summary: item?.summary ?? '秘书空闲等待', status: 'completed' },
    createdAt: startedAt,
    durationMs: end - start,
  });
}

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
    const loaded = {
      ...createSecretaryState(new Date().toISOString()),
      ...current,
      processIdentity: getProcessIdentity(process.pid),
      items: value.items.map((item) => ({
        ...item,
        processIdentity: item.processIdentity ?? '',
        completedTasks: Array.isArray(item.completedTasks) ? item.completedTasks : [],
      })),
      messages: Array.isArray(value.messages) ? value.messages : [],
      ...(Object.prototype.hasOwnProperty.call(value, 'orchestration')
        ? { orchestration: value.orchestration }
        : {}),
      status: 'running',
      pid: process.pid,
    } as SecretaryState;
    normalizeSecretaryState(loaded);
    return loaded;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
  await appendPublicWorkEvent(publicEventsFile, {
    eventId: `notice-${event.id}`,
    sequence: 0,
    itemId: item?.id ?? '',
    runId: item?.orchestration?.runId ?? 'secretary',
    agentId: 'secretary',
    ...publicEventContext(item),
    kind: 'action',
    payload: { action: kind, summary: message, status: 'published' },
    createdAt: event.createdAt,
  });
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

export function resolveInboxIntent(
  fallbackIntent: SecretaryMessageIntent,
  modelIntent: SecretaryMessageIntent | undefined,
  message: string,
): SecretaryMessageIntent {
  // A waiting item has a concrete recovery snapshot. Semantic triage is useful
  // for recognising an explicitly changed direction, but it must not
  // reinterpret a producer's ordinary decision as a new direction: doing so
  // leaves the existing item in waiting-producer and drops the acknowledgement
  // that makes its original snapshot runnable.
  if (
    modelIntent === 'direction' &&
    !messageIsNewDirection(message) &&
    (fallbackIntent === 'reply' || fallbackIntent === 'continue')
  ) {
    return fallbackIntent;
  }
  return modelIntent ?? fallbackIntent;
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
  const startedAt = Date.now();
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
  await appendPublicWorkEvent(publicEventsFile, {
    eventId: `triage-model-${request.id}`,
    sequence: 0,
    requestId: request.id,
    itemId: waiting?.id ?? request.id,
    runId: waiting?.orchestration?.runId ?? 'secretary',
    agentId: config.triage.model,
    ...publicEventContext(waiting ?? undefined),
    timeCategory: 'model-compute',
    kind: 'action',
    payload: {
      action: 'semantic-triage',
      summary: request.idea,
      status: code === 0 ? 'passed' : 'failed',
    },
    createdAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
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
    nodes: base.nodes.map((node) => ({
      ...node,
      documents: documents.filter((document) => document.stages.includes(node.id)),
    })),
  };
}

async function readRetryLogHints(directory: string): Promise<string[]> {
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
          /(usage limit|try again at|账号.*阻塞|鉴权.*阻塞|额度.*(?:不足|用尽))/i.test(line),
      );
    return lines.slice(-12);
  } catch {
    return [];
  }
}

function modelFromPhase(phase: string): string {
  return phase.match(/gpt-[a-z0-9.-]+/i)?.[0] ?? '';
}

function publicActivityText(value: unknown, limit = 240): string {
  const source = String(value ?? '');
  // Removing markers alone would leave the content of a private thought visible.
  // The dashboard only accepts explicit public operational text.
  if (
    /(<think\b|<\/think>|\b(?:analysis|reasoning|private thought|chain of thought)\b|私有推理|思维链)/i.test(
      source,
    )
  ) {
    return '';
  }
  return source
    .replace(/[A-Za-z]:[\\/][^\s，。；;]+/g, '[本机路径]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function publicActivityForItem(
  progress: Record<string, unknown> | null,
  recovery: Record<string, unknown> | null,
  taskRuns: Map<string, Record<string, unknown>>,
  tasks: Array<{ id: string; title: string; objective: string; status: string }>,
  recentOutput: string[],
  publicPhase = '',
): DashboardAgent['activity'] {
  const updatedAt = String(progress?.updatedAt ?? recovery?.updatedAt ?? new Date().toISOString());
  const activity: DashboardAgent['activity'] = [];
  const visibleFiles = new Set<string>();
  const visibleTests = new Set<string>();
  const phase = publicActivityText(publicPhase || progress?.phase || recovery?.phase);
  if (phase)
    activity.push({ kind: 'stage', createdAt: updatedAt, label: '阶段说明', detail: phase });
  for (const task of tasks) {
    const run = taskRuns.get(task.id);
    const taskTitle = publicActivityText(task.title, 160) || '未命名任务';
    const taskUpdatedAt = String(run?.completedAt ?? updatedAt);
    const detail = publicActivityText(task.objective || task.title);
    activity.push({
      kind: 'action',
      createdAt: taskUpdatedAt,
      label: `${task.status === 'pending' ? '待执行动作' : '执行动作'}：${taskTitle}`,
      detail: detail || '正在处理该任务。',
    });
    for (const file of stringArray(run?.changedFiles ?? run?.files).slice(0, 8)) {
      const path = publicActivityText(file, 160);
      if (path && !visibleFiles.has(path)) {
        visibleFiles.add(path);
        activity.push({
          kind: 'file',
          createdAt: taskUpdatedAt,
          label: '修改文件',
          detail: path,
        });
      }
    }
    for (const check of stringArray(run?.tests ?? run?.verification).slice(0, 5)) {
      const detail = publicActivityText(check);
      if (detail && !visibleTests.has(detail)) {
        visibleTests.add(detail);
        activity.push({
          kind: 'test',
          createdAt: taskUpdatedAt,
          label: '测试',
          detail,
        });
      }
    }
  }
  for (const line of recentOutput.slice(-8)) {
    const detail = publicActivityText(line);
    if (!detail) continue;
    const kind: DashboardAgent['activity'][number]['kind'] =
      /error|fatal|failed|failure|阻塞|额度|鉴权/i.test(detail)
        ? 'error'
        : /(?:npm|test|verify|vitest|playwright)/i.test(detail)
          ? 'test'
          : 'output';
    activity.push({
      kind,
      createdAt: updatedAt,
      label:
        kind === 'test'
          ? '测试输出（已截断）'
          : kind === 'error'
            ? '执行异常'
            : '运行输出（已截断）',
      detail,
    });
  }
  return activity.slice(-24);
}

function dashboardActivityFromPublicEvents(events: PublicWorkEvent[]): DashboardAgent['activity'] {
  return events.slice(-24).map((event) => {
    const detail = Object.values(event.payload)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((value) => value !== null && value !== '')
      .join(' · ');
    const kind: DashboardAgent['activity'][number]['kind'] =
      event.kind === 'file'
        ? 'file'
        : event.kind === 'test'
          ? 'test'
          : event.kind === 'error' || event.kind === 'blocker'
            ? 'error'
            : event.kind === 'plan' || event.kind === 'progress'
              ? 'stage'
              : 'action';
    return {
      kind,
      createdAt: event.createdAt,
      label: event.kind,
      detail: publicActivityText(detail || '公开事件'),
    };
  });
}

function mergeDashboardActivity(
  recorded: DashboardAgent['activity'],
  live: DashboardAgent['activity'],
): DashboardAgent['activity'] {
  const unique = new Map<string, DashboardAgent['activity'][number]>();
  for (const entry of [...recorded.slice(-16), ...live.slice(-16)]) {
    unique.set(`${entry.kind}\u0000${entry.label}\u0000${entry.detail}`, entry);
  }
  return [...unique.values()]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(-24);
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
  const rawPhase = String(progress?.phase ?? recovery?.phase ?? item.summary ?? '等待调度');
  const phase = publicActivityText(rawPhase) || '正在执行公开工作流';
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
    progress ? `运行阶段：${phase} / ${String(progress.status ?? '')}` : '',
    recovery?.error ? `阻塞：${String(recovery.error)}` : '',
  ]
    .map((entry) => publicActivityText(entry))
    .filter(Boolean);
  const publicEvents = item.runDirectory
    ? await readPublicWorkEvents(resolve(item.runDirectory, 'public-events.jsonl'))
    : [];
  const liveActivity = publicActivityForItem(
    progress,
    recovery,
    taskRuns,
    tasks,
    recentOutput,
    phase,
  );
  return {
    id: item.id,
    role: item.scope === 'version' ? 'Version PM' : 'Feature PM',
    type: item.scope === 'version' ? '版本调度' : 'Feature 交付',
    status,
    running: alive,
    model: modelFromPhase(rawPhase) || '尚未分配',
    phase,
    objective:
      publicActivityText(recovery?.resolvedDirection ?? recovery?.direction ?? item.idea) ||
      '正在执行公开工作流',
    pid: alive ? item.processPid : 0,
    startedAt: String(progress?.startedAt ?? item.createdAt),
    updatedAt: String(progress?.updatedAt ?? recovery?.updatedAt ?? item.updatedAt),
    elapsedSeconds: Number(progress?.elapsedSeconds ?? 0),
    runDirectory: item.runDirectory,
    retryAt: item.retryAt,
    activity:
      publicEvents.length > 0
        ? mergeDashboardActivity(dashboardActivityFromPublicEvents(publicEvents), liveActivity)
        : liveActivity,
    timing: summarizePublicTiming(publicEvents),
    executionMetrics: {
      actualLaunchCount: Number.isSafeInteger(recovery?.actualLaunchCount)
        ? Number(recovery?.actualLaunchCount)
        : null,
      abnormalRecoveryCount: Number.isSafeInteger(recovery?.abnormalRecoveryCount)
        ? Number(recovery?.abnormalRecoveryCount)
        : null,
      localRepairRoundCount: Number.isSafeInteger(recovery?.localRepairRoundCount)
        ? Number(recovery?.localRepairRoundCount)
        : null,
    },
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
  const snapshotAt = new Date().toISOString();
  const initializedAt = Date.parse(state.initializedAt);
  const secretaryPublicEvents = await readPublicWorkEvents(publicEventsFile);
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
      updatedAt: snapshotAt,
      elapsedSeconds: Number.isFinite(initializedAt)
        ? Math.max(0, Math.floor((Date.now() - initializedAt) / 1000))
        : 0,
      runDirectory: secretaryRoot,
      retryAt: '',
      activity: [
        {
          kind: 'stage',
          createdAt: state.lastEventAt,
          label: '阶段说明',
          detail: guardBusy ? '正在处理项目事件。' : '事件休眠，等待消息或运行状态变化。',
        },
      ],
      timing: summarizePublicTiming(secretaryPublicEvents),
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
          pm.activity.find((event) => event.kind === 'action' && event.label.startsWith('执行动作'))
            ?.detail || pm.objective,
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
            { id: 'approve', label: todo.decisionGateId ? '批准此决策' : '通过并继续' },
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

export function retryTimeFromOutput(
  lines: string[],
  now = Date.now(),
  fallbackMinutes = config.guard.executionRetryMinutes,
): string {
  const hint = lines.join('\n').match(/try again at\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!hint) return new Date(now + fallbackMinutes * 60_000).toISOString();
  let hour = Number(hint[1]) % 12;
  if (hint[3].toUpperCase() === 'PM') hour += 12;
  const candidate = new Date(now);
  candidate.setHours(hour, Number(hint[2]) + 5, 0, 0);
  if (candidate.getTime() <= now) return new Date(now + fallbackMinutes * 60_000).toISOString();
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
  if (action !== 'defer' && item.runDirectory && !item.orchestration?.waitingSnapshot) {
    await reconcileItem(item);
    if (item.status !== 'waiting-producer') throw new Error('待办运行状态已变化，请刷新后处理');
  }
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
    item.retryAt = retryTimeFromOutput(await readRetryLogHints(item.runDirectory));
    item.summary = `已采用默认方案，将在 ${new Date(item.retryAt).toLocaleString('zh-CN', { hour12: false })} 自动重试。`;
  } else throw new Error('不支持的秘书待办方案');
  if (item.status === 'retry-wait') acknowledgeWaitingSnapshot(item);
  item.updatedAt = new Date().toISOString();
  state.activeItemId = '';
  recordDashboardDecision(`处理待办：${item.idea}`, item.summary);
  await saveState();
  await emitNotice('todo-resolved', item.summary, item);
  await coordinate();
  return { message: item.summary };
}

async function applyVersionTodoAction(
  itemId: string,
  action: string,
  note: string,
): Promise<{ message: string }> {
  const version = await readFormalVersion(root);
  if (!version) throw new Error('当前没有正式版本');
  const { title, message } = applyVersionTodoDecision(version, itemId, action, note);
  await writeFormalVersion(root, version);
  recordDashboardDecision(`处理版本待办：${title}`, note ? `${message} ${note}` : message);
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
        runId: String(manifest.runId ?? entry.name),
        attempt: Number(manifest.attempt ?? 0),
        phase: String(manifest.currentStage ?? manifest.status ?? ''),
        elapsedSeconds: Number(manifest.elapsedSeconds ?? 0),
      });
    }
  }
  if (existsSync(runsRoot)) {
    for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = resolve(runsRoot, entry.name);
      const recovery = await readJson(resolve(directory, 'recovery.json'));
      const progress = await readJson(resolve(directory, 'progress.json'));
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
        runId: String(recovery?.runId ?? entry.name),
        attempt: Number(recovery?.attempt ?? recovery?.recoveryAttempts ?? 0),
        phase: String(progress?.phase ?? recovery?.phase ?? status),
        elapsedSeconds: Number(progress?.elapsedSeconds ?? 0),
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
      runId: String(manifest.runId ?? basename(item.runDirectory)),
      attempt: Number(
        manifest.attempt ?? item.orchestration?.attempt ?? item.recoveryAttempts ?? 0,
      ),
      phase: String(manifest.currentStage ?? manifest.status ?? ''),
      elapsedSeconds: Number(manifest.elapsedSeconds ?? 0),
    };
  }
  const recovery = await readJson(resolve(item.runDirectory, 'recovery.json'));
  const progress = await readJson(resolve(item.runDirectory, 'progress.json'));
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
    runId: String(recovery?.runId ?? basename(item.runDirectory)),
    attempt: Number(
      recovery?.attempt ??
        recovery?.recoveryAttempts ??
        item.orchestration?.attempt ??
        item.recoveryAttempts ??
        0,
    ),
    phase: String(progress?.phase ?? recovery?.phase ?? status),
    elapsedSeconds: Number(progress?.elapsedSeconds ?? 0),
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

export function localQuestionResponse(message: string, facts: ProjectFact[]): string {
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
  normalizeSecretaryState(state);
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
  if (!state.orchestration!.intakes.some((intake) => intake.requestId === request.id)) {
    state.orchestration!.intakes.push({
      requestId: request.id,
      intent,
      disposition: intent === 'continue' ? 'resumed' : 'answered',
      status: 'completed',
      targetVersionId: '',
      scopeRevision: null,
      reason: response,
      createdAt: request.createdAt,
      completedAt: new Date().toISOString(),
    });
  }
  await saveState();
  const publicItem = state.items.find(
    (item) => item.id === request.id || item.lastProducerRequestId === request.id,
  );
  await appendPublicWorkEvent(publicEventsFile, {
    eventId: `input-${request.id}`,
    sequence: 0,
    requestId: request.id,
    itemId: request.id,
    agentId: 'secretary',
    ...publicEventContext(publicItem),
    kind: 'input',
    payload: { summary: request.idea, source: 'producer-message' },
    createdAt: request.createdAt,
  });
  await appendPublicWorkEvent(publicEventsFile, {
    eventId: `response-${request.id}`,
    sequence: 0,
    requestId: request.id,
    itemId: request.id,
    agentId: 'secretary',
    ...publicEventContext(publicItem),
    kind: intent === 'reply' ? 'decision' : 'action',
    payload:
      intent === 'reply'
        ? { summary: response, basis: 'linked-producer-message', status }
        : { action: intent, summary: response, status },
  });
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
  const pending = state.items.find((item) => item.id === state.activeItemId);
  if (pending?.runDirectory && !pending.orchestration?.waitingSnapshot) {
    await reconcileItem(pending);
  }
  const waitingStartedAt = pending
    ? ([...(state.orchestration?.reconciliations ?? [])]
        .reverse()
        .find((record) => record.itemId === pending.id && record.outcome === 'waiting-producer')
        ?.reconciledAt ?? pending.updatedAt)
    : '';
  const waitingCategory =
    pending && externalBlocker(pending.summary) ? 'waiting-quota' : 'waiting-producer';
  const waiting = applyWaitingReply(state, request, intent);
  if (!waiting) throw new Error('等待事项已变化，无法应用当前回复');
  await appendSecretaryTiming(
    `wait-${waiting.id}-${waitingStartedAt}`,
    waitingCategory,
    waitingStartedAt,
    request.createdAt,
    waiting,
  );
  await saveState();
  await coordinate();
  const response = continueDispatchResponse(waiting, await confirmDispatchEvidence(waiting));
  await writeInboxResponse(request, response, waiting.status, intent, waiting.plannedTasks);
  await emitNotice('reply-accepted', response, waiting, undefined, request.id);
}

type DispatchEvidence = 'worker-running' | 'pm-running' | 'blocked' | 'recovering' | 'stopped';

async function confirmDispatchEvidence(
  item: SecretaryItem,
  settleMs = 1_200,
): Promise<DispatchEvidence> {
  const deadline = Date.now() + settleMs;
  do {
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    if (item.status === 'waiting-producer') return 'blocked';
    if (item.status === 'retry-wait') return 'recovering';
  } while (Date.now() < deadline);

  await coordinate();
  if (await activeWorkerProcess(item, true)) return 'worker-running';
  if (isOwnedProcessAlive(item.processPid, item.processIdentity, 0)) return 'pm-running';
  const reconciledStatus: string = item.status;
  if (reconciledStatus === 'waiting-producer') return 'blocked';
  if (reconciledStatus === 'retry-wait') return 'recovering';
  return 'stopped';
}

export function continueDispatchResponse(item: SecretaryItem, evidence: DispatchEvidence): string {
  if (evidence === 'worker-running') {
    return `已恢复“${item.idea}”，执行 Agent 已确认运行。`;
  }
  if (evidence === 'pm-running') {
    return `已恢复“${item.idea}”，Feature PM 已确认运行，正在准备或调度执行 Agent。`;
  }
  if (evidence === 'blocked') {
    return `尝试恢复“${item.idea}”后确认仍被阻塞：${item.summary}`;
  }
  if (evidence === 'recovering') {
    return `“${item.idea}”的进程未稳定启动，秘书已进入自动恢复，而不是把它误报为运行中。`;
  }
  return `“${item.idea}”尚未检测到真实 PM 或 Agent 进程，秘书已保留现场并继续诊断。`;
}

async function continueScheduledWork(request: IntakeRequest): Promise<void> {
  const result = applyContinueToSchedule(state, request);
  await saveState();
  if (!['waiting', 'idle'].includes(result.action)) await coordinate();

  const item = result.item;
  const response =
    item && !['waiting', 'idle'].includes(result.action)
      ? continueDispatchResponse(item, await confirmDispatchEvidence(item))
      : result.action === 'waiting'
        ? `“${item?.idea ?? '当前任务'}”仍在等待具体产品决定，不能用笼统的“继续”跳过该门禁。`
        : '当前没有已批准且可执行的任务；秘书会保持休眠，等待新的版本方向。';
  await writeInboxResponse(
    request,
    response,
    item?.status ?? 'answered',
    'continue',
    item?.plannedTasks ?? [],
  );
  await emitNotice('continue-accepted', response, item ?? undefined, undefined, request.id);
}

export function versionProducerDecision(message: string): 'approved' | 'changes-requested' | null {
  if (versionMessageIsNewDirection(message)) return null;
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
  return messageIsNewDirection(message);
}

function draftVersionId(request: IntakeRequest): string {
  const date = request.createdAt.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const requestKey = request.id.replace(/[^a-z0-9_-]/gi, '-').slice(0, 24) || 'direction';
  return `draft-${date}-${requestKey}`.toLowerCase();
}

const PRODUCER_STAGES = new Set<VersionStage>(['charter-review', 'producer-acceptance']);

const STAGE_DELIVERABLES: Partial<Record<VersionStage, string>> = {
  'charter-draft': '形成版本策划案，明确价值、范围、非目标、验收标准与建议阶段策略。',
  'module-design': '完成必要模块的详细策划；不适用内容明确说明，不为凑流程制造文档。',
  'design-review': '以主策身份审查详细策划，修正遗漏并给出通过或升级制作人的结论。',
  'task-breakdown': '把已批准范围拆成可验证、带依赖和验收标准的工作项。',
  'version-planning': '按依赖和风险排序工作项，控制版本工作量并冻结可执行范围。',
  development: '完成当前版本全部开发工作、定向自测、文档、完整门禁、审查和 Git 交付。',
  qa: '作为独立测试角色执行版本验收、集成和主线回归，不代替 Feature Agent 修代码。',
  bugfix: '修复版本测试登记的全部未关闭缺陷，并完成独立复验和必要回归。',
  candidate: '形成可供制作人体验的候选构建、版本说明、测试结论和遗留风险。',
};

function formalScopeRevision(version: FormalVersion): number {
  return (
    version.orchestration?.scopeRevisions
      .filter((revision) => revision.status === 'approved')
      .at(-1)?.revision ?? 1
  );
}

export function versionStageItemId(
  versionId: string,
  stage: VersionStage,
  scopeRevision: number,
  attempt: number,
): string {
  return `formal-${versionId}-${scopeRevision}-${stage}-${attempt}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export function versionStageDirection(version: FormalVersion, stage: VersionStage): string {
  const node = version.nodes.find((candidate) => candidate.id === stage);
  const artifact = `${version.documentRoot}/${stage}.md`.replace(/\\/g, '/');
  const policy = currentVersionStagePolicy(version, stage);
  const bugfixStep =
    stage === 'bugfix' &&
    version.bugs.some((bug) => bug.status === 'verify') &&
    version.bugs.every((bug) => ['verify', 'closed', 'deferred'].includes(bug.status))
      ? 'reverification'
      : 'primary';
  const taskManifest = `${version.documentRoot}/task-breakdown.json`.replace(/\\/g, '/');
  const stageManifest = `${version.documentRoot}/${
    stage === 'bugfix' && bugfixStep === 'reverification' ? 'bugfix-reverification' : stage
  }.json`.replace(/\\/g, '/');
  const stageSpecific =
    stage === 'task-breakdown'
      ? `同时写入 ${taskManifest}，格式必须为 {"workItems":[{"id":"稳定短标识","title":"任务标题","owner":"执行角色","dependsOn":["依赖任务 id"],"summary":"范围与验收","affectedPaths":["受影响路径"],"acceptanceCommands":["直接验收命令或检查"]}]}。每项必须给出非空的受影响路径与直接验收命令；依赖只能引用同一清单中的任务，不能用一个笼统占位项代替实际拆分。`
      : stage === 'design-review'
        ? `同时写入 ${stageManifest}，格式必须为 {"decision":"approved|changes-requested|producer-escalation","summary":"公开审核结论"}。任务执行成功不等于策划审核通过。`
        : stage === 'development'
          ? `同时写入 ${stageManifest}，逐一列出正式版本中的每个实际工作项，格式为 {"workItems":[{"id":"工作项 id","status":"completed|skipped","typecheck":"passed|failed","targetedTests":"passed|failed","commands":[{"command":"执行 Agent 实际运行的 Task 直接检查","exitCode":0}],"evidence":["公开证据"]}]}。不得用计划命令或一份聚合结论代替逐项执行证据；npm run verify、npm run verify:full、E2E 和 build 只登记在各自 Feature/Version 作用域。`
          : stage === 'qa'
            ? `同时写入 ${stageManifest}，格式为 {"status":"passed|failed","suites":["acceptance","integration","regression"],"commands":[{"command":"实际命令","exitCode":0}],"evidence":["公开证据"],"bugs":[{"id":"稳定缺陷 id","title":"标题","severity":"blocker|high|medium|low","expected":"预期","actual":"实际","evidence":"证据","linkedWorkItemId":"相关工作项 id"}]}。任务交付成功不等于产品测试通过；发现缺陷时 status 必须为 failed 并完整登记。只运行和记录测试，不修改产品实现。`
            : stage === 'bugfix' && bugfixStep === 'primary'
              ? `同时写入 ${stageManifest}，格式为 {"fixes":[{"bugId":"缺陷 id","evidence":["修复与定向测试证据"]}]}。必须逐项覆盖本轮所有待修缺陷，不得把未修缺陷送入复验。`
              : stage === 'bugfix' && bugfixStep === 'reverification'
                ? `本轮只做独立缺陷复验，不修改产品代码；同时写入 ${stageManifest}，格式为 {"status":"passed|failed","bugIds":["逐项复验的缺陷 id"],"suites":["acceptance","integration","regression","defect-reverification"],"commands":[{"command":"实际命令","exitCode":0}],"evidence":["公开证据"]}。`
                : '';
  return [
    `[formal-stage:${stage}]`,
    `推进正式版本“${version.title}”（${version.id}）的“${node?.title ?? stage}”阶段。`,
    `版本方向：${version.direction}`,
    `阶段交付：${STAGE_DELIVERABLES[stage] ?? node?.description ?? '完成当前阶段。'}`,
    `执行策略：${policy.mode === 'reduced' ? '精简执行' : '完整执行'}。理由：${policy.reason}`,
    policy.evidence.length > 0 ? `策略依据：${policy.evidence.join('、')}` : '',
    stageSpecific,
    `将公开结论写入 ${artifact}，同步必要长期文档和开发日志。`,
    '只处理当前正式版本和当前阶段，不另立版本，不等待制作人选择工程细节。',
    '不要直接编辑 .daoyan-agent 运行状态，也不要手工推进版本节点；阶段交付后由 notice guard 根据可审计报告原子登记证据并继续。',
    '若遇到只有制作人能决定的产品方向冲突或高风险架构取舍，以及账号、额度或外部访问阻塞，保存恢复点并明确报告；其他技术问题自行恢复和收束。',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function expectedVersionStageStep(
  version: FormalVersion,
  stage: VersionStage,
): 'primary' | 'reverification' {
  return stage === 'bugfix' &&
    version.bugs.some((bug) => bug.status === 'verify') &&
    version.bugs.every((bug) => ['verify', 'closed', 'deferred'].includes(bug.status))
    ? 'reverification'
    : 'primary';
}

export function ensureVersionStageItem(
  secretary: SecretaryState,
  version: FormalVersion,
  now = new Date().toISOString(),
): SecretaryItem | null {
  const stage = version.currentStage;
  if (
    version.status !== 'running' ||
    PRODUCER_STAGES.has(stage) ||
    stage === 'archived' ||
    currentVersionStagePolicy(version, stage).mode === 'skip'
  ) {
    return null;
  }
  const scopeRevision = formalScopeRevision(version);
  const stageStep = expectedVersionStageStep(version, stage);
  const linked = secretary.items.filter(
    (item) =>
      item.orchestration?.formalVersionId === version.id &&
      item.orchestration.formalStage === stage &&
      item.orchestration.formalScopeRevision === scopeRevision,
  );
  const linkedStep = linked.filter(
    (item) => (item.orchestration?.formalStageStep ?? 'primary') === stageStep,
  );
  if (
    linkedStep.some((item) =>
      ['queued', 'retry-wait', 'active', 'tracking', 'waiting-producer'].includes(item.status),
    )
  ) {
    return null;
  }
  const attempt = linked.length + 1;
  const id = versionStageItemId(version.id, stage, scopeRevision, attempt);
  const direction = versionStageDirection(version, stage);
  const item = itemFromIntake({ id, idea: direction, createdAt: now }, [], 'feature').item;
  item.status = 'queued';
  item.summary = `秘书已安排“${version.nodes.find((node) => node.id === stage)?.title ?? stage}”阶段，完成后将自动推进。`;
  item.orchestration = {
    ...item.orchestration!,
    formalVersionId: version.id,
    formalStage: stage,
    formalScopeRevision: scopeRevision,
    formalStageStep: stageStep,
  };
  secretary.items.push(item);
  return item;
}

async function routeNewDirection(request: IntakeRequest, item: SecretaryItem): Promise<string> {
  normalizeSecretaryState(state);
  const orchestration = state.orchestration!;
  let intake = orchestration.intakes.find((candidate) => candidate.requestId === request.id);
  if (intake?.status === 'completed') {
    item.status = intake.disposition === 'next-version-candidate' ? 'backlog' : 'answered';
    item.completedAt = item.status === 'answered' ? intake.completedAt : '';
    item.summary = intake.reason;
    return intake.reason;
  }
  let current = await readFormalVersion(root);
  let active = current && current.status !== 'archived' ? current : null;
  if (!intake || (intake.status === 'pending' && !intake.targetVersionId)) {
    const destination = directionDestination(request.idea, current);
    const disposition: IntakeDisposition =
      destination === 'draft-version'
        ? 'draft-created'
        : destination === 'current-version'
          ? 'merged-current'
          : destination === 'next-version-candidate'
            ? 'next-version-candidate'
            : 'scope-review';
    const targetVersionId =
      destination === 'draft-version' ? draftVersionId(request) : (active?.id ?? '');
    const pending = {
      requestId: request.id,
      intent: 'direction' as const,
      disposition,
      status: 'pending' as const,
      targetVersionId,
      scopeRevision: null,
      reason: '正在确定新方向的正式版本去向。',
      createdAt: request.createdAt,
      completedAt: '',
    };
    if (intake) Object.assign(intake, pending);
    else {
      intake = pending;
      orchestration.intakes.push(intake);
    }
    await saveState();
  }
  if (!intake) {
    // The branch above always creates an intake; keep this guard so a future
    // schema change cannot continue without a durable transaction intent.
    throw new Error('新方向缺少持久收件事务，已停止自动立项');
  }

  const destination: DirectionDestination =
    intake.disposition === 'draft-created'
      ? 'draft-version'
      : intake.disposition === 'merged-current'
        ? 'current-version'
        : intake.disposition === 'next-version-candidate'
          ? 'next-version-candidate'
          : 'scope-review';
  const target = intake.targetVersionId
    ? await readFormalVersionById(root, intake.targetVersionId)
    : null;
  const existingRevision = target?.orchestration?.scopeRevisions.find(
    (revision) => revision.sourceRequestId === request.id,
  );
  if (target && existingRevision) {
    intake.disposition =
      existingRevision.disposition === 'initial'
        ? 'draft-created'
        : existingRevision.disposition === 'merged'
          ? 'merged-current'
          : 'scope-review';
    intake.targetVersionId = target.id;
    intake.scopeRevision = existingRevision.revision;
    intake.reason =
      existingRevision.disposition === 'initial'
        ? `已为新方向建立正式版本草案“${target.title}”；草案不等于开发批准，完成策划后仍须经过制作人立项评审。`
        : existingRevision.disposition === 'merged'
          ? `该方向已并入未冻结的正式版本“${target.title}”范围修订 ${existingRevision.revision}。`
          : `该方向可能改变正式版本“${target.title}”的已批准承诺，已进入范围修订评审；确认前不会执行。`;
    intake.status = 'completed';
    intake.completedAt = new Date().toISOString();
    item.status = 'answered';
    item.completedAt = intake.completedAt;
    item.summary = intake.reason;
    await saveState();
    return intake.reason;
  }
  if (target && destination === 'draft-version') {
    intake.status = 'blocked';
    intake.reason = `目标草案 ID ${target.id} 已存在，但没有当前请求的来源修订；为避免覆盖或冒认历史版本，已停止自动立项。`;
    item.status = 'waiting-producer';
    item.summary = intake.reason;
    await saveState();
    return intake.reason;
  }

  current = await readFormalVersion(root);
  active = current && current.status !== 'archived' ? current : null;
  if (destination !== 'draft-version' && (!active || active.id !== intake.targetVersionId)) {
    intake.status = 'blocked';
    intake.reason = `收件事务原定关联正式版本 ${intake.targetVersionId || '未知'}，但当前版本已变化；为避免重复立项或误并范围，已停止自动处理。`;
    item.status = 'waiting-producer';
    item.summary = intake.reason;
    await saveState();
    return intake.reason;
  }
  if (destination === 'draft-version' && active && active.id !== intake.targetVersionId) {
    intake.status = 'blocked';
    intake.reason = `收件事务原定创建草案 ${intake.targetVersionId}，但当前已有活动版本 ${active.id}；为避免覆盖新状态，已停止自动立项。`;
    item.status = 'waiting-producer';
    item.summary = intake.reason;
    await saveState();
    return intake.reason;
  }

  if (destination === 'draft-version') {
    const id = intake.targetVersionId;
    if (!id) throw new Error('草案收件事务缺少目标版本 ID');
    const existing = await readFormalVersionById(root, id);
    const version =
      existing ??
      createFormalVersion({
        id,
        title: request.idea.slice(0, 36),
        direction: request.idea,
        documentRoot: `docs/versions/${id}`,
        currentStage: 'charter-draft',
        sourceRequestId: request.id,
        now: request.createdAt,
      });
    if (!existing) await writeFormalVersion(root, version, { allowVersionSwitch: true });
    intake.disposition = 'draft-created';
    intake.targetVersionId = version.id;
    intake.scopeRevision = 1;
    intake.reason = `已为新方向建立正式版本草案“${version.title}”；草案不等于开发批准，完成策划后仍须经过制作人立项评审。`;
    item.status = 'answered';
    item.completedAt = new Date().toISOString();
  } else if (destination === 'next-version-candidate' && active) {
    const candidateId = `candidate-${request.id}`;
    if (!orchestration.nextVersionCandidates.some((candidate) => candidate.id === candidateId)) {
      orchestration.nextVersionCandidates.push({
        id: candidateId,
        requestId: request.id,
        direction: request.idea,
        reason: `当前版本 ${active.id} 已冻结范围。`,
        sourceVersionId: active.id,
        createdAt: request.createdAt,
      });
    }
    intake.disposition = 'next-version-candidate';
    intake.targetVersionId = active.id;
    intake.reason = `当前正式版本“${active.title}”已冻结范围；该方向已进入下一版本候选，不会自动立项或启动开发。`;
    item.status = 'backlog';
  } else if (destination === 'current-version' && active) {
    const revision = recordScopeRevision(active, {
      direction: request.idea,
      sourceRequestId: request.id,
      disposition: 'merged',
      reason: '方向与当前未冻结版本目标一致，合并为新的范围修订。',
      now: request.createdAt,
    });
    await writeFormalVersion(root, active);
    intake.disposition = 'merged-current';
    intake.targetVersionId = active.id;
    intake.scopeRevision = revision.revision;
    intake.reason = `该方向已并入未冻结的正式版本“${active.title}”范围修订 ${revision.revision}。`;
    item.status = 'answered';
    item.completedAt = new Date().toISOString();
  } else if (active) {
    const revision = recordScopeRevision(active, {
      direction: request.idea,
      sourceRequestId: request.id,
      disposition: 'scope-review',
      reason: '该方向可能改变已批准承诺，需要制作人确认范围修订。',
      now: request.createdAt,
    });
    addDecisionGate(active, {
      kind: 'scope-change',
      stage: active.currentStage,
      summary: `确认是否将“${request.idea}”纳入当前版本`,
      sourceRequestId: request.id,
      now: request.createdAt,
    });
    await writeFormalVersion(root, active);
    intake.disposition = 'scope-review';
    intake.targetVersionId = active.id;
    intake.scopeRevision = revision.revision;
    intake.reason = `该方向可能改变正式版本“${active.title}”的已批准承诺，已进入范围修订评审；确认前不会执行。`;
    item.status = 'answered';
    item.completedAt = new Date().toISOString();
  } else {
    throw new Error('正式版本去向与当前状态不一致，已停止自动立项');
  }
  intake.status = 'completed';
  intake.completedAt = new Date().toISOString();
  item.summary = intake.reason;
  await saveState();
  return intake.reason;
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
  if (versionMessageIsNewDirection(request.idea)) return false;
  const current = await readFormalVersion(root);
  const decision = versionProducerDecision(request.idea);
  const decisionGate =
    current?.orchestration?.decisionGates.find((candidate) => candidate.status === 'open') ??
    (decision === 'approved'
      ? current?.orchestration?.decisionGates.find(
          (candidate) => candidate.status === 'rejected' && candidate.kind !== 'scope-change',
        )
      : undefined);
  if (current && decisionGate) {
    if (!decision) {
      const response = '已记录补充；当前范围或架构决策门禁仍在等待明确批准或退回。';
      await writeInboxResponse(request, response, 'answered', 'reply');
      return true;
    }
    resolveDecisionGate(
      current,
      decisionGate.id,
      decision === 'approved' ? 'approved' : 'rejected',
      request.createdAt,
      request.id,
    );
    await writeFormalVersion(root, current);
    const response =
      decision === 'approved'
        ? `已批准“${decisionGate.summary}”，内部流程可按新的范围修订继续。`
        : `已退回“${decisionGate.summary}”，当前版本保持原承诺并暂停相关动作。`;
    await writeInboxResponse(request, response, 'answered', 'reply');
    await emitNotice('version-decision-recorded', response, undefined, undefined, request.id);
    return true;
  }
  const gate = await currentProducerGate();
  if (!gate) return false;
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
  const gateResolution = version ? decisionResolutionForRequest(version, request.id) : null;
  if (!producerMessage && !replyMessage && !item && !approval && !gateResolution) return false;

  const stageTitle = version?.nodes.find((node) => node.id === version.currentStage)?.title;
  const approvalResponse = approval
    ? version?.status === 'archived'
      ? `版本“${version.title}”已完成归档。`
      : approval.decision === 'approved'
        ? `已记录版本评审通过，当前进入“${stageTitle ?? version?.currentStage}”。`
        : `已记录你的反馈，版本已退回“${stageTitle ?? version?.currentStage}”调整。`
    : '';
  const decisionResponse = gateResolution
    ? gateResolution.decision === 'approved'
      ? `已批准“${gateResolution.gate.summary}”，内部流程可继续。`
      : `已退回“${gateResolution.gate.summary}”，当前版本保持暂停等待重新审批。`
    : '';
  const response =
    replyMessage?.content || item?.summary || approvalResponse || decisionResponse || '已处理。';
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
        if (isWorkflowControlPlaneRequest(request.idea)) {
          const maintenance = itemFromIntake(request, []).item;
          const response =
            '这是秘书、调度器或项目中枢自身的维护请求。为避免不成熟系统自我修改，秘书不会派发给 Feature PM；请由主 Agent 直接维护，项目开发队列保持不变。';
          maintenance.status = 'answered';
          maintenance.plannedTasks = [];
          maintenance.completedAt = request.createdAt;
          maintenance.summary = response;
          state.items.push(maintenance);
          await saveState();
          await writeInboxResponse(request, response, maintenance.status, 'question');
          await emitNotice(
            'control-plane-maintenance',
            response,
            maintenance,
            undefined,
            request.id,
          );
          await rm(path, { force: true });
          continue;
        }
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
        const needsSemanticTriage =
          Boolean(waiting) || (fallbackIntent !== 'reply' && !local.item.matchedFact);
        let model: TriageResult | null = null;
        if (needsSemanticTriage) {
          try {
            model = await modelTriage(request, known.facts, waiting);
          } catch (error) {
            console.error(`[notice guard] 语义判断失败，使用本地规则：${String(error)}`);
          }
        }
        const intent = resolveInboxIntent(fallbackIntent, model?.intent, request.idea);
        if (waiting && (intent === 'reply' || intent === 'continue')) {
          await resumeWaitingItem(request, intent);
          await rm(path, { force: true });
          continue;
        }
        if (intent === 'continue') {
          await continueScheduledWork(request);
          await rm(path, { force: true });
          continue;
        }
        if (model) local.item.scope = model.scope;
        let response = model ? applyModelTriage(local.item, model) : local.response;
        if (intent === 'direction' && !local.item.matchedFact && model) {
          // A semantic topic match is not proof that the producer repeated the
          // same commitment. The version scope gate owns non-identical requests.
          local.item.idea = request.idea;
          local.item.status = 'queued';
          local.item.completedAt = '';
        }
        if (!model && intent === 'question') {
          local.item.status = 'answered';
          local.item.plannedTasks = [];
          local.item.completedAt = request.createdAt;
          if (!local.item.matchedFact) response = localQuestionResponse(request.idea, known.facts);
          local.item.summary = response;
        }
        if (!model && intent === 'reply') {
          local.item.status = 'answered';
          local.item.plannedTasks = [];
          local.item.completedAt = request.createdAt;
          response = '当前没有可关联的待办或评审；已保留这条回复，但不会据此建立版本或启动任务。';
          local.item.summary = response;
        }
        if (
          !model &&
          intent === 'direction' &&
          !messageIsNewDirection(request.idea) &&
          !local.item.matchedFact
        ) {
          local.item.status = 'answered';
          local.item.plannedTasks = [];
          local.item.completedAt = request.createdAt;
          response =
            '尚无法确认这条消息是否是新方向，已保留待确认；请补充希望新增或调整的目标，不会据此建立版本或启动任务。';
          local.item.summary = response;
          normalizeSecretaryState(state);
          state.orchestration!.intakes.push({
            requestId: request.id,
            intent,
            disposition: 'needs-confirmation',
            status: 'completed',
            targetVersionId: '',
            scopeRevision: null,
            reason: response,
            createdAt: request.createdAt,
            completedAt: new Date().toISOString(),
          });
        }
        if (local.item.matchedFact?.reference.startsWith('secretary:')) {
          local.item.status = 'answered';
          local.item.completedAt = request.createdAt;
          response = `该方向已经在秘书队列中，不会重复派发：${local.item.idea}`;
          local.item.summary = response;
        }
        if (intent === 'direction' && local.item.status === 'queued' && !local.item.matchedFact) {
          response = await routeNewDirection(request, local.item);
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

export async function waitForTerminalSnapshot<T extends { status: string }>(
  readSnapshot: () => Promise<T | null | undefined>,
  attempts = 4,
  settleMs = 100,
): Promise<T | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise((resolveWait) => setTimeout(resolveWait, settleMs));
    const snapshot = await readSnapshot();
    if (
      snapshot &&
      ['review-ready', 'delivered', 'waiting-producer', 'recoverable'].includes(snapshot.status)
    ) {
      return snapshot;
    }
  }
  return undefined;
}

export function observedExitEndsPm(
  source: 'pm' | 'worker',
  exited: { pid: number; identity: string },
  pm: { pid: number; identity: string },
  isAlive: (pid: number, identity: string) => boolean = (pid, identity) =>
    isOwnedProcessAlive(pid, identity, 0),
): boolean {
  const currentPmIsExitedProcess = exited.pid === pm.pid && exited.identity === pm.identity;
  if (pm.pid > 0 && pm.identity && isAlive(pm.pid, pm.identity)) return false;
  if (currentPmIsExitedProcess) return true;
  return source === 'worker' || (pm.pid > 0 && Boolean(pm.identity));
}

async function reconcileAfterProcessExit(
  item: SecretaryItem,
  source: 'pm' | 'worker' = 'pm',
  exited = { pid: item.processPid, identity: item.processIdentity },
): Promise<void> {
  // The wrapper/worker can exit slightly before its atomic terminal snapshot is
  // visible.  Give the writer a short bounded settle window and always re-read
  // from disk before deciding that recovery is required.
  const terminal = await waitForTerminalSnapshot<RunSnapshot>(() => snapshotForItem(item));
  if (terminal) {
    await reconcileItem(item, terminal, true);
    return;
  }
  const latest = item.runDirectory ? await snapshotForItem(item) : null;
  const pm = latest
    ? { pid: latest.processPid, identity: latest.processIdentity }
    : { pid: item.processPid, identity: item.processIdentity };
  await reconcileItem(item, latest ?? undefined, observedExitEndsPm(source, exited, pm));
}

function attachProcessExitNotice(item: SecretaryItem): void {
  const pid = item.processPid;
  const identity = item.processIdentity;
  if (!isOwnedProcessAlive(pid, identity) || processExitNotices.has(pid)) return;
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
    if (stopping || item.processPid !== pid || item.processIdentity !== identity) return;
    const exited = { pid, identity };
    void reconcileAfterProcessExit(item, 'pm', exited)
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
    void reconcileAfterProcessExit(item, 'worker', worker)
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

function scheduleOrphanRecovery(item: SecretaryItem): void {
  if (orphanTimers.has(item.id)) return;
  orphanTimers.set(
    item.id,
    setTimeout(() => {
      orphanTimers.delete(item.id);
      if (item.status !== 'tracking') return;
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
      if (item.orchestration) item.orchestration.processOccupied = false;
      if (canProveExited) {
        if (state.activeItemId === item.id) state.activeItemId = '';
      } else state.activeItemId = item.id;
      void saveState()
        .then(() =>
          canProveExited ? coordinate() : emitNotice('producer-decision', item.summary, item),
        )
        .catch((error) => console.error(`[notice guard] 孤儿运行处理失败：${String(error)}`));
    }, config.guard.orphanRecoveryMinutes * 60_000),
  );
}

function clearOrphanRecovery(itemId: string): void {
  const timer = orphanTimers.get(itemId);
  if (timer) clearTimeout(timer);
  orphanTimers.delete(itemId);
}

async function markMissingSnapshot(item: SecretaryItem, exitCode: number): Promise<void> {
  normalizeSecretaryState(state);
  const firstBlock = item.orchestration!.reconciliationOutcome !== 'missing';
  clearOrphanRecovery(item.id);
  item.status = 'tracking';
  item.retryAt = '';
  item.summary = `运行快照缺失、损坏或不可恢复（退出码 ${exitCode}）；已阻止派发，须恢复运行证据并核实 PM/子 Agent 归属和终态后重新对账。`;
  item.orchestration!.reconciliationOutcome = 'missing';
  const worker = await activeWorkerProcess(item, true);
  item.orchestration!.processOccupied =
    isOwnedProcessAlive(item.processPid, item.processIdentity, 0) || Boolean(worker);
  if (worker) attachWorkerExitNotice(item, worker);
  if (firstBlock) {
    state.orchestration!.reconciliations.push({
      itemId: item.id,
      runId: item.orchestration!.runId,
      attempt: item.orchestration!.attempt,
      snapshotStatus: 'missing',
      outcome: 'missing',
      reason: item.summary,
      evidence: item.runDirectory ? [item.runDirectory] : [],
      reconciledAt: new Date().toISOString(),
    });
    await emitNotice('unsafe-recovery', item.summary, item);
  }
}

async function reportRunProgress(item: SecretaryItem, run: RunSnapshot): Promise<void> {
  if (!['planned', 'running', 'active'].includes(run.status)) return;
  const pmAlive = isOwnedProcessAlive(run.processPid, run.processIdentity, 0);
  const worker = pmAlive ? null : await activeWorkerProcess(item, true);
  if (!pmAlive && !worker) return;
  normalizeSecretaryState(state);
  const orchestration = item.orchestration!;
  const now = new Date().toISOString();
  const decision = progressNoticeDecision(
    orchestration.lastProgressPhase ?? '',
    orchestration.lastProgressNoticeAt ?? '',
    run.phase,
    now,
  );
  if (!decision.notify) return;
  orchestration.lastProgressPhase = decision.phase;
  orchestration.lastProgressNoticeAt = now;
  await saveState();
  const elapsedMinutes = Math.max(0, Math.floor(run.elapsedSeconds / 60));
  const elapsed = elapsedMinutes > 0 ? `，本轮已运行约 ${elapsedMinutes} 分钟` : '';
  await emitNotice(
    decision.heartbeat ? 'progress-heartbeat' : 'progress-transition',
    `${item.scope === 'version' ? '版本' : 'Feature'}进度：${decision.phase}${elapsed}。仍在正常执行，无需你介入。`,
    item,
  );
}

async function reconcileItem(
  item: SecretaryItem,
  supplied?: RunSnapshot,
  processEnded = false,
): Promise<boolean> {
  let run = supplied;
  if (!run && item.runDirectory) {
    run =
      (await snapshotForItem(item)) ??
      (await scanRuns()).find((candidate) => candidate.directory === item.runDirectory) ??
      undefined;
  }
  const launchStartedAt =
    activeLaunchStartedAt.get(item.id) ??
    (['active', 'tracking'].includes(item.status) &&
    isOwnedProcessAlive(item.processPid, item.processIdentity, 0)
      ? item.updatedAt
      : undefined);
  if (!run && launchStartedAt && isBootstrapGraceActive(launchStartedAt)) {
    normalizeSecretaryState(state);
    item.status = 'tracking';
    item.summary = 'PM 已登记运行目录，正在创建首个恢复快照。';
    item.orchestration!.reconciliationOutcome = 'bootstrapping';
    item.orchestration!.processOccupied = true;
    state.activeItemId = item.id;
    const alreadyRecorded = state.orchestration!.reconciliations.some(
      (record) =>
        record.itemId === item.id &&
        record.attempt === item.orchestration!.attempt &&
        record.outcome === 'bootstrapping',
    );
    if (!alreadyRecorded) {
      state.orchestration!.reconciliations.push({
        itemId: item.id,
        runId: item.orchestration!.runId,
        attempt: item.orchestration!.attempt,
        snapshotStatus: 'bootstrapping',
        outcome: 'bootstrapping',
        reason: item.summary,
        evidence: [item.runDirectory],
        reconciledAt: new Date().toISOString(),
      });
    }
    return true;
  }
  if (
    !run ||
    ![
      'planned',
      'running',
      'active',
      'recoverable',
      'waiting-producer',
      'review-ready',
      'delivered',
      'failed',
      'preview',
    ].includes(run.status)
  ) {
    await markMissingSnapshot(item, 1);
    return false;
  }
  normalizeSecretaryState(state);
  const itemOrchestration = item.orchestration!;
  itemOrchestration.runId = run.runId;
  itemOrchestration.attempt = run.attempt;
  const recordReconciliation = (
    outcome: NonNullable<SecretaryItem['orchestration']>['reconciliationOutcome'],
    reason: string,
    evidence: string[] = [],
  ): void => {
    if (!outcome) return;
    itemOrchestration.reconciliationOutcome = outcome;
    const records = state.orchestration!.reconciliations;
    if (
      records.some(
        (record) =>
          record.itemId === item.id &&
          record.runId === run.runId &&
          record.attempt === run.attempt &&
          record.snapshotStatus === run.status &&
          record.outcome === outcome,
      )
    ) {
      return;
    }
    records.push({
      itemId: item.id,
      runId: run.runId,
      attempt: run.attempt,
      snapshotStatus: run.status,
      outcome,
      reason,
      evidence,
      reconciledAt: new Date().toISOString(),
    });
  };
  if (
    item.status === 'active' &&
    activeChild?.exitCode === null &&
    launchStartedAt &&
    snapshotPredatesLaunch(run.updatedAt, launchStartedAt)
  ) {
    return false;
  }
  // A tracked child outlives its PM, so the item may already have cleared the
  // PM reference. Keep using the owned snapshot to recognize that PM's exit.
  processEnded ||= Boolean(
    run.processPid > 0 &&
    run.processIdentity &&
    !isOwnedProcessAlive(run.processPid, run.processIdentity),
  );
  await reportRunProgress(item, run);
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
    const awaitingReview = run.status === 'review-ready';
    const firstDelivery = !state.orchestration!.reconciliations.some(
      (record) =>
        record.itemId === item.id &&
        record.runId === run.runId &&
        record.attempt === run.attempt &&
        record.snapshotStatus === run.status &&
        record.outcome === (awaitingReview ? 'awaiting-review' : 'delivered'),
    );
    const worker = await activeWorkerProcess(item, true);
    const pmOccupied = isOwnedProcessAlive(run.processPid, run.processIdentity, 0);
    const processOccupied = pmOccupied || Boolean(worker);
    item.status = processOccupied ? 'tracking' : 'delivered';
    item.summary = awaitingReview
      ? '本轮实现已完成，等待独立审查；旧恢复与修复摘要已清理。'
      : '本轮交付已完成；旧恢复、阻塞与修复摘要已清理。';
    if (!item.completedAt) item.completedAt = item.updatedAt;
    item.retryAt = '';
    item.recoveryAttempts = 0;
    itemOrchestration.awaitingReview = awaitingReview;
    itemOrchestration.processOccupied = processOccupied;
    item.processPid = pmOccupied ? run.processPid : (worker?.pid ?? 0);
    item.processIdentity = pmOccupied ? run.processIdentity : (worker?.identity ?? '');
    if (state.activeItemId === item.id && !processOccupied) state.activeItemId = '';
    if (processOccupied) state.activeItemId = item.id;
    recordReconciliation(
      awaitingReview ? 'awaiting-review' : 'delivered',
      processOccupied
        ? '终态快照已停止重试，但所属写进程仍占用工作区。'
        : awaitingReview
          ? '待审快照已停止开发派发，正式版本审批状态保持不变。'
          : '本轮交付已完成并清理陈旧恢复状态。',
      [run.directory],
    );
    const queued = state.items.some((candidate) => candidate.status === 'queued');
    clearOrphanRecovery(item.id);
    if (firstDelivery)
      await emitNotice(
        'delivery-complete',
        `${item.scope === 'version' ? '版本' : 'Feature'} ${awaitingReview ? '已进入待审' : '已完成交付'}：${item.idea}。${processOccupied ? '仍等待所属写进程退出，不会启动第二个写进程。' : queued ? '队列中的下一项将自动开始。' : '没有已批准待办时进入休眠。'}`,
        item,
      );
    return true;
  }
  const waitingSnapshot = JSON.stringify([
    run.directory,
    run.runId,
    run.attempt,
    run.status,
    run.updatedAt,
    run.error,
  ]);
  const acknowledgedWaiting =
    ['retry-wait', 'tracking'].includes(item.status) &&
    Boolean(item.retryAt) &&
    itemOrchestration.acknowledgedWaitingSnapshot === waitingSnapshot;
  if (run.status === 'waiting-producer') {
    const worker = await activeWorkerProcess(item, true);
    if (worker || isOwnedProcessAlive(run.processPid, run.processIdentity, 0)) {
      item.status = 'tracking';
      itemOrchestration.processOccupied = true;
      item.processPid = worker?.pid ?? run.processPid;
      item.processIdentity = worker?.identity ?? run.processIdentity;
      if (worker) attachWorkerExitNotice(item, worker);
      recordReconciliation('running', '等待快照仍有写进程，等待退出后处理恢复。', [run.directory]);
      return true;
    }
    if (acknowledgedWaiting) {
      item.status = 'retry-wait';
      itemOrchestration.processOccupied = false;
      recordReconciliation('retry-wait', '该等待快照已由制作人处理，保留恢复派发。', [
        run.directory,
      ]);
      return true;
    }
    clearOrphanRecovery(item.id);
    const firstRequest = item.status !== 'waiting-producer';
    item.status = 'waiting-producer';
    item.summary = run.error || '当前任务需要制作人决定产品方向。';
    item.processPid = 0;
    item.processIdentity = '';
    item.retryAt = '';
    item.recoveryAttempts = 0;
    itemOrchestration.awaitingReview = false;
    itemOrchestration.processOccupied = false;
    itemOrchestration.waitingSnapshot = waitingSnapshot;
    state.activeItemId = item.id;
    recordReconciliation('waiting-producer', item.summary, [run.directory]);
    if (firstRequest) await emitNotice('producer-decision', item.summary, item);
    return true;
  }
  if (run.status === 'recoverable') {
    const worker = await activeWorkerProcess(item, true);
    if (worker || isOwnedProcessAlive(run.processPid, run.processIdentity, 0)) {
      item.status = 'tracking';
      itemOrchestration.processOccupied = true;
      item.processPid = run.processPid;
      item.processIdentity = run.processIdentity;
      recordReconciliation('running', '恢复快照仍有关联写进程，等待退出后重新对账。', [
        run.directory,
      ]);
      if (worker) attachWorkerExitNotice(item, worker);
      return true;
    }
    if (
      item.scope === 'feature' &&
      !(await readJson(resolve(item.runDirectory, 'recovery.json')))
    ) {
      await markMissingSnapshot(item, 1);
      return false;
    }
    itemOrchestration.processOccupied = false;
    clearOrphanRecovery(item.id);
    item.processPid = 0;
    item.processIdentity = '';
    if (acknowledgedWaiting) {
      item.status = 'retry-wait';
      recordReconciliation('retry-wait', '该阻塞快照已由制作人处理，保留恢复派发。', [
        run.directory,
      ]);
      return true;
    }
    const alreadyWaitingForSnapshot =
      !externalBlocker(run.error) &&
      item.status === 'retry-wait' &&
      Boolean(item.retryAt) &&
      state.orchestration!.reconciliations.some(
        (record) =>
          record.itemId === item.id &&
          record.runId === run.runId &&
          record.attempt === run.attempt &&
          record.snapshotStatus === run.status &&
          record.outcome === 'retry-wait',
      );
    if (alreadyWaitingForSnapshot) {
      return true;
    }
    if (externalBlocker(run.error)) {
      const firstBlock = item.status !== 'waiting-producer';
      item.status = 'waiting-producer';
      itemOrchestration.waitingSnapshot = waitingSnapshot;
      item.retryAt = '';
      item.summary = `${run.error || '账号、鉴权或额度暂不可用'}。秘书已暂停当前工作；条件恢复后直接回复秘书即可继续。`;
      state.activeItemId = item.id;
      recordReconciliation('waiting-producer', item.summary, [run.directory]);
      if (firstBlock) await emitNotice('external-blocker', item.summary, item);
      return true;
    }
    if (item.recoveryAttempts >= config.guard.maxRecoveryAttempts) {
      item.status = 'waiting-producer';
      itemOrchestration.waitingSnapshot = waitingSnapshot;
      item.summary = `自动恢复已达到 ${config.guard.maxRecoveryAttempts} 次：${run.error}`;
      await emitNotice('recovery-exhausted', item.summary, item);
      return true;
    }
    const minutes = config.guard.executionRetryMinutes;
    item.status = 'retry-wait';
    item.summary = run.error || '调度运行可恢复，等待下一次自动接管。';
    item.retryAt = new Date(Date.now() + minutes * 60_000).toISOString();
    if (state.activeItemId === item.id) state.activeItemId = '';
    recordReconciliation('retry-wait', item.summary, [run.directory]);
    return true;
  }
  if (run.status === 'failed') {
    await markMissingSnapshot(item, 1);
    return true;
  }
  if (processEnded) {
    const worker = await activeWorkerProcess(item, true);
    if (worker) {
      clearOrphanRecovery(item.id);
      item.status = 'tracking';
      item.summary =
        'PM 已退出，但其子 Agent 仍在运行；秘书会等待该进程结束后再恢复，避免重复编辑。';
      item.retryAt = '';
      item.processPid = 0;
      item.processIdentity = '';
      state.activeItemId = item.id;
      itemOrchestration.processOccupied = true;
      recordReconciliation('running', item.summary, [run.directory]);
      attachWorkerExitNotice(item, worker);
      return true;
    }
    item.status = 'retry-wait';
    item.summary = 'PM 已退出但恢复点仍标记为运行中，将立即从该恢复点接管。';
    item.retryAt = new Date().toISOString();
    item.processPid = 0;
    item.processIdentity = '';
    if (state.activeItemId === item.id) state.activeItemId = '';
    itemOrchestration.processOccupied = false;
    recordReconciliation('retry-wait', item.summary, [run.directory]);
    return true;
  }
  item.status = 'tracking';
  state.activeItemId = item.id;
  itemOrchestration.processOccupied = true;
  recordReconciliation('running', '已核实本轮运行仍在执行或等待所属进程退出。', [run.directory]);
  const worker = await activeWorkerProcess(item);
  if (worker) {
    clearOrphanRecovery(item.id);
    attachWorkerExitNotice(item, worker);
  } else if (isOwnedProcessAlive(run.processPid, run.processIdentity, 0)) {
    clearOrphanRecovery(item.id);
    item.processPid = run.processPid;
    item.processIdentity = run.processIdentity;
    attachProcessExitNotice(item);
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
      throw new Error('既有 Feature 运行缺少 recovery.json，禁止作为新运行启动');
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
  if (
    item.runDirectory &&
    item.scope === 'feature' &&
    !(await readJson(resolve(item.runDirectory, 'recovery.json')))
  ) {
    await markMissingSnapshot(item, 1);
    await saveState();
    return;
  }
  const recovering = item.status === 'retry-wait';
  const recoveryStartedAt = recovering
    ? ([...(state.orchestration?.reconciliations ?? [])]
        .reverse()
        .find((record) => record.itemId === item.id && record.outcome === 'retry-wait')
        ?.reconciledAt ?? item.updatedAt)
    : '';
  clearOrphanRecovery(item.id);
  item.status = 'active';
  item.retryAt = '';
  item.updatedAt = new Date().toISOString();
  activeLaunchStartedAt.set(item.id, item.updatedAt);
  if (item.runDirectory) item.recoveryAttempts += 1;
  normalizeSecretaryState(state);
  item.orchestration!.attempt += 1;
  state.activeItemId = item.id;
  const args = runArgs(item);
  item.orchestration!.runId = item.runDirectory ? basename(item.runDirectory) : item.id;
  const log = openSync(resolve(secretaryRoot, `${item.id}.log`), 'a');
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: workerEnvironment(),
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  closeSync(log);
  activeChild = child;
  item.processPid = child.pid ?? 0;
  item.processIdentity = item.processPid ? await waitForProcessIdentity(item.processPid) : '';
  const launchedProcess = { pid: item.processPid, identity: item.processIdentity };
  await saveState();
  if (recovering) {
    await appendSecretaryTiming(
      `recovery-launch-${item.id}-${item.orchestration!.attempt}`,
      'recovery',
      recoveryStartedAt,
      item.updatedAt,
      item,
    );
  }
  child.on('error', async (error) => {
    item.summary = `无法启动 PM 调度器：${error.message}`;
  });
  child.on('close', () => {
    void (async () => {
      if (activeChild === child) activeChild = null;
      await locateVersionRun(item);
      await reconcileAfterProcessExit(item, 'pm', launchedProcess);
      activeLaunchStartedAt.delete(item.id);
      await saveState();
      await coordinate();
    })().catch((error) => console.error(`[notice guard] PM 退出处理失败：${String(error)}`));
  });
}

export function snapshotPredatesLaunch(
  snapshotUpdatedAt: string,
  launchStartedAt: string,
): boolean {
  const snapshot = Date.parse(snapshotUpdatedAt);
  const launch = Date.parse(launchStartedAt);
  return Number.isFinite(snapshot) && Number.isFinite(launch) && snapshot < launch;
}

export function isBootstrapGraceActive(
  launchStartedAt: string,
  now = Date.now(),
  graceMs = 15_000,
): boolean {
  const started = Date.parse(launchStartedAt);
  return Number.isFinite(started) && now >= started && now - started <= Math.max(0, graceMs);
}

function scheduleRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const firstPending = state.items.find((item) =>
    ['queued', 'retry-wait', 'active', 'tracking', 'waiting-producer'].includes(item.status),
  );
  if (firstPending?.status !== 'retry-wait') return;
  const retryAt = Date.parse(firstPending.retryAt);
  if (!Number.isFinite(retryAt)) return;
  const delay = Math.max(0, retryAt - Date.now());
  retryTimer = setTimeout(() => {
    retryTimer = null;
    requestCoordinate('事项恢复定时器');
  }, delay);
}

function currentGitRevision(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error('无法读取当前代码修订，不能登记版本交付证据');
  }
  return result.stdout.trim();
}

/**
 * Public activity still needs a stable, real code identity when the guard is
 * run from an isolated deployment or test fixture without repository metadata.
 * Formal stage evidence deliberately continues to use currentGitRevision(),
 * because a source snapshot must never stand in for its Git delivery gate.
 */
export function publicCodeRevision(workspaceRoot = root): string {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (git.status === 0 && git.stdout.trim()) return git.stdout.trim();

  const sources = ['package.json', 'scripts']
    .map((path) => resolve(workspaceRoot, path))
    .filter((path) => existsSync(path));
  if (sources.length === 0) {
    throw new Error('无法读取当前代码修订，不能登记公开事件');
  }

  const files: string[] = [];
  const collect = (path: string): void => {
    const entries = readdirSync(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) collect(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  for (const source of sources) {
    if (source.endsWith('package.json')) files.push(source);
    else collect(source);
  }

  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(relative(workspaceRoot, file).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return `source-${hash.digest('hex')}`;
}

function changedFilesBetween(baseRevision: string, headRevision: string): string[] {
  const result = spawnSync('git', ['diff', '--name-only', `${baseRevision}..${headRevision}`], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error('无法核对阶段执行前后的代码树，不能登记版本交付证据');
  }
  return result.stdout
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
}

function nextStage(version: FormalVersion): VersionStage | null {
  const index = version.nodes.findIndex((node) => node.id === version.currentStage);
  return (version.nodes[index + 1]?.id as VersionStage | undefined) ?? null;
}

export function advanceRecordedDirection(version: FormalVersion): boolean {
  if (version.currentStage !== 'direction') return false;
  const target = nextStage(version);
  if (!target) return false;
  setNodeEvidence(version, 'direction', {
    summary: '制作人方向已记录，秘书开始形成版本策划案。',
    artifact: '',
  });
  advanceVersion(version, target);
  return true;
}

export function isFormalVersionWriteConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes('已被其他操作更新，请刷新后重试');
}

async function writeDrivenFormalVersion(version: FormalVersion): Promise<boolean> {
  try {
    await writeFormalVersion(root, version);
    return true;
  } catch (error) {
    if (isFormalVersionWriteConflict(error)) return false;
    throw error;
  }
}

function stageArtifact(version: FormalVersion, stage: VersionStage): string {
  const expected = `${version.documentRoot}/${stage}.md`.replace(/\\/g, '/');
  if (existsSync(resolve(root, expected))) return expected;
  throw new Error(`阶段缺少必需产物：${expected}`);
}

export function parseVersionWorkItems(value: unknown, evidence: string): VersionWorkItem[] {
  if (!isRecord(value) || !Array.isArray(value.workItems) || value.workItems.length === 0) {
    throw new Error('任务拆分必须提供非空 workItems 清单');
  }
  const ids = new Set<string>();
  const workItems = value.workItems.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(entry.id) ||
      typeof entry.title !== 'string' ||
      !entry.title.trim() ||
      typeof entry.owner !== 'string' ||
      !entry.owner.trim() ||
      typeof entry.summary !== 'string' ||
      !entry.summary.trim() ||
      !Array.isArray(entry.affectedPaths) ||
      entry.affectedPaths.length === 0 ||
      entry.affectedPaths.some((path) => typeof path !== 'string' || !path.trim()) ||
      !Array.isArray(entry.acceptanceCommands) ||
      entry.acceptanceCommands.length === 0 ||
      entry.acceptanceCommands.some((command) => typeof command !== 'string' || !command.trim()) ||
      !Array.isArray(entry.dependsOn) ||
      entry.dependsOn.some((dependency) => typeof dependency !== 'string')
    ) {
      throw new Error('任务拆分清单字段不完整或 id 不合法');
    }
    if (ids.has(entry.id)) throw new Error(`任务拆分包含重复 id：${entry.id}`);
    ids.add(entry.id);
    return {
      id: entry.id,
      title: entry.title.trim(),
      owner: entry.owner.trim(),
      status: 'pending' as const,
      dependsOn: [...entry.dependsOn],
      summary: entry.summary.trim(),
      affectedPaths: entry.affectedPaths.map((path) => path.trim()),
      acceptanceCommands: entry.acceptanceCommands.map((command) => command.trim()),
      evidence,
    };
  });
  for (const item of workItems) {
    const unknown = item.dependsOn.find((dependency) => !ids.has(dependency));
    if (unknown) throw new Error(`任务 ${item.id} 引用了不存在的依赖：${unknown}`);
    if (item.dependsOn.includes(item.id)) throw new Error(`任务 ${item.id} 不能依赖自身`);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const byId = new Map(workItems.map((item) => [item.id, item]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`任务拆分包含循环依赖：${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of workItems) visit(item.id);
  return workItems;
}

export function replaceVersionWorkItems(
  version: FormalVersion,
  value: unknown,
  evidence: string,
): VersionWorkItem[] {
  const workItems = parseVersionWorkItems(value, evidence);
  version.workItems = workItems;
  return workItems;
}

type StageCommand = { command: string; exitCode: number };

export function isTaskScopeCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ').toLowerCase();
  if (
    /(?:^|\s)npm(?:\.cmd)?\s+run\s+(?:verify(?::full|:ci)?|coverage|sandbox|test:e2e|build|dist|release)(?:\s|$)/.test(
      normalized,
    )
  ) {
    return false;
  }
  return true;
}

function parseStageCommands(value: unknown): StageCommand[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry) =>
        !isRecord(entry) ||
        typeof entry.command !== 'string' ||
        !entry.command.trim() ||
        !Number.isSafeInteger(entry.exitCode),
    )
  ) {
    throw new Error('测试结论必须包含实际执行命令和退出码');
  }
  return value.map((entry) => ({
    command: String((entry as Record<string, unknown>).command),
    exitCode: Number((entry as Record<string, unknown>).exitCode),
  }));
}

function parseStringEvidence(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error('阶段结论必须包含公开证据');
  }
  return value.map(String);
}

export function parseDesignReviewResult(value: unknown): {
  decision: 'approved' | 'changes-requested' | 'producer-escalation';
  summary: string;
} {
  if (
    !isRecord(value) ||
    !['approved', 'changes-requested', 'producer-escalation'].includes(String(value.decision)) ||
    typeof value.summary !== 'string' ||
    !value.summary.trim()
  ) {
    throw new Error('主策审核结论格式无效');
  }
  return {
    decision: value.decision as 'approved' | 'changes-requested' | 'producer-escalation',
    summary: value.summary.trim(),
  };
}

export function parseDevelopmentResult(
  value: unknown,
  workItems: VersionWorkItem[],
): Array<{
  id: string;
  status: 'completed' | 'skipped';
  typecheck: 'passed' | 'failed';
  targetedTests: 'passed' | 'failed';
  commands: StageCommand[];
  evidence: string[];
}> {
  if (!isRecord(value) || !Array.isArray(value.workItems)) {
    throw new Error('开发阶段缺少逐工作项结果');
  }
  const expected = workItems.filter((item) => item.status !== 'skipped').map((item) => item.id);
  const entries = value.workItems.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      !['completed', 'skipped'].includes(String(entry.status)) ||
      !['passed', 'failed'].includes(String(entry.typecheck)) ||
      !['passed', 'failed'].includes(String(entry.targetedTests))
    ) {
      throw new Error('开发工作项结果格式无效');
    }
    const status = entry.status as 'completed' | 'skipped';
    const commands =
      status === 'skipped' && entry.commands === undefined
        ? []
        : parseStageCommands(entry.commands);
    const passedCommands = commands
      .filter((command) => command.exitCode === 0)
      .map((command) => command.command);
    if (
      status === 'completed' &&
      (passedCommands.length === 0 ||
        commands.some((command) => !isTaskScopeCommand(command.command)) ||
        (entry.typecheck === 'passed' &&
          !passedCommands.some((command) => /(?:typecheck|\btsc\b)/i.test(command))) ||
        (entry.targetedTests === 'passed' &&
          !passedCommands.some((command) =>
            /(?:\btest\b|vitest|startVitest|eslint|prettier|docs:check|check-docs)/i.test(command),
          )))
    ) {
      throw new Error('完成的 Task 必须登记实际运行且至少一项通过的类型、定向测试或文档检查命令');
    }
    return {
      id: entry.id,
      status,
      typecheck: entry.typecheck as 'passed' | 'failed',
      targetedTests: entry.targetedTests as 'passed' | 'failed',
      commands,
      evidence: parseStringEvidence(entry.evidence),
    };
  });
  if (
    new Set(entries.map((entry) => entry.id)).size !== entries.length ||
    expected.some((id) => !entries.some((entry) => entry.id === id)) ||
    entries.some((entry) => !expected.includes(entry.id))
  ) {
    throw new Error('开发结果必须与正式版本实际工作项逐一对应');
  }
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const workItemsById = new Map(workItems.map((item) => [item.id, item]));
  const ordered: typeof entries = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    for (const dependency of workItemsById.get(id)?.dependsOn ?? []) {
      if (entriesById.has(dependency)) visit(dependency);
    }
    visited.add(id);
    ordered.push(entriesById.get(id)!);
  };
  for (const item of workItems) {
    if (entriesById.has(item.id)) visit(item.id);
  }
  return ordered;
}

interface QaManifestBug {
  id: string;
  title: string;
  severity: 'blocker' | 'high' | 'medium' | 'low';
  expected: string;
  actual: string;
  evidence: string;
  linkedWorkItemId: string;
}

export function parseQaResult(
  value: unknown,
  workItems: VersionWorkItem[],
): {
  status: 'passed' | 'failed';
  suites: Array<'acceptance' | 'integration' | 'regression'>;
  commands: StageCommand[];
  evidence: string[];
  bugs: QaManifestBug[];
} {
  if (!isRecord(value) || !['passed', 'failed'].includes(String(value.status))) {
    throw new Error('QA 结论格式无效');
  }
  const required = ['acceptance', 'integration', 'regression'] as const;
  const suites = Array.isArray(value.suites) ? value.suites : [];
  if (required.some((suite) => !suites.includes(suite))) {
    throw new Error('QA 结论缺少验收、集成或回归套件');
  }
  if (!Array.isArray(value.bugs)) throw new Error('QA 结论缺少 bugs 清单');
  const workItemIds = new Set(workItems.map((item) => item.id));
  const ids = new Set<string>();
  const bugs = value.bugs.map((bug) => {
    if (
      !isRecord(bug) ||
      typeof bug.id !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(bug.id) ||
      ids.has(bug.id) ||
      typeof bug.title !== 'string' ||
      !bug.title.trim() ||
      !['blocker', 'high', 'medium', 'low'].includes(String(bug.severity)) ||
      typeof bug.expected !== 'string' ||
      typeof bug.actual !== 'string' ||
      typeof bug.evidence !== 'string' ||
      !bug.evidence.trim() ||
      typeof bug.linkedWorkItemId !== 'string' ||
      (bug.linkedWorkItemId && !workItemIds.has(bug.linkedWorkItemId))
    ) {
      throw new Error('QA 缺陷记录格式无效或未关联真实工作项');
    }
    ids.add(bug.id);
    return bug as unknown as QaManifestBug;
  });
  if (
    (value.status === 'passed' && bugs.length > 0) ||
    (value.status === 'failed' && bugs.length === 0)
  ) {
    throw new Error('QA 状态必须与缺陷清单一致');
  }
  return {
    status: value.status as 'passed' | 'failed',
    suites: [...required],
    commands: parseStageCommands(value.commands),
    evidence: parseStringEvidence(value.evidence),
    bugs,
  };
}

export function parseBugfixResult(
  value: unknown,
  bugIds: string[],
): Array<{ bugId: string; evidence: string[] }> {
  if (!isRecord(value) || !Array.isArray(value.fixes)) throw new Error('缺陷修复缺少 fixes 清单');
  const fixes = value.fixes.map((fix) => {
    if (!isRecord(fix) || typeof fix.bugId !== 'string') throw new Error('缺陷修复记录格式无效');
    return { bugId: fix.bugId, evidence: parseStringEvidence(fix.evidence) };
  });
  if (
    new Set(fixes.map((fix) => fix.bugId)).size !== fixes.length ||
    bugIds.some((id) => !fixes.some((fix) => fix.bugId === id)) ||
    fixes.some((fix) => !bugIds.includes(fix.bugId))
  ) {
    throw new Error('缺陷修复结果必须逐项覆盖全部待修缺陷');
  }
  return fixes;
}

export function parseReverificationResult(
  value: unknown,
  bugIds: string[],
): {
  status: 'passed' | 'failed';
  commands: StageCommand[];
  evidence: string[];
} {
  if (!isRecord(value) || !['passed', 'failed'].includes(String(value.status))) {
    throw new Error('缺陷复验结果必须逐项覆盖全部待复验缺陷和必要套件');
  }
  const actualBugIds = Array.isArray(value.bugIds) ? value.bugIds : [];
  const suites = Array.isArray(value.suites) ? value.suites : [];
  if (
    !['acceptance', 'integration', 'regression', 'defect-reverification'].every((suite) =>
      suites.includes(suite),
    ) ||
    new Set(actualBugIds).size !== actualBugIds.length ||
    bugIds.some((id) => !actualBugIds.includes(id)) ||
    actualBugIds.some((id) => typeof id !== 'string' || !bugIds.includes(id))
  ) {
    throw new Error('缺陷复验结果必须逐项覆盖全部待复验缺陷和必要套件');
  }
  return {
    status: value.status as 'passed' | 'failed',
    commands: parseStageCommands(value.commands),
    evidence: parseStringEvidence(value.evidence),
  };
}

function reportChangedFiles(report: Record<string, unknown>): string[] {
  if (!Array.isArray(report.tasks)) return [];
  return report.tasks.flatMap((task) =>
    isRecord(task) && Array.isArray(task.changedFiles)
      ? task.changedFiles.filter((path): path is string => typeof path === 'string')
      : [],
  );
}

export function nonDocumentationChanges(paths: string[]): string[] {
  return paths.filter((path) => !path.replace(/\\/g, '/').startsWith('docs/'));
}

interface FeatureGateArtifact {
  schemaVersion: 1;
  workspaceFingerprint: string;
  configFingerprint: string;
  command: string;
  commandFingerprint: string;
  executionRound?: number;
  log?: string;
  exitCode: 0;
  createdAt: string;
}

function fingerprintStrings(values: string[]): string {
  return createHash('sha256').update(values.join('\0')).digest('hex');
}

export function validationTreeFingerprintForPaths(paths: string[], workspaceRoot = root): string {
  const hash = createHash('sha256');
  for (const path of [...new Set(paths)].filter(isValidationTreePath).sort()) {
    hash.update(path);
    hash.update('\0');
    hash.update(
      existsSync(resolve(workspaceRoot, path))
        ? readFileSync(resolve(workspaceRoot, path))
        : '[deleted]',
    );
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function currentValidationTreeFingerprint(workspaceRoot = root): string {
  const gitPaths = (args: string[]): string[] => {
    const result = spawnSync('git', args, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error('无法计算正式验证代码树指纹');
    return result.stdout.split('\0').filter(Boolean);
  };
  const paths = [
    ...gitPaths(['-c', 'core.quotePath=false', 'ls-files', '-z']),
    ...gitPaths(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z']),
  ];
  return validationTreeFingerprintForPaths(paths, workspaceRoot);
}

export function currentValidationConfigFingerprint(workspaceRoot = root): string {
  const hash = createHash('sha256');
  for (const path of [
    'package.json',
    'package-lock.json',
    'agents/policy.json',
    'vite.config.ts',
  ]) {
    hash.update(path);
    hash.update(
      existsSync(resolve(workspaceRoot, path))
        ? readFileSync(resolve(workspaceRoot, path))
        : '[missing]',
    );
  }
  return hash.digest('hex');
}

async function readFeatureGateArtifact(runDirectory: string): Promise<FeatureGateArtifact> {
  const path = resolve(runDirectory, 'full-gate-evidence.json');
  const value = await readJson(path);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.exitCode !== 0 ||
    typeof value.workspaceFingerprint !== 'string' ||
    typeof value.configFingerprint !== 'string' ||
    typeof value.commandFingerprint !== 'string' ||
    value.command !== 'npm run verify:full' ||
    typeof value.createdAt !== 'string'
  ) {
    throw new Error('Feature PM 缺少可登记的完整门禁证据');
  }
  if (value.workspaceFingerprint !== currentValidationTreeFingerprint()) {
    throw new Error('Feature 完整门禁证据与当前代码树不匹配');
  }
  if (
    value.configFingerprint !== currentValidationConfigFingerprint() ||
    value.commandFingerprint !== fingerprintStrings([value.command])
  ) {
    throw new Error('Feature 完整门禁证据与当前命令或验证配置不匹配');
  }
  return value as unknown as FeatureGateArtifact;
}

export function latestReusableFeatureGate(
  version: FormalVersion,
  codeRevision: string,
  currentGitTree = currentValidationTreeFingerprint(),
  currentConfigFingerprint = currentValidationConfigFingerprint(),
  currentCommand = 'npm run verify:full',
): ValidationEvidence {
  const currentCommandFingerprint = fingerprintStrings([currentCommand]);
  const records = version.orchestration?.validationEvidence ?? [];
  for (const candidate of [...records].reverse()) {
    if (
      candidate.scope !== 'feature' ||
      candidate.codeRevision !== codeRevision ||
      !candidate.commands.some(
        (command) => command.command === 'npm run verify:full' && command.exitCode === 0,
      )
    ) {
      continue;
    }
    const reusable = reusableValidationEvidence(version, {
      scope: 'feature',
      ownerId: candidate.ownerId,
      gitTree: currentGitTree,
      codeRevision,
      commandFingerprint: currentCommandFingerprint,
      configFingerprint: currentConfigFingerprint,
    });
    if (reusable?.id === candidate.id) return reusable;
  }
  throw new Error('Version QA 缺少与候选修订匹配的 Feature verify:full 证据');
}

function reportValidationProfile(report: Record<string, unknown>): string {
  return isRecord(report.validation) && typeof report.validation.profile === 'string'
    ? report.validation.profile
    : 'task';
}

function reportExecutionRound(report: Record<string, unknown>): number {
  return isRecord(report.validation) &&
    Number.isInteger(report.validation.executionRound) &&
    Number(report.validation.executionRound) > 0
    ? Number(report.validation.executionRound)
    : 1;
}

function assertVerificationDidNotChangeImplementation(
  report: Record<string, unknown>,
  stage: 'qa' | 'bugfix-reverification' | 'candidate',
  testedRevision?: string,
  currentRevision?: string,
): void {
  const reported = nonDocumentationChanges(reportChangedFiles(report));
  const committed =
    testedRevision && currentRevision
      ? nonDocumentationChanges(changedFilesBetween(testedRevision, currentRevision))
      : [];
  const invalid = [...new Set([...reported, ...committed])];
  if (invalid.length > 0) {
    throw new Error(`${stage} 阶段改变了已测试的实现或测试代码：${invalid.join('、')}`);
  }
}

export function applyAutomaticStagePolicy(version: FormalVersion, stage: VersionStage): boolean {
  const current = currentVersionStagePolicy(version, stage);
  if (current.decidedBy !== 'version-kernel' || current.policyRevision !== 1) return false;
  const normalized = version.direction.replace(/\s/g, '');
  const explicitlyDocumentationOnly =
    /^(?:仅|只|纯文档)?(?:完善|更新|整理|补充|修订|编写|校对).*(?:文档|说明|指南)$/.test(
      normalized,
    );
  if (!explicitlyDocumentationOnly) return false;
  const plan = buildLocalPlan(version.direction);
  if (plan.tasks.length === 0 || plan.tasks.some((task) => task.type !== 'documentation'))
    return false;
  const reasons: Partial<Record<VersionStage, string>> = {
    'module-design': '该版本只有文档交付，版本策划已覆盖所需规则，无需另写模块详细策划。',
    'design-review': '没有独立模块策划产物，无需增加主策复审轮次。',
    'version-planning': '只有一个文档交付工作项，无需单独排期。',
    qa: '没有运行时代码或玩家流程变化，无需执行版本运行时测试。',
    candidate: '没有新增可执行构建，现有文档即为制作人可评审产物。',
  };
  const reason = reasons[stage];
  if (!reason) return false;
  recordStagePolicy(version, {
    stage,
    mode: 'skip',
    reason,
    evidence: [`${version.documentRoot}/charter.md`.replace(/\\/g, '/')],
    decidedBy: 'notice-guard',
    scopeRevision: formalScopeRevision(version),
  });
  return true;
}

async function finalizeDeliveredVersionStage(
  version: FormalVersion,
  item: SecretaryItem,
): Promise<boolean> {
  const stage = item.orchestration?.formalStage as VersionStage | undefined;
  if (!stage || version.currentStage !== stage || item.status !== 'delivered') return false;
  version = structuredClone(version);
  const target = nextStage(version);
  if (!target) return false;
  const reportPath = item.runDirectory ? resolve(item.runDirectory, 'report.json') : '';
  const report = reportPath ? await readJson(reportPath) : null;
  if (!isRecord(report) || report.status !== '已交付') {
    throw new Error('阶段运行缺少 PM 交付报告');
  }
  const validationProfile = reportValidationProfile(report);
  if (
    validationProfile !== 'light' &&
    (!isRecord(report.review) || report.review.verdict !== 'pass')
  ) {
    throw new Error('阶段运行缺少当前验证 Profile 要求的独立审查通过报告');
  }
  const evidence = item.runDirectory ? relative(root, reportPath).replace(/\\/g, '/') : item.id;
  const revision = currentGitRevision();
  const artifact = stageArtifact(version, stage);
  setNodeEvidence(version, stage, {
    artifact,
    summary: `该阶段已由秘书调度完成；交付证据：${evidence}。`,
  });

  if (stage === 'design-review') {
    const manifestPath = `${version.documentRoot}/design-review.json`.replace(/\\/g, '/');
    const result = parseDesignReviewResult(await readJson(resolve(root, manifestPath)));
    if (result.decision === 'changes-requested') {
      setNodeEvidence(version, stage, { artifact, summary: result.summary });
      recordApproval(version, {
        stage,
        reviewer: 'lead-designer',
        decision: 'changes-requested',
        documentRevision: version.charterRevision,
        comment: `${result.summary}；证据：${evidence}`,
      });
      await writeFormalVersion(root, version);
      item.orchestration!.formalStageConsumedAt = new Date().toISOString();
      await emitNotice(
        'version-design-changes-requested',
        `主策已退回“${version.title}”的详细策划：${result.summary} 秘书将自动安排修订与复审。`,
        item,
      );
      return true;
    }
    if (result.decision === 'producer-escalation') {
      addDecisionGate(version, {
        kind: 'producer-escalated-design',
        stage,
        summary: result.summary,
        sourceRequestId: item.id,
      });
      await writeFormalVersion(root, version);
      item.orchestration!.formalStageConsumedAt = new Date().toISOString();
      await emitNotice(
        'version-design-escalated',
        `主策将“${version.title}”的详细策划升级给制作人：${result.summary}`,
        item,
      );
      return true;
    }
    recordApproval(version, {
      stage,
      reviewer: 'lead-designer',
      decision: 'approved',
      documentRevision: version.charterRevision,
      comment: `${result.summary}；证据：${evidence}`,
    });
  }
  if (stage === 'task-breakdown') {
    const manifest = `${version.documentRoot}/task-breakdown.json`.replace(/\\/g, '/');
    const manifestValue = await readJson(resolve(root, manifest));
    replaceVersionWorkItems(version, manifestValue, manifest);
  }
  if (stage === 'development') {
    if (version.workItems.length === 0) {
      throw new Error('开发阶段缺少经任务拆分登记的工作项');
    }
    const manifest = `${version.documentRoot}/development.json`.replace(/\\/g, '/');
    const results = parseDevelopmentResult(
      await readJson(resolve(root, manifest)),
      version.workItems,
    );
    const gate = await readFeatureGateArtifact(item.runDirectory!);
    const taskEvidenceIds: string[] = [];
    for (const result of results) {
      if (
        result.status === 'completed' &&
        (result.typecheck !== 'passed' || result.targetedTests !== 'passed')
      ) {
        throw new Error(`工作项 ${result.id} 尚未形成通过的实现与自测证据`);
      }
      const workItem = version.workItems.find((candidate) => candidate.id === result.id)!;
      workItem.status = result.status;
      workItem.evidence = manifest;
      if (result.status === 'completed') {
        recordFeatureVerification(version, {
          workItemId: result.id,
          agentId: `feature:${item.id}`,
          codeRevision: revision,
          typecheck: result.typecheck,
          targetedTests: result.targetedTests,
          evidence: [evidence, manifest, ...result.evidence],
        });
        const commands = result.commands;
        const taskEvidence = recordValidationEvidence(version, {
          scope: 'task',
          ownerId: result.id,
          status: 'passed',
          gitTree: gate.workspaceFingerprint,
          codeRevision: revision,
          commandFingerprint: fingerprintStrings(
            commands.map((command) => `${command.command}\0${command.exitCode}`),
          ),
          configFingerprint: gate.configFingerprint,
          affectedPaths: workItem.affectedPaths ?? [],
          inputEvidenceIds: workItem.dependsOn
            .map((dependency) =>
              (version.orchestration?.validationEvidence ?? [])
                .filter(
                  (entry) =>
                    entry.scope === 'task' &&
                    entry.ownerId === dependency &&
                    entry.codeRevision === revision &&
                    !entry.invalidatedAt,
                )
                .at(-1),
            )
            .filter((entry): entry is ValidationEvidence => Boolean(entry))
            .map((entry) => entry.id),
          outputFingerprint: fingerprintStrings([
            result.id,
            result.typecheck,
            result.targetedTests,
            ...result.evidence,
          ]),
          executionRound: gate.executionRound ?? reportExecutionRound(report),
          commands,
          evidence: [manifest, ...result.evidence],
        });
        taskEvidenceIds.push(taskEvidence.id);
      }
    }
    recordValidationEvidence(version, {
      scope: 'feature',
      ownerId: item.id,
      status: 'passed',
      gitTree: gate.workspaceFingerprint,
      codeRevision: revision,
      commandFingerprint: gate.commandFingerprint ?? fingerprintStrings([gate.command]),
      configFingerprint: gate.configFingerprint,
      affectedPaths: version.workItems.flatMap((workItem) => workItem.affectedPaths ?? []),
      inputEvidenceIds: taskEvidenceIds,
      outputFingerprint: gate.workspaceFingerprint,
      executionRound: gate.executionRound ?? reportExecutionRound(report),
      commands: [{ command: gate.command, exitCode: 0 }],
      evidence: [
        evidence,
        manifest,
        gate.log || relative(root, resolve(item.runDirectory!, 'full-gate-evidence.json')),
      ],
    });
  }
  if (stage === 'qa') {
    const testedRevision = version.orchestration?.codeRevision;
    if (!testedRevision) throw new Error('版本 QA 缺少开发候选修订');
    assertVerificationDidNotChangeImplementation(report, 'qa', testedRevision, revision);
    const manifest = `${version.documentRoot}/qa.json`.replace(/\\/g, '/');
    const result = parseQaResult(await readJson(resolve(root, manifest)), version.workItems);
    const existingBugIds = new Set(version.bugs.map((bug) => bug.id));
    if (result.bugs.some((bug) => existingBugIds.has(bug.id))) {
      throw new Error('QA 结果包含重复缺陷 id');
    }
    version.bugs.push(
      ...result.bugs.map((bug) => ({
        ...bug,
        status: 'open' as const,
        verificationRunId: '',
      })),
    );
    const featureGate = latestReusableFeatureGate(version, testedRevision);
    const qa = recordQaRun(version, {
      agentId: `qa:${item.id}`,
      independent: true,
      codeRevision: testedRevision,
      suites: result.suites,
      status: result.status,
      commands: result.commands,
      evidence: [evidence, manifest, ...result.evidence],
      reusedFeatureEvidenceId: featureGate.id,
      gitTree: featureGate.gitTree,
      commandFingerprint: featureGate.commandFingerprint,
      configFingerprint: featureGate.configFingerprint,
    });
    recordValidationEvidence(version, {
      scope: 'version',
      ownerId: qa.id,
      status: result.status,
      gitTree: featureGate.gitTree,
      codeRevision: testedRevision,
      commandFingerprint: fingerprintStrings(result.commands.map((command) => command.command)),
      configFingerprint: featureGate.configFingerprint,
      affectedPaths: version.workItems.flatMap((workItem) => workItem.affectedPaths ?? []),
      inputEvidenceIds: [featureGate.id],
      outputFingerprint: fingerprintStrings([result.status, ...result.suites, ...result.evidence]),
      executionRound: reportExecutionRound(report),
      commands: result.commands,
      evidence: [evidence, manifest, ...result.evidence],
    });
  }
  if (stage === 'bugfix') {
    const bugs = version.bugs.filter((bug) => !['closed', 'deferred'].includes(bug.status));
    const stageStep = item.orchestration?.formalStageStep ?? 'primary';
    if (bugs.length > 0 && stageStep === 'primary') {
      const fixable = bugs.filter((bug) => bug.status !== 'verify');
      const previousRevision =
        version.orchestration?.qaRuns.at(-1)?.codeRevision ?? version.orchestration?.codeRevision;
      if (previousRevision && previousRevision !== revision) {
        invalidateValidationEvidence(version, {
          changedPaths: changedFilesBetween(previousRevision, revision),
        });
      }
      const gate = await readFeatureGateArtifact(item.runDirectory!);
      recordValidationEvidence(version, {
        scope: 'feature',
        ownerId: item.id,
        status: 'passed',
        gitTree: gate.workspaceFingerprint,
        codeRevision: revision,
        commandFingerprint: gate.commandFingerprint ?? fingerprintStrings([gate.command]),
        configFingerprint: gate.configFingerprint,
        affectedPaths: fixable.flatMap((bug) => {
          const workItem = version.workItems.find((entry) => entry.id === bug.linkedWorkItemId);
          return workItem?.affectedPaths ?? [];
        }),
        inputEvidenceIds: [],
        outputFingerprint: gate.workspaceFingerprint,
        executionRound: gate.executionRound ?? reportExecutionRound(report),
        commands: [{ command: gate.command, exitCode: 0 }],
        evidence: [
          evidence,
          gate.log || relative(root, resolve(item.runDirectory!, 'full-gate-evidence.json')),
        ],
      });
      const manifest = `${version.documentRoot}/bugfix.json`.replace(/\\/g, '/');
      const fixes = parseBugfixResult(
        await readJson(resolve(root, manifest)),
        fixable.map((bug) => bug.id),
      );
      for (const fix of fixes) {
        const bug = version.bugs.find((candidate) => candidate.id === fix.bugId)!;
        if (bug.status === 'open') transitionVersionBug(version, bug.id, 'fixing');
        transitionVersionBug(version, bug.id, 'verify', '', revision);
        bug.evidence = `${bug.evidence}\n${fix.evidence.join('\n')}`.trim();
      }
      for (const bug of version.bugs.filter((candidate) => candidate.status === 'verify')) {
        bug.fixCodeRevision = revision;
      }
      await writeFormalVersion(root, version);
      item.orchestration!.formalStageConsumedAt = new Date().toISOString();
      await emitNotice(
        'version-bugfix-awaiting-reverification',
        `版本“${version.title}”的缺陷修复已提交，秘书将安排独立测试 Agent 复验后再继续。`,
        item,
      );
      return true;
    }
    if (bugs.length > 0 && stageStep === 'reverification') {
      if (bugs.some((bug) => bug.status !== 'verify')) {
        throw new Error('独立缺陷复验只能消费全部处于待复验状态的缺陷');
      }
      const revisions = new Set(bugs.map((bug) => bug.fixCodeRevision).filter(Boolean));
      if (revisions.size !== 1) {
        throw new Error('独立缺陷复验缺少已提交的修复代码修订');
      }
      const testedRevision = [...revisions][0]!;
      assertVerificationDidNotChangeImplementation(
        report,
        'bugfix-reverification',
        testedRevision,
        revision,
      );
      const manifest = `${version.documentRoot}/bugfix-reverification.json`.replace(/\\/g, '/');
      const result = parseReverificationResult(
        await readJson(resolve(root, manifest)),
        bugs.map((bug) => bug.id),
      );
      const featureGate = latestReusableFeatureGate(version, testedRevision);
      const qa = recordQaRun(version, {
        agentId: `qa:${item.id}`,
        independent: true,
        codeRevision: testedRevision,
        suites: ['acceptance', 'integration', 'regression', 'defect-reverification'],
        status: result.status,
        commands: result.commands,
        evidence: [evidence, manifest, ...result.evidence],
        bugFixes: bugs.map((bug) => ({ bugId: bug.id, fixAttemptId: bug.fixAttemptId! })),
        reusedFeatureEvidenceId: featureGate.id,
        gitTree: featureGate.gitTree,
        commandFingerprint: featureGate.commandFingerprint,
        configFingerprint: featureGate.configFingerprint,
      });
      recordValidationEvidence(version, {
        scope: 'version',
        ownerId: qa.id,
        status: result.status,
        gitTree: featureGate.gitTree,
        codeRevision: testedRevision,
        commandFingerprint: fingerprintStrings(result.commands.map((command) => command.command)),
        configFingerprint: featureGate.configFingerprint,
        affectedPaths: bugs.flatMap((bug) => {
          const workItem = version.workItems.find((entry) => entry.id === bug.linkedWorkItemId);
          return workItem?.affectedPaths ?? [];
        }),
        inputEvidenceIds: [featureGate.id],
        outputFingerprint: fingerprintStrings([
          result.status,
          ...bugs.map((bug) => bug.fixAttemptId ?? ''),
          ...result.evidence,
        ]),
        executionRound: reportExecutionRound(report),
        commands: result.commands,
        evidence: [evidence, manifest, ...result.evidence],
      });
      if (result.status === 'failed') {
        for (const bug of bugs) transitionVersionBug(version, bug.id, 'open');
        await writeFormalVersion(root, version);
        item.orchestration!.formalStageConsumedAt = new Date().toISOString();
        await emitNotice(
          'version-bugfix-reverification-failed',
          `版本“${version.title}”的独立缺陷复验未通过，秘书将自动安排下一轮修复。`,
          item,
        );
        return true;
      }
      for (const bug of bugs) transitionVersionBug(version, bug.id, 'closed', qa.id);
    }
  }
  if (stage === 'candidate') {
    const testedRevision =
      version.orchestration?.qaRuns.at(-1)?.codeRevision ?? version.orchestration?.codeRevision;
    assertVerificationDidNotChangeImplementation(report, 'candidate', testedRevision, revision);
  }

  advanceVersion(version, target);
  await writeFormalVersion(root, version);
  item.orchestration!.formalStageConsumedAt = new Date().toISOString();
  await emitNotice(
    'version-stage-complete',
    `版本“${version.title}”的“${version.nodes.find((node) => node.id === stage)?.title ?? stage}”已完成，秘书继续推进“${version.nodes.find((node) => node.id === target)?.title ?? target}”。`,
    item,
  );
  return true;
}

async function driveFormalVersion(): Promise<boolean> {
  let version = await readFormalVersion(root);
  if (!version || version.status === 'archived' || version.status === 'paused') return false;
  let changed = false;
  for (let guard = 0; guard < version.nodes.length; guard += 1) {
    if (version.status === 'waiting-producer' || PRODUCER_STAGES.has(version.currentStage)) break;
    const stage = version.currentStage;
    if (applyAutomaticStagePolicy(version, stage)) {
      if (!(await writeDrivenFormalVersion(version))) {
        const refreshed = await readFormalVersion(root);
        if (!refreshed) return changed;
        version = refreshed;
        changed = true;
        continue;
      }
    }
    const policy = currentVersionStagePolicy(version, stage);
    if (
      stage === 'bugfix' &&
      policy.mode !== 'skip' &&
      version.bugs.every((bug) => ['closed', 'deferred'].includes(bug.status))
    ) {
      recordStagePolicy(version, {
        stage,
        mode: 'skip',
        reason: '独立版本测试没有留下待修缺陷，本版本无需缺陷修复轮次。',
        evidence: version.orchestration?.qaRuns.at(-1)?.evidence ?? [],
        decidedBy: 'notice-guard',
        scopeRevision: formalScopeRevision(version),
      });
      continue;
    }
    if (policy.mode === 'skip') {
      const target = nextStage(version);
      if (!target) break;
      setNodeEvidence(version, stage, { summary: policy.reason, artifact: '' });
      advanceVersion(version, target);
      if (!(await writeDrivenFormalVersion(version))) {
        const refreshed = await readFormalVersion(root);
        if (!refreshed) return changed;
        version = refreshed;
        changed = true;
        continue;
      }
      await emitNotice(
        'version-stage-not-required',
        `版本“${version.title}”的“${version.nodes.find((node) => node.id === stage)?.title ?? stage}”无需执行：${policy.reason} 秘书继续推进下一阶段。`,
      );
      changed = true;
      continue;
    }
    if (stage === 'direction') {
      if (!advanceRecordedDirection(version)) break;
      if (!(await writeDrivenFormalVersion(version))) {
        const refreshed = await readFormalVersion(root);
        if (!refreshed) return changed;
        version = refreshed;
        changed = true;
        continue;
      }
      changed = true;
      continue;
    }
    const delivered = state.items
      .filter(
        (item) =>
          item.status === 'delivered' &&
          !item.orchestration?.formalStageConsumedAt &&
          item.orchestration?.formalVersionId === version!.id &&
          item.orchestration.formalStage === stage &&
          item.orchestration.formalScopeRevision === formalScopeRevision(version!) &&
          (item.orchestration.formalStageStep ?? 'primary') ===
            expectedVersionStageStep(version!, stage),
      )
      .at(-1);
    if (delivered) {
      const attemptedRevision = version.stateRevision;
      try {
        if (await finalizeDeliveredVersionStage(version, delivered)) {
          changed = true;
          version = (await readFormalVersion(root)) ?? version;
          continue;
        }
      } catch (error) {
        delivered.summary = `阶段交付未能写入正式版本，将自动安排修复：${error instanceof Error ? error.message : String(error)}`;
        const persisted = await readFormalVersion(root);
        if (persisted?.id === version.id) {
          version = persisted;
          if (persisted.stateRevision !== attemptedRevision) {
            delete delivered.orchestration!.formalStageConsumedAt;
            changed = true;
            continue;
          }
        }
        delivered.orchestration!.formalStageConsumedAt = new Date().toISOString();
      }
    }
    const queued = ensureVersionStageItem(state, version);
    if (queued) {
      await emitNotice(
        'version-stage-scheduled',
        `秘书已安排版本“${version.title}”的“${version.nodes.find((node) => node.id === stage)?.title ?? stage}”，完成后自动继续。`,
        queued,
      );
      changed = true;
    }
    break;
  }
  return changed;
}

export async function persistScheduleCorrections(
  secretaryState: SecretaryState,
  publish: (correction: SecretaryItemResolution) => Promise<void>,
  persist: () => Promise<void>,
  now: () => string = () => new Date().toISOString(),
): Promise<number> {
  const corrections = pendingScheduleCorrections(secretaryState);
  for (const correction of corrections) {
    await publish(correction);
    correction.correctionSentAt = now();
    await persist();
  }
  return corrections.length;
}

async function coordinateOnce(): Promise<void> {
  if (stopping) return;
  // Re-arm only after the entire queue is reconciled and dispatch is unblocked.
  // Due retries blocked by a decision or writer wait for that owner's next event.
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const stateBeforeNormalization = JSON.stringify(state);
  const normalized = normalizeSecretaryState(state);
  const persistedCorrections = await persistScheduleCorrections(
    state,
    async (correction) => {
      const item = state.items.find((candidate) => candidate.id === correction.itemId);
      await emitNotice(
        'schedule-correction',
        `排期更正：${correction.reason} 原候选已标记为 ${correction.status}，不再计入待办。`,
        item,
        undefined,
        correction.correctionNoticeId,
      );
    },
    saveState,
  );
  const stateBeforeReconciliation = JSON.stringify(state);
  const targets = reconciliationTargets(state);
  let reconciliationFailed = false;
  for (const item of targets) {
    if (!item.runDirectory && item.scope === 'version') await locateVersionRun(item);
    if (!item.runDirectory) continue;
    const processEnded =
      item.processPid > 0 &&
      Boolean(item.processIdentity) &&
      !isOwnedProcessAlive(item.processPid, item.processIdentity);
    if (!(await reconcileItem(item, undefined, processEnded))) reconciliationFailed = true;
    if (isOwnedProcessAlive(item.processPid, item.processIdentity)) {
      attachProcessExitNotice(item);
    }
  }
  const waiting = state.items.find((item) => item.status === 'waiting-producer');
  const occupiedItems = state.items.filter(
    (item) =>
      ['active', 'tracking'].includes(item.status) &&
      (isOwnedProcessAlive(item.processPid, item.processIdentity) ||
        item.orchestration?.processOccupied),
  );
  const occupied = occupiedItems[0];
  // Preserve the current decision context, but never promote an unrelated
  // historical todo over a live writer or into a just-released active slot.
  const activeWaiting = state.items.find(
    (item) => item.id === state.activeItemId && item.status === 'waiting-producer',
  );
  state.activeItemId = occupied?.id ?? activeWaiting?.id ?? '';
  // Reconciliation is often deliberately observational: a due retry behind a
  // producer decision must remain asleep until the decision owner emits a new
  // event.  Do not turn that no-op observation into a fresh state write (and
  // therefore a fresh event) merely by refreshing bookkeeping timestamps.
  const stateChanged =
    (normalized &&
      persistedCorrections === 0 &&
      stateBeforeNormalization !== JSON.stringify(state)) ||
    JSON.stringify(state) !== stateBeforeReconciliation;
  if (stateChanged) await saveState();
  if (occupiedItems.length > 1) {
    const ids = occupiedItems.map((item) => item.id).sort();
    await appendPublicWorkEvent(publicEventsFile, {
      eventId: `multiple-writers-${ids.join('-')}`,
      sequence: 0,
      agentId: 'secretary',
      ...publicEventContext(),
      kind: 'blocker',
      payload: {
        summary: `检测到多个仍占用工作区的运行：${ids.join('、')}`,
        category: 'multiple-writers',
        recoveryCondition: '核实每个 PM 或子 Agent 的进程归属并等待其退出。',
      },
    });
    return;
  }
  if (reconciliationFailed || activeChild || waiting || occupied) return;
  if (process.env.DAOYAN_SECRETARY_NO_DISPATCH === '1') return;
  if (await driveFormalVersion()) await saveState();
  const formalVersion = await readFormalVersion(root);
  if (formalVersionBlocksDispatch(formalVersion)) return;
  if (await adoptExistingRun()) {
    coordinatePending = true;
    return;
  }
  const next = nextRunnableItem(state, new Date().toISOString());
  if (next) await launch(next);
  else scheduleRetry();
}

export function formalVersionBlocksDispatch(version: FormalVersion | null): boolean {
  return Boolean(
    version &&
    (version.status === 'waiting-producer' ||
      version.status === 'paused' ||
      version.todos.some((todo) => todo.assignee === 'producer' && todo.status === 'open') ||
      version.orchestration?.decisionGates.some(
        (gate) =>
          gate.status === 'open' || (gate.status === 'rejected' && gate.kind !== 'scope-change'),
      )),
  );
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

function requestCoordinate(source: string): void {
  void coordinate()
    .then(() => {
      if (!coordinateRecoveryTimer) return;
      clearTimeout(coordinateRecoveryTimer);
      coordinateRecoveryTimer = null;
    })
    .catch((error) => {
      console.error(`[notice guard] ${source}协调失败，将自动重试：${String(error)}`);
      if (stopping || coordinateRecoveryTimer) return;
      coordinateRecoveryTimer = setTimeout(() => {
        coordinateRecoveryTimer = null;
        requestCoordinate('协调恢复');
      }, 2_000);
    });
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
    state.messages.some((message) => message.id === id) ||
    state.orchestration?.intakes.some((intake) => intake.requestId === id) === true
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
    // fs.watch is kept for inbox files written by other processes, but it is not
    // a delivery guarantee for the HTTP/channel request that this guard just
    // persisted. Wake the event loop directly so a successfully accepted local
    // receipt cannot be stranded behind a missed Windows file-system event.
    void processInbox().catch((error) =>
      console.error(`[notice guard] 处理本机收件失败：${String(error)}`),
    );
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
  if (coordinateRecoveryTimer) clearTimeout(coordinateRecoveryTimer);
  for (const timer of orphanTimers.values()) clearTimeout(timer);
  orphanTimers.clear();
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
  const idleStartedAt = state.lastEventAt;
  const wasIdle = !state.items.some((item) =>
    ['queued', 'active', 'tracking', 'retry-wait', 'waiting-producer'].includes(item.status),
  );
  state.status = 'running';
  state.pid = process.pid;
  state.processIdentity = guardProcessIdentity;
  await synchronizeArchivedVersion();
  await saveState();
  await loadRecordedCorrelations();
  if (wasIdle) {
    await appendSecretaryTiming(`idle-${idleStartedAt}`, 'idle', idleStartedAt, state.lastEventAt);
  }
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
    requestCoordinate('运行事件');
  });
  await processInbox();
  await coordinate();
  startHttpServer();
  console.log('[notice guard] 已进入事件休眠；空闲时不调用模型、不轮询项目。');
}
