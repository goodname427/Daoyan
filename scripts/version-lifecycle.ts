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
  sourceRequestId?: string;
  createdAt: string;
}

function expectedReviewer(stage: VersionStage): VersionApproval['reviewer'] | null {
  if (stage === 'charter-review' || stage === 'producer-acceptance') return 'producer';
  if (stage === 'design-review') return 'lead-designer';
  return null;
}

export interface VersionTodo {
  id: string;
  decisionGateId?: string;
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
  /** Concrete implementation and test paths, preserved from the task manifest. */
  affectedPaths?: string[];
  /** Direct checks that establish this task's acceptance evidence. */
  acceptanceCommands?: string[];
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
  assignedTo?: string;
  verificationRunId?: string;
  fixAttemptId?: string;
  fixCodeRevision?: string;
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type StagePolicyMode = 'execute' | 'reduced' | 'skip';

export interface VersionRiskAssessment {
  revision: number;
  level: RiskLevel;
  impact: string[];
  stateTransitions: boolean;
  crossProcessConcurrency: boolean;
  externalDependencies: string[];
  rollback: string;
  evaluatedBy: string;
  basis: string;
  evaluatedAt: string;
}

export interface VersionStagePolicy {
  stage: VersionStage;
  mode: StagePolicyMode;
  reason: string;
  evidence: string[];
  decidedBy: string;
  decidedAt: string;
  policyRevision: number;
  scopeRevision: number;
}

export interface VersionScopeRevision {
  revision: number;
  direction: string;
  sourceRequestId: string;
  disposition: 'initial' | 'merged' | 'scope-review';
  status: 'pending' | 'approved' | 'rejected';
  reason: string;
  createdAt: string;
}

export interface VersionDecisionGate {
  id: string;
  kind: 'irreversible-decision' | 'scope-change' | 'producer-escalated-design';
  stage: VersionStage;
  status: 'open' | 'approved' | 'rejected';
  summary: string;
  sourceRequestId: string;
  resolvedBy: 'producer' | '';
  createdAt: string;
  resolvedAt: string;
  resolutionHistory?: Array<{
    requestId: string;
    decision: 'approved' | 'rejected';
    resolvedAt: string;
  }>;
}

export interface FeatureVerification {
  id: string;
  workItemId: string;
  agentId: string;
  codeRevision: string;
  scopeRevision: number;
  typecheck: 'passed' | 'failed';
  targetedTests: 'passed' | 'failed';
  evidence: string[];
  createdAt: string;
}

export type QaSuite = 'acceptance' | 'integration' | 'regression' | 'defect-reverification';

export interface VersionQaRun {
  id: string;
  agentId: string;
  independent: boolean;
  codeRevision: string;
  scopeRevision: number;
  suites: QaSuite[];
  status: 'passed' | 'failed';
  commands: Array<{ command: string; exitCode: number }>;
  evidence: string[];
  createdAt: string;
  bugFixes?: Array<{ bugId: string; fixAttemptId: string }>;
}

export interface FormalVersionOrchestration {
  schemaVersion: 1;
  migratedFrom: 'native' | 'formal-version-v1';
  riskAssessments: VersionRiskAssessment[];
  stagePolicies: VersionStagePolicy[];
  scopeRevisions: VersionScopeRevision[];
  decisionGates: VersionDecisionGate[];
  featureVerifications: FeatureVerification[];
  qaRuns: VersionQaRun[];
  codeRevision?: string;
  qaInvalidatedThrough?: number;
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
  orchestration?: FormalVersionOrchestration;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validateOrchestrationRecords(value: unknown): asserts value is FormalVersionOrchestration {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('正式版本编排扩展损坏；已停止自动写入和派发');
  }
  if (!['native', 'formal-version-v1'].includes(String(value.migratedFrom))) {
    throw new Error('正式版本编排扩展迁移来源无效；已停止自动写入和派发');
  }
  const arrays = [
    'riskAssessments',
    'stagePolicies',
    'scopeRevisions',
    'decisionGates',
    'featureVerifications',
    'qaRuns',
  ] as const;
  if (arrays.some((field) => !Array.isArray(value[field]))) {
    throw new Error('正式版本编排扩展损坏；已停止自动写入和派发');
  }
  if (
    (Object.hasOwn(value, 'codeRevision') &&
      (typeof value.codeRevision !== 'string' || !value.codeRevision.trim())) ||
    (Object.hasOwn(value, 'qaInvalidatedThrough') &&
      (!Number.isSafeInteger(value.qaInvalidatedThrough) ||
        Number(value.qaInvalidatedThrough) < 0 ||
        Number(value.qaInvalidatedThrough) > (value.qaRuns as unknown[]).length))
  )
    throw new Error('正式版本代码修订或 QA 失效边界损坏；已停止自动写入和派发');
  const riskAssessments = value.riskAssessments as unknown[];
  const stagePolicies = value.stagePolicies as unknown[];
  const scopeRevisionRecords = value.scopeRevisions as unknown[];
  const decisionGates = value.decisionGates as unknown[];
  const featureVerifications = value.featureVerifications as unknown[];
  const qaRuns = value.qaRuns as unknown[];
  const invalidRisk = riskAssessments.some(
    (entry) =>
      !isRecord(entry) ||
      !isPositiveInteger(entry.revision) ||
      !['low', 'medium', 'high', 'critical'].includes(String(entry.level)) ||
      !isStringArray(entry.impact) ||
      typeof entry.stateTransitions !== 'boolean' ||
      typeof entry.crossProcessConcurrency !== 'boolean' ||
      !isStringArray(entry.externalDependencies) ||
      [entry.rollback, entry.evaluatedBy, entry.basis, entry.evaluatedAt].some(
        (field) => typeof field !== 'string',
      ),
  );
  const invalidPolicy = stagePolicies.some(
    (entry) =>
      !isRecord(entry) ||
      !VERSION_STAGES.includes(entry.stage as VersionStage) ||
      !['execute', 'reduced', 'skip'].includes(String(entry.mode)) ||
      !isStringArray(entry.evidence) ||
      !isPositiveInteger(entry.policyRevision) ||
      !isPositiveInteger(entry.scopeRevision) ||
      [entry.reason, entry.decidedBy, entry.decidedAt].some((field) => typeof field !== 'string'),
  );
  const scopeRevisions = new Set<number>();
  const invalidScope = scopeRevisionRecords.some((entry) => {
    if (
      !isRecord(entry) ||
      !isPositiveInteger(entry.revision) ||
      scopeRevisions.has(entry.revision) ||
      !['initial', 'merged', 'scope-review'].includes(String(entry.disposition)) ||
      !['pending', 'approved', 'rejected'].includes(String(entry.status)) ||
      [entry.direction, entry.sourceRequestId, entry.reason, entry.createdAt].some(
        (field) => typeof field !== 'string',
      )
    ) {
      return true;
    }
    scopeRevisions.add(entry.revision);
    return false;
  });
  const invalidGate = decisionGates.some(
    (entry) =>
      !isRecord(entry) ||
      !['irreversible-decision', 'scope-change', 'producer-escalated-design'].includes(
        String(entry.kind),
      ) ||
      !VERSION_STAGES.includes(entry.stage as VersionStage) ||
      !['open', 'approved', 'rejected'].includes(String(entry.status)) ||
      !['producer', ''].includes(String(entry.resolvedBy)) ||
      (entry.resolutionHistory !== undefined &&
        (!Array.isArray(entry.resolutionHistory) ||
          entry.resolutionHistory.some(
            (resolution) =>
              !isRecord(resolution) ||
              typeof resolution.requestId !== 'string' ||
              !resolution.requestId.trim() ||
              !['approved', 'rejected'].includes(String(resolution.decision)) ||
              typeof resolution.resolvedAt !== 'string',
          ))) ||
      [entry.id, entry.summary, entry.sourceRequestId, entry.createdAt, entry.resolvedAt].some(
        (field) => typeof field !== 'string',
      ),
  );
  const invalidFeatureVerification = featureVerifications.some(
    (entry) =>
      !isRecord(entry) ||
      !isPositiveInteger(entry.scopeRevision) ||
      !['passed', 'failed'].includes(String(entry.typecheck)) ||
      !['passed', 'failed'].includes(String(entry.targetedTests)) ||
      !isStringArray(entry.evidence) ||
      [entry.id, entry.workItemId, entry.agentId, entry.codeRevision, entry.createdAt].some(
        (field) => typeof field !== 'string',
      ),
  );
  const invalidQaRun = qaRuns.some(
    (entry) =>
      !isRecord(entry) ||
      typeof entry.independent !== 'boolean' ||
      !isPositiveInteger(entry.scopeRevision) ||
      !isStringArray(entry.suites) ||
      entry.suites.some(
        (suite) =>
          !['acceptance', 'integration', 'regression', 'defect-reverification'].includes(suite),
      ) ||
      !['passed', 'failed'].includes(String(entry.status)) ||
      !Array.isArray(entry.commands) ||
      entry.commands.some(
        (command) =>
          !isRecord(command) ||
          typeof command.command !== 'string' ||
          !Number.isSafeInteger(command.exitCode),
      ) ||
      !isStringArray(entry.evidence) ||
      (entry.bugFixes !== undefined &&
        (!Array.isArray(entry.bugFixes) ||
          entry.bugFixes.some(
            (fix) =>
              !isRecord(fix) ||
              typeof fix.bugId !== 'string' ||
              !fix.bugId.trim() ||
              typeof fix.fixAttemptId !== 'string' ||
              !fix.fixAttemptId.trim(),
          ))) ||
      [entry.id, entry.agentId, entry.codeRevision, entry.createdAt].some(
        (field) => typeof field !== 'string',
      ),
  );
  const approvedScopeRevision = [...scopeRevisionRecords]
    .reverse()
    .find((entry) => isRecord(entry) && entry.status === 'approved');
  const approvedScope = isRecord(approvedScopeRevision)
    ? Number(approvedScopeRevision.revision)
    : 0;
  const missingCurrentPolicy =
    approvedScope <= 0 ||
    VERSION_STAGES.some(
      (stage) =>
        !stagePolicies.some(
          (entry) =>
            isRecord(entry) && entry.stage === stage && entry.scopeRevision === approvedScope,
        ),
    );
  if (
    riskAssessments.length === 0 ||
    scopeRevisionRecords.length === 0 ||
    invalidRisk ||
    invalidPolicy ||
    invalidScope ||
    invalidGate ||
    invalidFeatureVerification ||
    invalidQaRun ||
    missingCurrentPolicy
  ) {
    throw new Error('正式版本编排扩展嵌套记录损坏；已停止自动写入和派发');
  }
}

const UNSKIPPABLE_STAGES = new Set<VersionStage>([
  'direction',
  'charter-draft',
  'charter-review',
  'producer-acceptance',
  'archived',
]);

function defaultStagePolicies(
  scopeRevision: number,
  decidedAt: string,
  migrated: boolean,
): VersionStagePolicy[] {
  return VERSION_STAGES.map((stage) => ({
    stage,
    mode: 'execute',
    reason: migrated
      ? '旧状态缺少阶段策略，迁移时保守采用完整执行。'
      : '按版本基线完整执行；后续只可在保留固定门禁的前提下追加策略修订。',
    evidence: migrated ? ['legacy-unknown'] : [],
    decidedBy: migrated ? 'migration' : 'version-kernel',
    decidedAt,
    policyRevision: 1,
    scopeRevision,
  }));
}

function createOrchestration(
  direction: string,
  createdAt: string,
  sourceRequestId = '',
  migrated = false,
): FormalVersionOrchestration {
  return {
    schemaVersion: 1,
    migratedFrom: migrated ? 'formal-version-v1' : 'native',
    riskAssessments: [
      {
        revision: 1,
        level: 'high',
        impact: migrated ? ['legacy-unknown'] : ['persistent-state', 'cross-process-recovery'],
        stateTransitions: true,
        crossProcessConcurrency: true,
        externalDependencies: [],
        rollback: '保留 v1 信封和原事实，可停写后回退扩展。',
        evaluatedBy: migrated ? 'migration' : 'version-kernel',
        basis: migrated
          ? '历史风险依据不可用，采用保守高风险基线。'
          : '涉及持久状态与跨进程恢复，采用高风险基线。',
        evaluatedAt: createdAt,
      },
    ],
    stagePolicies: defaultStagePolicies(1, createdAt, migrated),
    scopeRevisions: [
      {
        revision: 1,
        direction,
        sourceRequestId,
        disposition: 'initial',
        status: 'approved',
        reason: migrated ? '由现有正式版本方向保守迁移。' : '正式版本初始方向。',
        createdAt,
      },
    ],
    decisionGates: [],
    featureVerifications: [],
    qaRuns: [],
  };
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
      (todo) =>
        !todo.decisionGateId &&
        todo.stage === stage &&
        todo.assignee === 'producer' &&
        todo.status === 'open',
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
  sourceRequestId?: string;
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
    orchestration: createOrchestration(input.direction, createdAt, input.sourceRequestId, false),
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

function requireOrchestration(version: FormalVersion): FormalVersionOrchestration {
  normalizeFormalVersion(version);
  if (!version.orchestration) throw new Error('正式版本编排扩展初始化失败');
  return version.orchestration;
}

function currentScopeRevision(orchestration: FormalVersionOrchestration): number {
  return (
    orchestration.scopeRevisions.filter((revision) => revision.status === 'approved').at(-1)
      ?.revision ?? 1
  );
}

function featureVerificationHasTrustedPass(verification: FeatureVerification): boolean {
  return (
    verification.agentId.trim().length > 0 &&
    verification.codeRevision.trim().length > 0 &&
    verification.typecheck === 'passed' &&
    verification.targetedTests === 'passed' &&
    verification.evidence.length > 0
  );
}

function qaRunHasTrustedResult(
  orchestration: FormalVersionOrchestration,
  run: VersionQaRun,
): boolean {
  return (
    run.independent &&
    run.commands.length > 0 &&
    run.evidence.length > 0 &&
    !orchestration.featureVerifications.some((verification) => verification.agentId === run.agentId)
  );
}

function qaRunHasTrustedPass(
  orchestration: FormalVersionOrchestration,
  run: VersionQaRun,
): boolean {
  return (
    qaRunHasTrustedResult(orchestration, run) &&
    run.status === 'passed' &&
    run.commands.every((command) => command.exitCode === 0)
  );
}

export function recordRiskAssessment(
  version: FormalVersion,
  input: Omit<VersionRiskAssessment, 'revision' | 'evaluatedAt'> & { now?: string },
): VersionRiskAssessment {
  const orchestration = requireOrchestration(version);
  const assessment: VersionRiskAssessment = {
    ...input,
    revision: (orchestration.riskAssessments.at(-1)?.revision ?? 0) + 1,
    evaluatedAt: nowIso(input.now),
  };
  orchestration.riskAssessments.push(assessment);
  version.updatedAt = assessment.evaluatedAt;
  return assessment;
}

export function recordStagePolicy(
  version: FormalVersion,
  input: Omit<VersionStagePolicy, 'policyRevision' | 'decidedAt'> & { now?: string },
): VersionStagePolicy {
  if (input.mode === 'skip' && UNSKIPPABLE_STAGES.has(input.stage)) {
    throw new Error(`${input.stage} 是固定门禁，不能跳过`);
  }
  if (!input.reason.trim()) throw new Error('阶段策略必须记录公开理由');
  if (
    input.stage === 'task-breakdown' &&
    input.mode === 'skip' &&
    version.workItems.some((item) => item.status !== 'skipped')
  ) {
    throw new Error('任务拆分仍有实际工作项，不能标记为无需执行');
  }
  const orchestration = requireOrchestration(version);
  const latestScope = currentScopeRevision(orchestration);
  if (input.scopeRevision !== latestScope) throw new Error('阶段策略适用的范围修订已过期');
  const policy: VersionStagePolicy = {
    ...input,
    evidence: [...input.evidence],
    policyRevision:
      Math.max(
        0,
        ...orchestration.stagePolicies
          .filter((candidate) => candidate.stage === input.stage)
          .map((candidate) => candidate.policyRevision),
      ) + 1,
    decidedAt: nowIso(input.now),
  };
  orchestration.stagePolicies.push(policy);
  if (input.stage === 'task-breakdown' && input.mode === 'skip') {
    orchestration.stagePolicies.push({
      stage: 'development',
      mode: 'skip',
      reason: `任务拆分无需执行，因此没有可进入开发的工作项：${input.reason}`,
      evidence: [...input.evidence],
      decidedBy: 'version-kernel',
      policyRevision:
        Math.max(
          0,
          ...orchestration.stagePolicies
            .filter((candidate) => candidate.stage === 'development')
            .map((candidate) => candidate.policyRevision),
        ) + 1,
      scopeRevision: input.scopeRevision,
      decidedAt: policy.decidedAt,
    });
  }
  version.updatedAt = policy.decidedAt;
  return policy;
}

export function recordScopeRevision(
  version: FormalVersion,
  input: Omit<VersionScopeRevision, 'revision' | 'status' | 'createdAt'> & { now?: string },
): VersionScopeRevision {
  const orchestration = requireOrchestration(version);
  const existing = input.sourceRequestId
    ? orchestration.scopeRevisions.find(
        (candidate) => candidate.sourceRequestId === input.sourceRequestId,
      )
    : undefined;
  if (existing) return existing;
  const revision: VersionScopeRevision = {
    ...input,
    revision: (orchestration.scopeRevisions.at(-1)?.revision ?? 0) + 1,
    status: input.disposition === 'scope-review' ? 'pending' : 'approved',
    createdAt: nowIso(input.now),
  };
  orchestration.scopeRevisions.push(revision);
  for (const stage of VERSION_STAGES) {
    const previous = orchestration.stagePolicies
      .filter((candidate) => candidate.stage === stage)
      .at(-1);
    if (!previous) continue;
    orchestration.stagePolicies.push({
      ...previous,
      evidence: [...previous.evidence],
      reason: `范围修订 ${revision.revision} 后复用既有策略：${previous.reason}`,
      decidedAt: revision.createdAt,
      decidedBy: 'version-kernel',
      policyRevision: previous.policyRevision + 1,
      scopeRevision: revision.revision,
    });
  }
  if (input.disposition === 'merged')
    version.direction = `${version.direction}\n${input.direction}`;
  version.updatedAt = revision.createdAt;
  return revision;
}

export function addDecisionGate(
  version: FormalVersion,
  input: Omit<VersionDecisionGate, 'id' | 'status' | 'resolvedBy' | 'createdAt' | 'resolvedAt'> & {
    now?: string;
  },
): VersionDecisionGate {
  const orchestration = requireOrchestration(version);
  const existing = orchestration.decisionGates.find(
    (candidate) =>
      candidate.sourceRequestId === input.sourceRequestId && candidate.kind === input.kind,
  );
  if (existing) return existing;
  const gate: VersionDecisionGate = {
    id: randomUUID(),
    kind: input.kind,
    stage: input.stage,
    status: 'open',
    summary: input.summary,
    sourceRequestId: input.sourceRequestId,
    resolvedBy: '',
    createdAt: nowIso(input.now),
    resolvedAt: '',
    resolutionHistory: [],
  };
  orchestration.decisionGates.push(gate);
  addVersionTodo(version, {
    decisionGateId: gate.id,
    title:
      input.kind === 'scope-change'
        ? '确认当前版本范围修订'
        : input.kind === 'producer-escalated-design'
          ? '评审升级的详细策划'
          : '确认不可逆架构决策',
    detail: input.summary,
    stage: input.stage,
    assignee: 'producer',
    now: gate.createdAt,
  });
  version.status = 'waiting-producer';
  version.updatedAt = gate.createdAt;
  return gate;
}

export function resolveDecisionGate(
  version: FormalVersion,
  gateId: string,
  decision: 'approved' | 'rejected',
  now?: string,
  sourceRequestId = '',
): void {
  const gate = requireOrchestration(version).decisionGates.find(
    (candidate) => candidate.id === gateId,
  );
  if (!gate) throw new Error(`找不到决策门禁：${gateId}`);
  const priorResolution = sourceRequestId
    ? gate.resolutionHistory?.find((entry) => entry.requestId === sourceRequestId)
    : undefined;
  if (priorResolution) {
    if (priorResolution.decision !== decision) throw new Error('同一制作人回复不能改写既有决策');
    return;
  }
  if (gate.status === 'approved') throw new Error('已经批准的决策门禁不能再次修改');
  if (gate.status === 'rejected' && gate.kind === 'scope-change') {
    throw new Error('已经拒绝的范围修订不能再次修改');
  }
  gate.status = decision;
  gate.resolvedBy = 'producer';
  gate.resolvedAt = nowIso(now);
  if (sourceRequestId) {
    gate.resolutionHistory ??= [];
    gate.resolutionHistory.push({
      requestId: sourceRequestId,
      decision,
      resolvedAt: gate.resolvedAt,
    });
  }
  for (const todo of version.todos.filter(
    (candidate) => candidate.status === 'open' && candidate.decisionGateId === gate.id,
  )) {
    todo.status = 'done';
    todo.completedAt = gate.resolvedAt;
  }
  if (decision === 'approved' && gate.kind === 'scope-change') {
    const revision = requireOrchestration(version).scopeRevisions.find(
      (candidate) => candidate.sourceRequestId === gate.sourceRequestId,
    );
    if (revision && !version.direction.includes(revision.direction)) {
      version.direction = `${version.direction}\n${revision.direction}`;
    }
    if (revision) revision.status = 'approved';
  } else if (decision === 'rejected' && gate.kind === 'scope-change') {
    const revision = requireOrchestration(version).scopeRevisions.find(
      (candidate) => candidate.sourceRequestId === gate.sourceRequestId,
    );
    if (revision) revision.status = 'rejected';
  }
  if (decision === 'rejected' && gate.kind !== 'scope-change') {
    addVersionTodo(version, {
      decisionGateId: gate.id,
      title:
        gate.kind === 'producer-escalated-design' ? '重新评审升级策划' : '重新审批不可逆架构决策',
      detail: `${gate.summary}（上次已退回；明确批准后才会恢复推进）`,
      stage: gate.stage,
      assignee: 'producer',
      now: gate.resolvedAt,
    });
  }
  const gates = requireOrchestration(version).decisionGates;
  version.status = gates.some(
    (entry) => entry.status === 'rejected' && entry.kind !== 'scope-change',
  )
    ? 'paused'
    : gates.some((entry) => entry.status === 'open') ||
        version.todos.some((entry) => entry.status === 'open' && entry.assignee === 'producer')
      ? 'waiting-producer'
      : 'running';
  version.updatedAt = gate.resolvedAt;
}

export function decisionResolutionForRequest(
  version: FormalVersion,
  requestId: string,
): { gate: VersionDecisionGate; decision: 'approved' | 'rejected'; resolvedAt: string } | null {
  for (const gate of requireOrchestration(version).decisionGates) {
    const resolution = gate.resolutionHistory?.find((entry) => entry.requestId === requestId);
    if (resolution)
      return { gate, decision: resolution.decision, resolvedAt: resolution.resolvedAt };
  }
  return null;
}

export function recordFeatureVerification(
  version: FormalVersion,
  input: Omit<FeatureVerification, 'id' | 'scopeRevision' | 'createdAt'> & { now?: string },
): FeatureVerification {
  if (!version.workItems.some((item) => item.id === input.workItemId)) {
    throw new Error(`Feature 自测必须关联真实工作项：${input.workItemId}`);
  }
  if (!input.agentId.trim() || !input.codeRevision.trim() || input.evidence.length === 0) {
    throw new Error('Feature 自测必须关联执行 Agent、代码修订和公开证据');
  }
  const result: FeatureVerification = {
    ...input,
    id: randomUUID(),
    scopeRevision: currentScopeRevision(requireOrchestration(version)),
    evidence: [...input.evidence],
    createdAt: nowIso(input.now),
  };
  const orchestration = requireOrchestration(version);
  orchestration.featureVerifications.push(result);
  orchestration.codeRevision = result.codeRevision;
  orchestration.qaInvalidatedThrough = orchestration.qaRuns.length;
  version.updatedAt = result.createdAt;
  return result;
}

export function recordQaRun(
  version: FormalVersion,
  input: Omit<VersionQaRun, 'id' | 'scopeRevision' | 'createdAt'> & { now?: string },
): VersionQaRun {
  if (!input.independent) throw new Error('版本 QA 必须由独立测试 Agent 执行');
  if (!input.agentId.trim() || !input.codeRevision.trim()) {
    throw new Error('版本 QA 必须关联测试 Agent 与代码修订');
  }
  if (input.commands.length === 0 || input.evidence.length === 0) {
    throw new Error('版本 QA 结论必须包含实际命令与公开证据');
  }
  if (input.status === 'passed' && input.commands.some((command) => command.exitCode !== 0)) {
    throw new Error('版本 QA 通过结论必须包含退出码为 0 的命令');
  }
  const orchestration = requireOrchestration(version);
  for (const fix of input.bugFixes ?? []) {
    const bug = version.bugs.find((entry) => entry.id === fix.bugId);
    if (
      !input.suites.includes('defect-reverification') ||
      !bug ||
      bug.status !== 'verify' ||
      !bug.fixAttemptId ||
      bug.fixAttemptId !== fix.fixAttemptId ||
      bug.fixCodeRevision !== input.codeRevision
    )
      throw new Error('缺陷复验必须关联当前修复轮次与代码修订');
  }
  if (
    orchestration.featureVerifications.some(
      (verification) => verification.agentId === input.agentId,
    )
  ) {
    throw new Error('版本 QA 的执行身份必须独立于 Feature Agent');
  }
  const result: VersionQaRun = {
    ...input,
    id: randomUUID(),
    scopeRevision: currentScopeRevision(orchestration),
    suites: [...new Set(input.suites)],
    commands: input.commands.map((command) => ({ ...command })),
    evidence: [...input.evidence],
    ...(input.bugFixes ? { bugFixes: input.bugFixes.map((fix) => ({ ...fix })) } : {}),
    createdAt: nowIso(input.now),
  };
  orchestration.qaRuns.push(result);
  version.updatedAt = result.createdAt;
  return result;
}

export function transitionVersionBug(
  version: FormalVersion,
  bugId: string,
  target: VersionBug['status'],
  verificationRunId = '',
  codeRevision = '',
): void {
  const bug = version.bugs.find((candidate) => candidate.id === bugId);
  if (!bug) throw new Error(`找不到版本缺陷：${bugId}`);
  const allowed: Record<VersionBug['status'], VersionBug['status'][]> = {
    open: ['fixing', 'deferred'],
    fixing: ['verify', 'open'],
    verify: ['closed', 'open', 'fixing'],
    closed: ['open'],
    deferred: ['open'],
  };
  if (!allowed[bug.status].includes(target)) {
    throw new Error(`缺陷不能从 ${bug.status} 转为 ${target}`);
  }
  if (target === 'verify' && !codeRevision.trim()) {
    throw new Error('提交缺陷复验必须指定修复代码修订');
  }
  if (target === 'closed') {
    const orchestration = requireOrchestration(version);
    const scopeRevision = currentScopeRevision(orchestration);
    const qa = orchestration.qaRuns.find(
      (run) =>
        run.id === verificationRunId &&
        qaRunHasTrustedPass(orchestration, run) &&
        !!bug.fixAttemptId &&
        !!bug.fixCodeRevision &&
        run.codeRevision === bug.fixCodeRevision &&
        run.bugFixes?.some(
          (fix) => fix.bugId === bug.id && fix.fixAttemptId === bug.fixAttemptId,
        ) &&
        run.scopeRevision === scopeRevision &&
        run.suites.includes('defect-reverification'),
    );
    if (!qa) throw new Error('缺陷只能由独立测试 Agent 的成功复验关闭');
    bug.verificationRunId = qa.id;
  }
  if (target === 'open' || target === 'fixing') {
    bug.verificationRunId = '';
    bug.fixAttemptId = target === 'fixing' ? randomUUID() : '';
    bug.fixCodeRevision = '';
    const orchestration = requireOrchestration(version);
    orchestration.qaInvalidatedThrough = orchestration.qaRuns.length;
  }
  if (target === 'verify') {
    // Legacy fixing records have no attempt identity; never infer one from old QA.
    bug.fixAttemptId ||= randomUUID();
    bug.fixCodeRevision = codeRevision;
    const orchestration = requireOrchestration(version);
    orchestration.codeRevision = codeRevision;
    orchestration.qaInvalidatedThrough = orchestration.qaRuns.length;
  }
  bug.status = target;
  version.updatedAt = new Date().toISOString();
}

function qaMatchesCurrentCode(version: FormalVersion, qa: VersionQaRun): boolean {
  const orchestration = requireOrchestration(version);
  if (orchestration.qaRuns.indexOf(qa) < (orchestration.qaInvalidatedThrough ?? 0)) return false;
  if (orchestration.codeRevision) return qa.codeRevision === orchestration.codeRevision;
  // Legacy records have no explicit candidate baseline. Any recorded revision
  // conflict is enough to retain the evidence for review without trusting it.
  const feature = orchestration.featureVerifications.at(-1);
  if (feature && feature.codeRevision !== qa.codeRevision) return false;
  return !version.bugs.some(
    (bug) => bug.fixCodeRevision && bug.fixCodeRevision !== qa.codeRevision,
  );
}

export function advanceVersion(version: FormalVersion, target: VersionStage, now?: string): void {
  const currentIndex = stageIndex(version.currentStage);
  const targetIndex = stageIndex(target);
  if (targetIndex !== currentIndex + 1) {
    throw new Error(`版本只能从 ${version.currentStage} 推进到下一个阶段`);
  }
  const orchestration = requireOrchestration(version);
  const unresolvedGate = orchestration.decisionGates.find(
    (gate) =>
      (gate.status === 'open' || (gate.status === 'rejected' && gate.kind !== 'scope-change')) &&
      stageIndex(gate.stage) <= currentIndex,
  );
  if (unresolvedGate) throw new Error(`尚未通过制作人决策门禁：${unresolvedGate.summary}`);
  if (version.status === 'paused') throw new Error('版本已暂停，不能推进阶段');
  const scopeRevision = currentScopeRevision(orchestration);
  const policy = orchestration.stagePolicies
    .filter(
      (candidate) =>
        candidate.stage === version.currentStage && candidate.scopeRevision === scopeRevision,
    )
    .at(-1);
  if (!policy) throw new Error(`${version.currentStage} 缺少当前范围的阶段策略`);
  if (policy.mode === 'skip' && UNSKIPPABLE_STAGES.has(version.currentStage)) {
    throw new Error(`${version.currentStage} 是固定门禁，不能跳过`);
  }
  if (
    version.currentStage === 'development' &&
    policy.mode === 'skip' &&
    version.workItems.some((item) => item.status !== 'skipped')
  ) {
    throw new Error('开发阶段存在实际工作项，不能标记为无需执行');
  }
  if (version.currentStage === 'development' && policy.mode !== 'skip') {
    const unfinished = version.workItems.find(
      (item) => !['completed', 'skipped'].includes(item.status),
    );
    if (unfinished) throw new Error(`Feature 尚未完成：${unfinished.title}`);
    const missing = version.workItems.find((item) => {
      if (item.status !== 'completed') return false;
      const latestVerification = orchestration.featureVerifications
        .filter(
          (verification) =>
            verification.workItemId === item.id && verification.scopeRevision === scopeRevision,
        )
        .at(-1);
      return !latestVerification || !featureVerificationHasTrustedPass(latestVerification);
    });
    if (missing) throw new Error(`Feature 尚无类型检查与定向测试通过证据：${missing.title}`);
  }
  if (version.currentStage === 'qa' && policy.mode !== 'skip') {
    const qa = orchestration.qaRuns.at(-1);
    const required: QaSuite[] = ['acceptance', 'integration', 'regression'];
    if (
      !qa ||
      !qaRunHasTrustedResult(orchestration, qa) ||
      qa.scopeRevision !== scopeRevision ||
      !qaMatchesCurrentCode(version, qa) ||
      required.some((suite) => !qa.suites.includes(suite)) ||
      (qa.status === 'failed' &&
        !version.bugs.some((bug) => !['closed', 'deferred'].includes(bug.status)))
    ) {
      throw new Error('版本测试尚未形成独立验收、集成与回归通过结论');
    }
  }
  if (target === 'candidate') {
    const blocking = version.bugs.find(
      (bug) => ['blocker', 'high'].includes(bug.severity) && !['closed'].includes(bug.status),
    );
    if (blocking) throw new Error(`阻塞或高风险缺陷尚未通过复验：${blocking.title}`);
    const qaPolicy = orchestration.stagePolicies
      .filter((candidate) => candidate.stage === 'qa' && candidate.scopeRevision === scopeRevision)
      .at(-1);
    if (qaPolicy?.mode !== 'skip') {
      const qa = orchestration.qaRuns.at(-1);
      if (
        !qa ||
        !qaRunHasTrustedPass(orchestration, qa) ||
        qa.scopeRevision !== scopeRevision ||
        !qaMatchesCurrentCode(version, qa) ||
        !qa.suites.includes('regression')
      ) {
        throw new Error('候选版本尚无当前范围与代码修订的有效独立 QA 回归通过结论');
      }
    }
    if (policy.mode === 'skip') {
      const unresolved = version.bugs.some((bug) => !['closed', 'deferred'].includes(bug.status));
      if (unresolved) {
        throw new Error('缺陷修复只有在独立 QA 无待修缺陷时才能跳过');
      }
    }
  }
  const requiredReviewer = policy.mode === 'skip' ? null : expectedReviewer(version.currentStage);
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
  current.status = policy.mode === 'skip' ? 'skipped' : 'completed';
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
  if (input.sourceRequestId) {
    const existing = version.approvals.find(
      (approval) => approval.sourceRequestId === input.sourceRequestId,
    );
    if (existing) return existing;
  }
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
    ...(input.sourceRequestId ? { sourceRequestId: input.sourceRequestId } : {}),
    createdAt,
  };
  version.approvals.push(approval);
  const openTodo = version.todos.find(
    (todo) =>
      !todo.decisionGateId &&
      todo.stage === input.stage &&
      todo.assignee === 'producer' &&
      todo.status === 'open',
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

export function applyVersionTodoDecision(
  version: FormalVersion,
  itemId: string,
  action: string,
  note = '',
): { title: string; message: string } {
  if (!['approve', 'request-changes'].includes(action)) throw new Error('不支持的版本待办方案');
  normalizeFormalVersion(version);
  const todo = version.todos.find(
    (candidate) =>
      candidate.id === itemId && candidate.assignee === 'producer' && candidate.status === 'open',
  );
  if (!todo || todo.stage !== version.currentStage) throw new Error('版本待办已经处理或不存在');
  if (todo.decisionGateId) {
    const gate = version.orchestration?.decisionGates.find(
      (candidate) =>
        candidate.id === todo.decisionGateId &&
        (candidate.status === 'open' ||
          (candidate.status === 'rejected' && candidate.kind !== 'scope-change')),
    );
    if (!gate) throw new Error('决策门禁已经处理或不存在');
    const approved = action === 'approve';
    resolveDecisionGate(version, gate.id, approved ? 'approved' : 'rejected');
    const message = approved
      ? `已批准“${gate.summary}”，当前阶段的其他门禁仍需分别完成。`
      : `已退回“${gate.summary}”，相关决策已记录。`;
    return { title: todo.title, message };
  }
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
  const message =
    version.status === 'archived'
      ? `版本“${version.title}”已完成归档。`
      : decision === 'approved'
        ? `已通过，版本进入“${version.nodes.find((node) => node.id === version.currentStage)?.title}”。`
        : `已退回“${version.nodes.find((node) => node.id === version.currentStage)?.title}”修正。`;
  return { title: todo.title, message };
}

export function addVersionTodo(
  version: FormalVersion,
  input: Omit<VersionTodo, 'id' | 'status' | 'createdAt' | 'completedAt'> & { now?: string },
): VersionTodo {
  const todo: VersionTodo = {
    id: randomUUID(),
    ...(input.decisionGateId ? { decisionGateId: input.decisionGateId } : {}),
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

export function currentVersionStagePolicy(
  version: FormalVersion,
  stage: VersionStage,
): VersionStagePolicy {
  const orchestration = requireOrchestration(version);
  const scopeRevision = currentScopeRevision(orchestration);
  const policy = orchestration.stagePolicies
    .filter((candidate) => candidate.stage === stage && candidate.scopeRevision === scopeRevision)
    .at(-1);
  if (!policy) throw new Error(`${stage} 缺少当前范围的阶段策略`);
  return policy;
}

export function effectiveVersionNodes(version: FormalVersion): VersionNode[] {
  return version.nodes.map((node) => {
    const policy = currentVersionStagePolicy(version, node.id);
    if (policy.mode !== 'skip' || node.status === 'completed') return node;
    return {
      ...node,
      status: 'skipped',
      summary: node.summary || policy.reason,
    };
  });
}

export function versionProgress(version: FormalVersion): number {
  const applicable = effectiveVersionNodes(version).filter((node) => node.status !== 'skipped');
  if (applicable.length === 0) return 100;
  const completed = applicable.filter((node) => node.status === 'completed').length;
  return Math.round((completed / applicable.length) * 100);
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
    nodes: effectiveVersionNodes(version),
    progress: versionProgress(version),
    health: versionHealth(version),
    producerTodos: version.todos.filter(
      (todo) => todo.assignee === 'producer' && todo.status === 'open',
    ),
    openBugCount: version.bugs.filter((bug) => !['closed', 'deferred'].includes(bug.status)).length,
  };
}

export function normalizeFormalVersion(version: FormalVersion): boolean {
  const hasOrchestration = Object.prototype.hasOwnProperty.call(version, 'orchestration');
  if (hasOrchestration) validateOrchestrationRecords(version.orchestration);
  if (
    version.bugs.some((bug) =>
      [bug.fixAttemptId, bug.fixCodeRevision].some(
        (field) => field !== undefined && typeof field !== 'string',
      ),
    )
  )
    throw new Error('缺陷修复绑定损坏；已停止自动写入和派发');
  let orchestrationChanged = false;
  if (!hasOrchestration) {
    version.orchestration = createOrchestration(
      version.direction,
      version.createdAt || version.updatedAt || new Date().toISOString(),
      '',
      true,
    );
    orchestrationChanged = true;
  }
  const orchestration = version.orchestration;
  if (!orchestration) throw new Error('正式版本编排扩展损坏；已停止自动写入和派发');
  // Old decision todos used summary/stage instead of an explicit foreign key.
  // Link only unambiguous matches; never turn an ambiguous decision into a stage approval.
  for (const todo of version.todos) {
    if (todo.decisionGateId !== undefined) {
      if (
        typeof todo.decisionGateId !== 'string' ||
        !orchestration.decisionGates.some(
          (gate) => gate.id === todo.decisionGateId && gate.stage === todo.stage,
        )
      )
        throw new Error('决策待办关联损坏；已停止自动写入和派发');
      continue;
    }
    const matches = orchestration.decisionGates.filter(
      (gate) =>
        todo.assignee === 'producer' &&
        gate.stage === todo.stage &&
        gate.summary === todo.detail &&
        gate.createdAt === todo.createdAt,
    );
    if (matches.length > 1) throw new Error('旧决策待办关联不明确；已停止自动写入和派发');
    if (matches[0]) {
      todo.decisionGateId = matches[0].id;
      orchestrationChanged = true;
    }
  }
  if (version.currentStage !== 'archived') {
    if (version.status !== 'archived') return orchestrationChanged;
    const current = VERSION_STAGE_DEFINITIONS.find((stage) => stage.id === version.currentStage);
    version.status = current?.producerGate ? 'waiting-producer' : 'running';
    version.completedAt = '';
    return true;
  }
  let changed = orchestrationChanged || version.status !== 'archived';
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
    if (parsed.schemaVersion !== 1) {
      throw new Error(`不支持正式版本信封版本 ${String(parsed.schemaVersion)}：${path}`);
    }
    if (!VERSION_STAGES.includes(parsed.currentStage)) {
      throw new Error(`正式版本阶段无效：${path}`);
    }
    parsed.stateRevision = Number.isSafeInteger(parsed.stateRevision) ? parsed.stateRevision : 0;
    normalizeFormalVersion(parsed);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError)
      throw new Error(`正式版本状态损坏：${path}`, { cause: error });
    throw error;
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
  normalizeFormalVersion(snapshot);
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
