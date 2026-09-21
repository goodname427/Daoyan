export const MODEL_TIERS = ['economy', 'standard', 'advanced', 'critical'] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];
export type TaskType = 'analysis' | 'implementation' | 'test' | 'documentation';
export type ValidationProfile = 'light' | 'task' | 'feature' | 'version';

export type FeatureValidationStage = 'fast-gate' | 'independent-review' | 'full-gate';

export interface ModelRoute {
  model: string;
  reasoning: 'low' | 'medium' | 'high';
}

export interface AgentPolicy {
  version: number;
  planner: ModelRoute;
  tiers: Record<ModelTier, ModelRoute>;
  reviewers: Record<ModelTier, ModelRoute>;
  recovery: {
    transientRetries: number;
    retryBackoffSeconds: number;
    reviewerFallbacks: Record<ModelTier, ModelRoute[]>;
  };
  versionCycle: {
    maxFeatureRounds: number;
    featureRecoveryAttempts: number;
  };
  limits: {
    maxTasks: number;
    maxEscalationsPerTask: number;
    maxReviewRounds: number;
  };
  timeouts: {
    heartbeatSeconds: number;
    plannerMinutes: number;
    workers: Record<ModelTier, number>;
    reviewers: Record<ModelTier, number>;
    repairs: Record<ModelTier, number>;
    verificationMinutes: number;
  };
  verification: { delivery: string[] };
  git: {
    autoCommit: boolean;
    autoPush: boolean;
    remote: string;
    proxyFallback: string;
  };
}

export interface PlannedTask {
  id: string;
  title: string;
  objective: string;
  type: TaskType;
  tier: ModelTier;
  reasoning: string;
  dependsOn: string[];
  paths: string[];
  deliverables: string[];
  verification: string[];
  validationProfile?: ValidationProfile;
}

export function validationProfileForTask(task: PlannedTask): ValidationProfile {
  if (task.validationProfile) return task.validationProfile;
  return task.type === 'documentation' || task.type === 'analysis' ? 'light' : 'task';
}

const VALIDATION_PROFILE_WEIGHT: Record<ValidationProfile, number> = {
  light: 0,
  task: 1,
  feature: 2,
  version: 3,
};

/** Resolve mixed plans conservatively while keeping planning/docs work genuinely light. */
export function validationProfileForPlan(plan: TaskPlan): ValidationProfile {
  return plan.tasks
    .map(validationProfileForTask)
    .reduce((selected, profile) =>
      VALIDATION_PROFILE_WEIGHT[profile] > VALIDATION_PROFILE_WEIGHT[selected] ? profile : selected,
    );
}

/**
 * This is the production execution contract consumed by the Feature PM.
 * Version work owns its own integration commands and only receives a report review;
 * it must not replay Feature gates. Light work remains at Task-scoped direct checks.
 */
export function validationStagesForPlan(plan: TaskPlan): FeatureValidationStage[] {
  const profile = validationProfileForPlan(plan);
  if (profile === 'light') return [];
  if (profile === 'version') return ['independent-review'];
  return ['fast-gate', 'independent-review', 'full-gate'];
}

export function failedNpmCommandFromOutput(output: string, fallback: string[]): string[] {
  const scripts = [...output.matchAll(/^>\s+\S+@\S+\s+([a-z0-9:_-]+)\s*$/gim)].map(
    (match) => match[1],
  );
  const failedScript = [...scripts]
    .reverse()
    .find((script) => !['verify', 'verify:full'].includes(script));
  return failedScript ? ['npm', 'run', failedScript] : [...fallback];
}

