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
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLocalPlan, classifyAgentFailure, preferredWindowsExecutable } from './agent-routing';
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
  publicVersionState,
  readFormalVersion,
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
const stateFile = resolve(secretaryRoot, 'state.json');
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
): Promise<void> {
  const event = {
    id: randomUUID(),
    kind,
    message,
    itemId: item?.id ?? '',
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
  const executable = codexExecutable();
  if (!executable) return null;
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

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
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
  state.messages.push(
    {
      id: request.id,
      role: 'producer',
      content: request.idea,
      intent,
      createdAt: request.createdAt,
    },
    {
      id: `${request.id}-response`,
      role: 'secretary',
      content: response,
      intent,
      createdAt: new Date().toISOString(),
    },
  );
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
  await emitNotice('reply-accepted', waiting.summary, waiting);
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
    await emitNotice('version-comment-recorded', response);
    return true;
  }
  const approved = decision === 'approved';
  recordApproval(gate.version, {
    stage: gate.version.currentStage,
    reviewer: 'producer',
    decision,
    documentRevision: gate.version.charterRevision,
    comment: request.idea,
  });
  if (approved) {
    const currentIndex = gate.version.nodes.findIndex(
      (node) => node.id === gate.version.currentStage,
    );
    const next = gate.version.nodes[currentIndex + 1];
    if (next) advanceVersion(gate.version, next.id);
  }
  await writeFormalVersion(root, gate.version);
  const stageTitle =
    gate.version.nodes.find((node) => node.id === gate.version.currentStage)?.title ??
    gate.version.currentStage;
  const response = approved
    ? `已记录版本评审通过，当前进入“${stageTitle}”。`
    : `已记录你的反馈，版本已退回“${stageTitle}”调整。`;
  await writeInboxResponse(request, response, 'answered', 'reply');
  await emitNotice(approved ? 'version-approved' : 'version-changes-requested', response);
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
          await rm(path, { force: true });
          await emitNotice('question-answered', versionAnswer, local.item);
          continue;
        }
        if (await handleVersionProducerReply(request, fallbackIntent)) {
          await rm(path, { force: true });
          continue;
        }
        const needsSemanticTriage = !local.item.matchedFact || Boolean(waiting);
        const model = needsSemanticTriage ? await modelTriage(request, known.facts, waiting) : null;
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
          await rm(path, { force: true });
          await emitNotice('continue-accepted', response);
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

async function dashboardPayload(): Promise<object> {
  const version = await readFormalVersion(root);
  return {
    generatedAt: new Date().toISOString(),
    secretary: publicSecretaryState(state),
    version: version ? publicVersionState(version) : null,
  };
}

async function serveDashboardAsset(pathname: string, response: ServerResponse): Promise<boolean> {
  const assets: Record<string, { file: string; type: string }> = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/dashboard.css': { file: 'dashboard.css', type: 'text/css; charset=utf-8' },
    '/dashboard.js': { file: 'dashboard.js', type: 'text/javascript; charset=utf-8' },
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

async function serveArtifact(requestedPath: string, response: ServerResponse): Promise<void> {
  const versionsDocsRoot = resolve(root, 'docs/versions');
  const absolute = resolve(root, requestedPath);
  const child = relative(versionsDocsRoot, absolute);
  if (!requestedPath || child.startsWith('..') || isAbsolute(child)) {
    sendJson(response, 403, { error: '只能查看正式版本档案中的文档' });
    return;
  }
  try {
    const [realRoot, realTarget] = await Promise.all([
      realpath(versionsDocsRoot),
      realpath(absolute),
    ]);
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

async function enqueueIdea(idea: string): Promise<string> {
  const request: IntakeRequest = {
    id: randomUUID(),
    idea,
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(resolve(inboxRoot, `${request.id}.json`), request);
  return request.id;
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
        sendJson(response, 200, await dashboardPayload());
        return;
      }
      if (request.method === 'GET' && target.pathname === '/api/artifact') {
        await serveArtifact(target.searchParams.get('path') ?? '', response);
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
          const id = await enqueueIdea(value.idea.trim());
          sendJson(response, 202, { id, status: 'accepted' });
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
