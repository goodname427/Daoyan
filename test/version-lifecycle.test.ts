import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addVersionTodo,
  advanceVersion,
  completeVersionTodo,
  createFormalVersion,
  listFormalVersions,
  normalizeFormalVersion,
  readFormalVersion,
  readFormalVersionById,
  recordApproval,
  versionHealth,
  versionProgress,
  writeFormalVersion,
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

  it('completes archival atomically after producer acceptance', () => {
    const version = createFormalVersion({
      id: 'archive-complete',
      title: '归档一致性',
      direction: '避免归档假卡死',
      documentRoot: 'docs/versions/archive-complete',
      currentStage: 'producer-acceptance',
      now: '2026-09-20T02:00:00.000Z',
    });
    recordApproval(version, {
      stage: 'producer-acceptance',
      reviewer: 'producer',
      decision: 'approved',
      documentRevision: '1',
      comment: '通过',
      now: '2026-09-20T02:01:00.000Z',
    });

    advanceVersion(version, 'archived', '2026-09-20T02:02:00.000Z');

    expect(version.status).toBe('archived');
    expect(version.currentStage).toBe('archived');
    expect(version.nodes.find((node) => node.id === 'archived')).toEqual(
      expect.objectContaining({
        status: 'completed',
        completedAt: '2026-09-20T02:02:00.000Z',
      }),
    );
    expect(version.completedAt).toBe('2026-09-20T02:02:00.000Z');
    expect(versionProgress(version)).toBe(100);
  });

  it('repairs legacy archived versions that left the final node active', () => {
    const version = createFormalVersion({
      id: 'legacy-archive',
      title: '旧归档',
      direction: '修复历史半状态',
      documentRoot: 'docs/versions/legacy-archive',
      currentStage: 'archived',
      now: '2026-09-20T03:00:00.000Z',
    });
    const archived = version.nodes.find((node) => node.id === 'archived');
    if (!archived) throw new Error('测试版本缺少归档节点');
    archived.status = 'completed';
    archived.completedAt = '';
    version.completedAt = '';

    expect(normalizeFormalVersion(version)).toBe(true);
    expect(archived.status).toBe('completed');
    expect(archived.completedAt).not.toBe('');
    expect(version.completedAt).not.toBe('');
    expect(versionProgress(version)).toBe(100);
  });

  it('does not turn a non-archive stage into an archive from status alone', () => {
    const version = createFormalVersion({
      id: 'invalid-archive-flag',
      title: '异常归档标记',
      direction: '不绕过制作人门禁',
      documentRoot: 'docs/versions/invalid-archive-flag',
      currentStage: 'producer-acceptance',
    });
    version.status = 'archived';

    expect(normalizeFormalVersion(version)).toBe(true);
    expect(version.currentStage).toBe('producer-acceptance');
    expect(version.status).toBe('waiting-producer');
  });

  it('persists snapshots and lists current and historical versions', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-version-history-'));
    try {
      const previous = createFormalVersion({
        id: 'previous-version',
        title: '上一个版本',
        direction: '历史查看',
        documentRoot: 'docs/versions/previous-version',
        currentStage: 'archived',
        now: '2026-09-19T00:00:00.000Z',
      });
      await writeFormalVersion(temporary, previous);
      const current = createFormalVersion({
        id: 'current-version',
        title: '当前版本',
        direction: '继续开发',
        documentRoot: 'docs/versions/current-version',
        currentStage: 'development',
        now: '2026-09-20T00:00:00.000Z',
      });
      await writeFormalVersion(temporary, current, { allowVersionSwitch: true });

      const versions = await listFormalVersions(temporary);
      expect(versions.map((version) => version.id)).toEqual([
        'current-version',
        'previous-version',
      ]);
      expect((await readFormalVersionById(temporary, 'previous-version'))?.status).toBe('archived');
      expect(
        (await readFormalVersionById(temporary, 'previous-version'))?.nodes.find(
          (node) => node.id === 'archived',
        )?.completedAt,
      ).toBe('2026-09-19T00:00:00.000Z');
      await expect(writeFormalVersion(temporary, previous)).rejects.toThrow(
        '切换版本必须使用显式立项操作',
      );
      await expect(
        writeFormalVersion(temporary, previous, { allowVersionSwitch: true }),
      ).rejects.toThrow('不能覆盖历史正式版本');
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('serializes concurrent writes and keeps the newest state', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-version-concurrency-'));
    try {
      const base = createFormalVersion({
        id: 'concurrent-version',
        title: '并发写入',
        direction: '验证写入队列',
        documentRoot: 'docs/versions/concurrent-version',
        currentStage: 'development',
        now: '2026-09-20T00:00:00.000Z',
      });
      const writes = Array.from({ length: 30 }, (_, index) => {
        const snapshot = structuredClone(base);
        snapshot.updatedAt = `2026-09-20T00:00:${String(index).padStart(2, '0')}.000Z`;
        snapshot.direction = `写入 ${index}`;
        return writeFormalVersion(temporary, snapshot);
      });

      const results = await Promise.allSettled(writes);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(29);
      expect((await readFormalVersionById(temporary, 'concurrent-version'))?.direction).toBe(
        '写入 0',
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('reclaims a write lock whose owning process is gone', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-version-lock-'));
    try {
      const stateRoot = resolve(temporary, '.daoyan-agent', 'releases');
      await mkdir(stateRoot, { recursive: true });
      await writeFile(
        resolve(stateRoot, '.write.lock'),
        JSON.stringify({ pid: 2_147_000_000, processIdentity: 'dead-process' }),
        'utf8',
      );
      const version = createFormalVersion({
        id: 'lock-recovery',
        title: '锁恢复',
        direction: '回收崩溃锁',
        documentRoot: 'docs/versions/lock-recovery',
      });

      await expect(writeFormalVersion(temporary, version)).resolves.toBeUndefined();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('finishes a pending two-file version transaction before reading state', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-version-transaction-'));
    try {
      const version = createFormalVersion({
        id: 'transaction-recovery',
        title: '事务恢复',
        direction: '旧方向',
        documentRoot: 'docs/versions/transaction-recovery',
      });
      await writeFormalVersion(temporary, version);
      const snapshot = structuredClone(version);
      snapshot.stateRevision += 1;
      snapshot.direction = '已恢复的新方向';
      snapshot.updatedAt = '2026-09-20T05:00:00.000Z';
      const stateRoot = resolve(temporary, '.daoyan-agent', 'releases');
      await writeFile(
        resolve(stateRoot, '.write-transaction.json'),
        JSON.stringify({ version: snapshot }),
        'utf8',
      );
      await writeFile(
        resolve(stateRoot, 'versions', `${snapshot.id}.json`),
        JSON.stringify(snapshot),
        'utf8',
      );

      const recovered = await readFormalVersion(temporary);
      expect(recovered).toEqual(
        expect.objectContaining({
          id: snapshot.id,
          stateRevision: snapshot.stateRevision,
          direction: '已恢复的新方向',
        }),
      );
      expect((await readFormalVersionById(temporary, snapshot.id))?.direction).toBe(
        '已恢复的新方向',
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
