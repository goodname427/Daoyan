import { describe, expect, it } from 'vitest';
import { advanceVersion, createFormalVersion, recordApproval } from '../scripts/version-lifecycle';
import { buildLocalPlan, validationStagesForPlan } from '../scripts/agent-routing';
import { ensureVersionStageItem } from '../scripts/secretary-notice-guard';
import { createSecretaryState } from '../scripts/secretary-state';
import {
  assertStageTaskPaths,
  assertStageTaskDeliveryScope,
  assertTaskWriteScope,
  parseStageTaskManifest,
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
    const charterPlan = buildLocalPlan('整理版本策划');
    charterPlan.tasks = [
      { ...charterPlan.tasks[0], type: 'documentation', validationProfile: 'light' },
    ];
    charterPlan.riskSignals.push('formal-stage-deliverable');
    expect(validationStagesForPlan(charterPlan)).toEqual([]);
    const taskPlan = buildLocalPlan('实现测试功能');
    taskPlan.riskSignals.push('formal-stage-deliverable');
    expect(validationStagesForPlan(taskPlan)).not.toContain('full-gate');
    const finalPlan = buildLocalPlan(
      '[formal-stage:development]\n[formal-stage-finalizing]\n汇总结果',
    );
    expect(validationStagesForPlan(finalPlan)).toContain('full-gate');
  });
});
