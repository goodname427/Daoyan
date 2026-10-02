import { describe, expect, it } from 'vitest';
import { advanceVersion, createFormalVersion, recordApproval } from '../scripts/version-lifecycle';
import {
  applyFormalStageValidationProfile,
  buildLocalPlan,
  validationStagesForPlan,
} from '../scripts/agent-routing';
import { ensureVersionStageItem } from '../scripts/secretary-notice-guard';
import { createSecretaryState } from '../scripts/secretary-state';
import {
  assertModuleDesignReworkCoverage,
  assertModuleDesignTaskPlan,
  assertRoadmapHandoffTaskPlan,
  assertStageTaskPaths,
  assertStageTaskDeliveryScope,
  assertStageTaskPrestartScope,
  assertTaskWriteScope,
  parseStageTaskManifest,
  parseStageTaskResult,
  developmentTaskEnvironmentBlockerReason,
  stageTaskImplementationDeviationReason,
  stageTaskTechnicalBlockerReason,
  readyStageTasks,
} from '../scripts/version-stage-tasks';

const task = (id: string, dependsOn: string[] = [], writePaths = [`src/${id}`]) => ({
  id,
  title: id,
  objective: `交付 ${id}`,
  deliverables: [`${id} 产物`],
  acceptance: [`${id} 可检查`],
  dependsOn,
  readPaths: ['docs/status.md'],
  writePaths,
});