export function npmRunCommandsFromScript(script: string): string[][] {
  return script
    .split(/\s*&&\s*/)
    .map((segment) => /^npm\s+run\s+([a-z0-9:_-]+)$/i.exec(segment.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ['npm', 'run', match[1]]);
}

export function fastGateCommandProgress(
  commands: string[][],
  failedCommand: string[],
): { completedCommands: string[][]; pendingCommands: string[][] } {
  const failedKey = failedCommand.join('\0');
  const failedIndex = commands.findIndex((command) => command.join('\0') === failedKey);
  if (failedIndex < 0) {
    return { completedCommands: [], pendingCommands: [[...failedCommand]] };
  }
  return {
    completedCommands: commands.slice(0, failedIndex).map((command) => [...command]),
    pendingCommands: commands.slice(failedIndex).map((command) => [...command]),
  };
}

export function pendingValidationStages(
  stages: FeatureValidationStage[],
  evidence: {
    fullGate: boolean;
    fastGate: boolean;
    independentReview: boolean;
    completedDeliveryCommit?: boolean;
  },
): FeatureValidationStage[] {
  if (evidence.fullGate && stages.includes('full-gate')) return [];
  // An exact clean commit created from the Git-delivery checkpoint can only
  // exist after Task work, the fast gate and independent review succeeded.
  // If its final evidence is missing, repair only that final evidence instead
  // of replaying expensive upstream model work.
  if (evidence.completedDeliveryCommit) {
    return stages.includes('full-gate') ? ['full-gate'] : [];
  }
  return stages.filter(
    (stage) =>
      !(
        (stage === 'fast-gate' && evidence.fastGate) ||
        (stage === 'independent-review' && evidence.independentReview)
      ),
  );
}

export interface TaskPlan {
  version: 1;
  title: string;
  summary: string;
  producerDecisionRequired: boolean;
  producerQuestion: string;
  riskSignals: string[];
  acceptanceCriteria: string[];
  nonGoals: string[];
  tasks: PlannedTask[];
  commitMessage: string;
}

export interface TaskReuseEvidence {
  taskId: string;
  passed: boolean;
  inputFingerprint: string;
  currentInputFingerprint: string;
  outputFingerprint: string;
  currentOutputFingerprint: string;
  commandFingerprint: string;
  currentCommandFingerprint: string;
  configFingerprint: string;
  currentConfigFingerprint: string;
}

const POST_FEATURE_GATE_REPORT =
  /^(?:qa|bugfix|bugfix-reverification|candidate|producer-acceptance|archived)\.(?:json|md)$/;

/**
 * Formal-version reports written after the Feature gate are not implementation
 * inputs. The development manifest is written before that gate and is consumed
 * as Task evidence, so it remains bound to the validated tree together with
 * scope, planning and task-breakdown inputs.
 */
export function isValidationTreePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  const match = /^docs\/versions\/[^/]+\/(.+)$/.exec(normalized);
  return !match || !POST_FEATURE_GATE_REPORT.test(match[1]);
}

export function recoveryCountersAfterResume(
  status: 'active' | 'recoverable' | 'waiting-producer' | 'delivered',
  actualLaunchCount: number | null,
  abnormalRecoveryCount: number | null,
): { actualLaunchCount: number | null; abnormalRecoveryCount: number | null } {
  return {
    actualLaunchCount: actualLaunchCount === null ? null : actualLaunchCount + 1,
    abnormalRecoveryCount:
      abnormalRecoveryCount === null
        ? null
        : abnormalRecoveryCount + (status === 'active' || status === 'recoverable' ? 1 : 0),
  };
}

export type WorkspaceChangeBaseline = Record<string, string | null>;

/** Compare dirty path/content snapshots so pre-checkpoint changes do not block recovery. */
export function changedPathsSinceWorkspaceBaseline(
  previous: WorkspaceChangeBaseline,
  current: WorkspaceChangeBaseline,
): string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter(
      (path) =>
        !Object.hasOwn(previous, path) ||
        !Object.hasOwn(current, path) ||
        previous[path] !== current[path],
    )
    .sort((left, right) => left.localeCompare(right));
}

/** Persisted Task inputs include declared paths plus resolved read-only imports. */
export function taskInputPaths(declaredPaths: string[], directDependencies: string[]): string[] {
  return [
    ...new Set([...declaredPaths, ...directDependencies].map((path) => path.replaceAll('\\', '/'))),
  ].sort((left, right) => left.localeCompare(right));
}

/** Extract relative module references that can be resolved to repository files. */
export function relativeModuleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]?.startsWith('.')) specifiers.add(match[1]);
    }
  }
  return [...specifiers].sort((left, right) => left.localeCompare(right));
}

/**
 * New checkpoints bind output evidence to the files the Agent actually changed.
 * Declared task paths remain a legacy fallback because older checkpoints did not
 * distinguish suggested inputs from observed outputs.
 */
export function taskOutputPaths(
  declaredPaths: string[],
  changedFiles: string[] | undefined,
): string[] {
  const selected = changedFiles === undefined ? declaredPaths : changedFiles;
  return [...new Set(selected.map((path) => path.replaceAll('\\', '/')))].sort((left, right) =>
    left.localeCompare(right),
  );
}

export function selectReusableTaskIds(
  tasks: PlannedTask[],
  evidence: TaskReuseEvidence[],
): string[] {
  const byTask = new Map(evidence.map((entry) => [entry.taskId, entry]));
  const reusable = new Set<string>();
  for (const task of sortTasks(tasks)) {
    const entry = byTask.get(task.id);
    if (
      entry?.passed &&
      entry.inputFingerprint.length > 0 &&
      entry.inputFingerprint === entry.currentInputFingerprint &&
      entry.outputFingerprint.length > 0 &&
      entry.outputFingerprint === entry.currentOutputFingerprint &&
      entry.commandFingerprint.length > 0 &&
      entry.commandFingerprint === entry.currentCommandFingerprint &&
      entry.configFingerprint.length > 0 &&
      entry.configFingerprint === entry.currentConfigFingerprint &&
      task.dependsOn.every((dependency) => reusable.has(dependency))
    ) {
      reusable.add(task.id);
    }
  }
  return [...reusable];
}

