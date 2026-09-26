import type { VersionStage } from './version-lifecycle';

export type StageTaskStatus = 'pending' | 'active' | 'submitted' | 'accepted' | 'blocked';

export interface VersionStageTask {
  id: string;
  stage: VersionStage;
  stageStep: 'primary' | 'reverification';
  scopeRevision: number;
  stageStartedAt: string;
  title: string;
  objective: string;
  deliverables: string[];
  acceptance: string[];
  dependsOn: string[];
  readPaths: string[];
  writePaths: string[];
  status: StageTaskStatus;
  pmItemId: string;
  commit: string;
  evidence: string[];
}

export interface StageTaskResult {
  taskId: string;
  status: 'completed';
  summary: string;
  commands: Array<{ command: string; exitCode: number }>;
  evidence: string[];
}

type TaskDraft = Pick<
  VersionStageTask,
  | 'id'
  | 'title'
  | 'objective'
  | 'deliverables'
  | 'acceptance'
  | 'dependsOn'
  | 'readPaths'
  | 'writePaths'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim());
}

function normalizedPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`节点任务路径必须是安全的仓库相对路径：${path}`);
  }
  return normalized;
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Version PM's task contracts, not Feature PM's internal execution plan. */
export function parseStageTaskManifest(
  value: unknown,
  stage: VersionStage,
  scopeRevision: number,
  stageStartedAt = '',
  stageStep: 'primary' | 'reverification' = 'primary',
): VersionStageTask[] {
  if (!isRecord(value) || !Array.isArray(value.tasks) || value.tasks.length === 0) {
    throw new Error('节点任务清单必须包含非空 tasks');
  }
  const ids = new Set<string>();
  const drafts: TaskDraft[] = value.tasks.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(entry.id) ||
      typeof entry.title !== 'string' ||
      !entry.title.trim() ||
      typeof entry.objective !== 'string' ||
      !entry.objective.trim() ||
      !isStrings(entry.deliverables) ||
      entry.deliverables.length === 0 ||
      !isStrings(entry.acceptance) ||
      entry.acceptance.length === 0 ||
      !isStrings(entry.dependsOn) ||
      !isStrings(entry.readPaths) ||
      !isStrings(entry.writePaths) ||
      entry.writePaths.length === 0
    ) {
      throw new Error('节点任务合同缺少目标、交付物、验收、依赖或写入范围');
    }
    if (ids.has(entry.id)) throw new Error(`节点任务 id 重复：${entry.id}`);
    ids.add(entry.id);
    return {
      id: entry.id,
      title: entry.title.trim(),
      objective: entry.objective.trim(),
      deliverables: entry.deliverables.map((part: string) => part.trim()),
      acceptance: entry.acceptance.map((part: string) => part.trim()),
      dependsOn: [...entry.dependsOn],
      readPaths: [...new Set(entry.readPaths.map((path: string) => normalizedPath(path)))],
      writePaths: [...new Set(entry.writePaths.map((path: string) => normalizedPath(path)))],
    };
  });
  const byId = new Map(drafts.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ancestors = new Map<string, Set<string>>();
  const visit = (id: string): Set<string> => {
    if (visiting.has(id)) throw new Error(`节点任务依赖存在循环：${id}`);
    if (visited.has(id)) return ancestors.get(id)!;
    const task = byId.get(id)!;
    visiting.add(id);
    const result = new Set<string>();
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`节点任务依赖不存在：${dependency}`);
      if (dependency === id) throw new Error(`节点任务不能依赖自己：${id}`);
      result.add(dependency);
      for (const ancestor of visit(dependency)) result.add(ancestor);
    }
    visiting.delete(id);
    visited.add(id);
    ancestors.set(id, result);
    return result;
  };
  for (const task of drafts) visit(task.id);
  for (let index = 0; index < drafts.length; index += 1) {
    const left = drafts[index];
    for (const right of drafts.slice(index + 1)) {
      if (ancestors.get(left.id)!.has(right.id) || ancestors.get(right.id)!.has(left.id)) continue;
      if (left.writePaths.some((a) => right.writePaths.some((b) => overlaps(a, b)))) {
        throw new Error(`无依赖的节点任务写入范围重叠：${left.id} / ${right.id}`);
      }
    }
  }
  return drafts.map((task) => ({
    ...task,
    stage,
    stageStep,
    scopeRevision,
    stageStartedAt,
    status: 'pending',
    pmItemId: '',
    commit: '',
    evidence: [],
  }));
}

