import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  continueDispatchResponse,
  currentValidationConfigFingerprint,
  advanceRecordedDirection,
  applyAutomaticStagePolicy,
  featureTaskCompletions,
  retryTimeFromOutput,
  resolveInboxIntent,
  runArgs,
  snapshotPredatesLaunch,
  isBootstrapGraceActive,
  localQuestionResponse,
  ensureVersionStageItem,
  formalVersionBlocksDispatch,
  isFormalVersionWriteConflict,
  parseBugfixResult,
  parseDesignReviewResult,
  parseDevelopmentResult,
  isTaskScopeCommand,
  latestReusableFeatureGate,
  parseQaResult,
  parseReverificationResult,
  parseVersionWorkItems,
  persistScheduleCorrections,
  publicCodeRevision,
  progressNoticeDecision,
  observedExitEndsPm,
  nonDocumentationChanges,
  replaceVersionWorkItems,
  versionStageDirection,
  versionMessageIsNewDirection,
  versionProducerDecision,
  validationTreeFingerprintForPaths,
  waitForTerminalSnapshot,
  windowsCodexInvocation,
} from '../scripts/secretary-notice-guard';
import {
  createSecretaryState,
  itemFromIntake,
  normalizeSecretaryState,
  pendingScheduleCorrections,
} from '../scripts/secretary-state';
import {
  createFormalVersion,
  currentVersionStagePolicy,
  recordValidationEvidence,
  recordStagePolicy,
  transitionVersionBug,
} from '../scripts/version-lifecycle';