export function canReuseFullGateEvidence(
  value: {
    schemaVersion?: number;
    exitCode?: number;
    workspaceFingerprint?: string;
    configFingerprint?: string;
    command?: string;
  } | null,
  workspaceFingerprint: string,
  configFingerprint: string,
  command: string,
): boolean {
  return Boolean(
    value &&
    value.schemaVersion === 1 &&
    value.exitCode === 0 &&
    value.workspaceFingerprint === workspaceFingerprint &&
    value.configFingerprint === configFingerprint &&
    value.command === command,
  );
}

export type QualityLoopAction = 'complete' | 'repair-in-place' | 'recover' | 'wait-external';

export function qualityLoopAction(input: {
  commandPassed: boolean;
  hasOpenFindings: boolean;
  madeProgress: boolean;
  failureKind?: AgentFailureKind;
  processAbnormal?: boolean;
}): QualityLoopAction {
  if (input.failureKind === 'external-blocker') return 'wait-external';
  if (input.processAbnormal || input.failureKind === 'transient') return 'recover';
  if (!input.commandPassed || input.hasOpenFindings) {
    return input.madeProgress ? 'repair-in-place' : 'recover';
  }
  return 'complete';
}

const FORMAL_STAGE_MARKER = /^\[formal-stage:([a-z-]+)\]\s*/;

const FORMAL_STAGE_TASKS: Record<
  string,
  Pick<PlannedTask, 'title' | 'type' | 'tier' | 'paths' | 'deliverables' | 'verification'>
> = {
  'charter-draft': {
    title: '编写版本策划案',
    type: 'documentation',
    tier: 'standard',
    paths: ['docs/versions/', 'docs/product/', 'docs/specs/'],
    deliverables: ['当前版本的策划案与公开阶段结论'],
    verification: ['核对版本方向、范围、非目标和验收标准'],
  },
  'module-design': {
    title: '完成模块详细策划',
    type: 'documentation',
    tier: 'standard',
    paths: ['docs/versions/', 'docs/product/', 'docs/specs/', 'docs/architecture/'],
    deliverables: ['当前阶段的详细策划与公开阶段结论'],
    verification: ['核对规则、交互、边界和验收标准'],
  },
  'design-review': {
    title: '审核模块详细策划',
    type: 'analysis',
    tier: 'advanced',
    paths: ['docs/versions/', 'docs/product/', 'docs/specs/', 'docs/architecture/'],
    deliverables: ['结构化审核结论与公开阶段结论'],
    verification: ['核对策划完整性、架构约束和产品冲突'],
  },
  'task-breakdown': {
    title: '拆分可执行工作项',
    type: 'analysis',
    tier: 'standard',
    paths: ['docs/versions/', 'docs/specs/', 'docs/status.md'],
    deliverables: ['带稳定 ID 和依赖的任务清单'],
    verification: ['校验任务范围、依赖和验收证据'],
  },
  'version-planning': {
    title: '完成版本排期',
    type: 'analysis',
    tier: 'standard',
    paths: ['docs/versions/', 'docs/status.md'],
    deliverables: ['排序、工作量与范围冻结结论'],
    verification: ['核对依赖顺序和版本容量'],
  },
  development: {
    title: '执行版本开发',
    type: 'implementation',
    tier: 'advanced',
    paths: ['src/', 'scripts/', 'test/', 'e2e/', 'docs/'],
    deliverables: ['逐项完成正式工作项及其验证证据'],
    verification: ['执行 Agent 运行类型检查与定向测试；Feature PM 汇总后运行快速门禁'],
  },
  qa: {
    title: '执行独立版本测试',
    type: 'test',
    tier: 'standard',
    paths: ['test/', 'e2e/', 'docs/versions/'],
    deliverables: ['独立 QA 结论、命令证据和完整缺陷清单'],
    verification: ['验收、集成与核心流程回归'],
  },
  bugfix: {
    title: '修复或复验版本缺陷',
    type: 'implementation',
    tier: 'advanced',
    paths: ['src/', 'scripts/', 'test/', 'e2e/', 'docs/versions/'],
    deliverables: ['逐项缺陷修复或独立复验结论'],
    verification: ['定向测试、缺陷复验和必要回归'],
  },
  candidate: {
    title: '形成版本候选',
    type: 'test',
    tier: 'standard',
    paths: ['docs/versions/', 'dist/'],
    deliverables: ['可体验入口、版本说明和遗留风险'],
    verification: ['确认候选内容与已测试代码修订一致'],
  },
  archived: {
    title: '归档正式版本',
    type: 'documentation',
    tier: 'economy',
    paths: ['docs/versions/', 'docs/status.md', 'docs/dev/'],
    deliverables: ['完整版本档案与状态更新'],
    verification: ['核对策划、任务、测试、缺陷和体验结论'],
  },
};

