import { describe, expect, it } from 'vitest';
import {
  applyContinueToSchedule,
  applyWaitingReply,
  createSecretaryState,
  decideIntake,
  firstUntrackedScheduledFact,
  inferMessageIntent,
  intentSimilarity,
  isRunEligibleForAdoption,
  itemFromIntake,
  nextRunnableItem,
  projectFactsFromItems,
  projectFactsFromStatus,
  taskCompletionKey,
  unrecordedTaskCompletions,
  type IntakeRequest,
  type SecretaryTaskCompletion,
} from '../scripts/secretary-state';

const status = `
## 已具备

- 蓝图编辑支持撤销、重做和节点搜索。

## 当前迭代

- 已完成并发施法。

## 下一阶段候选

1. 继续迁移旧元法术到统一实体能力。
2. 境界成长和掉落。
`;

describe('persistent secretary state', () => {
  it('extracts completed and scheduled facts from the status source of truth', () => {
    expect(projectFactsFromStatus(status).map((fact) => fact.kind)).toEqual([
      'completed',
      'completed',
      'scheduled',
      'scheduled',
    ]);
  });

  it('conservatively distinguishes completed, active, scheduled and new ideas', () => {
    const facts = [
      ...projectFactsFromStatus(status),
      { kind: 'active' as const, text: '法术书持久化和导入导出', reference: 'active-version' },
    ];
    expect(decideIntake('蓝图节点搜索和撤销重做', facts).action).toBe('answer-completed');
    expect(decideIntake('完成法术书持久化和导入导出', facts).action).toBe('track-active');
    expect(decideIntake('把旧元法术迁移到统一实体能力', facts).action).toBe('queue-scheduled');
    expect(decideIntake('新增宗门经营系统', facts).action).toBe('queue-new');
    expect(intentSimilarity('法术书导入导出', '法术书持久化和导入导出')).toBeGreaterThan(0.7);
  });

  it('answers known work and turns new ideas into PM task contracts', () => {
    const request: IntakeRequest = {
      id: 'idea-1',
      idea: '新增宗门经营界面',
      createdAt: '2026-09-14T00:00:00.000Z',
    };
    const result = itemFromIntake(request, projectFactsFromStatus(status));
    expect(result.item.status).toBe('queued');
    expect(result.item.plannedTasks).toEqual(['完成产品纵向切片']);
    expect(decideIntake(request.idea, projectFactsFromItems([result.item])).action).toBe(
      'queue-scheduled',
    );
  });

  it('runs one item at a time and wakes retry items only after their timer', () => {
    const state = createSecretaryState('2026-09-14T00:00:00.000Z');
    const first = itemFromIntake(
      {
        id: 'first',
        idea: '新增宗门经营系统',
        createdAt: '2026-09-14T00:00:00.000Z',
      },
      [],
    ).item;
    const retry = {
      ...first,
      id: 'retry',
      status: 'retry-wait' as const,
      retryAt: '2026-09-14T02:00:00.000Z',
    };
    state.items.push(retry, first);
    expect(nextRunnableItem(state, '2026-09-14T01:00:00.000Z')).toBeNull();
    expect(nextRunnableItem(state, '2026-09-14T03:00:00.000Z')?.id).toBe('retry');
    state.activeItemId = 'active';
    expect(nextRunnableItem(state, '2026-09-14T03:00:00.000Z')).toBeNull();
  });

  it('infers natural conversation intent without producer flags', () => {
    expect(inferMessageIntent('现在做到哪一步了？', false)).toBe('question');
    expect(inferMessageIntent('继续按当前计划推进', false)).toBe('continue');
    expect(inferMessageIntent('采用兼容旧存档的方案', true)).toBe('reply');
    expect(inferMessageIntent('现在可以继续了', true)).toBe('continue');
    expect(inferMessageIntent('目前额度已经恢复', true)).toBe('continue');
    expect(inferMessageIntent('现在项目进度怎么样？', true)).toBe('question');
    expect(inferMessageIntent('当前进度如何，可以继续推进吗？', true)).toBe('question');
    expect(inferMessageIntent('增加法术对比视图', false)).toBe('direction');
  });

  it('resumes the waiting task from an untyped natural-language reply', () => {
    const state = createSecretaryState('2026-09-14T00:00:00.000Z');
    const waiting = itemFromIntake(
      {
        id: 'blocked',
        idea: '完成法术存档迁移',
        createdAt: '2026-09-14T00:00:00.000Z',
      },
      [],
    ).item;
    waiting.status = 'waiting-producer';
    state.items.push(waiting);
    state.activeItemId = waiting.id;
    const request: IntakeRequest = {
      id: 'reply',
      idea: '现在可以继续了',
      createdAt: '2026-09-14T01:00:00.000Z',
    };
    const intent = inferMessageIntent(request.idea, true);

    expect(applyWaitingReply(state, request, intent)?.id).toBe(waiting.id);
    expect(waiting.status).toBe('retry-wait');
    expect(waiting.producerGuidance).toBe(request.idea);
    expect(state.activeItemId).toBe('');
  });

  it('turns a natural-language continue request into an immediate durable retry', () => {
    const state = createSecretaryState('2026-09-14T00:00:00.000Z');
    const retry = itemFromIntake(
      {
        id: 'retry',
        idea: '迁移旧元法术',
        createdAt: '2026-09-14T00:00:00.000Z',
      },
      [],
    ).item;
    retry.status = 'retry-wait';
    retry.retryAt = '2026-09-15T04:31:00.000Z';
    state.items.push(retry);
    const request: IntakeRequest = {
      id: 'continue-now',
      idea: '继续推进任务',
      createdAt: '2026-09-14T01:00:00.000Z',
    };

    expect(applyContinueToSchedule(state, request)).toEqual({
      action: 'resumed',
      item: retry,
    });
    expect(retry.retryAt).toBe(request.createdAt);
    expect(retry.lastProducerRequestId).toBe(request.id);
    expect(nextRunnableItem(state, request.createdAt)).toBe(retry);
  });

  it('selects the next status backlog item only once', () => {
    const facts = projectFactsFromStatus(status);
    const first = itemFromIntake(
      {
        id: 'scheduled',
        idea: '继续迁移旧元法术到统一实体能力',
        createdAt: '2026-09-14T00:00:00.000Z',
      },
      facts,
    ).item;

    expect(firstUntrackedScheduledFact(facts, [first])?.text).toBe('境界成长和掉落。');
    expect(firstUntrackedScheduledFact(facts, [{ ...first, status: 'answered' }])?.text).toBe(
      '继续迁移旧元法术到统一实体能力。',
    );
    expect(firstUntrackedScheduledFact(facts, [])?.text).toBe('继续迁移旧元法术到统一实体能力。');
  });

  it('ignores unowned runs that predate the persistent secretary', () => {
    const initialized = '2026-09-20T00:00:00.000Z';
    expect(isRunEligibleForAdoption('2026-09-13T00:00:00.000Z', initialized, false)).toBe(false);
    expect(isRunEligibleForAdoption('2026-09-19T23:58:00.000Z', initialized, false)).toBe(true);
    expect(isRunEligibleForAdoption('2026-09-13T00:00:00.000Z', initialized, true)).toBe(true);
  });

  it('deduplicates completed task notifications across guard restarts', () => {
    const first: SecretaryTaskCompletion = {
      key: taskCompletionKey('E:\\repo\\.daoyan-agent\\runs\\one', 'core'),
      taskId: 'core',
      taskTitle: '实现核心契约',
      parentScope: 'feature',
      parentTitle: '完善常驻秘书',
      versionTitle: '',
      completedAt: '2026-09-14T01:00:00.000Z',
      runDirectory: 'E:\\repo\\.daoyan-agent\\runs\\one',
    };
    const duplicateFromRestart = {
      ...first,
      completedAt: '2026-09-14T02:00:00.000Z',
    };
    const next = {
      ...first,
      key: taskCompletionKey(first.runDirectory, 'experience'),
      taskId: 'experience',
      taskTitle: '完成体验闭环',
    };

    expect(unrecordedTaskCompletions([first], [duplicateFromRestart, next])).toEqual([next]);
    expect(first.key).toBe('E:/repo/.daoyan-agent/runs/one#core');
  });
});
