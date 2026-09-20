import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canRebaseEmptyRecovery,
  conventionalCommitOrFallback,
  canResumeCompletedCommit,
  canRefreshVersionRecoveryFingerprint,
  buildLocalPlan,
  classifyAgentFailure,
  escalateTier,
  isSafeRunId,
  optimizePlan,
  preferredWindowsExecutable,
  resolveProducerDirection,
  reviewRouteForPlan,
  reviewRoutesForPlan,
  routeForTask,
  sortTasks,
  validatePlan,
  validatePolicy,
  validateReview,
  versionTasksFromStatus,
  type AgentPolicy,
  type PlannedTask,
  type TaskPlan,
} from '../scripts/agent-routing';

const policy: AgentPolicy = {
  version: 1,
  planner: { model: 'planner', reasoning: 'medium' },
  tiers: {
    economy: { model: 'luna', reasoning: 'low' },
    standard: { model: 'terra', reasoning: 'medium' },
    advanced: { model: 'sol', reasoning: 'high' },
    critical: { model: 'astra', reasoning: 'high' },
  },
  reviewers: {
    economy: { model: 'luna-review', reasoning: 'low' },
    standard: { model: 'terra-review', reasoning: 'low' },
    advanced: { model: 'sol-review', reasoning: 'high' },
    critical: { model: 'astra-review', reasoning: 'high' },
  },
  recovery: {
    transientRetries: 1,
    retryBackoffSeconds: 0,
    reviewerFallbacks: {
      economy: [{ model: 'terra-review', reasoning: 'low' }],
      standard: [{ model: 'luna-review', reasoning: 'medium' }],
      advanced: [
        { model: 'terra-review', reasoning: 'medium' },
        { model: 'astra-review', reasoning: 'medium' },
      ],
      critical: [{ model: 'sol-review', reasoning: 'high' }],
    },
  },
  versionCycle: {
    maxFeatureRounds: 2,
    featureRecoveryAttempts: 2,
  },
  limits: { maxTasks: 6, maxEscalationsPerTask: 2, maxReviewRounds: 2 },
  timeouts: {
    heartbeatSeconds: 20,
    plannerMinutes: 3,
    workers: { economy: 4, standard: 6, advanced: 12, critical: 18 },
    reviewers: { economy: 3, standard: 4, advanced: 8, critical: 12 },
    repairs: { economy: 4, standard: 6, advanced: 10, critical: 15 },
    verificationMinutes: 10,
  },
  verification: { delivery: ['npm', 'run', 'verify:full'] },
  git: {
    autoCommit: true,
    autoPush: true,
    remote: 'origin',
    proxyFallback: 'http://127.0.0.1:7897',
  },
};

function task(id: string, dependsOn: string[] = []): PlannedTask {
  return {
    id,
    title: id,
    objective: id,
    type: 'implementation',
    tier: 'standard',
    reasoning: '常规实现',
    dependsOn,
    paths: [],
    deliverables: [],
    verification: [],
  };
}

function plan(tasks: PlannedTask[]): TaskPlan {
  return {
    version: 1,
    title: '测试计划',
    summary: '验证调度行为',
    producerDecisionRequired: false,
    producerQuestion: '',
    riskSignals: [],
    acceptanceCriteria: ['计划可以执行'],
    nonGoals: [],
    tasks,
    commitMessage: 'test: 验证调度行为',
  };
}