function buildFormalStagePlan(direction: string, stage: string): TaskPlan | null {
  const template = FORMAL_STAGE_TASKS[stage];
  if (!template) return null;
  const summary = direction.replace(FORMAL_STAGE_MARKER, '').trim();
  const versionValidation =
    stage === 'qa' ||
    stage === 'candidate' ||
    (stage === 'bugfix' && summary.includes('本轮只做独立缺陷复验'));
  return {
    version: 1,
    title: template.title,
    summary,
    producerDecisionRequired: false,
    producerQuestion: '',
    riskSignals: [`正式版本内部阶段：${stage}`],
    acceptanceCriteria: [...template.deliverables, ...template.verification],
    nonGoals: ['不创建新版本，不越过当前阶段，不替制作人作产品方向决策。'],
    tasks: [
      {
        id: `formal-${stage}`,
        ...template,
        objective: summary,
        reasoning: '该事项由正式版本内核定向派发，不再按制作人新方向重新拆分。',
        dependsOn: [],
        validationProfile: versionValidation
          ? 'version'
          : stage === 'development' || stage === 'bugfix'
            ? 'task'
            : 'light',
      },
    ],
    commitMessage: `chore: advance formal version ${stage}`,
  };
}

export interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  paths: string[];
}

export interface ReviewResult {
  verdict: 'pass' | 'fix';
  summary: string;
  findings: ReviewFinding[];
}

export type AgentFailureKind = 'transient' | 'external-blocker' | 'execution';

export interface CompletedCommitRecoveryInput {
  phase: string;
  baseline: string;
  currentHead: string;
  currentParent: string;
  currentMessage: string;
  expectedMessage: string;
  worktreeClean: boolean;
}

export interface EmptyRecoveryRebaseInput {
  status: string;
  taskRunCount: number;
  baseline: string;
  currentHead: string;
  worktreeClean: boolean;
  baselineIsAncestor: boolean;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function validatePolicy(value: unknown): AgentPolicy {
  assert(typeof value === 'object' && value !== null, 'Agent policy 必须是对象');
  const policy = value as Partial<AgentPolicy>;
  assert(policy.version === 1, 'Agent policy 版本必须为 1');
  assert(policy.planner && typeof policy.planner.model === 'string', '缺少 planner 模型');
  assert(policy.tiers, '缺少模型分层');
  assert(policy.reviewers, '缺少审查模型分层');
  assert(policy.recovery, '缺少故障恢复策略');
  assert(
    Number.isInteger(policy.recovery.transientRetries) && policy.recovery.transientRetries >= 0,
    'transientRetries 必须是非负整数',
  );
  assert(policy.recovery.retryBackoffSeconds >= 0, 'retryBackoffSeconds 不能为负数');
  assert(policy.versionCycle, '缺少版本迭代策略');
  assert(
    Number.isInteger(policy.versionCycle.maxFeatureRounds) &&
      policy.versionCycle.maxFeatureRounds > 0,
    'maxFeatureRounds 必须是正整数',
  );
  assert(
    Number.isInteger(policy.versionCycle.featureRecoveryAttempts) &&
      policy.versionCycle.featureRecoveryAttempts >= 0,
    'featureRecoveryAttempts 必须是非负整数',
  );
  for (const tier of MODEL_TIERS) {
    assert(policy.tiers[tier] && typeof policy.tiers[tier].model === 'string', `缺少 ${tier} 模型`);
    assert(
      policy.reviewers[tier] && typeof policy.reviewers[tier].model === 'string',
      `缺少 ${tier} 审查模型`,
    );
    assert(Array.isArray(policy.recovery.reviewerFallbacks[tier]), `缺少 ${tier} 审查备用路由`);
    for (const route of policy.recovery.reviewerFallbacks[tier]) {
      assert(typeof route.model === 'string' && route.model.length > 0, `${tier} 审查备用模型非法`);
      assert(['low', 'medium', 'high'].includes(route.reasoning), `${tier} 审查备用推理等级非法`);
    }
  }
  assert(policy.limits && policy.limits.maxTasks > 0, 'maxTasks 必须大于 0');
  assert(policy.timeouts && policy.timeouts.heartbeatSeconds > 0, 'heartbeatSeconds 必须大于 0');
  assert(Number.isInteger(policy.timeouts.heartbeatSeconds), 'heartbeatSeconds 必须是正整数');
  assert(policy.timeouts.plannerMinutes > 0, 'plannerMinutes 必须大于 0');
  assert(Number.isInteger(policy.timeouts.plannerMinutes), 'plannerMinutes 必须是正整数');
  assert(policy.timeouts.verificationMinutes > 0, 'verificationMinutes 必须大于 0');
  assert(Number.isInteger(policy.timeouts.verificationMinutes), 'verificationMinutes 必须是正整数');
  for (const tier of MODEL_TIERS) {
    assert(policy.timeouts.workers[tier] > 0, `缺少 ${tier} 执行超时`);
    assert(policy.timeouts.reviewers[tier] > 0, `缺少 ${tier} 审查超时`);
    assert(policy.timeouts.repairs[tier] > 0, `缺少 ${tier} 修复超时`);
    assert(Number.isInteger(policy.timeouts.workers[tier]), `${tier} 执行超时必须是正整数`);
    assert(Number.isInteger(policy.timeouts.reviewers[tier]), `${tier} 审查超时必须是正整数`);
    assert(Number.isInteger(policy.timeouts.repairs[tier]), `${tier} 修复超时必须是正整数`);
  }
  assert(policy.verification && isStringArray(policy.verification.delivery), '缺少交付验证命令');
  assert(policy.git && typeof policy.git.remote === 'string', '缺少 Git 策略');
  return policy as AgentPolicy;
}

export function validatePlan(value: unknown, maxTasks: number): TaskPlan {
  assert(typeof value === 'object' && value !== null, '任务计划必须是对象');
  const plan = value as Partial<TaskPlan>;
  assert(plan.version === 1, '任务计划版本必须为 1');
  assert(typeof plan.title === 'string' && plan.title.length > 0, '任务计划缺少标题');
  assert(typeof plan.summary === 'string' && plan.summary.length > 0, '任务计划缺少摘要');
  assert(typeof plan.producerDecisionRequired === 'boolean', '任务计划缺少制作人决策状态');
  assert(typeof plan.producerQuestion === 'string', '任务计划缺少制作人问题字段');
  assert(isStringArray(plan.riskSignals), 'riskSignals 必须是字符串数组');
  assert(
    isStringArray(plan.acceptanceCriteria) && plan.acceptanceCriteria.length > 0,
    '至少需要一条验收标准',
  );
  assert(isStringArray(plan.nonGoals), 'nonGoals 必须是字符串数组');
  assert(Array.isArray(plan.tasks) && plan.tasks.length > 0, '至少需要一个任务');
  assert(plan.tasks.length <= maxTasks, `任务数量超过上限 ${maxTasks}`);
  assert(typeof plan.commitMessage === 'string', '缺少提交信息');

  const ids = new Set<string>();
  for (const task of plan.tasks) {
    assert(task && typeof task === 'object', '任务必须是对象');
    assert(/^[a-z0-9][a-z0-9-]*$/.test(task.id), `任务 id 非法: ${task.id}`);
    assert(!ids.has(task.id), `任务 id 重复: ${task.id}`);
    ids.add(task.id);
    assert(MODEL_TIERS.includes(task.tier), `任务 ${task.id} 的模型层级非法`);
    assert(isStringArray(task.dependsOn), `任务 ${task.id} 的 dependsOn 非法`);
    assert(isStringArray(task.paths), `任务 ${task.id} 的 paths 非法`);
    assert(isStringArray(task.deliverables), `任务 ${task.id} 的 deliverables 非法`);
    assert(isStringArray(task.verification), `任务 ${task.id} 的 verification 非法`);
    assert(
      task.validationProfile === undefined ||
        ['light', 'task', 'feature', 'version'].includes(task.validationProfile),
      `任务 ${task.id} 的 validationProfile 非法`,
    );
  }
  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn) {
      assert(ids.has(dependency), `任务 ${task.id} 依赖不存在的任务 ${dependency}`);
      assert(dependency !== task.id, `任务 ${task.id} 不能依赖自己`);
    }
  }
  sortTasks(plan.tasks);
  return plan as TaskPlan;
}

