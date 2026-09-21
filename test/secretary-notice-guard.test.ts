import { describe, expect, it } from 'vitest';
import {
  continueDispatchResponse,
  advanceRecordedDirection,
  applyAutomaticStagePolicy,
  featureTaskCompletions,
  retryTimeFromOutput,
  runArgs,
  snapshotPredatesLaunch,
  ensureVersionStageItem,
  formalVersionBlocksDispatch,
  isFormalVersionWriteConflict,
  parseBugfixResult,
  parseDesignReviewResult,
  parseDevelopmentResult,
  parseQaResult,
  parseReverificationResult,
  parseVersionWorkItems,
  nonDocumentationChanges,
  replaceVersionWorkItems,
  versionStageDirection,
  versionMessageIsNewDirection,
  versionProducerDecision,
  windowsCodexInvocation,
} from '../scripts/secretary-notice-guard';
import { itemFromIntake } from '../scripts/secretary-state';
import { createSecretaryState } from '../scripts/secretary-state';
import {
  createFormalVersion,
  currentVersionStagePolicy,
  recordStagePolicy,
  transitionVersionBug,
} from '../scripts/version-lifecycle';

describe('secretary worker process launch', () => {
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
            },
            {
              id: 'ui',
              title: '接入界面',
              owner: 'Feature PM',
              dependsOn: ['core'],
              summary: '完成交互和 E2E。',
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
            },
          ],
        },
        'manifest.json',
      ),
    ).toThrow('不存在的依赖');
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
