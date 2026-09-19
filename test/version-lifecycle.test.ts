import { describe, expect, it } from 'vitest';
import {
  addVersionTodo,
  advanceVersion,
  completeVersionTodo,
  createFormalVersion,
  recordApproval,
  versionHealth,
  versionProgress,
} from '../scripts/version-lifecycle';

describe('formal version lifecycle', () => {
  it('moves through adjacent stages and freezes scope after planning', () => {
    const version = createFormalVersion({
      id: 'v-next',
      title: '下个版本',
      direction: '完善法术深度',
      documentRoot: 'docs/versions/v-next',
      now: '2026-09-20T00:00:00.000Z',
    });

    advanceVersion(version, 'charter-draft', '2026-09-20T00:01:00.000Z');
    advanceVersion(version, 'charter-review', '2026-09-20T00:02:00.000Z');
    expect(version.status).toBe('waiting-producer');
    expect(version.todos).toEqual([
      expect.objectContaining({ stage: 'charter-review', assignee: 'producer', status: 'open' }),
    ]);
    expect(() => advanceVersion(version, 'module-design')).toThrow('尚未取得有效批准');

    recordApproval(version, {
      stage: 'charter-review',
      reviewer: 'producer',
      decision: 'approved',
      documentRevision: '1',
      comment: '通过',
      now: '2026-09-20T00:03:00.000Z',
    });
    expect(version.todos[0].status).toBe('done');
    advanceVersion(version, 'module-design', '2026-09-20T00:04:00.000Z');
    advanceVersion(version, 'design-review', '2026-09-20T00:05:00.000Z');
    recordApproval(version, {
      stage: 'design-review',
      reviewer: 'lead-designer',
      decision: 'approved',
      documentRevision: '1',
      comment: '主策审核通过',
      now: '2026-09-20T00:05:30.000Z',
    });
    advanceVersion(version, 'task-breakdown', '2026-09-20T00:06:00.000Z');
    advanceVersion(version, 'version-planning', '2026-09-20T00:07:00.000Z');
    expect(version.scopeFrozen).toBe(false);
    advanceVersion(version, 'development', '2026-09-20T00:08:00.000Z');
    expect(version.scopeFrozen).toBe(true);
    expect(versionProgress(version)).toBeGreaterThan(50);
  });

  it('rejects approvals from the wrong role, stage or revision window', () => {
    const version = createFormalVersion({
      id: 'strict-review',
      title: '严格评审',
      direction: '验证审批约束',
      documentRoot: 'docs/versions/strict-review',
      currentStage: 'charter-review',
      now: '2026-09-20T00:10:00.000Z',
    });
    expect(() =>
      recordApproval(version, {
        stage: 'charter-review',
        reviewer: 'lead-designer',
        decision: 'approved',
        documentRevision: '1',
        comment: '越权批准',
      }),
    ).toThrow('评审角色不匹配');
    expect(() =>
      recordApproval(version, {
        stage: 'design-review',
        reviewer: 'lead-designer',
        decision: 'approved',
        documentRevision: '1',
        comment: '提前批准',
      }),
    ).toThrow('只能评审当前阶段');

    expect(() =>
      recordApproval(version, {
        stage: 'charter-review',
        reviewer: 'producer',
        decision: 'approved',
        documentRevision: '0',
        comment: '旧文档版本',
      }),
    ).toThrow('评审文档版本已过期');
    expect(() =>
      recordApproval(version, {
        stage: 'charter-review',
        reviewer: 'producer',
        decision: 'approved',
        documentRevision: '1',
        comment: '早于本轮评审',
        now: '2026-09-20T00:00:00.000Z',
      }),
    ).toThrow('评审时间早于当前评审轮次');

    version.approvals.push({
      id: 'stale',
      stage: 'charter-review',
      reviewer: 'producer',
      decision: 'approved',
      documentRevision: '1',
      comment: '早于当前评审轮次',
      createdAt: '2026-09-20T00:00:00.000Z',
    });
    expect(() => advanceVersion(version, 'module-design')).toThrow('尚未取得有效批准');
  });

  it('requires the lead designer to approve the current detailed-design review', () => {
    const version = createFormalVersion({
      id: 'design-review',
      title: '详细策划评审',
      direction: '验证主策权限',
      documentRoot: 'docs/versions/design-review',
      currentStage: 'design-review',
      now: '2026-09-20T01:00:00.000Z',
    });
    expect(() =>
      recordApproval(version, {
        stage: 'design-review',
        reviewer: 'producer',
        decision: 'approved',
        documentRevision: '1',
        comment: '错误角色',
      }),
    ).toThrow('评审角色不匹配');
    expect(() => advanceVersion(version, 'task-breakdown')).toThrow('尚未取得有效批准');

    recordApproval(version, {
      stage: 'design-review',
      reviewer: 'lead-designer',
      decision: 'approved',
      documentRevision: '1',
      comment: '主策通过',
      now: '2026-09-20T01:01:00.000Z',
    });
    advanceVersion(version, 'task-breakdown', '2026-09-20T01:02:00.000Z');
    expect(version.currentStage).toBe('task-breakdown');
  });

  it('returns rejected reviews to the authoring stage', () => {
    const version = createFormalVersion({
      id: 'review',
      title: '评审版本',
      direction: '验证评审回环',
      documentRoot: 'docs/versions/review',
      currentStage: 'charter-review',
      now: '2026-09-20T00:00:00.000Z',
    });

    recordApproval(version, {
      stage: 'charter-review',
      reviewer: 'producer',
      decision: 'changes-requested',
      documentRevision: '1',
      comment: '需要收缩范围',
      now: '2026-09-20T00:05:00.000Z',
    });

    expect(version.currentStage).toBe('charter-draft');
    expect(version.charterRevision).toBe('2');
    expect(version.status).toBe('running');
    expect(version.nodes.find((node) => node.id === 'charter-draft')?.status).toBe('active');
  });

  it('tracks producer work and release health without hiding blocking bugs', () => {
    const version = createFormalVersion({
      id: 'quality',
      title: '质量版本',
      direction: '验证质量门禁',
      documentRoot: 'docs/versions/quality',
      currentStage: 'qa',
    });
    const todo = addVersionTodo(version, {
      title: '体验候选版本',
      detail: '验证主线流程',
      stage: 'producer-acceptance',
      assignee: 'producer',
    });
    expect(todo.status).toBe('open');
    completeVersionTodo(version, todo.id);
    expect(todo.status).toBe('done');

    version.bugs.push({
      id: 'bug-1',
      title: '无法开始战斗',
      severity: 'blocker',
      status: 'open',
      expected: '可以开始',
      actual: '按钮无响应',
      evidence: '',
      linkedWorkItemId: '',
    });
    expect(versionHealth(version)).toBe('at-risk');
    version.bugs[0].status = 'closed';
    expect(versionHealth(version)).toBe('healthy');
  });
});