export function sortTasks(tasks: PlannedTask[]): PlannedTask[] {
  const remaining = new Map(tasks.map((task) => [task.id, task]));
  const completed = new Set<string>();
  const sorted: PlannedTask[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((task) =>
      task.dependsOn.every((dependency) => completed.has(dependency)),
    );
    if (ready.length === 0) throw new Error('任务依赖存在循环');
    for (const task of ready) {
      sorted.push(task);
      completed.add(task.id);
      remaining.delete(task.id);
    }
  }
  return sorted;
}

export function optimizePlan(plan: TaskPlan): TaskPlan {
  if (plan.tasks.length <= 1) return plan;
  const tiers = new Set(plan.tasks.map((task) => task.tier));
  if (tiers.size !== 1) return plan;

  const sorted = sortTasks(plan.tasks);
  const typeOrder: TaskType[] = ['analysis', 'documentation', 'test', 'implementation'];
  const type = sorted.reduce(
    (selected, task) =>
      typeOrder.indexOf(task.type) > typeOrder.indexOf(selected) ? task.type : selected,
    sorted[0].type,
  );
  const unique = (items: string[]) => [...new Set(items)];
  const merged: PlannedTask = {
    id: 'delivery',
    title: plan.title,
    objective: sorted.map((task) => task.objective).join('；'),
    type,
    tier: sorted[0].tier,
    reasoning: `同一风险层级的 ${sorted.length} 个线性任务由一个 Agent 连续完成，减少重复读取上下文。`,
    dependsOn: [],
    paths: unique(sorted.flatMap((task) => task.paths)),
    deliverables: unique(sorted.flatMap((task) => task.deliverables)),
    verification: unique(sorted.flatMap((task) => task.verification)),
    validationProfile: validationProfileForPlan(plan),
  };
  return { ...plan, tasks: [merged] };
}

export function routeForTask(policy: AgentPolicy, tier: ModelTier): ModelRoute {
  return policy.tiers[tier];
}

