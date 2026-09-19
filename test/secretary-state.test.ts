import { describe, expect, it } from 'vitest';
import {
  createSecretaryState,
  decideIntake,
  intentSimilarity,
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
      scope: 'feature',
      decision: false,
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
        scope: 'feature',
        decision: false,
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
