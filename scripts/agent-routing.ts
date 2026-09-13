export const MODEL_TIERS = ['economy', 'standard', 'advanced', 'critical'] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];
export type TaskType = 'analysis' | 'implementation' | 'test' | 'documentation';

export interface ModelRoute {
  model: string;
  reasoning: 'low' | 'medium' | 'high';
}

export interface AgentPolicy {
  version: number;
  planner: ModelRoute;
  tiers: Record<ModelTier, ModelRoute>;
  reviewers: Record<ModelTier, ModelRoute>;
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
  for (const tier of MODEL_TIERS) {
    assert(policy.tiers[tier] && typeof policy.tiers[tier].model === 'string', `缺少 ${tier} 模型`);
    assert(
      policy.reviewers[tier] && typeof policy.reviewers[tier].model === 'string',
      `缺少 ${tier} 审查模型`,
    );
  }
  assert(policy.limits && policy.limits.maxTasks > 0, 'maxTasks 必须大于 0');
  assert(policy.timeouts && policy.timeouts.heartbeatSeconds > 0, 'heartbeatSeconds 必须大于 0');
  assert(policy.timeouts.plannerMinutes > 0, 'plannerMinutes 必须大于 0');
  assert(policy.timeouts.verificationMinutes > 0, 'verificationMinutes 必须大于 0');
  for (const tier of MODEL_TIERS) {
    assert(policy.timeouts.workers[tier] > 0, `缺少 ${tier} 执行超时`);
    assert(policy.timeouts.reviewers[tier] > 0, `缺少 ${tier} 审查超时`);
    assert(policy.timeouts.repairs[tier] > 0, `缺少 ${tier} 修复超时`);
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
  const lines = status.split(/\r?\n/);
  const preferredHeadings = ['## 当前首要任务', '## 下一阶段候选'];
  for (const heading of preferredHeadings) {
    const start = lines.findIndex((line) => line.trim() === heading);
    if (start < 0) continue;
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.startsWith('## ')) break;
      const match = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      return match[1].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    }
  }
  return null;
}

export function resolveProducerDirection(direction: string, status: string): string {
  const normalized = direction.trim();
  if (!isGenericContinuation(normalized)) return normalized;
  return nextTaskFromStatus(status) ?? normalized;
}

export function buildLocalPlan(direction: string): TaskPlan {
  const normalized = direction.trim();
  if (!normalized) throw new Error('制作人方向不能为空');

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
      verification: ['npm run docs:check', 'npm run verify'],
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
      verification: ['运行相关单元与集成测试', 'npm run verify'],
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
      verification: ['运行相关单元与集成测试', 'npm run verify'],
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
      verification: ['npm run verify', 'npm run verify:full', '实际体验受影响路径'],
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