export function readyStageTasks(tasks: VersionStageTask[]): VersionStageTask[] {
  const accepted = new Set(
    tasks.filter((task) => task.status === 'accepted').map((task) => task.id),
  );
  return tasks.filter(
    (task) => task.status === 'pending' && task.dependsOn.every((id) => accepted.has(id)),
  );
}

export function assertStageTaskPaths(task: VersionStageTask, documentRoot: string): void {
  const root = normalizedPath(documentRoot);
  const verificationOnly =
    ['qa', 'candidate'].includes(task.stage) || task.stageStep === 'reverification';
  if (verificationOnly && task.writePaths.some((path) => !path.startsWith(`${root}/`))) {
    throw new Error(`独立验证任务 ${task.id} 只能写入当前版本证据目录`);
  }
  if (
    task.writePaths.some(
      (path) =>
        ['docs', 'docs/status.md', 'docs/dev', root].includes(path) ||
        path ===
          `${root}/${task.stage === 'bugfix' && task.stageStep === 'reverification' ? 'bugfix-reverification' : task.stage}-tasks.json` ||
        path ===
          `${root}/${task.stage === 'bugfix' && task.stageStep === 'reverification' ? 'bugfix-reverification' : task.stage}-tasks.md`,
    )
  ) {
    throw new Error(`节点任务 ${task.id} 试图占用 Version PM 的共享文档`);
  }
}

export function validateStageTaskState(value: unknown): value is VersionStageTask[] {
  return (
    Array.isArray(value) &&
    value.every(
      (task) =>
        isRecord(task) &&
        typeof task.id === 'string' &&
        typeof task.stage === 'string' &&
        ['primary', 'reverification'].includes(String(task.stageStep)) &&
        Number.isSafeInteger(task.scopeRevision) &&
        Number(task.scopeRevision) > 0 &&
        typeof task.stageStartedAt === 'string' &&
        typeof task.title === 'string' &&
        typeof task.objective === 'string' &&
        isStrings(task.deliverables) &&
        isStrings(task.acceptance) &&
        isStrings(task.dependsOn) &&
        isStrings(task.readPaths) &&
        isStrings(task.writePaths) &&
        ['pending', 'active', 'submitted', 'accepted', 'blocked'].includes(String(task.status)) &&
        typeof task.pmItemId === 'string' &&
        typeof task.commit === 'string' &&
        isStrings(task.evidence),
    )
  );
}

export function assertTaskWriteScope(task: VersionStageTask, changedFiles: string[]): void {
  const outOfScope = changedFiles
    .map(normalizedPath)
    .filter((path) => !task.writePaths.some((scope) => overlaps(path, scope)));
  if (outOfScope.length > 0) {
    throw new Error(`任务 ${task.id} 改动超出独占写入范围：${outOfScope.join('、')}`);
  }
}

/** Main Agent control-plane commits may land while a game task is being delivered. */
export function assertStageTaskDeliveryScope(task: VersionStageTask, changedFiles: string[]): void {
  const controlPlane = (path: string): boolean =>
    /^(?:scripts|test)\/(?:agent-|secretary-|version-)[^/]+\.ts$/.test(path) ||
    ['docs/status.md', 'docs/workflow.md', 'docs/agent-workflow.md'].includes(path) ||
    /^docs\/dev\/\d{4}-\d{2}-\d{2}\.md$/.test(path);
  const taskChanges = changedFiles.filter((path) => !controlPlane(normalizedPath(path)));
  if (taskChanges.length === 0) throw new Error(`节点任务 ${task.id} 未提交合同内交付文件`);
  assertTaskWriteScope(task, taskChanges);
}

export function parseStageTaskResult(value: unknown, expectedTaskId: string): StageTaskResult {
  if (
    !isRecord(value) ||
    value.taskId !== expectedTaskId ||
    value.status !== 'completed' ||
    typeof value.summary !== 'string' ||
    !value.summary.trim() ||
    !Array.isArray(value.commands) ||
    value.commands.length === 0 ||
    value.commands.some(
      (entry) =>
        !isRecord(entry) ||
        typeof entry.command !== 'string' ||
        !entry.command.trim() ||
        !Number.isSafeInteger(entry.exitCode),
    ) ||
    !isStrings(value.evidence) ||
    value.evidence.length === 0
  ) {
    throw new Error(`节点任务 ${expectedTaskId} 缺少实际检查或交付证据`);
  }
  return {
    taskId: expectedTaskId,
    status: 'completed',
    summary: value.summary.trim(),
    commands: value.commands.map((entry) => ({ command: entry.command, exitCode: entry.exitCode })),
    evidence: [...value.evidence],
  };
}
