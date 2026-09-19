import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getProcessIdentity, isOwnedProcessAlive, isProcessAlive } from './process-identity';

export const VERSION_STAGES = [
  'direction',
  'charter-draft',
  'charter-review',
  'module-design',
  'design-review',
  'task-breakdown',
  'version-planning',
  'development',
  'qa',
  'bugfix',
  'candidate',
  'producer-acceptance',
  'archived',
] as const;

export type VersionStage = (typeof VERSION_STAGES)[number];
export type LifecycleStatus = 'pending' | 'active' | 'blocked' | 'completed' | 'skipped';
export type VersionStatus = 'drafting' | 'running' | 'waiting-producer' | 'paused' | 'archived';

export interface VersionStageDefinition {
  id: VersionStage;
  title: string;
  owner: string;
  description: string;
  producerGate: boolean;
}

export const VERSION_STAGE_DEFINITIONS: VersionStageDefinition[] = [
  {
    id: 'direction',
    title: '方向收集',
    owner: '制作人 / 常驻秘书',
    description: '记录版本方向、玩家价值和必须解决的问题。',
    producerGate: false,
  },
  {
    id: 'charter-draft',
    title: '版本策划',
    owner: '主策',
    description: '确定版本目标、重点模块、范围、非目标和验收标准。',
    producerGate: false,
  },
  {
    id: 'charter-review',
    title: '立项评审',
    owner: '制作人',
    description: '制作人评审版本策划案；未通过则退回主策修改。',
    producerGate: true,
  },
  {
    id: 'module-design',
    title: '详细策划',
    owner: '策划',
    description: '按模块补齐规则、交互、数值、边界和验收。',
    producerGate: false,
  },
  {
    id: 'design-review',
    title: '策划审核',
    owner: '主策',
    description: '逐份审核详细策划，必要时升级给制作人。',
    producerGate: false,
  },
  {
    id: 'task-breakdown',
    title: '任务拆分',
    owner: '策划',
    description: '把已批准策划拆为可验证任务并标注依赖。',
    producerGate: false,
  },
  {
    id: 'version-planning',
    title: '版本排期',
    owner: 'Version PM',
    description: '排序、估算、控制工作量并冻结版本范围。',
    producerGate: false,
  },
  {
    id: 'development',
    title: '开发执行',
    owner: 'Feature PM',
    description: '按依赖顺序完成开发、验证、审查和 Git 交付。',
    producerGate: false,
  },
  {
    id: 'qa',
    title: '版本测试',
    owner: '测试',
    description: '验证本版本全部内容并回归核心体验链路。',
    producerGate: false,
  },
  {
    id: 'bugfix',
    title: '缺陷修复',
    owner: '开发 / 测试',
    description: '开发逐项修复缺陷，测试复验并完成必要回归。',
    producerGate: false,
  },
  {
    id: 'candidate',
    title: '候选构建',
    owner: 'Version PM',
    description: '形成可体验构建、测试报告、版本说明和遗留风险。',
    producerGate: false,
  },
  {
    id: 'producer-acceptance',
    title: '制作人体验',
    owner: '制作人',
    description: '体验候选版本并决定通过、修正或调整方向。',
    producerGate: true,
  },
  {
    id: 'archived',
    title: '版本归档',
    owner: '常驻秘书',
    description: '保存策划、任务、测试、缺陷、构建与最终结论。',
    producerGate: false,
  },
];

export interface VersionNode {
  id: VersionStage;
  title: string;
  owner: string;
  description: string;
  producerGate: boolean;
  status: LifecycleStatus;
  summary: string;
  artifact: string;
  startedAt: string;
  completedAt: string;
}

export interface VersionApproval {
  id: string;
  stage: VersionStage;
  reviewer: 'producer' | 'lead-designer';
  decision: 'approved' | 'changes-requested';
  documentRevision: string;
  comment: string;
  createdAt: string;
}

function expectedReviewer(stage: VersionStage): VersionApproval['reviewer'] | null {
  if (stage === 'charter-review' || stage === 'producer-acceptance') return 'producer';
  if (stage === 'design-review') return 'lead-designer';
  return null;
}

export interface VersionTodo {
  id: string;
  title: string;
  detail: string;
  stage: VersionStage;
  assignee: 'producer' | 'lead-designer' | 'planner' | 'pm' | 'qa';
  status: 'open' | 'done' | 'cancelled';
  createdAt: string;
  completedAt: string;
}

export interface VersionWorkItem {
  id: string;
  title: string;
  owner: string;
  status: LifecycleStatus;
  dependsOn: string[];
  summary: string;
  evidence: string;
}

