import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addVersionTodo,
  addDecisionGate,
  advanceVersion,
  applyVersionTodoDecision,
  completeVersionTodo,
  createMigrationBackup,
  createFormalVersion,
  currentVersionStagePolicy,
  effectiveVersionNodes,
  decisionResolutionForRequest,
  listFormalVersions,
  normalizeFormalVersion,
  downgradeFormalVersionPreservingFacts,
  invalidateValidationEvidence,
  recordValidationEvidence,
  reusableValidationEvidence,
  recordFeatureVerification,
  recordQaRun,
  recordRiskAssessment,
  recordScopeRevision,
  recordStagePolicy,
  readFormalVersion,
  readFormalVersionById,
  recordApproval,
  resolveDecisionGate,
  transitionVersionBug,
  versionHealth,
  versionProgress,
  writeFormalVersion,
  verifyMigrationBackup,
  type FormalVersion,
} from '../scripts/version-lifecycle';

describe('formal version lifecycle', () => {
  it('backs up isolated migration bytes atomically and preserves extension facts for downgrade', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'daoyan-migration-drill-'));
    const source = resolve(directory, 'source');
    const backup = resolve(directory, 'backup');
    try {
      await mkdir(source, { recursive: true });
      await writeFile(resolve(source, 'current.json'), '{"legacy":true}\n', 'utf8');
      const manifest = await createMigrationBackup(
        source,
        backup,
        ['current.json', 'missing.json'],
        '2026-09-21T00:00:00.000Z',
      );
      expect(manifest.entries).toEqual([
        expect.objectContaining({ path: 'current.json', existed: true }),
        { path: 'missing.json', existed: false, sha256: '' },
      ]);
      expect(await verifyMigrationBackup(manifest)).toBe(true);

      const version = createFormalVersion({
        id: 'downgrade',
        title: '保留增量降级',
        direction: '迁移演练',
        documentRoot: 'docs/versions/downgrade',
      });
      recordScopeRevision(version, {
        direction: '迁移后新增事实',
        sourceRequestId: 'after-migration',
        disposition: 'merged',
        reason: '验证降级不丢事实',
      });
      const projection = downgradeFormalVersionPreservingFacts(version);
      expect(projection.legacy).not.toHaveProperty('orchestration');
      expect(projection.preservedExtension.scopeRevisions.at(-1)?.direction).toBe('迁移后新增事实');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('reuses scoped evidence across unrelated changes and invalidates affected downstream facts', () => {
    const version = createFormalVersion({
      id: 'evidence-contract',
      title: '证据合同',
      direction: '验证增量证据',
      documentRoot: 'docs/versions/evidence-contract',
    });
    const task = recordValidationEvidence(version, {
      id: 'task-a',
      scope: 'task',
      ownerId: 'task-a',
      status: 'passed',
      gitTree: 'tree-a',
      codeRevision: 'rev-a',
      commandFingerprint: 'command-a',
      configFingerprint: 'config-a',
      affectedPaths: ['scripts/version-lifecycle.ts'],
      inputEvidenceIds: [],
      outputFingerprint: 'output-a',
      executionRound: 1,
      commands: [{ command: 'npm test -- lifecycle', exitCode: 0 }],
      evidence: ['task-a.log'],
    });
    recordValidationEvidence(version, {
      id: 'feature-a',
      scope: 'feature',
      ownerId: 'feature-a',
      status: 'passed',
      gitTree: 'tree-a',
      codeRevision: 'rev-a',
      commandFingerprint: 'command-feature',
      configFingerprint: 'config-a',
      affectedPaths: ['scripts/'],
      inputEvidenceIds: [task.id],
      outputFingerprint: 'output-feature',
      executionRound: 1,
      commands: [{ command: 'npm run verify:full', exitCode: 0 }],
      evidence: ['feature.log'],
    });

    expect(
      reusableValidationEvidence(version, {
        scope: 'task',
        ownerId: 'task-a',
        gitTree: 'tree-a',
        codeRevision: 'rev-a',
        commandFingerprint: 'command-a',
        configFingerprint: 'config-a',
        changedPaths: ['docs/status.md'],
      })?.id,
    ).toBe('task-a');
    expect(
      invalidateValidationEvidence(version, {
        changedPaths: ['scripts/version-lifecycle.ts'],
        now: '2026-09-21T12:00:00.000Z',
      }),
    ).toEqual(['task-a', 'feature-a']);
    expect(
      reusableValidationEvidence(version, {
        scope: 'feature',
        ownerId: 'feature-a',
        gitTree: 'tree-a',
        codeRevision: 'rev-a',
        commandFingerprint: 'command-feature',
        configFingerprint: 'config-a',
      }),
    ).toBeNull();
  });

  it('lets Version QA reuse a matching Feature full gate without rerunning it', () => {
    const version = createFormalVersion({
      id: 'version-qa-reuse',
      title: 'QA 复用',
      direction: '复用 Feature 门禁',
      documentRoot: 'docs/versions/version-qa-reuse',
    });
    const gate = recordValidationEvidence(version, {
      id: 'feature-full',
      scope: 'feature',
      ownerId: 'feature',
      status: 'passed',
      gitTree: 'tree-a',
      codeRevision: 'rev-a',
      commandFingerprint: 'full-command',
      configFingerprint: 'config-a',
      affectedPaths: ['scripts/'],
      inputEvidenceIds: [],
      outputFingerprint: 'output-a',
      executionRound: 1,
      commands: [{ command: 'npm run verify:full', exitCode: 0 }],
      evidence: ['full-gate.json'],
    });
    expect(() =>
      recordQaRun(version, {
        agentId: 'version-qa',
        independent: true,
        codeRevision: 'rev-a',
        suites: ['integration', 'regression'],
        status: 'passed',
        commands: [
          { command: 'npm run test:e2e', exitCode: 0 },
          { command: 'npm run build', exitCode: 0 },
        ],
        evidence: ['qa.json'],
        reusedFeatureEvidenceId: gate.id,
        gitTree: 'tree-a',
        commandFingerprint: 'full-command',
        configFingerprint: 'config-a',
      }),
    ).not.toThrow();
    expect(() =>
      recordQaRun(version, {
        agentId: 'version-qa-2',
        independent: true,
        codeRevision: 'rev-a',
        suites: ['regression'],
        status: 'passed',
        commands: [{ command: 'npm run verify:full', exitCode: 0 }],
        evidence: ['qa-2.json'],
        reusedFeatureEvidenceId: gate.id,
        gitTree: 'tree-a',
        commandFingerprint: 'full-command',
        configFingerprint: 'config-a',
      }),
    ).toThrow('不得重复');

    const targeted = recordValidationEvidence(version, {
      id: 'feature-targeted',
      scope: 'feature',
      ownerId: 'feature',
      status: 'passed',
      gitTree: 'tree-a',
      codeRevision: 'rev-a',
      commandFingerprint: 'targeted-command',
      configFingerprint: 'config-a',
      affectedPaths: ['scripts/'],
      inputEvidenceIds: [],
      outputFingerprint: 'output-targeted',
      executionRound: 1,
      commands: [{ command: 'npm test -- test/version-lifecycle.test.ts', exitCode: 0 }],
      evidence: ['targeted.log'],
    });
    expect(() =>
      recordQaRun(version, {
        agentId: 'version-qa-targeted',
        independent: true,
        codeRevision: 'rev-a',
        suites: ['regression'],
        status: 'passed',
        commands: [{ command: 'npm run build', exitCode: 0 }],
        evidence: ['qa-targeted.json'],
        reusedFeatureEvidenceId: targeted.id,
        gitTree: 'tree-a',
        commandFingerprint: 'targeted-command',
        configFingerprint: 'config-a',
      }),
    ).toThrow('Feature verify:full');
    expect(
      reusableValidationEvidence(version, {
        scope: 'feature',
        ownerId: 'feature',
        gitTree: 'tree-b',
        codeRevision: 'rev-a',
        commandFingerprint: 'full-command',
        configFingerprint: 'config-a',
      }),
    ).toBeNull();
  });
  it('advances every canonical stage through approval and QA gates to complete archival', () => {
    const stages = [
      'direction',
      'charter-draft',
      'charter-review',
      'module-design',
      'design-review',
      'task-breakdown',
      'version-planning',
      'development',
      'qa',
      'bugfix',
      'candidate',
      'producer-acceptance',
      'archived',
    ] as const;
    const version = createFormalVersion({
      id: 'complete-lifecycle',
      title: '完整阶段回归',
      direction: '验证阶段与节点一致且门禁不可绕过',
      documentRoot: 'docs/versions/complete-lifecycle',
    });
    expect(version.nodes.map((node) => node.id)).toEqual(stages);
    expect(version.orchestration?.stagePolicies.map((policy) => policy.stage)).toEqual(stages);
    for (const target of stages.slice(1)) {
      const stage = version.currentStage;
      if (
        stage === 'charter-review' ||
        stage === 'design-review' ||
        stage === 'producer-acceptance'
      ) {
        const before = structuredClone(version);
        expect(() => advanceVersion(version, target)).toThrow('尚未取得有效批准');
        expect(version).toEqual(before);
        recordApproval(version, {
          stage,
          reviewer: stage === 'design-review' ? 'lead-designer' : 'producer',
          decision: 'approved',
          documentRevision: version.charterRevision,
          comment: '当前修订通过',
        });
      }
      if (stage === 'qa') {
        expect(() => advanceVersion(version, target)).toThrow('独立验收');
        recordQaRun(version, {
          agentId: 'independent-qa',
          independent: true,
          codeRevision: 'lifecycle-fixture',
          suites: ['acceptance', 'integration', 'regression'],
          status: 'passed',
          commands: [{ command: 'fixture verification', exitCode: 0 }],
          evidence: ['fixture-report.json'],
        });
      }
      advanceVersion(version, target);
      expect(version.nodes.find((node) => node.id === stage)?.status).toBe('completed');
      expect(version.currentStage).toBe(target);
    }
    expect(version.nodes.every((node) => node.status === 'completed')).toBe(true);
    expect(version.status).toBe('archived');
    expect(versionProgress(version)).toBe(100);
  });

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

  it('treats a replayed producer request as the same approval', () => {
    const version = createFormalVersion({
      id: 'idempotent-review',
      title: '幂等评审版本',
      direction: '验证消息重投',
      documentRoot: 'docs/versions/idempotent-review',
      currentStage: 'producer-acceptance',
      now: '2026-09-20T00:00:00.000Z',
    });
    const input = {
      stage: 'producer-acceptance' as const,
      reviewer: 'producer' as const,
      decision: 'approved' as const,
      documentRevision: '1',
      comment: '通过',
      sourceRequestId: 'dingtalk-request-1',
      now: '2026-09-20T00:05:00.000Z',
    };

    const first = recordApproval(version, input);
    const replay = recordApproval(version, input);

    expect(replay.id).toBe(first.id);
    expect(version.approvals).toHaveLength(1);
  });

  it('keeps rejected candidate feedback in the current version repair loop', () => {
    const version = createFormalVersion({
      id: 'candidate-rejected',
      title: '候选反馈',
      direction: '修正体验问题',
      documentRoot: 'docs/versions/candidate-rejected',
      currentStage: 'producer-acceptance',
      now: '2026-09-20T00:00:00.000Z',
    });
    const input = {
      stage: 'producer-acceptance' as const,
      reviewer: 'producer' as const,
      decision: 'changes-requested' as const,
      documentRevision: '1',
      comment: '不通过，不要锁死伤害上限',
      sourceRequestId: 'producer-feedback-1',
      now: '2026-09-20T00:05:00.000Z',
    };
    recordApproval(version, input);
    recordApproval(version, input);
    expect(version.currentStage).toBe('bugfix');
    expect(version.bugs).toEqual([
      expect.objectContaining({
        origin: 'producer-acceptance',
        status: 'open',
        actual: input.comment,
        evidence: '制作人消息 producer-feedback-1',
      }),
    ]);
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

  it.each(['future', 'null'] as const)(
    'preserves every file when a pending transaction has a %s orchestration extension',
    async (mode) => {
      const temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-version-invalid-transaction-'));
      try {
        const version = createFormalVersion({
          id: 'invalid-transaction',
          title: '无效事务',
          direction: '拒绝未来扩展',
          documentRoot: 'docs/versions/invalid-transaction',
        });
        await writeFormalVersion(temporary, version);
        const stateRoot = resolve(temporary, '.daoyan-agent', 'releases');
        const currentPath = resolve(stateRoot, 'current.json');
        const historyPath = resolve(stateRoot, 'versions', `${version.id}.json`);
        const transactionPath = resolve(stateRoot, '.write-transaction.json');
        const beforeCurrent = await readFile(currentPath, 'utf8');
        const beforeHistory = await readFile(historyPath, 'utf8');
        const snapshot = structuredClone(version);
        if (!snapshot.orchestration) throw new Error('测试版本缺少编排扩展');
        if (mode === 'future') {
          (snapshot.orchestration as { schemaVersion: number }).schemaVersion = 2;
        } else {
          (snapshot as unknown as { orchestration: unknown }).orchestration = null;
        }
        const transaction = `${JSON.stringify({ version: snapshot }, null, 2)}\n`;
        await writeFile(transactionPath, transaction, 'utf8');

        await expect(readFormalVersion(temporary)).rejects.toThrow('停止自动写入和派发');
        expect(await readFile(currentPath, 'utf8')).toBe(beforeCurrent);
        expect(await readFile(historyPath, 'utf8')).toBe(beforeHistory);
        expect(await readFile(transactionPath, 'utf8')).toBe(transaction);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );

  it('persists risk, scope and stage strategy while refusing to skip fixed gates', () => {
    const version = createFormalVersion({
      id: 'adaptive-policy',
      title: '自适应策略',
      direction: '建立编排内核',
      documentRoot: 'docs/versions/adaptive-policy',
      now: '2026-09-21T00:00:00.000Z',
    });
    const scope = recordScopeRevision(version, {
      direction: '补齐兼容迁移',
      sourceRequestId: 'request-2',
      disposition: 'merged',
      reason: '属于已批准方向',
      now: '2026-09-21T00:01:00.000Z',
    });
    recordRiskAssessment(version, {
      level: 'critical',
      impact: ['persistent-state'],
      stateTransitions: true,
      crossProcessConcurrency: true,
      externalDependencies: [],
      rollback: '停写后恢复备份',
      evaluatedBy: 'version-pm',
      basis: '涉及迁移和恢复',
      now: '2026-09-21T00:02:00.000Z',
    });
    recordStagePolicy(version, {
      stage: 'module-design',
      mode: 'reduced',
      reason: '复用已确认规格',
      evidence: ['docs/spec.md'],
      decidedBy: 'version-pm',
      scopeRevision: scope.revision,
      now: '2026-09-21T00:03:00.000Z',
    });

    expect(version.orchestration?.riskAssessments.at(-1)?.level).toBe('critical');
    expect(version.orchestration?.stagePolicies.at(-1)).toEqual(
      expect.objectContaining({ mode: 'reduced', scopeRevision: 2 }),
    );
    expect(() =>
      recordStagePolicy(version, {
        stage: 'producer-acceptance',
        mode: 'skip',
        reason: '错误地尝试跳过',
        evidence: [],
        decidedBy: 'pm',
        scopeRevision: scope.revision,
      }),
    ).toThrow('固定门禁');
  });

  it('marks unnecessary stages explicitly and removes them from the progress denominator', () => {
    const version = createFormalVersion({
      id: 'adaptive-progress',
      title: '自适应进度',
      direction: '验证无需执行节点',
      documentRoot: 'docs/versions/adaptive-progress',
      currentStage: 'module-design',
    });
    recordStagePolicy(version, {
      stage: 'module-design',
      mode: 'skip',
      reason: '当前版本复用已批准规格，无需重复详细策划。',
      evidence: ['docs/specs/existing.md'],
      decidedBy: 'version-pm',
      scopeRevision: 1,
    });

    expect(effectiveVersionNodes(version).find((node) => node.id === 'module-design')).toEqual(
      expect.objectContaining({
        status: 'skipped',
        summary: '当前版本复用已批准规格，无需重复详细策划。',
      }),
    );
    expect(versionProgress(version)).toBe(Math.round((3 / 12) * 100));
    advanceVersion(version, 'design-review');
    expect(version.nodes.find((node) => node.id === 'module-design')?.status).toBe('skipped');
    expect(versionProgress(version)).toBe(Math.round((3 / 12) * 100));
  });

  it('allows optional planning and quality stages to be omitted without fabricating evidence', () => {
    const design = createFormalVersion({
      id: 'skip-design-review',
      title: '精简策划',
      direction: '小范围版本',
      documentRoot: 'docs/versions/skip-design-review',
      currentStage: 'design-review',
    });
    recordStagePolicy(design, {
      stage: 'design-review',
      mode: 'skip',
      reason: '没有独立模块策划，无需主策重复审核。',
      evidence: [],
      decidedBy: 'version-pm',
      scopeRevision: 1,
    });
    expect(() => advanceVersion(design, 'task-breakdown')).not.toThrow();

    const qa = createFormalVersion({
      id: 'skip-qa',
      title: '无运行时变更',
      direction: '仅整理文档',
      documentRoot: 'docs/versions/skip-qa',
      currentStage: 'qa',
    });
    recordStagePolicy(qa, {
      stage: 'qa',
      mode: 'skip',
      reason: '没有运行时代码变更。',
      evidence: ['docs-only'],
      decidedBy: 'version-pm',
      scopeRevision: 1,
    });
    expect(() => advanceVersion(qa, 'bugfix')).not.toThrow();
  });

  it('closes an omitted task breakdown over development and rejects hidden work', () => {
    const version = createFormalVersion({
      id: 'skip-task-breakdown',
      title: '无需开发',
      direction: '复用现有交付，不产生开发工作项',
      documentRoot: 'docs/versions/skip-task-breakdown',
      currentStage: 'task-breakdown',
    });
    recordStagePolicy(version, {
      stage: 'task-breakdown',
      mode: 'skip',
      reason: '本版本没有需要拆分的开发内容。',
      evidence: ['docs/specs/existing.md'],
      decidedBy: 'version-pm',
      scopeRevision: 1,
    });

    expect(currentVersionStagePolicy(version, 'development')).toEqual(
      expect.objectContaining({ mode: 'skip', decidedBy: 'version-kernel' }),
    );

    const invalid = createFormalVersion({
      id: 'hidden-work',
      title: '隐藏工作',
      direction: '不能绕过真实工作项',
      documentRoot: 'docs/versions/hidden-work',
      currentStage: 'task-breakdown',
    });
    invalid.workItems.push({
      id: 'feature',
      title: '真实工作项',
      owner: 'Feature PM',
      status: 'pending',
      dependsOn: [],
      summary: '需要开发。',
      evidence: 'task-breakdown.json',
    });
    expect(() =>
      recordStagePolicy(invalid, {
        stage: 'task-breakdown',
        mode: 'skip',
        reason: '错误跳过。',
        evidence: [],
        decidedBy: 'version-pm',
        scopeRevision: 1,
      }),
    ).toThrow('仍有实际工作项');
  });

  it('refuses to skip development while any real work item remains', () => {
    const version = createFormalVersion({
      id: 'skip-development',
      title: '开发不可绕过',
      direction: '验证开发跳过门禁',
      documentRoot: 'docs/versions/skip-development',
      currentStage: 'development',
    });
    version.workItems.push({
      id: 'feature',
      title: '真实工作项',
      owner: 'Feature PM',
      status: 'pending',
      dependsOn: [],
      summary: '需要实现。',
      evidence: 'task-breakdown.json',
    });
    recordStagePolicy(version, {
      stage: 'development',
      mode: 'skip',
      reason: '错误跳过。',
      evidence: [],
      decidedBy: 'version-pm',
      scopeRevision: 1,
    });

    expect(() => advanceVersion(version, 'qa')).toThrow('存在实际工作项');
    version.workItems[0].status = 'skipped';
    expect(() => advanceVersion(version, 'qa')).not.toThrow();
  });

  it('lets completed QA with structured defects enter bug fixing without calling it a pass', () => {
    const version = createFormalVersion({
      id: 'qa-with-defects',
      title: 'QA 缺陷闭环',
      direction: '验证失败测试进入修复',
      documentRoot: 'docs/versions/qa-with-defects',
      currentStage: 'qa',
    });
    version.bugs.push({
      id: 'bug-1',
      title: '验收失败',
      severity: 'high',
      status: 'open',
      expected: '通过',
      actual: '失败',
      evidence: 'qa.json',
      linkedWorkItemId: '',
    });
    recordQaRun(version, {
      agentId: 'independent-qa',
      independent: true,
      codeRevision: 'candidate-a',
      suites: ['acceptance', 'integration', 'regression'],
      status: 'failed',
      commands: [{ command: 'npm test', exitCode: 1 }],
      evidence: ['qa.json'],
    });

    expect(() => advanceVersion(version, 'bugfix')).not.toThrow();

    const missingBug = createFormalVersion({
      id: 'qa-failed-without-defect',
      title: '无缺陷失败',
      direction: '拒绝无结构失败',
      documentRoot: 'docs/versions/qa-failed-without-defect',
      currentStage: 'qa',
    });
    recordQaRun(missingBug, {
      agentId: 'independent-qa',
      independent: true,
      codeRevision: 'candidate-a',
      suites: ['acceptance', 'integration', 'regression'],
      status: 'failed',
      commands: [{ command: 'npm test', exitCode: 1 }],
      evidence: ['qa.json'],
    });
    expect(() => advanceVersion(missingBug, 'bugfix')).toThrow('独立验收');
  });

  it.each(['irreversible-decision', 'producer-escalated-design'] as const)(
    'blocks rejected %s until explicit approval',
    (kind) => {
      const version = createFormalVersion({
        id: 'decision-gate',
        title: '决策门禁',
        direction: '验证门禁',
        documentRoot: 'docs/versions/decision-gate',
      });
      const gate = addDecisionGate(version, {
        kind,
        stage: 'direction',
        summary: '确认不可逆语义',
        sourceRequestId: 'decision-1',
      });
      expect(() => advanceVersion(version, 'charter-draft')).toThrow('制作人决策门禁');
      resolveDecisionGate(version, gate.id, 'rejected');
      expect(version.status).toBe('paused');
      const rejected = structuredClone(version);
      normalizeFormalVersion(rejected);
      expect(() => advanceVersion(rejected, 'charter-draft')).toThrow('制作人决策门禁');
      expect(() => advanceVersion(version, 'charter-draft')).toThrow('制作人决策门禁');
      expect(version).toEqual(rejected);
      const unrelated = addDecisionGate(version, {
        kind: 'scope-change',
        stage: 'direction',
        summary: '其他范围决定',
        sourceRequestId: 'other',
      });
      resolveDecisionGate(version, unrelated.id, 'approved');
      expect(version.status).toBe('paused');
      expect(() => advanceVersion(version, 'charter-draft')).toThrow('制作人决策门禁');
      const reapproval = version.todos.find(
        (todo) => todo.decisionGateId === gate.id && todo.status === 'open',
      );
      expect(reapproval?.title).toContain('重新');
      applyVersionTodoDecision(version, reapproval!.id, 'approve');
      expect(() => advanceVersion(version, 'charter-draft')).not.toThrow();
    },
  );

  it('persists producer decision request ids and replays them idempotently', () => {
    const version = createFormalVersion({
      id: 'decision-replay',
      title: '决策回复重放',
      direction: '验证决策回复幂等',
      documentRoot: 'docs/versions/decision-replay',
    });
    const gate = addDecisionGate(version, {
      kind: 'irreversible-decision',
      stage: 'direction',
      summary: '确认状态迁移',
      sourceRequestId: 'direction-request',
    });
    resolveDecisionGate(version, gate.id, 'rejected', '2026-09-21T01:00:00.000Z', 'producer-reply');
    const snapshot = structuredClone(version);
    resolveDecisionGate(version, gate.id, 'rejected', '2026-09-21T01:00:00.000Z', 'producer-reply');
    expect(version).toEqual(snapshot);
    expect(decisionResolutionForRequest(version, 'producer-reply')).toEqual(
      expect.objectContaining({
        gate: expect.objectContaining({ id: gate.id }),
        decision: 'rejected',
      }),
    );
    expect(() =>
      resolveDecisionGate(version, gate.id, 'approved', undefined, 'producer-reply'),
    ).toThrow('不能改写');
  });

  it('keeps Feature checks separate from independent QA and defect reverification', () => {
    const version = createFormalVersion({
      id: 'qa-loop',
      title: '测试闭环',
      direction: '验证独立测试',
      documentRoot: 'docs/versions/qa-loop',
      currentStage: 'qa',
    });
    version.workItems.push({
      id: 'kernel',
      title: '编排内核',
      owner: 'feature-agent',
      status: 'completed',
      dependsOn: [],
      summary: '实现完成',
      evidence: 'feature-report.json',
    });
    recordFeatureVerification(version, {
      workItemId: 'kernel',
      agentId: 'feature-agent',
      codeRevision: 'abc123',
      typecheck: 'passed',
      targetedTests: 'passed',
      evidence: ['targeted.log'],
    });
    expect(() => advanceVersion(version, 'bugfix')).toThrow('独立验收');
    expect(() =>
      recordQaRun(version, {
        agentId: 'feature-agent',
        independent: false,
        codeRevision: 'abc123',
        suites: ['acceptance', 'integration', 'regression'],
        status: 'passed',
        commands: [],
        evidence: [],
      }),
    ).toThrow('独立测试 Agent');
    expect(() =>
      recordQaRun(version, {
        agentId: 'feature-agent',
        independent: true,
        codeRevision: 'def456',
        suites: ['acceptance', 'integration', 'regression'],
        status: 'passed',
        commands: [{ command: 'npm run verify', exitCode: 0 }],
        evidence: ['qa-report.json'],
      }),
    ).toThrow('身份必须独立');
    expect(() =>
      recordQaRun(version, {
        agentId: 'qa-agent',
        independent: true,
        codeRevision: 'abc123',
        suites: ['acceptance', 'integration', 'regression'],
        status: 'passed',
        commands: [{ command: 'npm run verify', exitCode: 1 }],
        evidence: ['qa-report.json'],
      }),
    ).toThrow('退出码为 0');
    recordQaRun(version, {
      agentId: 'qa-agent',
      independent: true,
      codeRevision: 'abc123',
      suites: ['acceptance', 'integration', 'regression'],
      status: 'passed',
      commands: [{ command: 'npm run verify', exitCode: 0 }],
      evidence: ['qa-report.json'],
    });
    advanceVersion(version, 'bugfix');
    version.bugs.push({
      id: 'bug-1',
      title: '恢复重复派发',
      severity: 'high',
      status: 'verify',
      expected: '只派发一次',
      actual: '重复派发',
      evidence: 'bug.log',
      linkedWorkItemId: 'kernel',
    });
    expect(() => advanceVersion(version, 'candidate')).toThrow('尚未通过复验');
    transitionVersionBug(version, 'bug-1', 'fixing');
    transitionVersionBug(version, 'bug-1', 'verify', '', 'def456');
    const verification = recordQaRun(version, {
      agentId: 'qa-agent',
      independent: true,
      codeRevision: 'def456',
      suites: ['defect-reverification', 'regression'],
      status: 'passed',
      commands: [{ command: 'npm test -- recovery', exitCode: 0 }],
      evidence: ['reverify.json'],
      bugFixes: [{ bugId: 'bug-1', fixAttemptId: version.bugs[0].fixAttemptId! }],
    });
    transitionVersionBug(version, 'bug-1', 'closed', verification.id);
    expect(() => advanceVersion(version, 'candidate')).not.toThrow();
  });

  it('accepts a failed task-scoped test only when current Feature full-gate evidence covers it', () => {
    const version = createFormalVersion({
      id: 'feature-covered-task',
      title: '完整门禁覆盖',
      direction: '验证最终代码树',
      documentRoot: 'docs/versions/feature-covered-task',
      currentStage: 'development',
    });
    version.workItems.push({
      id: 'kernel',
      title: '核心实现',
      owner: 'feature-agent',
      status: 'completed',
      dependsOn: [],
      summary: '',
      evidence: 'development.json',
    });
    recordFeatureVerification(version, {
      workItemId: 'kernel',
      agentId: 'feature-agent',
      codeRevision: 'rev-a',
      typecheck: 'passed',
      targetedTests: 'covered-by-feature-gate',
      evidence: ['task-test-failed.log', 'full-gate-evidence.json'],
    });
    expect(() => advanceVersion(version, 'qa')).toThrow('类型检查与定向测试');
    recordValidationEvidence(version, {
      scope: 'feature',
      ownerId: 'feature-run',
      status: 'passed',
      gitTree: 'tree-a',
      codeRevision: 'rev-a',
      commandFingerprint: 'command-a',
      configFingerprint: 'config-a',
      affectedPaths: ['src/core/world.ts'],
      inputEvidenceIds: [],
      outputFingerprint: 'output-a',
      executionRound: 1,
      commands: [{ command: 'npm run verify:full', exitCode: 0 }],
      evidence: ['full-gate-evidence.json'],
    });
    expect(() => advanceVersion(version, 'qa')).not.toThrow();
  });

  it('accepts a documentation task without Task typecheck only with matching Feature gate evidence', () => {
    const version = createFormalVersion({
      id: 'documented-feature',
      title: '架构合同',
      direction: '更新合同',
      documentRoot: 'docs/versions/documented-feature',
      currentStage: 'development',
    });
    version.workItems.push({
      id: 'adr',
      title: 'ADR',
      owner: 'architecture-agent',
      status: 'completed',
      dependsOn: [],
      summary: '记录决策',
      evidence: 'development.json',
    });
    recordFeatureVerification(version, {
      workItemId: 'adr',
      agentId: 'architecture-agent',
      codeRevision: 'rev-a',
      typecheck: 'covered-by-feature-gate',
      targetedTests: 'passed',
      evidence: ['docs-check.log'],
    });
    expect(() => advanceVersion(version, 'qa')).toThrow('类型检查与定向测试');
    recordValidationEvidence(version, {
      scope: 'feature',
      ownerId: 'feature-run',
      status: 'passed',
      gitTree: 'tree-a',
      codeRevision: 'rev-a',
      commandFingerprint: 'command-a',
      configFingerprint: 'config-a',
      affectedPaths: ['docs/adr/0018.md'],
      inputEvidenceIds: [],
      outputFingerprint: 'output-a',
      executionRound: 1,
      commands: [{ command: 'npm run verify:full', exitCode: 0 }],
      evidence: ['full-gate-evidence.json'],
    });
    expect(() => advanceVersion(version, 'qa')).not.toThrow();
  });

  it.each(['execute', 'reduced', 'skip'] as const)(
    'blocks failed regression before candidate even with %s bugfix policy and no open bugs',
    (mode) => {
      const version = createFormalVersion({
        id: 'candidate-qa',
        title: '候选回归门禁',
        direction: '修复后必须重新核对独立 QA',
        documentRoot: 'docs/versions/candidate-qa',
        currentStage: 'qa',
      });
      const initialQa = recordQaRun(version, {
        agentId: 'qa-agent',
        independent: true,
        codeRevision: 'before-fix',
        suites: ['acceptance', 'integration', 'regression'],
        status: 'passed',
        commands: [{ command: 'npm run verify', exitCode: 0 }],
        evidence: ['initial-qa.json'],
      });
      advanceVersion(version, 'bugfix');
      recordStagePolicy(version, {
        stage: 'bugfix',
        mode,
        scopeRevision: 1,
        reason: '按风险执行修复',
        decidedBy: 'version-pm',
        evidence: [],
      });
      const failed = recordQaRun(version, {
        agentId: 'qa-agent',
        independent: true,
        codeRevision: 'after-fix',
        suites: ['regression'],
        status: 'failed',
        commands: [{ command: 'npm test', exitCode: 1 }],
        evidence: ['failed-regression.json'],
      });
      expect(version.bugs).toEqual([]);
      expect(initialQa.status).toBe('passed');
      const before = structuredClone(version);
      expect(() => advanceVersion(version, 'candidate')).toThrow('有效独立 QA');
      expect(version).toEqual(before);
      recordQaRun(version, {
        agentId: 'qa-agent',
        independent: true,
        codeRevision: failed.codeRevision,
        suites: ['regression'],
        status: 'passed',
        commands: [{ command: 'npm test', exitCode: 0 }],
        evidence: ['passed-regression.json'],
      });
      expect(() => advanceVersion(version, 'candidate')).not.toThrow();
    },
  );

  it.each(['execute', 'reduced', 'skip'] as const)(
    'requires fresh regression for the repaired code with %s policy',
    (mode) => {
      let version = createFormalVersion({
        id: 'changed-code',
        title: '代码修订门禁',
        direction: '修复后回归',
        documentRoot: 'docs/versions/changed-code',
        currentStage: 'qa',
      });
      const qa = {
        agentId: 'tester',
        independent: true,
        codeRevision: 'A',
        suites: ['acceptance', 'integration', 'regression'] as const,
        status: 'passed' as const,
        commands: [{ command: 'npm test', exitCode: 0 }],
        evidence: ['qa.json'],
      };
      recordQaRun(version, { ...qa, suites: [...qa.suites] });
      advanceVersion(version, 'bugfix');
      recordStagePolicy(version, {
        stage: 'bugfix',
        mode,
        scopeRevision: 1,
        reason: '风险策略',
        decidedBy: 'pm',
        evidence: [],
      });
      version.bugs.push({
        id: 'medium',
        title: '一般缺陷',
        severity: 'medium',
        status: 'open',
        expected: '正常',
        actual: '错误',
        evidence: 'bug.json',
        linkedWorkItemId: '',
      });
      transitionVersionBug(version, 'medium', 'fixing');
      transitionVersionBug(version, 'medium', 'verify', '', 'B');
      // The invalidation boundary survives persistence and old QA stays readable.
      version = JSON.parse(JSON.stringify(version)) as FormalVersion;
      normalizeFormalVersion(version);
      expect(version.orchestration!.qaRuns[0].status).toBe('passed');
      expect(() => advanceVersion(version, 'candidate')).toThrow('有效独立 QA');
      recordQaRun(version, { ...qa, suites: [...qa.suites] });
      expect(() => advanceVersion(version, 'candidate')).toThrow('有效独立 QA');
      const fresh = recordQaRun(version, {
        ...qa,
        codeRevision: 'B',
        suites: ['regression', 'defect-reverification'],
        bugFixes: [{ bugId: 'medium', fixAttemptId: version.bugs[0].fixAttemptId! }],
      });
      transitionVersionBug(version, 'medium', 'closed', fresh.id);
      expect(() => advanceVersion(version, 'candidate')).not.toThrow();
    },
  );

  it('invalidates old regression even when a repair reuses its code revision label', () => {
    const version = createFormalVersion({
      id: 'same-code',
      title: '同修订修复',
      direction: '重新验证',
      documentRoot: 'docs/versions/same-code',
      currentStage: 'bugfix',
    });
    recordQaRun(version, {
      agentId: 'tester',
      independent: true,
      codeRevision: 'A',
      suites: ['regression'],
      status: 'passed',
      commands: [{ command: 'npm test', exitCode: 0 }],
      evidence: ['qa.json'],
    });
    version.bugs.push({
      id: 'medium',
      title: '缺陷',
      severity: 'medium',
      status: 'fixing',
      expected: '',
      actual: '',
      evidence: '',
      linkedWorkItemId: '',
    });
    transitionVersionBug(version, 'medium', 'verify', '', 'A');
    expect(() => advanceVersion(version, 'candidate')).toThrow('有效独立 QA');
  });

  it('keeps legacy fixes readable without trusting a different QA revision', () => {
    const version = createFormalVersion({
      id: 'legacy-fix',
      title: '旧修复证据',
      direction: '保守迁移',
      documentRoot: 'docs/versions/legacy-fix',
      currentStage: 'bugfix',
    });
    recordQaRun(version, {
      agentId: 'tester',
      independent: true,
      codeRevision: 'A',
      suites: ['regression'],
      status: 'passed',
      commands: [{ command: 'npm test', exitCode: 0 }],
      evidence: ['qa.json'],
    });
    version.bugs.push({
      id: 'medium',
      title: '旧修复',
      severity: 'medium',
      status: 'verify',
      expected: '',
      actual: '',
      evidence: '',
      linkedWorkItemId: '',
      fixAttemptId: 'old-fix',
      fixCodeRevision: 'B',
    });
    normalizeFormalVersion(version);
    expect(version.orchestration!.codeRevision).toBeUndefined();
    expect(() => advanceVersion(version, 'candidate')).toThrow('有效独立 QA');
  });

  it('does not trust newer legacy QA evidence for a different feature revision', () => {
    const version = createFormalVersion({
      id: 'legacy-feature-revision',
      title: '旧 Feature 修订证据',
      direction: '保守迁移',
      documentRoot: 'docs/versions/legacy-feature-revision',
      currentStage: 'qa',
    });
    version.workItems.push({
      id: 'legacy-feature',
      title: '旧 Feature',
      owner: 'feature-agent',
      status: 'completed',
      dependsOn: [],
      summary: '完成修订 B',
      evidence: 'feature.json',
    });
    recordFeatureVerification(version, {
      workItemId: 'legacy-feature',
      agentId: 'feature-agent',
      codeRevision: 'B',
      typecheck: 'passed',
      targetedTests: 'passed',
      evidence: ['feature-verification.json'],
    });
    recordQaRun(version, {
      agentId: 'tester',
      independent: true,
      codeRevision: 'A',
      suites: ['acceptance', 'integration', 'regression'],
      status: 'passed',
      commands: [{ command: 'npm test', exitCode: 0 }],
      evidence: ['qa.json'],
    });
    delete version.orchestration!.codeRevision;
    expect(() => advanceVersion(version, 'bugfix')).toThrow('独立验收');
  });

  it.each([{ codeRevision: null }, { qaInvalidatedThrough: -1 }, { qaInvalidatedThrough: 1 }])(
    'rejects a corrupt candidate code baseline %j',
    (fields) => {
      const version = createFormalVersion({
        id: 'invalid-baseline',
        title: '校验',
        direction: '校验',
        documentRoot: 'docs/versions/invalid-baseline',
      });
      Object.assign(version.orchestration!, fields);
      expect(() => normalizeFormalVersion(version)).toThrow('代码修订或 QA 失效边界损坏');
    },
  );

  it('keeps legacy QA records readable but does not trust incomplete pass evidence', () => {
    const version = createFormalVersion({
      id: 'legacy-qa-evidence',
      title: '旧 QA 证据',
      direction: '兼容旧测试记录',
      documentRoot: 'docs/versions/legacy-qa-evidence',
      currentStage: 'qa',
    });
    const qa = recordQaRun(version, {
      agentId: 'qa-agent',
      independent: true,
      codeRevision: 'abc123',
      suites: ['acceptance', 'integration', 'regression'],
      status: 'passed',
      commands: [{ command: 'npm run verify', exitCode: 0 }],
      evidence: ['qa-report.json'],
    });
    qa.commands = [];
    qa.evidence = [];

    expect(() => normalizeFormalVersion(version)).not.toThrow();
    expect(() => advanceVersion(version, 'bugfix')).toThrow('独立验收');
  });

  it('does not leave development with unfinished or unverified Feature work', () => {
    const version = createFormalVersion({
      id: 'feature-gate',
      title: 'Feature 自测门禁',
      direction: '验证开发证据',
      documentRoot: 'docs/versions/feature-gate',
      currentStage: 'development',
    });
    version.workItems.push({
      id: 'kernel',
      title: '编排内核',
      owner: 'feature-agent',
      status: 'active',
      dependsOn: [],
      summary: '',
      evidence: '',
    });

    expect(() => advanceVersion(version, 'qa')).toThrow('Feature 尚未完成');
    version.workItems[0].status = 'completed';
    expect(() => advanceVersion(version, 'qa')).toThrow('类型检查与定向测试');
    expect(() =>
      recordFeatureVerification(version, {
        workItemId: 'kernel',
        agentId: 'feature-agent',
        codeRevision: '',
        typecheck: 'passed',
        targetedTests: 'passed',
        evidence: [],
      }),
    ).toThrow('代码修订和公开证据');
    version.orchestration?.featureVerifications.push({
      id: 'legacy-feature-check',
      workItemId: 'kernel',
      agentId: '',
      codeRevision: '',
      scopeRevision: 1,
      typecheck: 'passed',
      targetedTests: 'passed',
      evidence: [],
      createdAt: '2026-09-21T00:00:00.000Z',
    });
    expect(() => normalizeFormalVersion(version)).not.toThrow();
    expect(() => advanceVersion(version, 'qa')).toThrow('类型检查与定向测试');
    recordFeatureVerification(version, {
      workItemId: 'kernel',
      agentId: 'feature-agent',
      codeRevision: 'abc123',
      typecheck: 'passed',
      targetedTests: 'passed',
      evidence: ['feature-checks.json'],
    });
    recordFeatureVerification(version, {
      workItemId: 'kernel',
      agentId: 'feature-agent',
      codeRevision: 'def456',
      typecheck: 'failed',
      targetedTests: 'passed',
      evidence: ['failed-feature-checks.json'],
    });
    expect(() => advanceVersion(version, 'qa')).toThrow('类型检查与定向测试');
    recordFeatureVerification(version, {
      workItemId: 'kernel',
      agentId: 'feature-agent',
      codeRevision: 'def456',
      typecheck: 'passed',
      targetedTests: 'passed',
      evidence: ['feature-checks-after-fix.json'],
    });
    expect(() => advanceVersion(version, 'qa')).not.toThrow();
  });

  it('does not close a defect with QA evidence from an obsolete scope revision', () => {
    const version = createFormalVersion({
      id: 'stale-defect-verification',
      title: '失效复验',
      direction: '验证范围修订隔离',
      documentRoot: 'docs/versions/stale-defect-verification',
      currentStage: 'bugfix',
    });
    version.bugs.push({
      id: 'bug-1',
      title: '重复派发',
      severity: 'high',
      status: 'verify',
      expected: '单次派发',
      actual: '重复派发',
      evidence: 'bug.json',
      linkedWorkItemId: 'kernel',
    });
    transitionVersionBug(version, 'bug-1', 'fixing');
    transitionVersionBug(version, 'bug-1', 'verify', '', 'abc123');
    const stale = recordQaRun(version, {
      agentId: 'qa-agent',
      independent: true,
      codeRevision: 'abc123',
      suites: ['defect-reverification', 'regression'],
      status: 'passed',
      commands: [{ command: 'npm test -- recovery', exitCode: 0 }],
      evidence: ['reverify.json'],
      bugFixes: [{ bugId: 'bug-1', fixAttemptId: version.bugs[0].fixAttemptId! }],
    });
    recordScopeRevision(version, {
      direction: '补充迁移边界',
      sourceRequestId: 'scope-2',
      disposition: 'merged',
      reason: '范围变化使旧测试结论失效',
    });

    expect(() => transitionVersionBug(version, 'bug-1', 'closed', stale.id)).toThrow('成功复验');
  });

  it('binds defect evidence to the current fix attempt and code revision across reopen and reload', () => {
    const version = createFormalVersion({
      id: 'reopened-bug',
      title: '重新打开的缺陷',
      direction: '验证修复轮次',
      documentRoot: 'docs/versions/reopened-bug',
      currentStage: 'bugfix',
    });
    version.bugs.push({
      id: 'bug',
      title: '缺陷',
      severity: 'high',
      status: 'open',
      expected: '',
      actual: '',
      evidence: '',
      linkedWorkItemId: 'feature',
    });
    const bug = version.bugs[0];
    const qaInput = {
      agentId: 'qa',
      independent: true,
      codeRevision: 'fix-a',
      suites: ['defect-reverification'] as const,
      status: 'passed' as const,
      commands: [{ command: 'npm test -- defect', exitCode: 0 }],
      evidence: ['defect-report.json'],
    };
    transitionVersionBug(version, bug.id, 'fixing');
    expect(() => transitionVersionBug(version, bug.id, 'verify')).toThrow('代码修订');
    transitionVersionBug(version, bug.id, 'verify', '', 'fix-a');
    const firstAttempt = bug.fixAttemptId!;
    const first = recordQaRun(version, {
      ...qaInput,
      suites: [...qaInput.suites],
      bugFixes: [{ bugId: bug.id, fixAttemptId: firstAttempt }],
    });
    transitionVersionBug(version, bug.id, 'closed', first.id);
    transitionVersionBug(version, bug.id, 'open');
    transitionVersionBug(version, bug.id, 'fixing');
    transitionVersionBug(version, bug.id, 'verify', '', 'fix-a');
    expect(bug.fixAttemptId).not.toBe(firstAttempt);
    const reloaded = JSON.parse(JSON.stringify(version));
    normalizeFormalVersion(reloaded);
    expect(() => transitionVersionBug(reloaded, bug.id, 'closed', first.id)).toThrow('成功复验');
    expect(reloaded.bugs[0].status).toBe('verify');
    expect(() =>
      recordQaRun(version, {
        ...qaInput,
        suites: [...qaInput.suites],
        bugFixes: first.bugFixes,
      }),
    ).toThrow('当前修复轮次');
    transitionVersionBug(version, bug.id, 'fixing');
    transitionVersionBug(version, bug.id, 'verify', '', 'fix-b');
    expect(() =>
      recordQaRun(version, {
        ...qaInput,
        suites: [...qaInput.suites],
        bugFixes: [{ bugId: bug.id, fixAttemptId: bug.fixAttemptId! }],
      }),
    ).toThrow('代码修订');
    const unbound = recordQaRun(version, {
      ...qaInput,
      codeRevision: 'fix-b',
      suites: [...qaInput.suites],
    });
    expect(() => transitionVersionBug(version, bug.id, 'closed', unbound.id)).toThrow('成功复验');
    const current = recordQaRun(version, {
      ...qaInput,
      codeRevision: 'fix-b',
      suites: [...qaInput.suites],
      bugFixes: [{ bugId: bug.id, fixAttemptId: bug.fixAttemptId! }],
    });
    // A persisted report for an old code snapshot cannot close even with the current attempt ID.
    current.codeRevision = 'fix-a';
    expect(() => transitionVersionBug(version, bug.id, 'closed', current.id)).toThrow('成功复验');
    current.codeRevision = 'fix-b';
    transitionVersionBug(version, bug.id, 'closed', current.id);
    expect(bug.verificationRunId).toBe(current.id);
  });

  it('migrates decision todo links idempotently without consuming stage review todos', () => {
    const version = createFormalVersion({
      id: 'legacy-decision-todo',
      title: '待办迁移',
      direction: '关联门禁',
      documentRoot: 'docs/versions/legacy-decision-todo',
      currentStage: 'charter-review',
    });
    const gate = addDecisionGate(version, {
      kind: 'irreversible-decision',
      stage: 'charter-review',
      summary: '架构选择',
      sourceRequestId: 'gate',
    });
    const todo = version.todos.find((entry) => entry.decisionGateId === gate.id)!;
    delete todo.decisionGateId;
    expect(normalizeFormalVersion(version)).toBe(true);
    expect(todo.decisionGateId).toBe(gate.id);
    expect(normalizeFormalVersion(version)).toBe(false);
    resolveDecisionGate(version, gate.id, 'approved');
    expect(todo.status).toBe('done');
    expect(version.todos[0].status).toBe('open');
    expect(version.status).toBe('waiting-producer');
    expect(version.approvals).toHaveLength(0);
    expect(() => advanceVersion(version, 'module-design')).toThrow('有效批准');
  });

  it.each(['module-design', 'charter-review'] as const)(
    'handles dashboard decision actions separately at %s',
    (stage) => {
      for (const action of ['approve', 'request-changes']) {
        for (const kind of ['scope-change', 'irreversible-decision'] as const) {
          const version = createFormalVersion({
            id: 'dashboard-action',
            title: '看板操作',
            direction: '门禁隔离',
            documentRoot: 'docs/versions/dashboard-action',
            currentStage: stage,
          });
          const gate = addDecisionGate(version, {
            kind,
            stage,
            summary: '待决事项',
            sourceRequestId: 'gate',
          });
          const todo = version.todos.find((entry) => entry.decisionGateId === gate.id)!;
          if (action === 'request-changes') delete todo.decisionGateId;
          expect(applyVersionTodoDecision(version, todo.id, action).message).toContain(
            action === 'approve' ? '已批准' : '已退回',
          );
          expect(gate.status).toBe(action === 'approve' ? 'approved' : 'rejected');
          expect(todo.status).toBe('done');
          expect(version.approvals).toHaveLength(0);
          expect(version.currentStage).toBe(stage);
          const stageReviewTodos = stage === 'charter-review' ? 1 : 0;
          const reapprovalTodos =
            action === 'request-changes' && kind === 'irreversible-decision' ? 1 : 0;
          expect(version.todos.filter((entry) => entry.status === 'open')).toHaveLength(
            stageReviewTodos + reapprovalTodos,
          );
          expect(version.status).toBe(
            action === 'request-changes' && kind === 'irreversible-decision'
              ? 'paused'
              : stage === 'charter-review'
                ? 'waiting-producer'
                : 'running',
          );
          const saved = structuredClone(version);
          expect(() => applyVersionTodoDecision(version, todo.id, action)).toThrow('已经处理');
          expect(version).toEqual(saved);
        }
      }
    },
  );

  it('keeps decision todos open when a stage approval is recorded first', () => {
    const version = createFormalVersion({
      id: 'stage-first',
      title: '独立评审',
      direction: '门禁隔离',
      documentRoot: 'docs/versions/stage-first',
      currentStage: 'charter-review',
    });
    const gate = addDecisionGate(version, {
      kind: 'scope-change',
      stage: 'charter-review',
      summary: '新增范围',
      sourceRequestId: 'scope',
    });
    recordApproval(version, {
      stage: 'charter-review',
      reviewer: 'producer',
      decision: 'approved',
      documentRevision: version.charterRevision,
      comment: '原立项通过',
    });
    expect(version.todos.find((todo) => todo.decisionGateId === gate.id)?.status).toBe('open');
    expect(() => advanceVersion(version, 'module-design')).toThrow('制作人决策门禁');
    resolveDecisionGate(version, gate.id, 'rejected');
    expect(() => advanceVersion(version, 'module-design')).not.toThrow();
  });

  it('migrates legacy formal versions conservatively and rejects future extensions', () => {
    const version = createFormalVersion({
      id: 'legacy-extension',
      title: '旧状态',
      direction: '兼容迁移',
      documentRoot: 'docs/versions/legacy-extension',
    });
    Reflect.deleteProperty(version, 'orchestration');
    expect(normalizeFormalVersion(version)).toBe(true);
    expect(version.orchestration?.migratedFrom).toBe('formal-version-v1');
    expect(version.orchestration?.stagePolicies).toHaveLength(13);
    expect(version.orchestration?.stagePolicies.map((policy) => policy.stage)).toEqual(
      version.nodes.map((node) => node.id),
    );
    expect(version.orchestration?.stagePolicies.every((policy) => policy.mode === 'execute')).toBe(
      true,
    );
    if (!version.orchestration) throw new Error('迁移未生成编排扩展');
    const migrated = structuredClone(version);
    expect(normalizeFormalVersion(version)).toBe(false);
    expect(version).toEqual(migrated);
    (version.orchestration as { schemaVersion: number }).schemaVersion = 2;
    expect(() => normalizeFormalVersion(version)).toThrow('停止自动写入和派发');
  });

  it('rejects malformed nested orchestration records before they can be persisted', () => {
    const version = createFormalVersion({
      id: 'invalid-nested-extension',
      title: '损坏扩展',
      direction: '拒绝损坏嵌套记录',
      documentRoot: 'docs/versions/invalid-nested-extension',
    });
    if (!version.orchestration) throw new Error('测试版本缺少编排扩展');
    (version.orchestration.riskAssessments[0] as { level: string }).level = 'unknown';

    expect(() => normalizeFormalVersion(version)).toThrow('嵌套记录损坏');
  });

  it.each([null, false, 0])(
    'rejects an explicitly present malformed orchestration value %s instead of migrating it',
    (orchestration) => {
      const version = createFormalVersion({
        id: 'invalid-present-extension',
        title: '损坏扩展',
        direction: '区分缺失和损坏字段',
        documentRoot: 'docs/versions/invalid-present-extension',
      });
      (version as unknown as { orchestration: unknown }).orchestration = orchestration;

      expect(() => normalizeFormalVersion(version)).toThrow('停止自动写入和派发');
      expect((version as unknown as { orchestration: unknown }).orchestration).toBe(orchestration);
    },
  );
});
