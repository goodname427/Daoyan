import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

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

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

function stageIndex(stage: VersionStage): number {
  return VERSION_STAGES.indexOf(stage);
}

function stageStatus(stage: VersionStage, current: VersionStage): LifecycleStatus {
  if (stageIndex(stage) < stageIndex(current)) return 'completed';
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
    id: input.id,
    title: input.title,
    direction: input.direction,
    status: VERSION_STAGE_DEFINITIONS.find((stage) => stage.id === currentStage)?.producerGate
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
      completedAt: stageIndex(definition.id) < stageIndex(currentStage) ? createdAt : '',
    })),
    approvals: [],
    todos: [],
    workItems: [],
    bugs: [],
    createdAt,
    updatedAt: createdAt,
    completedAt: '',
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
  if (target === 'archived') version.completedAt = timestamp;
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

export async function readFormalVersion(root: string): Promise<FormalVersion | null> {
  const runtime = resolve(
    root,
    process.env.DAOYAN_RELEASE_STATE_DIR ?? '.daoyan-agent/releases',
    'current.json',
  );
  const seed = resolve(root, 'docs/versions/current.json');
  const path = existsSync(runtime) ? runtime : seed;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as FormalVersion;
    if (parsed.schemaVersion !== 1 || !VERSION_STAGES.includes(parsed.currentStage)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeFormalVersion(root: string, version: FormalVersion): Promise<void> {
  const path = resolve(
    root,
    process.env.DAOYAN_RELEASE_STATE_DIR ?? '.daoyan-agent/releases',
    'current.json',
  );
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(version, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}