describe('agent routing', () => {
  it('maps tiers and escalates without exceeding Astra', () => {
    expect(routeForTask(policy, 'economy').model).toBe('luna');
    expect(escalateTier('economy')).toBe('standard');
    expect(escalateTier('advanced')).toBe('critical');
    expect(escalateTier('critical')).toBeNull();
  });

  it('sorts dependent tasks before their consumers', () => {
    expect(sortTasks([task('docs', ['core']), task('core')]).map((item) => item.id)).toEqual([
      'core',
      'docs',
    ]);
  });

  it('rejects cycles and missing dependencies', () => {
    expect(() => sortTasks([task('a', ['b']), task('b', ['a'])])).toThrow('循环');
    expect(() => validatePlan(plan([task('a', ['missing'])]), 6)).toThrow('不存在');
  });

  it('validates policy and task limits', () => {
    expect(validatePolicy(policy)).toEqual(policy);
    expect(
      validatePolicy(JSON.parse(readFileSync(resolve('agents/policy.json'), 'utf8'))).version,
    ).toBe(1);
    expect(validatePlan(plan([task('a')]), 1).tasks).toHaveLength(1);
    expect(() => validatePlan(plan([task('a'), task('b')]), 1)).toThrow('超过上限');
  });

  it('keeps the 20-second heartbeat while granting long-running delivery tiers enough time', () => {
    const configured = validatePolicy(
      JSON.parse(readFileSync(resolve('agents/policy.json'), 'utf8')),
    );
    expect(configured.timeouts.heartbeatSeconds).toBe(20);
    expect(configured.timeouts.workers).toEqual({
      economy: 12,
      standard: 25,
      advanced: 40,
      critical: 60,
    });
    expect(configured.timeouts.repairs).toEqual(configured.timeouts.workers);
    expect(configured.timeouts.plannerMinutes).toBe(8);
    expect(configured.timeouts.reviewers).toEqual({
      economy: 8,
      standard: 12,
      advanced: 20,
      critical: 30,
    });
    expect(configured.timeouts.verificationMinutes).toBe(20);
    expect(() =>
      validatePolicy({
        ...configured,
        timeouts: {
          ...configured.timeouts,
          workers: { ...configured.timeouts.workers, standard: 0 },
        },
      }),
    ).toThrow('standard 执行超时');
  });

  it('keeps conventional commits and replaces invalid messages', () => {
    expect(conventionalCommitOrFallback('fix(core): 修复资源释放', '资源释放')).toBe(
      'fix(core): 修复资源释放',
    );
    expect(conventionalCommitOrFallback('修复资源释放', '资源释放')).toBe('feat: 完成资源释放');
  });

  it('resumes an exact clean delivery commit from post-task delivery phases', () => {
    const input = {
      phase: 'Git 交付',
      baseline: 'base',
      currentHead: 'head',
      currentParent: 'base',
      currentMessage: 'feat: 完成版本迭代',
      expectedMessage: 'feat: 完成版本迭代',
      worktreeClean: true,
    };
    expect(canResumeCompletedCommit(input)).toBe(true);
    expect(canResumeCompletedCommit({ ...input, phase: '独立审查第 2 轮' })).toBe(true);
    expect(canResumeCompletedCommit({ ...input, phase: '交付门禁第 1 轮' })).toBe(true);
    expect(canResumeCompletedCommit({ ...input, phase: '执行任务' })).toBe(false);
    expect(canResumeCompletedCommit({ ...input, currentParent: 'other' })).toBe(false);
    expect(canResumeCompletedCommit({ ...input, currentMessage: 'feat: 外部提交' })).toBe(false);
    expect(canResumeCompletedCommit({ ...input, worktreeClean: false })).toBe(false);
  });

  it('rebases an empty recoverable run when the clean repository only moved forward', () => {
    const input = {
      status: 'recoverable',
      taskRunCount: 0,
      baseline: 'old',
      currentHead: 'new',
      worktreeClean: true,
      baselineIsAncestor: true,
    };
    expect(canRebaseEmptyRecovery(input)).toBe(true);
    expect(canRebaseEmptyRecovery({ ...input, taskRunCount: 1 })).toBe(false);
    expect(canRebaseEmptyRecovery({ ...input, worktreeClean: false })).toBe(false);
    expect(canRebaseEmptyRecovery({ ...input, baselineIsAncestor: false })).toBe(false);
  });

  it('coalesces same-tier work to avoid repeated context reads', () => {
    const optimized = optimizePlan(plan([task('read'), task('write', ['read'])]));
    expect(optimized.tasks).toHaveLength(1);
    expect(optimized.tasks[0].id).toBe('delivery');
    expect(optimized.tasks[0].objective).toContain('read；write');

    const mixed = plan([task('ui'), { ...task('core'), tier: 'advanced' }]);
    expect(optimizePlan(mixed).tasks).toHaveLength(2);
  });

  it('validates structured review results', () => {
    expect(validateReview({ verdict: 'pass', summary: '通过', findings: [] }).verdict).toBe('pass');
    expect(() => validateReview({ verdict: 'maybe', summary: '', findings: [] })).toThrow(
      'verdict',
    );
  });

  it('builds zero-token plans from product direction and splits core from UI', () => {
    const docs = buildLocalPlan('整理制作人工作流文档');
    expect(docs.tasks).toHaveLength(1);
    expect(docs.tasks[0].tier).toBe('economy');

    const crossLayer = buildLocalPlan('推演台新增 VM 单步执行界面');
    expect(crossLayer.tasks.map((item) => item.tier)).toEqual(['advanced', 'standard']);
    expect(crossLayer.tasks[1].dependsOn).toEqual(['core']);

    const release = buildLocalPlan('发布大版本');
    expect(release.producerDecisionRequired).toBe(true);
  });

  it('scales review cost with the highest task risk', () => {
    expect(reviewRouteForPlan(policy, buildLocalPlan('整理工作流文档')).model).toBe('luna-review');
    expect(reviewRouteForPlan(policy, buildLocalPlan('推演台新增 VM 单步界面')).model).toBe(
      'sol-review',
    );
  });

  it('builds a distinct reviewer fallback chain for the plan risk', () => {
    expect(
      reviewRoutesForPlan(policy, buildLocalPlan('推演台新增 VM 单步界面')).map(
        (route) => route.model,
      ),
    ).toEqual(['sol-review', 'terra-review', 'astra-review']);
  });

  it('distinguishes retriable provider failures from external blockers', () => {
    expect(classifyAgentFailure('Selected model is at capacity', 1)).toBe('transient');
    expect(classifyAgentFailure('dispatcher timeout', 124)).toBe('transient');
    expect(classifyAgentFailure('usage limit reached; purchase more credits', 1)).toBe(
      'external-blocker',
    );
    expect(classifyAgentFailure('执行 delivery 遇到账号或鉴权阻塞', 1)).toBe('external-blocker');
    expect(classifyAgentFailure('tests failed', 1)).toBe('execution');
  });

  it('prefers Windows executables and then cmd shims over extensionless shell shims', () => {
    expect(
      preferredWindowsExecutable([
        'C:\\Users\\dev\\npm\\codex',
        'C:\\Users\\dev\\npm\\codex.cmd',
        'C:\\Codex\\codex.exe',
      ]),
    ).toBe('C:\\Codex\\codex.exe');
    expect(
      preferredWindowsExecutable(['C:\\Users\\dev\\npm\\codex', 'C:\\Users\\dev\\npm\\codex.cmd']),
    ).toBe('C:\\Users\\dev\\npm\\codex.cmd');
  });

  it('resolves a generic continuation to the first documented next task', () => {
    const status = `
## 当前迭代

- 已完成当前功能。

## 下一阶段候选

1. 完成 [元法术方案](./proposal.md) 的关键决策。
2. 完善蓝图编辑。
`;
    expect(resolveProducerDirection('继续推进后续的开发任务', status)).toBe(
      '完成 元法术方案 的关键决策。',
    );
    expect(resolveProducerDirection('继续修复蓝图连线', status)).toBe('继续修复蓝图连线');
  });

  it('freezes an ordered, deduplicated version queue from status', () => {
    const status = `
## 当前首要任务

- 完成 [蓝图编辑](./blueprint.md)。

## 下一阶段候选

1. 完成 [蓝图编辑](./blueprint.md)。
2. 持久化法术书。

## 已知债务

- 不应该进入版本队列。
`;
    expect(versionTasksFromStatus(status)).toEqual(['完成 蓝图编辑。', '持久化法术书。']);
  });

  it('accepts localized run ids without allowing paths to escape the runs directory', () => {
    expect(isSafeRunId('2026-09-14T01-30-20-725Z-推进到下一个稳定可玩版本-feature-01')).toBe(true);
    expect(isSafeRunId('release_0.2.1')).toBe(true);
    expect(isSafeRunId('..')).toBe(false);
    expect(isSafeRunId('../outside')).toBe(false);
    expect(isSafeRunId('child/run')).toBe(false);
    expect(isSafeRunId('child\\run')).toBe(false);
  });

  it('refreshes an untouched failed version only across dispatcher maintenance commits', () => {
    const safeRecovery = {
      recoverable: true,
      cleanWorktree: true,
      baselineIsAncestor: true,
      hasChildRecovery: false,
      hasChildReport: false,
      changedPaths: [
        'scripts/agent-dispatcher.ts',
        'scripts/agent-routing.ts',
        'scripts/version-dispatcher.ts',
        'test/agent-routing.test.ts',
      ],
    };
    expect(canRefreshVersionRecoveryFingerprint(safeRecovery)).toBe(true);
    expect(
      canRefreshVersionRecoveryFingerprint({
        ...safeRecovery,
        changedPaths: [...safeRecovery.changedPaths, 'src/core/vm.ts'],
      }),
    ).toBe(false);
    expect(canRefreshVersionRecoveryFingerprint({ ...safeRecovery, hasChildRecovery: true })).toBe(
      false,
    );
    expect(canRefreshVersionRecoveryFingerprint({ ...safeRecovery, cleanWorktree: false })).toBe(
      false,
    );
    expect(
      canRefreshVersionRecoveryFingerprint({ ...safeRecovery, baselineIsAncestor: false }),
    ).toBe(false);
  });
});