describe('stage-owned task contracts', () => {
  it('assigns an identical acceptance check to only one task in a node', () => {
    expect(() =>
      parseStageTaskManifest(
        {
          tasks: [
            { ...task('design'), acceptance: ['实际操作相同的玩家场景'] },
            { ...task('qa'), acceptance: ['实际操作相同的玩家场景'] },
          ],
        },
        'qa',
        1,
      ),
    ).toThrow('节点验收重复分派');
  });
  it('requires every rejected same-key consumer to have a writing owner', () => {
    const root = 'docs/versions/v2';
    const review = {
      reviewDecision: 'changes-requested',
      checks: {
        sameKeyConflicts: [
          'physics-material-design.md:704,710 stale bound',
          'mana-ledger-design.md:944 stale consumer',
          'module-design.md:1-20 stale summary',
        ],
      },
    };
    const plan = {
      tasks: [task('physics', [], [`${root}/physics-material-design.md`])],
    };
    expect(() => assertModuleDesignReworkCoverage(plan, review, root)).toThrow(
      'mana-ledger-design.md',
    );
    plan.tasks.push(task('ledger', ['physics'], [`${root}/mana-ledger-design.md`]));
    expect(() => assertModuleDesignReworkCoverage(plan, review, root)).not.toThrow();
    expect(() =>
      assertModuleDesignReworkCoverage(plan, { reviewDecision: 'approved' }, root),
    ).not.toThrow();
  });
  it('requires a Version PM owned roadmap handoff with design and delivery evidence', () => {
    const path = 'docs/versions/v2/roadmap-handoff.md';
    const plan = {
      tasks: [task('world')],
      roadmapHandoff: {
        owner: 'Version PM',
        path,
        acceptance: ['引用 design-review.md 与实测 development.json，区分未来候选'],
      },
    };
    expect(() => assertRoadmapHandoffTaskPlan(plan, path)).not.toThrow();
    expect(() => assertRoadmapHandoffTaskPlan({ tasks: plan.tasks }, path)).toThrow('Version PM');
    expect(() =>
      assertRoadmapHandoffTaskPlan(
        { ...plan, roadmapHandoff: { ...plan.roadmapHandoff, owner: 'Feature PM' } },
        path,
      ),
    ).toThrow('Version PM');
    expect(() =>
      assertRoadmapHandoffTaskPlan(
        { ...plan, roadmapHandoff: { ...plan.roadmapHandoff, acceptance: ['写路线图'] } },
        path,
      ),
    ).toThrow('已批准策划');
  });
  it('records Version PM context decisions and keeps old task manifests valid', () => {
    const [continued] = parseStageTaskManifest(
      {
        tasks: [
          {
            ...task('world', [], ['docs/versions/v2/world.md']),
            contextPolicy: 'continue',
            contextReason: '同一世界理论文档的定向修订',
          },
        ],
      },
      'module-design',
      13,
    );
    expect(continued.contextPolicy).toBe('continue');
    expect(continued.contextReason).toBe('同一世界理论文档的定向修订');
    const [legacy] = parseStageTaskManifest(
      { tasks: [task('legacy', [], ['docs/versions/v2/legacy.md'])] },
      'module-design',
      13,
    );
    expect(legacy.contextPolicy).toBeUndefined();
    expect(() =>
      parseStageTaskManifest(
        { tasks: [{ ...task('world'), contextPolicy: 'fresh' }] },
        'module-design',
        13,
      ),
    ).toThrow('节点任务合同');
    expect(() =>
      parseStageTaskManifest(
        { tasks: [{ ...task('world'), contextPolicy: 'invalid' }] },
        'module-design',
        13,
      ),
    ).toThrow('节点任务合同');
  });
  it('recovers a delivered result whose paths were recorded as artifacts', () => {
    const result = {
      taskId: 'physics',
      status: 'completed',
      summary: '有限证书已提交',
      commands: [{ command: 'node scripts/check-docs.mjs', exitCode: 0 }],
      artifacts: ['docs/versions/v2/physics.md'],
    };
    expect(parseStageTaskResult(result, 'physics').evidence).toEqual(result.artifacts);
    expect(() => parseStageTaskResult({ ...result, evidence: [] }, 'physics')).toThrow(
      '缺少实际检查',
    );
    expect(() => parseStageTaskResult({ ...result, artifacts: [] }, 'physics')).toThrow(
      '缺少实际检查',
    );
  });
  it('keeps a documented browser permission blocker distinct from missing delivery evidence', () => {
    const blocked = {
      taskId: 'da-a-flow',
      status: 'blocked',
      completed: false,
      summary: '独立策划尚未取得玩家页面操作证据',
      evidence: ['docs/versions/v2/tasks/design-acceptance-da-a-flow/browser-attempts.json'],
      openDeviations: [{ kind: 'technical-blocker', status: 'open', actual: '用户拒绝浏览器访问' }],
      confirmedImplementationDeviations: [],
    };
    expect(stageTaskTechnicalBlockerReason(blocked, 'da-a-flow')).toBe('用户拒绝浏览器访问');
    expect(
      stageTaskTechnicalBlockerReason({ ...blocked, openDeviations: [] }, 'da-a-flow'),
    ).toBeNull();
    expect(
      stageTaskTechnicalBlockerReason({ ...blocked, status: 'completed' }, 'da-a-flow'),
    ).toBeNull();
    expect(stageTaskTechnicalBlockerReason(blocked, 'other-task')).toBeNull();
  });
  it('recognizes a development playtest denied before any player action', () => {
    const blocked = {
      taskId: 'dev-battle-boundary-a1',
      status: 'blocked',
      completed: false,
      actualApplication: {
        observations: { blocker: 'Computer Use was not approved to use electron' },
      },
    };
    expect(developmentTaskEnvironmentBlockerReason(blocked, blocked.taskId)).toBe(
      'Computer Use was not approved to use electron',
    );
    expect(
      developmentTaskEnvironmentBlockerReason({ ...blocked, status: 'completed' }, blocked.taskId),
    ).toBeNull();
    expect(developmentTaskEnvironmentBlockerReason(blocked, 'other-task')).toBeNull();
    expect(
      developmentTaskEnvironmentBlockerReason(
        { ...blocked, actualApplication: {} },
        blocked.taskId,
      ),
    ).toBeNull();
  });
  it('returns a signed negative design verdict to development without treating an environment gap as pass', () => {
    const blocked = {
      taskId: 'da-a-flow',
      status: 'blocked',
      completed: false,
      summary: '独立实玩发现旧 Battle 缺证拒绝偏差，截图仍待补',
      evidence: ['docs/versions/v2/tasks/design-acceptance-da-a-flow/experience.md'],
      commands: [{ command: 'node docs/versions/v2/tasks/check.mjs', exitCode: 0 }],
      independence: { participatedInDevelopment: false },
      runtimeConfiguration: { playerOperations: 38 },
      confirmedImplementationDeviations: [
        { id: 'DV01', evidence: 'docs/versions/v2/tasks/independent-play.json' },
      ],
    };
    expect(stageTaskImplementationDeviationReason(blocked, 'da-a-flow')).toBe('DV01');
    expect(stageTaskTechnicalBlockerReason(blocked, 'da-a-flow')).toBeNull();
    expect(
      stageTaskImplementationDeviationReason(
        { ...blocked, runtimeConfiguration: { playerOperations: 0 } },
        'da-a-flow',
      ),
    ).toBeNull();
    expect(
      stageTaskImplementationDeviationReason(
        { ...blocked, commands: [{ command: 'node check.mjs', exitCode: 1 }] },
        'da-a-flow',
      ),
    ).toBeNull();
  });
  it('requires one detailed-design owner per declared module', () => {
    const tasks = [task('resources'), task('market')];
    const modules = [
      { id: 'resources', title: '资源', taskId: 'resources' },
      { id: 'market', title: '市场', taskId: 'market' },
    ];
    const plan = { tasks, modules, crossModuleContracts: ['市场交易转移资源归属'] };
    expect(() => assertModuleDesignTaskPlan(plan)).not.toThrow();
    expect(() => assertModuleDesignTaskPlan({ tasks })).toThrow('模块清单');
    expect(() =>
      assertModuleDesignTaskPlan({
        ...plan,
        modules: modules.map((module) => ({ ...module, taskId: 'resources' })),
      }),
    ).toThrow('独立');
    expect(() => assertModuleDesignTaskPlan({ ...plan, modules: modules.slice(0, 1) })).toThrow(
      '解释边界',
    );
  });
  it('ignores separate Main Agent control-plane fixes but rejects game changes outside a task', () => {
    const [charter] = parseStageTaskManifest(
      { tasks: [task('charter', [], ['docs/versions/v2/charter-draft.md'])] },
      'charter-draft',
      1,
      '2026-09-26T00:00:00.000Z',
    );
    expect(() =>
      assertStageTaskDeliveryScope(charter, [
        'scripts/agent-dispatcher.ts',
        'test/version-stage-tasks.test.ts',
        'docs/status.md',
        'docs/workflow.md',
        'docs/dev/2026-09-26.md',
        'docs/versions/v2/charter-draft.md',
      ]),
    ).not.toThrow();
    expect(() => assertStageTaskDeliveryScope(charter, ['scripts/agent-dispatcher.ts'])).toThrow(
      '未提交合同内',
    );
    expect(() =>
      assertStageTaskDeliveryScope(charter, [
        'docs/versions/v2/charter-draft.md',
        'src/core/world.ts',
      ]),
    ).toThrow('超出');
  });
  it('separates a rebased empty run from commits that changed its contract', () => {
    const [review] = parseStageTaskManifest(
      {
        tasks: [
          {
            ...task('review', [], ['docs/versions/v2/design-review-findings.md']),
            readPaths: ['docs/versions/v2/world-rule-design.md'],
          },
        ],
      },
      'design-review',
      1,
      '2026-09-26T00:00:00.000Z',
    );
    expect(() =>
      assertStageTaskPrestartScope(review, [
        'scripts/agent-routing.ts',
        'docs/versions/v2/design-review-tasks.md',
      ]),
    ).not.toThrow();
    expect(() =>
      assertStageTaskPrestartScope(review, ['docs/versions/v2/world-rule-design.md']),
    ).toThrow('合同输入或输出');
    expect(() =>
      assertStageTaskPrestartScope(review, ['docs/versions/v2/design-review-findings.md']),
    ).toThrow('合同输入或输出');
    expect(() =>
      assertStageTaskDeliveryScope(review, ['docs/versions/v2/design-review-findings.md']),
    ).not.toThrow();
  });
  it('creates new versions without the up-front breakdown and planning nodes', () => {
    const version = createFormalVersion({
      id: 'v2',
      title: 'v2',
      direction: '完成新版本',
      documentRoot: 'docs/versions/v2',
      workflowRevision: 2,
    });
    expect(version.nodes.map((node) => node.id)).not.toContain('task-breakdown');
    expect(version.nodes.map((node) => node.id)).not.toContain('version-planning');
    expect(version.stageTasks).toEqual([]);
    advanceVersion(version, 'charter-draft');
    const acceptStage = (stage: 'charter-draft' | 'module-design' | 'design-review') => {
      const tasks = parseStageTaskManifest(
        { tasks: [task(`${stage}-work`, [], [`docs/versions/v2/${stage}.md`])] },
        stage,
        1,
        version.nodes.find((node) => node.id === stage)!.startedAt,
      );
      tasks[0].status = 'accepted';
      version.stageTasks!.push(...tasks);
    };
    acceptStage('charter-draft');
    advanceVersion(version, 'charter-review');
    recordApproval(version, {
      stage: 'charter-review',
      reviewer: 'producer',
      decision: 'approved',
      documentRevision: version.charterRevision,
      comment: '方向通过',
    });
    advanceVersion(version, 'module-design');
    acceptStage('module-design');
    advanceVersion(version, 'design-review');
    acceptStage('design-review');
    recordApproval(version, {
      stage: 'design-review',
      reviewer: 'lead-designer',
      decision: 'approved',
      documentRevision: version.charterRevision,
      comment: '策划通过',
    });
    advanceVersion(version, 'development');
    expect(version.scopeFrozen).toBe(true);
  });

  it('validates dependency order and actual write scope', () => {
    const tasks = parseStageTaskManifest(
      { tasks: [task('spell'), task('arena', ['spell'], ['src/game/arena'])] },
      'development',
      1,
    );
    expect(readyStageTasks(tasks).map((item) => item.id)).toEqual(['spell']);
    tasks[0].status = 'accepted';
    expect(readyStageTasks(tasks).map((item) => item.id)).toEqual(['arena']);
    expect(() => assertTaskWriteScope(tasks[1], ['src/game/arena/battle.ts'])).not.toThrow();
    expect(() => assertTaskWriteScope(tasks[1], ['src/core/vm.ts'])).toThrow('超出');
  });

  it('rejects unrelated writers with overlapping paths and cyclic dependencies', () => {
    expect(() =>
      parseStageTaskManifest(
        { tasks: [task('one', [], ['src/core']), task('two', [], ['src/core/vm.ts'])] },
        'development',
        1,
      ),
    ).toThrow('重叠');
    expect(() =>
      parseStageTaskManifest(
        { tasks: [task('one', ['two']), task('two', ['one'])] },
        'development',
        1,
      ),
    ).toThrow('循环');
  });

  it('keeps independent verification inside version evidence and reserves shared reports', () => {
    const [qa] = parseStageTaskManifest({ tasks: [task('qa-cross', [], ['src/game'])] }, 'qa', 1);
    expect(() => assertStageTaskPaths(qa, 'docs/versions/v2')).toThrow('证据目录');
    qa.writePaths = ['docs/versions/v2/tasks/qa-cross.md'];
    expect(() => assertStageTaskPaths(qa, 'docs/versions/v2')).not.toThrow();
    qa.writePaths = ['docs/versions/v2/qa-tasks.json'];
    expect(() => assertStageTaskPaths(qa, 'docs/versions/v2')).toThrow('共享文档');
    const designAcceptance = {
      ...qa,
      stage: 'design-acceptance' as const,
      writePaths: ['src/game'],
    };
    expect(() => assertStageTaskPaths(designAcceptance, 'docs/versions/v2')).toThrow('证据目录');
  });

  it('dispatches planning, one PM per deliverable, then stage finalization', () => {
    const timestamp = '2026-09-24T00:00:00.000Z';
    const version = createFormalVersion({
      id: 'task-owned',
      title: '任务归属',
      direction: '开发法术',
      documentRoot: 'docs/versions/task-owned',
      currentStage: 'development',
      workflowRevision: 2,
      now: timestamp,
    });
    const secretary = createSecretaryState(timestamp);
    const planning = ensureVersionStageItem(secretary, version, timestamp);
    expect(planning?.orchestration?.formalStageStep).toBe('planning');
    expect(buildLocalPlan(planning!.idea).tasks).toHaveLength(1);
    planning!.status = 'delivered';
    planning!.orchestration!.formalStageConsumedAt = timestamp;
    version.stageTasks = parseStageTaskManifest(
      {
        tasks: [
          task('spell', [], ['src/core/spell.ts']),
          task('arena', ['spell'], ['src/game/arena.ts']),
        ],
      },
      'development',
      1,
      timestamp,
    );
    const first = ensureVersionStageItem(secretary, version, timestamp);
    expect(first?.orchestration?.formalTaskId).toBe('spell');
    expect(first?.idea).toContain('[formal-stage-deliverable:development:spell]');
    first!.status = 'delivered';
    first!.orchestration!.formalStageConsumedAt = timestamp;
    version.stageTasks[0].status = 'accepted';
    const second = ensureVersionStageItem(secretary, version, timestamp);
    expect(second?.orchestration?.formalTaskId).toBe('arena');
    second!.status = 'delivered';
    second!.orchestration!.formalStageConsumedAt = timestamp;
    version.stageTasks[1].status = 'accepted';
    const finalizing = ensureVersionStageItem(secretary, version, timestamp);
    expect(finalizing?.orchestration?.formalStageStep).toBe('finalizing');
    expect(buildLocalPlan(finalizing!.idea).tasks).toHaveLength(1);
    expect(buildLocalPlan(finalizing!.idea).tasks[0].title).toBe('执行版本开发');
  });

  it('separates bug fixing from independent reverification inside one node', () => {
    const timestamp = '2026-09-24T00:00:00.000Z';
    const version = createFormalVersion({
      id: 'bug-round',
      title: '缺陷轮次',
      direction: '修复缺陷',
      documentRoot: 'docs/versions/bug-round',
      currentStage: 'bugfix',
      workflowRevision: 2,
      now: timestamp,
    });
    const secretary = createSecretaryState(timestamp);
    const first = ensureVersionStageItem(secretary, version, timestamp)!;
    expect(first.idea).toContain('[formal-stage-task-plan:bugfix]');
    expect(first.orchestration?.formalStageStep).toBe('planning');
    first.status = 'delivered';
    first.orchestration!.formalStageConsumedAt = timestamp;
    version.bugs.push({
      id: 'bug-1',
      title: '重复派发',
      severity: 'high',
      status: 'verify',
      expected: '单次',
      actual: '重复',
      evidence: 'bug.json',
      linkedWorkItemId: '',
    });
    const second = ensureVersionStageItem(secretary, version, timestamp)!;
    expect(second.idea).toContain('bugfix-reverification-tasks.json');
    expect(second.orchestration?.formalStageStep).toBe('planning');
    expect(second.id).not.toBe(first.id);
  });

  it('keeps task PM checks separate from the final full gate', () => {
    const charterPlan = buildLocalPlan('实现任务记录交付');
    charterPlan.tasks[0].type = 'implementation';
    expect(
      applyFormalStageValidationProfile(
        charterPlan,
        '[formal-stage-deliverable:charter-draft:game-intent-charter]',
      ),
    ).toBe(true);
    expect(charterPlan.tasks[0].validationProfile).toBe('light');
    expect(validationStagesForPlan(charterPlan)).toEqual([]);
    const taskPlan = buildLocalPlan('实现测试功能');
    taskPlan.riskSignals.push('formal-stage-deliverable');
    expect(validationStagesForPlan(taskPlan)).not.toContain('full-gate');
    const finalPlan = buildLocalPlan(
      '[formal-stage:development]\n[formal-stage-finalizing]\n汇总结果',
    );
    expect(validationStagesForPlan(finalPlan)).toContain('full-gate');
    expect(validationStagesForPlan(finalPlan)).not.toContain('fast-gate');
  });

  it('lets design review produce evidence before escalating a producer decision', () => {
    const reviewPlan = buildLocalPlan('审核统一世界规则');
    reviewPlan.producerDecisionRequired = true;
    reviewPlan.producerQuestion = '请先选择物理规则';
    expect(
      applyFormalStageValidationProfile(
        reviewPlan,
        '[formal-stage-deliverable:design-review:unified-world-review]',
      ),
    ).toBe(true);
    expect(reviewPlan.producerDecisionRequired).toBe(false);
    expect(reviewPlan.producerQuestion).toBe('请先选择物理规则');
    expect(validationStagesForPlan(reviewPlan)).toEqual([]);

    const developmentPlan = buildLocalPlan('实现物理规则');
    developmentPlan.producerDecisionRequired = true;
    applyFormalStageValidationProfile(
      developmentPlan,
      '[formal-stage-deliverable:development:physics]',
    );
    expect(developmentPlan.producerDecisionRequired).toBe(true);
    const contingencyPlan = buildLocalPlan('实现已批准的首批三行为');
    contingencyPlan.producerDecisionRequired = true;
    contingencyPlan.producerQuestion =
      '如果实现过程中发现必须改变已批准世界原则或作出不可逆架构选择，先提交阻断事实与可比较取舍，再由制作人决定；除此情形按合同推进。';
    applyFormalStageValidationProfile(
      contingencyPlan,
      '[formal-stage-deliverable:development:world-core]',
    );
    expect(contingencyPlan.producerDecisionRequired).toBe(false);
    expect(contingencyPlan.producerQuestion).toContain('如果实现过程中发现');
  });
});