export function highestTier(tasks: PlannedTask[]): ModelTier {
  return tasks.reduce(
    (highest, task) =>
      MODEL_TIERS.indexOf(task.tier) > MODEL_TIERS.indexOf(highest) ? task.tier : highest,
    'economy' as ModelTier,
  );
}

export function reviewRouteForPlan(policy: AgentPolicy, plan: TaskPlan): ModelRoute {
  return policy.reviewers[highestTier(plan.tasks)];
}

export function reviewRoutesForPlan(policy: AgentPolicy, plan: TaskPlan): ModelRoute[] {
  const tier = highestTier(plan.tasks);
  const routes = [policy.reviewers[tier], ...policy.recovery.reviewerFallbacks[tier]];
  return routes.filter(
    (route, index) =>
      routes.findIndex(
        (candidate) => candidate.model === route.model && candidate.reasoning === route.reasoning,
      ) === index,
  );
}

export function classifyAgentFailure(output: string, code: number): AgentFailureKind {
  const normalized = output.toLowerCase();
  if (
    includesAny(normalized, [
      'usage limit',
      'insufficient_quota',
      'purchase more credits',
      'not logged in',
      'unauthorized',
      'authentication failed',
      'invalid api key',
      '账号或鉴权阻塞',
      '额度已用尽',
      '用量上限',
    ])
  ) {
    return 'external-blocker';
  }
  if (
    code === 124 ||
    includesAny(normalized, [
      'at capacity',
      'request timed out',
      'reconnecting',
      'temporarily unavailable',
      'service unavailable',
      'connection reset',
      'connection refused',
      'network error',
      'rate limit',
      'too many requests',
    ])
  ) {
    return 'transient';
  }
  return 'execution';
}

export function escalateTier(tier: ModelTier): ModelTier | null {
  const index = MODEL_TIERS.indexOf(tier);
  return index < MODEL_TIERS.length - 1 ? MODEL_TIERS[index + 1] : null;
}

export function conventionalCommitOrFallback(message: string, title: string): string {
  if (/^(feat|fix|docs|refactor|test|chore|perf|build|ci)(\([^)]+\))?!?: .+/.test(message)) {
    return message;
  }
  return `feat: 完成${title}`;
}

export function canResumeCompletedCommit(input: CompletedCommitRecoveryInput): boolean {
  const deliveryPhaseCanOwnCommit =
    input.phase === 'Git 交付' ||
    /^(交付门禁|门禁修复|独立审查|审查修复)第 \d+ 轮$/.test(input.phase);
  return (
    deliveryPhaseCanOwnCommit &&
    input.worktreeClean &&
    input.currentHead !== input.baseline &&
    input.currentParent === input.baseline &&
    input.currentMessage === input.expectedMessage
  );
}

export function canRebaseEmptyRecovery(input: EmptyRecoveryRebaseInput): boolean {
  return (
    ['recoverable', 'waiting-producer'].includes(input.status) &&
    input.taskRunCount === 0 &&
    input.worktreeClean &&
    input.currentHead !== input.baseline &&
    input.baselineIsAncestor
  );
}

export function validateReview(value: unknown): ReviewResult {
  assert(typeof value === 'object' && value !== null, '审查结果必须是对象');
  const review = value as Partial<ReviewResult>;
  assert(review.verdict === 'pass' || review.verdict === 'fix', '审查 verdict 非法');
  assert(typeof review.summary === 'string', '审查结果缺少摘要');
  assert(Array.isArray(review.findings), '审查 findings 必须是数组');
  for (const finding of review.findings) {
    assert(
      ['critical', 'high', 'medium', 'low'].includes(finding.severity),
      '审查问题 severity 非法',
    );
    assert(typeof finding.title === 'string', '审查问题缺少标题');
    assert(typeof finding.detail === 'string', '审查问题缺少详情');
    assert(isStringArray(finding.paths), '审查问题 paths 非法');
  }
  return review as ReviewResult;
}

export function preferredWindowsExecutable(candidates: string[]): string | null {
  return (
    candidates.find((path) => path.toLowerCase().endsWith('.exe')) ??
    candidates.find((path) => path.toLowerCase().endsWith('.cmd')) ??
    candidates.find((path) => path.toLowerCase().endsWith('.bat')) ??
    candidates[0] ??
    null
  );
}

export function isSafeRunId(runId: string): boolean {
  return runId !== '.' && runId !== '..' && /^[\p{L}\p{N}._-]+$/u.test(runId);
}

const VERSION_DISPATCHER_MAINTENANCE_PATHS = new Set([
  'AGENTS.md',
  'README.md',
  'agents/README.md',
  'agents/policy.json',
  'docs/agent-workflow.md',
  'docs/dev/2026-09-14-version-dispatcher.md',
  'docs/specs/version-iteration-workflow.md',
  'docs/testing.md',
  'package-lock.json',
  'package.json',
  'scripts/agent-dispatcher.ts',
  'scripts/agent-routing.ts',
  'scripts/check-docs.mjs',
  'scripts/version-dispatcher.ts',
  'test/agent-routing.test.ts',
]);