describe('secretary worker process launch', () => {
  it('reports phase transitions immediately and long phases at a bounded interval', () => {
    const started = '2026-09-21T00:00:00.000Z';
    expect(progressNoticeDecision('', '', '独立审查第 1 轮', started)).toEqual({
      notify: true,
      phase: '独立审查',
      heartbeat: false,
    });
    expect(
      progressNoticeDecision('独立审查', started, '独立审查第 2 轮', '2026-09-21T00:29:59.000Z'),
    ).toEqual({ notify: false, phase: '独立审查', heartbeat: true });
    expect(
      progressNoticeDecision('独立审查', started, '独立审查第 3 轮', '2026-09-21T00:30:00.000Z'),
    ).toEqual({ notify: true, phase: '独立审查', heartbeat: true });
  });

  it('uses a deterministic source revision when an isolated guard has no Git metadata', async () => {
    const fixture = await mkdtemp(resolve(tmpdir(), 'daoyan-public-revision-'));
    try {
      await mkdir(resolve(fixture, 'scripts'));
      await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
      await writeFile(resolve(fixture, 'scripts/guard.ts'), 'export const revision = 1;\n');

      const first = publicCodeRevision(fixture);
      expect(first).toMatch(/^source-[a-f0-9]{64}$/);
      expect(publicCodeRevision(fixture)).toBe(first);

      await writeFile(resolve(fixture, 'scripts/guard.ts'), 'export const revision = 2;\n');
      expect(publicCodeRevision(fixture)).not.toBe(first);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('reports an intact error when neither Git nor source files can identify the revision', async () => {
    const fixture = await mkdtemp(resolve(tmpdir(), 'daoyan-missing-public-revision-'));
    try {
      expect(() => publicCodeRevision(fixture)).toThrowError(
        '无法读取当前代码修订，不能登记公开事件',
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('uses a bounded bootstrapping grace before classifying a missing first snapshot', () => {
    const started = Date.parse('2026-09-21T00:00:00.000Z');
    expect(isBootstrapGraceActive(new Date(started).toISOString(), started + 5_000)).toBe(true);
    expect(isBootstrapGraceActive(new Date(started).toISOString(), started + 15_001)).toBe(false);
  });

  it('rereads a delayed terminal snapshot after the launched PM wrapper exits', async () => {
    let reads = 0;
    const snapshot = await waitForTerminalSnapshot(
      async () => {
        reads += 1;
        return reads < 3 ? undefined : { status: 'delivered', revision: 'final' };
      },
      4,
      0,
    );

    expect(reads).toBe(3);
    expect(snapshot).toEqual({ status: 'delivered', revision: 'final' });
  });

  it('does not treat a worker exit as the end of a still-running PM', () => {
    const wrapper = { pid: 41, identity: 'tsx-wrapper' };
    const pm = { pid: 42, identity: 'pm-start' };
    expect(observedExitEndsPm('worker', wrapper, pm, () => true)).toBe(false);
    expect(observedExitEndsPm('worker', wrapper, pm, () => false)).toBe(true);
    expect(observedExitEndsPm('pm', wrapper, pm, () => true)).toBe(false);
    expect(observedExitEndsPm('pm', pm, pm, () => false)).toBe(true);

    const source = readFileSync(resolve('scripts/secretary-notice-guard.ts'), 'utf8');
    expect(source).toContain("reconcileAfterProcessExit(item, 'worker', worker)");
    expect(source).toContain("reconcileAfterProcessExit(item, 'pm', launchedProcess)");
    expect(source).toContain('item.processPid = run.processPid');
  });

  it('persists a sent schedule correction even when reconciliation has no other changes', async () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    const stale = itemFromIntake(
      {
        id: '42c7e743-2bdc-4152-aaf4-c8cd979df279',
        idea: '开发手机 Sites 项目中枢 MVP',
        createdAt: state.initializedAt,
      },
      [],
    ).item;
    stale.status = 'backlog';
    state.items.push(stale);
    normalizeSecretaryState(state);
    let persisted = '';

    expect(
      await persistScheduleCorrections(
        state,
        async () => undefined,
        async () => {
          persisted = JSON.stringify(state);
        },
        () => '2026-09-21T01:00:00.000Z',
      ),
    ).toBe(1);

    const restarted = JSON.parse(persisted) as typeof state;
    expect(restarted.orchestration?.itemResolutions?.[0].correctionSentAt).toBe(
      '2026-09-21T01:00:00.000Z',
    );
    expect(pendingScheduleCorrections(restarted)).toEqual([]);
  });

  it('persists each correction before a later notification fails and resumes from the remainder', async () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    for (const [id, idea] of [
      ['42c7e743-2bdc-4152-aaf4-c8cd979df279', '开发手机 Sites 项目中枢 MVP'],
      ['85d190db-9843-4f83-a35f-ea0608fa9d7c', '增强桌面项目中枢工作台'],
    ]) {
      const item = itemFromIntake({ id, idea, createdAt: state.initializedAt }, []).item;
      item.status = 'backlog';
      state.items.push(item);
    }
    normalizeSecretaryState(state);
    let persisted = '';
    let publishCount = 0;

    await expect(
      persistScheduleCorrections(
        state,
        async () => {
          publishCount += 1;
          if (publishCount === 2) throw new Error('second publish failed');
        },
        async () => {
          persisted = JSON.stringify(state);
        },
        () => '2026-09-21T01:00:00.000Z',
      ),
    ).rejects.toThrow('second publish failed');

    const restarted = JSON.parse(persisted) as typeof state;
    expect(pendingScheduleCorrections(restarted).map((entry) => entry.itemId)).toEqual([
      '85d190db-9843-4f83-a35f-ea0608fa9d7c',
    ]);
    const resumed: string[] = [];
    await persistScheduleCorrections(
      restarted,
      async (correction) => {
        resumed.push(correction.itemId);
      },
      async () => undefined,
      () => '2026-09-21T02:00:00.000Z',
    );
    expect(resumed).toEqual(['85d190db-9843-4f83-a35f-ea0608fa9d7c']);
    expect(pendingScheduleCorrections(restarted)).toEqual([]);
  });

  it('answers schedule questions from reconciled facts without stale backlog items', () => {
    expect(localQuestionResponse('现在排期是什么？', [])).toContain('没有未承接的后续排期');
    expect(
      localQuestionResponse('现在排期是什么？', [
        { kind: 'scheduled', text: '境界成长', reference: 'secretary:realm' },
      ]),
    ).toContain('后续排期：境界成长');
  });
  it('runs a Windows codex cmd shim through its Node entrypoint', () => {
    const shim = 'C:\\Users\\dev\\npm\\codex.cmd';
    const expectedEntry = 'C:\\Users\\dev\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';

    expect(
      windowsCodexInvocation(
        [shim],
        ['exec', '-'],
        'C:\\node.exe',
        (path) => path === expectedEntry,
      ),
    ).toEqual({
      command: 'C:\\node.exe',
      args: [expectedEntry, 'exec', '-'],
    });
  });
});

describe('secretary retry scheduling', () => {
  it('uses a short retry when a clock-only provider hint is already stale', () => {
    const now = new Date('2026-09-20T09:00:00+08:00').getTime();
    expect(retryTimeFromOutput(['try again at 4:31 AM'], now, 5)).toBe(
      new Date(now + 5 * 60_000).toISOString(),
    );
  });
});

describe('secretary dispatch feedback', () => {
  const item = itemFromIntake(
    { id: 'feature', idea: '继续迁移旧元法术', createdAt: '2026-09-20T00:00:00.000Z' },
    [],
  ).item;

  it('only claims an Agent is running when worker evidence exists', () => {
    expect(continueDispatchResponse(item, 'worker-running')).toContain('执行 Agent 已确认运行');
    expect(continueDispatchResponse(item, 'pm-running')).toContain('Feature PM 已确认运行');
  });

  it('reports a failed launch as recovery instead of a successful start', () => {
    expect(continueDispatchResponse(item, 'recovering')).toContain('未稳定启动');
    expect(continueDispatchResponse(item, 'recovering')).not.toContain('已确认运行');
  });
});

describe('secretary waiting-message intent', () => {
  it('does not let semantic triage downgrade an explicit version direction', () => {
    expect(
      resolveInboxIntent(
        'direction',
        'continue',
        '推进一个新的正式版本，目标是统一实体创建、控制与属性模型',
      ),
    ).toBe('direction');
  });

  it('keeps an ordinary producer decision attached to its waiting snapshot', () => {
    expect(resolveInboxIntent('reply', 'direction', '采用方案 A，兼容已有存档')).toBe('reply');
  });

  it('keeps an explicit commitment change as a new direction', () => {
    expect(resolveInboxIntent('reply', 'direction', '取消旧方案，替换为新兼容方案')).toBe(
      'direction',
    );
  });
});

describe('secretary launch snapshot ordering', () => {
  it('refuses to restart an existing Feature without its recovery file', () => {
    const item = itemFromIntake({ id: 'old', idea: '新增功能', createdAt: '' }, []).item;
    item.runDirectory = 'old-run';
    expect(() => runArgs(item, false)).toThrow('禁止作为新运行启动');
    expect(item.runDirectory).toBe('old-run');
  });

  it('ignores a persisted failure from before the current PM launch', () => {
    expect(snapshotPredatesLaunch('2026-09-20T14:11:21.000Z', '2026-09-20T14:23:52.000Z')).toBe(
      true,
    );
    expect(snapshotPredatesLaunch('2026-09-20T14:23:58.000Z', '2026-09-20T14:23:52.000Z')).toBe(
      false,
    );
  });
});

describe('secretary task milestone extraction', () => {
  it('turns passed Feature PM task runs into visualization-ready milestones', () => {
    const completions = featureTaskCompletions(
      'E:\\repo\\.daoyan-agent\\runs\\feature-1',
      '完善常驻秘书',
      '稳定工作流版本',
      {
        updatedAt: '2026-09-19T01:01:00.000Z',
        taskRuns: [
          {
            result: 'passed',
            completedAt: '2026-09-19T01:00:00.000Z',
            task: { id: 'core', title: '实现任务事件契约' },
          },
          {
            result: 'failed',
            task: { id: 'experience', title: '整理制作人入口' },
          },
        ],
      },
      null,
    );

    expect(completions).toEqual([
      {
        key: 'E:/repo/.daoyan-agent/runs/feature-1#core',
        taskId: 'core',
        taskTitle: '实现任务事件契约',
        parentScope: 'feature',
        parentTitle: '完善常驻秘书',
        versionTitle: '稳定工作流版本',
        completedAt: '2026-09-19T01:00:00.000Z',
        runDirectory: 'E:\\repo\\.daoyan-agent\\runs\\feature-1',
      },
    ]);
  });

  it('uses the checkpoint timestamp for older successful task records', () => {
    const [completion] = featureTaskCompletions(
      'run',
      '旧 Feature',
      '',
      {
        updatedAt: '2026-09-19T02:00:00.000Z',
        taskRuns: [{ result: 'passed', task: { id: 'delivery', title: '完成交付' } }],
      },
      null,
    );

    expect(completion.completedAt).toBe('2026-09-19T02:00:00.000Z');
  });
});

describe('formal version producer decisions', () => {
  it('requires explicit approval or explicit requested changes', () => {
    expect(versionProducerDecision('通过，可以继续推进')).toBe('approved');
    expect(versionProducerDecision('这里有问题，需要调整范围')).toBe('changes-requested');
    expect(versionProducerDecision('我再看看，晚点回复')).toBeNull();
    expect(versionProducerDecision('另外我有一个新方向')).toBeNull();
    expect(versionProducerDecision('新增审批确认功能')).toBeNull();
    expect(versionMessageIsNewDirection('另外我有一个新方向')).toBe(true);
    expect(versionMessageIsNewDirection('新增审批确认功能')).toBe(true);
    expect(versionMessageIsNewDirection('我再看看，晚点回复')).toBe(false);
  });

  it('passes the producer decision text into a resumed Feature PM', () => {
    const args = runArgs(
      {
        id: 'decision',
        idea: '调整存档结构',
        scope: 'feature',
        status: 'retry-wait',
        summary: '等待决定',
        plannedTasks: [],
        matchedFact: null,
        runDirectory: 'E:\\repo\\.daoyan-agent\\runs\\decision',
        processPid: 0,
        processIdentity: '',
        recoveryAttempts: 0,
        retryAt: '',
        producerGuidance: '兼容旧存档',
        createdAt: '',
        updatedAt: '',
        completedAt: '',
        completedTasks: [],
      },
      true,
    );

    expect(args).toEqual(
      expect.arrayContaining([
        '--resume',
        '--decision-confirmed',
        '--producer-guidance',
        '兼容旧存档',
      ]),
    );
  });
});

describe('formal version stage dispatch', () => {
  it('advances a newly recorded direction without requiring a direction document', () => {
    const version = createFormalVersion({
      id: 'new-version',
      title: '新版本',
      direction: '推进新的制作人方向',
      documentRoot: 'docs/versions/new-version',
    });

    expect(advanceRecordedDirection(version)).toBe(true);
    expect(version.currentStage).toBe('charter-draft');
    expect(version.nodes.find((node) => node.id === 'direction')).toEqual(
      expect.objectContaining({
        status: 'completed',
        artifact: '',
        summary: '制作人方向已记录，秘书开始形成版本策划案。',
      }),
    );
    expect(advanceRecordedDirection(version)).toBe(false);
  });

  it('recognizes optimistic version write conflicts as recoverable coordination events', () => {
    expect(
      isFormalVersionWriteConflict(new Error('版本 current 已被其他操作更新，请刷新后重试')),
    ).toBe(true);
    expect(isFormalVersionWriteConflict(new Error('阶段产物损坏'))).toBe(false);
  });

  it('creates one durable internal stage item and does not wait for producer input', () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    const version = createFormalVersion({
      id: 'auto-stage',
      title: '自动阶段',
      direction: '持续推进到真正阻塞',
      documentRoot: 'docs/versions/auto-stage',
      currentStage: 'module-design',
    });

    const item = ensureVersionStageItem(state, version, '2026-09-21T00:01:00.000Z');

    expect(item).toEqual(expect.objectContaining({ status: 'queued', scope: 'feature' }));
    expect(item?.orchestration).toEqual(
      expect.objectContaining({
        formalVersionId: 'auto-stage',
        formalStage: 'module-design',
        formalScopeRevision: 1,
        formalStageStep: 'primary',
      }),
    );
    expect(versionStageDirection(version, 'module-design')).toContain('完成必要模块的详细策划');
    expect(versionStageDirection(version, 'module-design')).toMatch(
      /^\[formal-stage:module-design\]/,
    );
    expect(ensureVersionStageItem(state, version, '2026-09-21T00:02:00.000Z')).toBeNull();
  });

  it('does not dispatch producer gates or stages declared unnecessary', () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    const review = createFormalVersion({
      id: 'producer-gate',
      title: '制作人门禁',
      direction: '等待评审',
      documentRoot: 'docs/versions/producer-gate',
      currentStage: 'charter-review',
    });
    expect(ensureVersionStageItem(state, review)).toBeNull();
    expect(formalVersionBlocksDispatch(review)).toBe(true);

    const reduced = createFormalVersion({
      id: 'skip-stage',
      title: '跳过阶段',
      direction: '按需执行',
      documentRoot: 'docs/versions/skip-stage',
      currentStage: 'module-design',
    });
    recordStagePolicy(reduced, {
      stage: 'module-design',
      mode: 'skip',
      reason: '已有有效规格。',
      evidence: ['docs/spec.md'],
      decidedBy: 'version-pm',
      scopeRevision: 1,
    });
    expect(ensureVersionStageItem(state, reduced)).toBeNull();
    expect(formalVersionBlocksDispatch(reduced)).toBe(false);
  });

  it('carries reduced policy context into the stage prompt', () => {
    const version = createFormalVersion({
      id: 'reduced-stage',
      title: '精简阶段',
      direction: '整理现有界面说明',
      documentRoot: 'docs/versions/reduced-stage',
      currentStage: 'module-design',
    });
    recordStagePolicy(version, {
      stage: 'module-design',
      mode: 'reduced',
      reason: '复用现有规格，只核对差异。',
      evidence: ['docs/specs/existing.md'],
      decidedBy: 'version-pm',
      scopeRevision: 1,
    });

    expect(versionStageDirection(version, 'module-design')).toContain('执行策略：精简执行');
    expect(versionStageDirection(version, 'module-design')).toContain('复用现有规格');
  });

  it('uses a separate durable item for bug-fix reverification', () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    const version = createFormalVersion({
      id: 'bugfix-stage',
      title: '缺陷闭环',
      direction: '修复版本缺陷',
      documentRoot: 'docs/versions/bugfix-stage',
      currentStage: 'bugfix',
    });
    version.bugs.push({
      id: 'bug-1',
      title: '坏路径',
      severity: 'high',
      status: 'open',
      expected: '正常',
      actual: '异常',
      evidence: 'bug-report.md',
      linkedWorkItemId: 'feature',
      verificationRunId: '',
    });

    const primary = ensureVersionStageItem(state, version);
    expect(primary?.orchestration?.formalStageStep).toBe('primary');
    if (primary) primary.status = 'delivered';
    transitionVersionBug(version, 'bug-1', 'fixing');
    transitionVersionBug(version, 'bug-1', 'verify', '', 'abc123');
    const item = ensureVersionStageItem(state, version);
    expect(item?.orchestration?.formalStageStep).toBe('reverification');
    expect(item?.id).not.toBe(primary?.id);
    expect(versionStageDirection(version, 'bugfix')).toContain('本轮只做独立缺陷复验');
  });

  it('validates and preserves the task-breakdown manifest', () => {
    expect(
      parseVersionWorkItems(
        {
          workItems: [
            {
              id: 'core',
              title: '实现核心',
              owner: 'Feature PM',
              dependsOn: [],
              summary: '实现并通过定向测试。',
              affectedPaths: ['scripts/core.ts', 'test/core.test.ts'],
              acceptanceCommands: ['npm test -- test/core.test.ts'],
            },
            {
              id: 'ui',
              title: '接入界面',
              owner: 'Feature PM',
              dependsOn: ['core'],
              summary: '完成交互和 E2E。',
              affectedPaths: ['src/app/', 'test/ui.test.ts'],
              acceptanceCommands: ['npm test -- test/ui.test.ts'],
            },
          ],
        },
        'docs/versions/example/task-breakdown.json',
      ),
    ).toEqual([
      expect.objectContaining({ id: 'core', status: 'pending' }),
      expect.objectContaining({ id: 'ui', dependsOn: ['core'] }),
    ]);
    expect(() =>
      parseVersionWorkItems(
        {
          workItems: [
            {
              id: 'ui',
              title: '接入界面',
              owner: 'Feature PM',
              dependsOn: ['missing'],
              summary: '完成交互。',
              affectedPaths: ['src/app/'],
              acceptanceCommands: ['npm test -- test/ui.test.ts'],
            },
          ],
        },
        'manifest.json',
      ),
    ).toThrow('不存在的依赖');
    expect(() =>
      parseVersionWorkItems(
        {
          workItems: [
            {
              id: 'incomplete',
              title: '缺少可审计验收的任务',
              owner: 'Feature PM',
              dependsOn: [],
              summary: '不应被登记。',
            },
          ],
        },
        'manifest.json',
      ),
    ).toThrow('字段不完整');
  });

  it('replaces stale task-breakdown state with the current validated manifest', () => {
    const version = createFormalVersion({
      id: 'replanned',
      title: '重新拆分',
      direction: '调整任务清单',
      documentRoot: 'docs/versions/replanned',
      currentStage: 'task-breakdown',
    });
    version.workItems.push({
      id: 'stale',
      title: '旧任务',
      owner: 'Feature PM',
      status: 'completed',
      dependsOn: [],
      summary: '旧范围',
      evidence: 'old.json',
    });

    replaceVersionWorkItems(
      version,
      {
        workItems: [
          {
            id: 'current',
            title: '当前任务',
            owner: 'Feature PM',
            dependsOn: [],
            summary: '当前范围',
            affectedPaths: ['scripts/current.ts'],
            acceptanceCommands: ['npm test -- test/current.test.ts'],
          },
        ],
      },
      'task-breakdown.json',
    );

    expect(version.workItems).toEqual([
      expect.objectContaining({
        id: 'current',
        status: 'pending',
        evidence: 'task-breakdown.json',
      }),
    ]);
  });

  it('automatically omits non-applicable runtime stages for documentation-only versions', () => {
    const version = createFormalVersion({
      id: 'docs-only',
      title: '文档版本',
      direction: '完善使用文档和说明',
      documentRoot: 'docs/versions/docs-only',
      currentStage: 'module-design',
    });

    expect(applyAutomaticStagePolicy(version, 'module-design')).toBe(true);
    expect(currentVersionStagePolicy(version, 'module-design').mode).toBe('skip');
    expect(
      ensureVersionStageItem(createSecretaryState('2026-09-21T00:00:00.000Z'), version),
    ).toBeNull();
  });

  it('does not treat runtime logging UI as a documentation-only version', () => {
    const version = createFormalVersion({
      id: 'battle-log',
      title: '战斗日志',
      direction: '增加战斗日志展示',
      documentRoot: 'docs/versions/battle-log',
      currentStage: 'qa',
    });
    expect(applyAutomaticStagePolicy(version, 'qa')).toBe(false);
    expect(currentVersionStagePolicy(version, 'qa').mode).toBe('execute');
  });

  it('requires structured conclusions instead of inferring product success from task delivery', () => {
    const workItems = parseVersionWorkItems(
      {
        workItems: [
          {
            id: 'core',
            title: '核心',
            owner: 'Feature PM',
            dependsOn: [],
            summary: '完成核心行为。',
            affectedPaths: ['scripts/core.ts', 'test/core.test.ts'],
            acceptanceCommands: ['npm test -- test/core.test.ts'],
          },
        ],
      },
      'task-breakdown.json',
    );
    expect(
      parseDesignReviewResult({ decision: 'producer-escalation', summary: '存在产品取舍。' }),
    ).toEqual({ decision: 'producer-escalation', summary: '存在产品取舍。' });
    expect(() => parseDevelopmentResult({ workItems: [] }, workItems)).toThrow('逐一对应');
    expect(
      parseDevelopmentResult(
        {
          workItems: [
            {
              id: 'core',
              status: 'skipped',
              typecheck: 'failed',
              targetedTests: 'failed',
              evidence: ['该工作项经详细策划确认不适用。'],
            },
          ],
        },
        workItems,
      )[0].status,
    ).toBe('skipped');
    expect(
      parseDevelopmentResult(
        {
          workItems: [
            {
              id: 'core',
              status: 'completed',
              typecheck: 'passed',
              targetedTests: 'passed',
              commands: [
                { command: 'npm run typecheck', exitCode: 0 },
                { command: 'npm test -- test/core.test.ts', exitCode: 0 },
              ],
              evidence: ['task-output.md'],
            },
          ],
        },
        workItems,
      )[0].commands,
    ).toEqual([
      { command: 'npm run typecheck', exitCode: 0 },
      { command: 'npm test -- test/core.test.ts', exitCode: 0 },
    ]);
    expect(() =>
      parseDevelopmentResult(
        {
          workItems: [
            {
              id: 'core',
              status: 'completed',
              typecheck: 'passed',
              targetedTests: 'passed',
              commands: [{ command: 'npm run verify:full', exitCode: 0 }],
              evidence: ['planned-command-only.md'],
            },
          ],
        },
        workItems,
      ),
    ).toThrow('Task 必须登记实际运行');
    expect(isTaskScopeCommand('npm run test:e2e')).toBe(false);
    expect(isTaskScopeCommand('npm run build')).toBe(false);
    expect(isTaskScopeCommand('cmd /c npm.cmd run verify:full')).toBe(false);
    expect(
      parseQaResult(
        {
          status: 'failed',
          suites: ['acceptance', 'integration', 'regression'],
          commands: [{ command: 'npm test', exitCode: 1 }],
          evidence: ['qa.md'],
          bugs: [
            {
              id: 'bug-1',
              title: '失败',
              severity: 'high',
              expected: '成功',
              actual: '失败',
              evidence: 'qa.md',
              linkedWorkItemId: 'core',
            },
          ],
        },
        workItems,
      ).status,
    ).toBe('failed');
    expect(() => parseBugfixResult({ fixes: [] }, ['bug-1'])).toThrow('逐项覆盖');
    expect(() =>
      parseReverificationResult(
        {
          status: 'passed',
          bugIds: [],
          suites: ['acceptance', 'integration', 'regression', 'defect-reverification'],
          commands: [{ command: 'npm test', exitCode: 0 }],
          evidence: ['qa.md'],
        },
        ['bug-1'],
      ),
    ).toThrow('逐项覆盖');
  });

  it('topologically orders development results before Task evidence is linked', () => {
    const workItems = parseVersionWorkItems(
      {
        workItems: [
          {
            id: 'downstream',
            title: '下游',
            owner: 'Feature PM',
            dependsOn: ['upstream'],
            summary: '消费上游证据。',
            affectedPaths: ['scripts/downstream.ts'],
            acceptanceCommands: ['npm test -- test/downstream.test.ts'],
          },
          {
            id: 'upstream',
            title: '上游',
            owner: 'Feature PM',
            dependsOn: [],
            summary: '提供依赖证据。',
            affectedPaths: ['scripts/upstream.ts'],
            acceptanceCommands: ['npm test -- test/upstream.test.ts'],
          },
        ],
      },
      'task-breakdown.json',
    );
    const result = parseDevelopmentResult(
      {
        workItems: [
          {
            id: 'downstream',
            status: 'completed',
            typecheck: 'passed',
            targetedTests: 'passed',
            commands: [
              { command: 'npm run typecheck', exitCode: 0 },
              { command: 'npm test -- test/downstream.test.ts', exitCode: 0 },
            ],
            evidence: ['downstream.md'],
          },
          {
            id: 'upstream',
            status: 'completed',
            typecheck: 'passed',
            targetedTests: 'passed',
            commands: [
              { command: 'npm run typecheck', exitCode: 0 },
              { command: 'npm test -- test/upstream.test.ts', exitCode: 0 },
            ],
            evidence: ['upstream.md'],
          },
        ],
      },
      workItems,
    );

    expect(result.map((entry) => entry.id)).toEqual(['upstream', 'downstream']);
  });

  it('wires Task, Feature, and Version validation evidence into formal stage ingestion', () => {
    const source = readFileSync(resolve('scripts/secretary-notice-guard.ts'), 'utf8');
    expect(source.match(/recordValidationEvidence\(version/g)?.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain('reusedFeatureEvidenceId: featureGate.id');
    expect(source).toContain('latestReusableFeatureGate(version, testedRevision)');
    expect(source).toContain("scope: 'task'");
    expect(source).toContain("scope: 'feature'");
    expect(source).toContain("scope: 'version'");
    expect(source).toContain('const commands = result.commands');
    expect(source).not.toContain('commands.map((command) => ({ command, exitCode: 0 }))');
  });

  it('checks the live candidate tree and validation config before QA reuses a Feature gate', () => {
    const version = createFormalVersion({
      id: 'live-gate-reuse',
      title: '实时门禁复用',
      direction: '验证当前候选树。',
      documentRoot: 'docs/versions/live-gate-reuse',
      currentStage: 'qa',
    });
    const commandFingerprint = createHash('sha256').update('npm run verify:full').digest('hex');
    const gate = recordValidationEvidence(version, {
      id: 'feature-gate',
      scope: 'feature',
      ownerId: 'feature-pm',
      status: 'passed',
      gitTree: 'tree-current',
      codeRevision: 'rev-current',
      commandFingerprint,
      configFingerprint: 'config-current',
      affectedPaths: ['scripts/'],
      inputEvidenceIds: [],
      outputFingerprint: 'tree-current',
      executionRound: 1,
      commands: [{ command: 'npm run verify:full', exitCode: 0 }],
      evidence: ['full-gate-evidence.json'],
    });

    expect(
      latestReusableFeatureGate(version, 'rev-current', 'tree-current', 'config-current').id,
    ).toBe(gate.id);
    expect(() =>
      latestReusableFeatureGate(version, 'rev-current', 'tree-changed', 'config-current'),
    ).toThrow('缺少与候选修订匹配');
    expect(() =>
      latestReusableFeatureGate(version, 'rev-current', 'tree-current', 'config-changed'),
    ).toThrow('缺少与候选修订匹配');
  });

  it('reuses the development Feature gate after mandatory QA stage documents are recorded', async () => {
    const fixture = await mkdtemp(resolve(tmpdir(), 'daoyan-feature-gate-qa-order-'));
    try {
      await mkdir(resolve(fixture, 'scripts'), { recursive: true });
      await mkdir(resolve(fixture, 'docs/versions/release'), { recursive: true });
      await writeFile(resolve(fixture, 'scripts/feature.ts'), 'export const feature = true;\n');
      await writeFile(resolve(fixture, 'package.json'), '{"scripts":{}}\n');
      await writeFile(resolve(fixture, 'package-lock.json'), '{}\n');
      await writeFile(resolve(fixture, 'vite.config.ts'), 'export default {};\n');
      const taskBreakdownPath = 'docs/versions/release/task-breakdown.json';
      const taskBreakdown = '{"workItems":[{"id":"feature"}]}\n';
      await writeFile(resolve(fixture, taskBreakdownPath), taskBreakdown);
      const developmentManifestPath = 'docs/versions/release/development.json';
      const developmentManifest =
        '{"workItems":[{"id":"feature","commands":[{"command":"npm run typecheck","exitCode":0}]}]}\n';
      await writeFile(resolve(fixture, developmentManifestPath), developmentManifest);
      const testedRevision = 'development-revision';
      const developmentPaths = [
        'scripts/feature.ts',
        'package.json',
        'package-lock.json',
        'vite.config.ts',
        taskBreakdownPath,
        developmentManifestPath,
      ];
      const testedTree = validationTreeFingerprintForPaths(developmentPaths, fixture);
      const config = currentValidationConfigFingerprint(fixture);
      const version = createFormalVersion({
        id: 'qa-stage-order',
        title: '开发到 QA 顺序',
        direction: 'QA 阶段产物不得使 Feature 门禁失效。',
        documentRoot: 'docs/versions/release',
        currentStage: 'qa',
      });
      const commandFingerprint = createHash('sha256').update('npm run verify:full').digest('hex');
      const gate = recordValidationEvidence(version, {
        id: 'development-feature-gate',
        scope: 'feature',
        ownerId: 'feature-pm',
        status: 'passed',
        gitTree: testedTree,
        codeRevision: testedRevision,
        commandFingerprint,
        configFingerprint: config,
        affectedPaths: ['scripts/'],
        inputEvidenceIds: [],
        outputFingerprint: testedTree,
        executionRound: 1,
        commands: [{ command: 'npm run verify:full', exitCode: 0 }],
        evidence: ['full-gate-evidence.json'],
      });

      await writeFile(resolve(fixture, 'docs/versions/release/qa.json'), '{"status":"passed"}\n');
      await writeFile(resolve(fixture, 'docs/versions/release/qa.md'), '# QA\n\n通过。\n');

      const qaTree = validationTreeFingerprintForPaths(
        [...developmentPaths, 'docs/versions/release/qa.json', 'docs/versions/release/qa.md'],
        fixture,
      );
      expect(qaTree).toBe(testedTree);
      expect(latestReusableFeatureGate(version, testedRevision, qaTree, config).id).toBe(gate.id);

      await writeFile(
        resolve(fixture, developmentManifestPath),
        '{"workItems":[{"id":"feature","commands":[{"command":"npm run typecheck","exitCode":1}]}]}\n',
      );
      const changedDevelopmentTree = validationTreeFingerprintForPaths(developmentPaths, fixture);
      expect(changedDevelopmentTree).not.toBe(testedTree);
      expect(() =>
        latestReusableFeatureGate(version, testedRevision, changedDevelopmentTree, config),
      ).toThrow('缺少与候选修订匹配');
      await writeFile(resolve(fixture, developmentManifestPath), developmentManifest);

      await writeFile(
        resolve(fixture, taskBreakdownPath),
        '{"workItems":[{"id":"changed-scope"}]}\n',
      );
      const changedScopeTree = validationTreeFingerprintForPaths(developmentPaths, fixture);
      expect(changedScopeTree).not.toBe(testedTree);
      expect(() =>
        latestReusableFeatureGate(version, testedRevision, changedScopeTree, config),
      ).toThrow('缺少与候选修订匹配');

      await writeFile(resolve(fixture, taskBreakdownPath), taskBreakdown);
      await writeFile(resolve(fixture, 'scripts/feature.ts'), 'export const feature = false;\n');
      const changedCodeTree = validationTreeFingerprintForPaths(developmentPaths, fixture);
      expect(changedCodeTree).not.toBe(testedTree);
      expect(() =>
        latestReusableFeatureGate(version, testedRevision, changedCodeTree, config),
      ).toThrow('缺少与候选修订匹配');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('treats candidate changes outside version documents as untested implementation drift', () => {
    expect(
      nonDocumentationChanges([
        'docs/versions/release/candidate.md',
        'src/app/App.tsx',
        'test/render.test.tsx',
      ]),
    ).toEqual(['src/app/App.tsx', 'test/render.test.tsx']);
  });
});