export interface VersionBug {
  id: string;
  title: string;
  severity: 'blocker' | 'high' | 'medium' | 'low';
  status: 'open' | 'fixing' | 'verify' | 'closed' | 'deferred';
  expected: string;
  actual: string;
  evidence: string;
  linkedWorkItemId: string;
}

export interface FormalVersion {
  schemaVersion: 1;
  stateRevision: number;
  id: string;
  title: string;
  direction: string;
  status: VersionStatus;
  currentStage: VersionStage;
  scopeFrozen: boolean;
  charterRevision: string;
  documentRoot: string;
  nodes: VersionNode[];
  approvals: VersionApproval[];
  todos: VersionTodo[];
  workItems: VersionWorkItem[];
  bugs: VersionBug[];
  createdAt: string;
  updatedAt: string;
  completedAt: string;
}

const versionWriteQueues = new Map<string, Promise<void>>();
const versionWriterIdentity = getProcessIdentity(process.pid);

async function withVersionWriteLock<T>(stateRoot: string, action: () => Promise<T>): Promise<T> {
  await mkdir(stateRoot, { recursive: true });
  const lockPath = resolve(stateRoot, '.write.lock');
  const deadline = Date.now() + 5_000;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  while (!handle && Date.now() < deadline) {
    try {
      handle = await open(lockPath, 'wx');
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, processIdentity: versionWriterIdentity, createdAt: new Date().toISOString() })}\n`,
        'utf8',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lockAge =
        Date.now() - (await stat(lockPath).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
      const owner = await readFile(lockPath, 'utf8')
        .then((value) => JSON.parse(value) as { pid?: number; processIdentity?: string })
        .catch(() => null);
      const ownerAlive = owner?.processIdentity
        ? isOwnedProcessAlive(Number(owner.pid ?? 0), owner.processIdentity, 0)
        : isProcessAlive(Number(owner?.pid ?? 0));
      if ((owner && !ownerAlive) || (!owner && lockAge > 1_000)) {
        await rm(lockPath, { force: true });
      } else await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  if (!handle) throw new Error('正式版本状态正被另一个进程更新，请稍后重试');
  try {
    return await action();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

function stageIndex(stage: VersionStage): number {
  return VERSION_STAGES.indexOf(stage);
}

function stageStatus(stage: VersionStage, current: VersionStage): LifecycleStatus {
  if (stageIndex(stage) < stageIndex(current)) return 'completed';
  if (stage === 'archived' && current === 'archived') return 'completed';
  if (stage === current) return 'active';
  return 'pending';
}

function ensureProducerTodo(version: FormalVersion, stage: VersionStage, now: string): void {
  const definition = VERSION_STAGE_DEFINITIONS.find((candidate) => candidate.id === stage);
  if (!definition?.producerGate) return;
  if (
    version.todos.some(
      (todo) => todo.stage === stage && todo.assignee === 'producer' && todo.status === 'open',
    )
  ) {
    return;
  }
  version.todos.push({
    id: randomUUID(),
    title: stage === 'charter-review' ? '评审版本策划案' : '体验候选版本',
    detail:
      stage === 'charter-review'
        ? '确认版本目标、范围、非目标和验收标准，或指出需要调整的内容。'
        : '体验候选版本，确认通过归档，或指出需要修复和调整的内容。',
    stage,
    assignee: 'producer',
    status: 'open',
    createdAt: now,
    completedAt: '',
  });
}

export function createFormalVersion(input: {
  id: string;
  title: string;
  direction: string;
  documentRoot: string;
  currentStage?: VersionStage;
  now?: string;
}): FormalVersion {
  const createdAt = nowIso(input.now);
  const currentStage = input.currentStage ?? 'direction';
  const version: FormalVersion = {
    schemaVersion: 1,
    stateRevision: 0,
    id: input.id,
    title: input.title,
    direction: input.direction,
    status:
      currentStage === 'archived'
        ? 'archived'
        : VERSION_STAGE_DEFINITIONS.find((stage) => stage.id === currentStage)?.producerGate
          ? 'waiting-producer'
          : 'running',
    currentStage,
    scopeFrozen: stageIndex(currentStage) > stageIndex('version-planning'),
    charterRevision: '1',
    documentRoot: input.documentRoot,
    nodes: VERSION_STAGE_DEFINITIONS.map((definition) => ({
      ...definition,
      status: stageStatus(definition.id, currentStage),
      summary: '',
      artifact: '',
      startedAt: definition.id === currentStage ? createdAt : '',
      completedAt:
        stageIndex(definition.id) < stageIndex(currentStage) ||
        (definition.id === 'archived' && currentStage === 'archived')
          ? createdAt
          : '',
    })),
    approvals: [],
    todos: [],
    workItems: [],
    bugs: [],
    createdAt,
    updatedAt: createdAt,
    completedAt: currentStage === 'archived' ? createdAt : '',
  };
  ensureProducerTodo(version, currentStage, createdAt);
  return version;
}

export function setNodeEvidence(
  version: FormalVersion,
  stage: VersionStage,
  evidence: Pick<VersionNode, 'summary' | 'artifact'>,
): void {
  const node = version.nodes.find((candidate) => candidate.id === stage);
  if (!node) throw new Error(`未知版本阶段：${stage}`);
  node.summary = evidence.summary;
  node.artifact = evidence.artifact;
  version.updatedAt = new Date().toISOString();
}

export function advanceVersion(version: FormalVersion, target: VersionStage, now?: string): void {
  const currentIndex = stageIndex(version.currentStage);
  const targetIndex = stageIndex(target);
  if (targetIndex !== currentIndex + 1) {
    throw new Error(`版本只能从 ${version.currentStage} 推进到下一个阶段`);
  }
  const requiredReviewer = expectedReviewer(version.currentStage);
  if (requiredReviewer) {
    const currentNode = version.nodes[currentIndex];
    const approved = version.approvals.some(
      (approval) =>
        approval.stage === version.currentStage &&
        approval.decision === 'approved' &&
        approval.reviewer === requiredReviewer &&
        approval.documentRevision === version.charterRevision &&
        approval.createdAt >= currentNode.startedAt,
    );
    if (!approved) throw new Error(`${version.currentStage} 尚未取得有效批准`);
  }
  const timestamp = nowIso(now);
  const current = version.nodes[currentIndex];
  current.status = 'completed';
  current.completedAt = timestamp;
  const next = version.nodes[targetIndex];
  next.status = 'active';
  next.startedAt = timestamp;
  version.currentStage = target;
  version.scopeFrozen = targetIndex > stageIndex('version-planning');
  version.status = next.producerGate
    ? 'waiting-producer'
    : target === 'archived'
      ? 'archived'
      : 'running';
  version.updatedAt = timestamp;
  ensureProducerTodo(version, target, timestamp);
  if (target === 'archived') {
    next.status = 'completed';
    next.completedAt = timestamp;
    version.completedAt = timestamp;
  }
}

export function recordApproval(
  version: FormalVersion,
  input: Omit<VersionApproval, 'id' | 'createdAt'> & { now?: string },
): VersionApproval {
  if (
    input.stage !== 'charter-review' &&
    input.stage !== 'design-review' &&
    input.stage !== 'producer-acceptance'
  ) {
    throw new Error(`${input.stage} 不是评审阶段`);
  }
  if (version.currentStage !== input.stage) {
    throw new Error(`只能评审当前阶段 ${version.currentStage}`);
  }
  const requiredReviewer = expectedReviewer(input.stage);
  if (input.reviewer !== requiredReviewer) throw new Error(`${input.stage} 评审角色不匹配`);
  if (input.documentRevision !== version.charterRevision) {
    throw new Error(`${input.stage} 评审文档版本已过期`);
  }
  const createdAt = nowIso(input.now);
  const currentNode = version.nodes.find((node) => node.id === input.stage);
  if (!currentNode?.startedAt || createdAt < currentNode.startedAt) {
    throw new Error(`${input.stage} 评审时间早于当前评审轮次`);
  }
  const approval: VersionApproval = {
    id: randomUUID(),
    stage: input.stage,
    reviewer: input.reviewer,
    decision: input.decision,
    documentRevision: input.documentRevision,
    comment: input.comment,
    createdAt,
  };
  version.approvals.push(approval);
  const openTodo = version.todos.find(
    (todo) => todo.stage === input.stage && todo.assignee === 'producer' && todo.status === 'open',
  );
  if (openTodo) {
    openTodo.status = 'done';
    openTodo.completedAt = approval.createdAt;
  }
  version.updatedAt = approval.createdAt;
  if (input.decision === 'changes-requested') {
    const fallback =
      input.stage === 'charter-review'
        ? 'charter-draft'
        : input.stage === 'design-review'
          ? 'module-design'
          : 'bugfix';
    const current = version.nodes.find((node) => node.id === version.currentStage);
    if (current) current.status = 'pending';
    const fallbackNode = version.nodes.find((node) => node.id === fallback);
    if (!fallbackNode) throw new Error(`找不到评审回退阶段：${fallback}`);
    fallbackNode.status = 'active';
    fallbackNode.startedAt = approval.createdAt;
    fallbackNode.completedAt = '';
    version.currentStage = fallback;
    version.status = 'running';
    if (fallback === 'charter-draft')
      version.charterRevision = String(Number(version.charterRevision) + 1);
  }
  return approval;
}

export function addVersionTodo(
  version: FormalVersion,
  input: Omit<VersionTodo, 'id' | 'status' | 'createdAt' | 'completedAt'> & { now?: string },
): VersionTodo {
  const todo: VersionTodo = {
    id: randomUUID(),
    title: input.title,
    detail: input.detail,
    stage: input.stage,
    assignee: input.assignee,
    status: 'open',
    createdAt: nowIso(input.now),
    completedAt: '',
  };
  version.todos.push(todo);
  version.updatedAt = todo.createdAt;
  return todo;
}

export function completeVersionTodo(version: FormalVersion, todoId: string, now?: string): void {
  const todo = version.todos.find((candidate) => candidate.id === todoId);
  if (!todo) throw new Error(`找不到版本待办：${todoId}`);
  todo.status = 'done';
  todo.completedAt = nowIso(now);
  version.updatedAt = todo.completedAt;
}

export function versionProgress(version: FormalVersion): number {
  const completed = version.nodes.filter((node) => node.status === 'completed').length;
  return Math.round((completed / version.nodes.length) * 100);
}

export function versionHealth(version: FormalVersion): 'blocked' | 'at-risk' | 'healthy' {
  if (version.status === 'paused' || version.nodes.some((node) => node.status === 'blocked'))
    return 'blocked';
  if (
    version.bugs.some(
      (bug) => bug.status !== 'closed' && ['blocker', 'high'].includes(bug.severity),
    )
  )
    return 'at-risk';
  return 'healthy';
}

export function publicVersionState(version: FormalVersion): object {
  return {
    ...version,
    progress: versionProgress(version),
    health: versionHealth(version),
    producerTodos: version.todos.filter(
      (todo) => todo.assignee === 'producer' && todo.status === 'open',
    ),
    openBugCount: version.bugs.filter((bug) => !['closed', 'deferred'].includes(bug.status)).length,
  };
}

export function normalizeFormalVersion(version: FormalVersion): boolean {
  if (version.currentStage !== 'archived') {
    if (version.status !== 'archived') return false;
    const current = VERSION_STAGE_DEFINITIONS.find((stage) => stage.id === version.currentStage);
    version.status = current?.producerGate ? 'waiting-producer' : 'running';
    version.completedAt = '';
    return true;
  }
  let changed = version.status !== 'archived';
  version.status = 'archived';
  const archived = version.nodes.find((node) => node.id === 'archived');
  const timestamp = version.completedAt || version.updatedAt || new Date().toISOString();
  if (archived) {
    if (archived.status !== 'completed') {
      archived.status = 'completed';
      changed = true;
    }
    if (!archived.startedAt) {
      archived.startedAt = timestamp;
      changed = true;
    }
    if (!archived.completedAt) {
      archived.completedAt = timestamp;
      changed = true;
    }
  }
  if (!version.completedAt) {
    version.completedAt = timestamp;
    changed = true;
  }
  return changed;
}

function releaseStateRoot(root: string): string {
  return resolve(root, process.env.DAOYAN_RELEASE_STATE_DIR ?? '.daoyan-agent/releases');
}

async function readVersionFile(path: string): Promise<FormalVersion | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as FormalVersion;
    if (parsed.schemaVersion !== 1 || !VERSION_STAGES.includes(parsed.currentStage)) return null;
    parsed.stateRevision = Number.isSafeInteger(parsed.stateRevision) ? parsed.stateRevision : 0;
    normalizeFormalVersion(parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function writeVersionSnapshotFiles(
  stateRoot: string,
  snapshot: FormalVersion,
): Promise<void> {
  const currentPath = resolve(stateRoot, 'current.json');
  const historyPath = resolve(stateRoot, 'versions', `${snapshot.id}.json`);
  const payload = `${JSON.stringify(snapshot, null, 2)}\n`;
  for (const path of [historyPath, currentPath]) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, payload, 'utf8');
    await rename(temporary, path);
  }
}

async function recoverPendingVersionWrite(stateRoot: string): Promise<void> {
  const transactionPath = resolve(stateRoot, '.write-transaction.json');
  if (!existsSync(transactionPath)) return;
  const transaction = await readFile(transactionPath, 'utf8')
    .then((value) => JSON.parse(value) as { version?: FormalVersion })
    .catch(() => null);
  const snapshot = transaction?.version;
  if (
    !snapshot ||
    snapshot.schemaVersion !== 1 ||
    !/^[a-z0-9._-]+$/i.test(snapshot.id) ||
    !VERSION_STAGES.includes(snapshot.currentStage)
  ) {
    throw new Error('正式版本写入事务损坏，需要保留现场并人工检查');
  }
  await writeVersionSnapshotFiles(stateRoot, snapshot);
  await rm(transactionPath, { force: true });
}

async function recoverFormalVersionWrite(root: string): Promise<void> {
  const stateRoot = releaseStateRoot(root);
  if (!existsSync(resolve(stateRoot, '.write-transaction.json'))) return;
  const previous = versionWriteQueues.get(stateRoot) ?? Promise.resolve();
  const queued = previous
    .catch(() => undefined)
    .then(() => withVersionWriteLock(stateRoot, () => recoverPendingVersionWrite(stateRoot)));
  versionWriteQueues.set(stateRoot, queued);
  try {
    await queued;
  } finally {
    if (versionWriteQueues.get(stateRoot) === queued) versionWriteQueues.delete(stateRoot);
  }
}

export async function readFormalVersion(root: string): Promise<FormalVersion | null> {
  await recoverFormalVersionWrite(root);
  const runtime = resolve(releaseStateRoot(root), 'current.json');
  const seed = resolve(root, 'docs/versions/current.json');
  const path = existsSync(runtime) ? runtime : seed;
  return await readVersionFile(path);
}

export async function listFormalVersions(root: string): Promise<FormalVersion[]> {
  const byId = new Map<string, FormalVersion>();
  const current = await readFormalVersion(root);
  if (current) byId.set(current.id, current);
  const directory = resolve(releaseStateRoot(root), 'versions');
  if (existsSync(directory)) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const version = await readVersionFile(resolve(directory, entry.name));
      if (!version) continue;
      const existing = byId.get(version.id);
      if (!existing || version.updatedAt > existing.updatedAt) byId.set(version.id, version);
    }
  }
  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readFormalVersionById(
  root: string,
  versionId: string,
): Promise<FormalVersion | null> {
  const versions = await listFormalVersions(root);
  return versions.find((version) => version.id === versionId) ?? null;
}

export async function writeFormalVersion(
  root: string,
  version: FormalVersion,
  options: { allowVersionSwitch?: boolean } = {},
): Promise<void> {
  if (!/^[a-z0-9._-]+$/i.test(version.id)) throw new Error(`版本 ID 不安全：${version.id}`);
  normalizeFormalVersion(version);
  const stateRoot = releaseStateRoot(root);
  const expectedRevision = version.stateRevision;
  const previous = versionWriteQueues.get(stateRoot) ?? Promise.resolve();
  const queued = previous
    .catch(() => undefined)
    .then(() =>
      withVersionWriteLock(stateRoot, async () => {
        await recoverPendingVersionWrite(stateRoot);
        const currentPath = resolve(stateRoot, 'current.json');
        const existing = await readVersionFile(currentPath);
        if (existing?.id === version.id && existing.stateRevision !== expectedRevision) {
          throw new Error(`版本 ${version.id} 已被其他操作更新，请刷新后重试`);
        }
        if (existing && existing.id !== version.id && !options.allowVersionSwitch) {
          throw new Error(`当前正式版本是 ${existing.id}，切换版本必须使用显式立项操作`);
        }
        const historyPath = resolve(stateRoot, 'versions', `${version.id}.json`);
        const historical = await readVersionFile(historyPath);
        if (existing?.id !== version.id && historical) {
          throw new Error(`版本 ID ${version.id} 已存在，不能覆盖历史正式版本`);
        }
        const nextRevision = existing?.id === version.id ? existing.stateRevision + 1 : 1;
        const snapshot = { ...version, stateRevision: nextRevision };
        const transactionPath = resolve(stateRoot, '.write-transaction.json');
        const transactionTemporary = `${transactionPath}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(
          transactionTemporary,
          `${JSON.stringify({ version: snapshot }, null, 2)}\n`,
          'utf8',
        );
        await rename(transactionTemporary, transactionPath);
        await writeVersionSnapshotFiles(stateRoot, snapshot);
        await rm(transactionPath, { force: true });
        version.stateRevision = nextRevision;
      }),
    );
  versionWriteQueues.set(stateRoot, queued);
  try {
    await queued;
  } finally {
    if (versionWriteQueues.get(stateRoot) === queued) versionWriteQueues.delete(stateRoot);
  }
}