export function canRefreshVersionRecoveryFingerprint(input: {
  recoverable: boolean;
  cleanWorktree: boolean;
  baselineIsAncestor: boolean;
  hasChildRecovery: boolean;
  hasChildReport: boolean;
  changedPaths: string[];
}): boolean {
  return (
    input.recoverable &&
    input.cleanWorktree &&
    input.baselineIsAncestor &&
    !input.hasChildRecovery &&
    !input.hasChildReport &&
    input.changedPaths.length > 0 &&
    input.changedPaths.every((path) =>
      VERSION_DISPATCHER_MAINTENANCE_PATHS.has(path.replaceAll('\\', '/')),
    )
  );
}

function includesAny(source: string, terms: string[]): boolean {
  return terms.some((term) => source.toLowerCase().includes(term.toLowerCase()));
}

function normalizeContinuation(direction: string): string {
  return direction
    .trim()
    .toLowerCase()
    .replace(/[\s，。！？!?,.、]/g, '');
}

export function isGenericContinuation(direction: string): boolean {
  return new Set([
    '继续',
    '继续推进',
    '继续开发',
    '继续执行',
    '继续后续任务',
    '继续推进后续任务',
    '继续推进后续的开发任务',
    '下一步',
    '推进下一步',
  ]).has(normalizeContinuation(direction));
}

export function nextTaskFromStatus(status: string): string | null {
  return versionTasksFromStatus(status)[0] ?? null;
}

export function versionTasksFromStatus(status: string): string[] {
  const lines = status.split(/\r?\n/);
  const preferredHeadings = ['## 当前首要任务', '## 下一阶段候选'];
  const tasks: string[] = [];
  for (const heading of preferredHeadings) {
    const start = lines.findIndex((line) => line.trim() === heading);
    if (start < 0) continue;
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.startsWith('## ')) break;
      const match = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      const task = match[1].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      if (!tasks.includes(task)) tasks.push(task);
    }
  }
  return tasks;
}

export function resolveProducerDirection(direction: string, status: string): string {
  const normalized = direction.trim();
  if (!isGenericContinuation(normalized)) return normalized;
  return nextTaskFromStatus(status) ?? normalized;
}

