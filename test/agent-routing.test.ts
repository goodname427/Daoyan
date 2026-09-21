import { readFileSync } from 'node:fs';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canRebaseEmptyRecovery,
  canReuseFullGateEvidence,
  changedPathsSinceWorkspaceBaseline,
  conventionalCommitOrFallback,
  canResumeCompletedCommit,
  canRefreshVersionRecoveryFingerprint,
  buildLocalPlan,
  classifyAgentFailure,
  escalateTier,
  fastGateCommandProgress,
  failedNpmCommandFromOutput,
  isValidationTreePath,
  isSafeRunId,
  optimizePlan,
  npmRunCommandsFromScript,
  pendingValidationStages,
  preferredWindowsExecutable,
  qualityLoopAction,
  resolveProducerDirection,
  reviewRouteForPlan,
  reviewRoutesForPlan,
  routeForTask,
  relativeModuleSpecifiers,
  recoveryCountersAfterResume,
  sortTasks,
  taskInputPaths,
  taskOutputPaths,
  validatePlan,
  validatePolicy,
  validateReview,
  versionTasksFromStatus,
  validationProfileForTask,
  validationProfileForPlan,
  validationStagesForPlan,
  selectReusableTaskIds,
  type AgentPolicy,
  type PlannedTask,
  type TaskPlan,
} from '../scripts/agent-routing';
import {
  fingerprintPaths,
  isValidationTreePath as isPrePushValidationTreePath,
} from '../scripts/pre-push-verify.mjs';

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
    expect(validationProfileForTask(docs.tasks[0])).toBe('light');
    expect(docs.tasks[0].verification).not.toContain('npm run verify');

    const crossLayer = buildLocalPlan('推演台新增 VM 单步执行界面');
    expect(crossLayer.tasks.map((item) => item.tier)).toEqual(['advanced', 'standard']);
    expect(crossLayer.tasks[1].dependsOn).toEqual(['core']);

    const release = buildLocalPlan('发布大版本');
    expect(release.producerDecisionRequired).toBe(true);
  });

  it('keeps execution Agents on task-scoped checks', () => {
    const implementation = buildLocalPlan('修复秘书恢复竞态').tasks[0];
    expect(validationProfileForTask(implementation)).toBe('task');
    expect(implementation.verification.join(' ')).not.toContain('verify:full');
    expect(implementation.verification.join(' ')).not.toMatch(/npm run verify(?:\s|$)/);
  });

  it('drives the real Feature PM validation stages from the effective plan profile', () => {
    const light = buildLocalPlan('整理制作人工作流文档');
    const implementation = buildLocalPlan('修复秘书恢复竞态');
    const qa = buildLocalPlan('[formal-stage:qa]\n\n执行版本集成与候选验证。');
    const reverification = buildLocalPlan(
      '[formal-stage:bugfix]\n\n本轮只做独立缺陷复验，不修改产品代码。',
    );

    expect(validationProfileForPlan(light)).toBe('light');
    expect(validationStagesForPlan(light)).toEqual([]);
    expect(validationStagesForPlan(implementation)).toEqual([
      'fast-gate',
      'independent-review',
      'full-gate',
    ]);
    expect(validationStagesForPlan(qa)).toEqual(['independent-review']);
    expect(validationStagesForPlan(reverification)).toEqual(['independent-review']);

    const dispatcher = readFileSync(resolve('scripts/agent-dispatcher.ts'), 'utf8');
    expect(dispatcher).toContain('pendingValidationStages(configuredValidationStages');
    expect(dispatcher).toContain('validationProgress: activeValidationProgress');
    expect(dispatcher).toContain(
      "import { treeFingerprint as validationTreeFingerprint } from './pre-push-verify.mjs'",
    );
  });

  it('selects the failed npm child command for an in-place targeted recheck', () => {
    const output = `> daoyan@0.2.0 verify\n> npm run typecheck && npm run format:check\n\n> daoyan@0.2.0 typecheck\n> tsc --noEmit\n\n> daoyan@0.2.0 format:check\n> prettier --check .\n`;
    expect(failedNpmCommandFromOutput(output, ['npm', 'run', 'verify'])).toEqual([
      'npm',
      'run',
      'format:check',
    ]);
  });

  it('continues the fast gate from a middle failure through every unexecuted command', () => {
    const commands = npmRunCommandsFromScript(
      'npm run typecheck && npm run lint && npm run format:check && npm run docs:check && npm run test',
    );
    expect(fastGateCommandProgress(commands, ['npm', 'run', 'lint'])).toEqual({
      completedCommands: [['npm', 'run', 'typecheck']],
      pendingCommands: [
        ['npm', 'run', 'lint'],
        ['npm', 'run', 'format:check'],
        ['npm', 'run', 'docs:check'],
        ['npm', 'run', 'test'],
      ],
    });
  });

  it('skips upstream Feature gates when the final-tree full gate evidence is reusable', () => {
    expect(
      pendingValidationStages(['fast-gate', 'independent-review', 'full-gate'], {
        fullGate: true,
        fastGate: false,
        independentReview: false,
      }),
    ).toEqual([]);
  });

  it('only rebuilds the final gate when an exact Git-delivery commit lost its evidence', () => {
    expect(
      pendingValidationStages(['fast-gate', 'independent-review', 'full-gate'], {
        fullGate: false,
        fastGate: false,
        independentReview: false,
        completedDeliveryCommit: true,
      }),
    ).toEqual(['full-gate']);
  });

  it('preserves valid completed tasks and only invalidates affected downstream dependencies', () => {
    const tasks = [task('foundation'), task('consumer', ['foundation']), task('unrelated')];
    const evidence = tasks.map((entry) => ({
      taskId: entry.id,
      passed: true,
      inputFingerprint: `${entry.id}-input`,
      currentInputFingerprint: `${entry.id}-input`,
      outputFingerprint: `${entry.id}-output`,
      currentOutputFingerprint: `${entry.id}-output`,
      commandFingerprint: `${entry.id}-command`,
      currentCommandFingerprint: `${entry.id}-command`,
      configFingerprint: 'config',
      currentConfigFingerprint: 'config',
    }));
    evidence[0].currentOutputFingerprint = 'changed';
    expect(selectReusableTaskIds(tasks, evidence)).toEqual(['unrelated']);
  });

  it('attributes only dirty path content changed after the recovery checkpoint', () => {
    const checkpoint = {
      'docs/completed.md': 'completed-hash',
      'docs/restored.md': 'restored-hash',
      'module-design.md': 'unrelated-takeover-hash',
    };
    expect(
      changedPathsSinceWorkspaceBaseline(checkpoint, {
        ...checkpoint,
        'docs/new-change.md': 'new-change-hash',
      }),
    ).toEqual(['docs/new-change.md']);
    expect(
      changedPathsSinceWorkspaceBaseline(checkpoint, {
        'docs/completed.md': 'completed-hash',
        'module-design.md': 'unrelated-takeover-hash',
      }),
    ).toEqual(['docs/restored.md']);
  });

  it('binds selective recovery to read-only direct dependencies outside suggested paths', () => {
    expect(taskOutputPaths(['scripts/suggested-input.ts'], ['scripts/modified-output.ts'])).toEqual(
      ['scripts/modified-output.ts'],
    );
    expect(
      taskInputPaths(['scripts/suggested-input.ts'], ['scripts/read-only-dependency.ts']),
    ).toEqual(['scripts/read-only-dependency.ts', 'scripts/suggested-input.ts']);
    expect(
      relativeModuleSpecifiers(
        "import { helper } from './read-only-dependency';\nexport * from '../shared/value';\n",
      ),
    ).toEqual(['../shared/value', './read-only-dependency']);

    const dispatcher = readFileSync(resolve('scripts/agent-dispatcher.ts'), 'utf8');
    expect(dispatcher).toContain('collectTaskInputPaths(task.paths, changedFiles)');
    expect(dispatcher).toContain('inputPaths,');
    expect(dispatcher).toContain('taskOutputPaths(run.task.paths, run.changedFiles)');
    expect(dispatcher).toContain(
      'currentInputFingerprint: await taskPathFingerprint(run.inputPaths ?? run.task.paths)',
    );

    const tasks = [task('implementation'), task('downstream', ['implementation'])];
    const evidence = tasks.map((entry) => ({
      taskId: entry.id,
      passed: true,
      inputFingerprint: `${entry.id}-input`,
      currentInputFingerprint: `${entry.id}-input`,
      outputFingerprint: `${entry.id}-output`,
      currentOutputFingerprint: `${entry.id}-output`,
      commandFingerprint: `${entry.id}-command`,
      currentCommandFingerprint: `${entry.id}-command`,
      configFingerprint: 'config',
      currentConfigFingerprint: 'config',
    }));
    evidence[0].currentInputFingerprint = 'read-only-direct-dependency-changed';
    expect(selectReusableTaskIds(tasks, evidence)).toEqual([]);
  });

  it('excludes only formal-version stage artifacts from the validation tree', () => {
    for (const [path, expected] of [
      ['docs/versions/release/charter.md', true],
      ['docs/versions/release/version-planning.md', true],
      ['docs/versions/release/module-design.md', true],
      ['docs/versions/release/task-breakdown.json', true],
      ['docs/versions/release/development.json', true],
      ['docs/versions/release/development.md', true],
      ['docs/versions/release/qa.json', false],
      ['docs/versions/release/bugfix-reverification.md', false],
      ['docs/status.md', true],
      ['scripts/version-lifecycle.ts', true],
      ['test/version-lifecycle.test.ts', true],
    ] as const) {
      expect(isValidationTreePath(path)).toBe(expected);
      expect(isPrePushValidationTreePath(path)).toBe(expected);
    }
  });

  it('invalidates full-gate evidence when development task commands are changed', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'daoyan-development-evidence-'));
    const manifest = resolve(directory, 'development.json');
    try {
      await writeFile(
        manifest,
        '{"workItems":[{"id":"task","commands":[{"command":"npm run typecheck","exitCode":0}]}]}\n',
      );
      const testedTree = fingerprintPaths(['development.json'], directory);
      const evidence = {
        schemaVersion: 1,
        exitCode: 0,
        workspaceFingerprint: testedTree,
        configFingerprint: 'config',
        command: 'npm run verify:full',
      };
      expect(canReuseFullGateEvidence(evidence, testedTree, 'config', 'npm run verify:full')).toBe(
        true,
      );

      await writeFile(
        manifest,
        '{"workItems":[{"id":"task","commands":[{"command":"npm run typecheck","exitCode":1}]}]}\n',
      );
      const tamperedTree = fingerprintPaths(['development.json'], directory);
      expect(tamperedTree).not.toBe(testedTree);
      expect(
        canReuseFullGateEvidence(evidence, tamperedTree, 'config', 'npm run verify:full'),
      ).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('counts a resumed active checkpoint as an abnormal crash recovery', () => {
    expect(recoveryCountersAfterResume('active', 2, 0)).toEqual({
      actualLaunchCount: 3,
      abnormalRecoveryCount: 1,
    });
    expect(recoveryCountersAfterResume('recoverable', 3, 1)).toEqual({
      actualLaunchCount: 4,
      abnormalRecoveryCount: 2,
    });
    expect(recoveryCountersAfterResume('waiting-producer', 4, 2)).toEqual({
      actualLaunchCount: 5,
      abnormalRecoveryCount: 2,
    });
    expect(recoveryCountersAfterResume('active', null, null)).toEqual({
      actualLaunchCount: null,
      abnormalRecoveryCount: null,
    });
  });

  it('reuses a successful full gate only for the exact tree, configuration and command', () => {
    const evidence = {
      schemaVersion: 1,
      exitCode: 0,
      workspaceFingerprint: 'tree-a',
      configFingerprint: 'config-a',
      command: 'npm run verify:full',
    };
    expect(canReuseFullGateEvidence(evidence, 'tree-a', 'config-a', 'npm run verify:full')).toBe(
      true,
    );
    expect(canReuseFullGateEvidence(evidence, 'tree-b', 'config-a', 'npm run verify:full')).toBe(
      false,
    );
    expect(canReuseFullGateEvidence(evidence, 'tree-a', 'config-b', 'npm run verify:full')).toBe(
      false,
    );
  });

  it('fingerprints a deleted tracked file with the shared deleted sentinel', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'daoyan-pre-push-delete-'));
    try {
      await writeFile(resolve(directory, 'deleted.txt'), 'tracked\n', 'utf8');
      const before = fingerprintPaths(['deleted.txt'], directory);
      await unlink(resolve(directory, 'deleted.txt'));
      expect(() => fingerprintPaths(['deleted.txt'], directory)).not.toThrow();
      expect(fingerprintPaths(['deleted.txt'], directory)).not.toBe(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps Version PM on evidence reuse instead of rerunning the Feature full gate', () => {
    const source = readFileSync(resolve('scripts/version-dispatcher.ts'), 'utf8');
    expect(source).toContain("[resolve(root, 'scripts/pre-push-verify.mjs'), '--check-only']");
    expect(source).not.toContain("[npmExecPath, 'run', 'verify:full']");
  });

  it('keeps format failures and newly discovered review findings in the same PM loop', () => {
    expect(
      qualityLoopAction({ commandPassed: false, hasOpenFindings: false, madeProgress: true }),
    ).toBe('repair-in-place');
    expect(
      qualityLoopAction({ commandPassed: true, hasOpenFindings: true, madeProgress: true }),
    ).toBe('repair-in-place');
    expect(
      qualityLoopAction({ commandPassed: true, hasOpenFindings: true, madeProgress: false }),
    ).toBe('recover');
    expect(
      qualityLoopAction({
        commandPassed: false,
        hasOpenFindings: false,
        madeProgress: false,
        failureKind: 'external-blocker',
      }),
    ).toBe('wait-external');
  });

  it('routes formal version stages directly without reopening producer planning', () => {
    const qa = buildLocalPlan(
      '[formal-stage:qa]\n\n推进正式版本测试。若遇到高风险架构取舍则报告。',
    );

    expect(qa.producerDecisionRequired).toBe(false);
    expect(qa.tasks).toHaveLength(1);
    expect(qa.tasks[0]).toEqual(
      expect.objectContaining({ id: 'formal-qa', type: 'test', title: '执行独立版本测试' }),
    );
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

  it('rebases an untouched producer-decision checkpoint only when the workspace stayed clean', () => {
    expect(
      canRebaseEmptyRecovery({
        status: 'waiting-producer',
        taskRunCount: 0,
        baseline: 'old',
        currentHead: 'new',
        worktreeClean: true,
        baselineIsAncestor: true,
      }),
    ).toBe(true);
  });
});