export function buildLocalPlan(direction: string): TaskPlan {
  const normalized = direction.trim();
  if (!normalized) throw new Error('制作人方向不能为空');

  const formalStage = FORMAL_STAGE_MARKER.exec(normalized)?.[1];
  if (formalStage) {
    const plan = buildFormalStagePlan(normalized, formalStage);
    if (plan) return plan;
  }

  const implementationTerms = ['新增', '实现', '修复', '支持', '调整', '重构', '改造', '开发'];
  const documentationTerms = ['文档', '说明', '指南', '日志', '链接', '格式'];
  const criticalTerms = ['架构不变量', '不可逆', '大版本', '破坏兼容', '数据迁移', '整体架构'];
  const advancedTerms = [
    'src/core',
    'dsl',
    'ast',
    '编译器',
    'vm',
    '元法术',
    '资源模型',
    '并发',
    '实体模型',
    '法力',
    '神识',
    '施法管线',
  ];
  const experienceTerms = [
    'ui',
    '界面',
    '推演台',
    '演武场',
    '蓝图',
    '编辑器',
    '按钮',
    '滚动',
    '布局',
    '交互',
  ];

  const docsOnly =
    includesAny(normalized, documentationTerms) && !includesAny(normalized, implementationTerms);
  const critical = includesAny(normalized, criticalTerms);
  const advanced = !docsOnly && includesAny(normalized, advancedTerms);
  const experience = !docsOnly && includesAny(normalized, experienceTerms);
  const releaseDecision = includesAny(normalized, ['大版本发布', '发布大版本']);
  const irreversibleDecision = includesAny(normalized, ['不可逆', '破坏兼容', '删除现有存档']);
  const tasks: PlannedTask[] = [];

  if (docsOnly) {
    tasks.push({
      id: 'documentation',
      title: '完成文档方向',
      objective: normalized,
      type: 'documentation',
      tier: 'economy',
      reasoning: '方向只涉及长期文档或说明，不需要读取和修改产品运行时。',
      dependsOn: [],
      paths: ['README.md', 'docs/', '.codebuddy/memory/'],
      deliverables: ['完成方向要求的文档改动', '同步必要入口与开发日志'],
      verification: ['npm run docs:check'],
      validationProfile: 'light',
    });
  } else if (critical) {
    tasks.push({
      id: 'architecture',
      title: '确定架构决策与迁移边界',
      objective: `为“${normalized}”核对架构不变量，形成 ADR、规格和可回退方案。`,
      type: 'analysis',
      tier: 'critical',
      reasoning: '方向包含不可逆、兼容、迁移或架构不变量信号，需要最高级别架构判断。',
      dependsOn: [],
      paths: ['docs/architecture/', 'docs/adr/', 'docs/specs/', 'docs/status.md'],
      deliverables: ['已采纳 ADR 或明确无需 ADR 的规格', '迁移、兼容与回退边界'],
      verification: ['核对架构不变量和现有 ADR'],
      validationProfile: 'light',
    });
    tasks.push({
      id: 'implementation',
      title: '实现架构决策的纵向切片',
      objective: normalized,
      type: 'implementation',
      tier: 'advanced',
      reasoning: '架构决策后的共享契约和核心实现需要高级工程模型。',
      dependsOn: ['architecture'],
      paths: ['src/core/', 'src/game/', 'test/', 'docs/'],
      deliverables: ['可运行的最小完整实现', '风险相称的测试和长期文档'],
      verification: ['运行相关类型检查与单元/集成测试'],
      validationProfile: 'task',
    });
    if (experience) {
      tasks.push({
        id: 'experience',
        title: '接入玩家体验与端到端验证',
        objective: `把“${normalized}”接入实际用户流程。`,
        type: 'implementation',
        tier: 'standard',
        reasoning: 'UI 和 E2E 在核心契约稳定后由常规模型完成，避免高级模型承担表现层工作。',
        dependsOn: ['implementation'],
        paths: ['src/app/', 'e2e/', 'docs/product/', 'docs/reference/'],
        deliverables: ['完整可操作体验', 'E2E 覆盖与玩家文档'],
        verification: ['npm run test:e2e', '实际体验受影响路径'],
        validationProfile: 'task',
      });
    }
  } else if (advanced && experience) {
    tasks.push({
      id: 'core',
      title: '实现核心契约与行为',
      objective: `完成“${normalized}”所需的核心、战斗或共享数据契约。`,
      type: 'implementation',
      tier: 'advanced',
      reasoning: '方向同时涉及核心语义和用户界面，先稳定底层契约。',
      dependsOn: [],
      paths: ['src/core/', 'src/game/', 'test/', 'docs/architecture/'],
      deliverables: ['核心实现与单元/集成测试', '必要的规格或 ADR'],
      verification: ['运行相关类型检查与单元/集成测试'],
      validationProfile: 'task',
    });
    tasks.push({
      id: 'experience',
      title: '完成界面接入与体验闭环',
      objective: normalized,
      type: 'implementation',
      tier: 'standard',
      reasoning: '表现层在核心契约完成后独立接入，使用常规模型控制成本。',
      dependsOn: ['core'],
      paths: ['src/app/', 'e2e/', 'docs/product/', 'docs/reference/'],
      deliverables: ['可操作 UI、E2E 和相关文档'],
      verification: ['npm run test:e2e', '实际体验受影响路径'],
      validationProfile: 'task',
    });
  } else {
    const tier: ModelTier = advanced ? 'advanced' : experience ? 'standard' : 'standard';
    tasks.push({
      id: 'delivery',
      title: advanced ? '完成核心纵向切片' : '完成产品纵向切片',
      objective: normalized,
      type: 'implementation',
      tier,
      reasoning: advanced
        ? '方向涉及核心语义或共享契约，由高级模型一次完成实现、测试和文档。'
        : '常规产品任务由默认模型完成，不额外创建管理 Agent。',
      dependsOn: [],
      paths: advanced
        ? ['src/core/', 'src/game/', 'test/', 'docs/']
        : ['src/app/', 'src/game/', 'test/', 'e2e/', 'docs/'],
      deliverables: ['可体验的完整改动', '风险相称的测试', '同步长期文档与开发日志'],
      verification: ['运行改动直接相关的类型检查和定向测试', '实际体验受影响路径'],
      validationProfile: 'task',
    });
  }

  const changeType = docsOnly
    ? 'docs'
    : includesAny(normalized, ['修复', '问题', '错误'])
      ? 'fix'
      : 'feat';
  const title = normalized.length > 36 ? `${normalized.slice(0, 36)}...` : normalized;
  return {
    version: 1,
    title,
    summary: normalized,
    producerDecisionRequired: releaseDecision || irreversibleDecision,
    producerQuestion: releaseDecision
      ? '该方向包含大版本发布。请确认是否正式发布大版本；实现和验证可以在确认前继续单独提出。'
      : irreversibleDecision
        ? '该方向明确包含不可逆或破坏兼容的选择，请确认接受该后果后再执行。'
        : '',
    riskSignals: [
      ...(critical ? ['检测到架构、迁移或兼容性风险'] : []),
      ...(advanced ? ['检测到核心语义或共享契约'] : []),
      ...(experience ? ['检测到玩家界面与体验路径'] : []),
      ...(docsOnly ? ['检测到纯文档范围'] : []),
    ],
    acceptanceCriteria: [
      `“${normalized}”可以通过测试或实际操作观察到。`,
      '现有相关用户流程和架构不变量没有回归。',
      '风险相称的测试、长期文档和开发日志已经同步。',
      '完整交付门禁和独立审查通过。',
    ],
    nonGoals: ['不处理制作人方向之外的无关重构或产品调整。'],
    tasks,
    commitMessage: `${changeType}: ${title}`,
  };
}
