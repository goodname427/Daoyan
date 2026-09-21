import { describe, expect, it } from 'vitest';
import {
  applyContinueToSchedule,
  applyWaitingReply,
  closeArchivedVersionItems,
  createSecretaryState,
  decideIntake,
  directionDestination,
  firstUntrackedScheduledFact,
  inferMessageIntent,
  intentSimilarity,
  isRunEligibleForAdoption,
  isWorkflowControlPlaneRequest,
  itemFromIntake,
  nextRunnableItem,
  normalizeSecretaryState,
  pendingScheduleCorrections,
  publicSecretaryState,
  projectFactsFromItems,
  projectFactsFromStatus,
  taskCompletionKey,
  unrecordedTaskCompletions,
  reconciliationTargets,
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
  it('retires stale formal-stage work when its control-plane version is archived', () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    const item = itemFromIntake(
      { id: 'formal-development', idea: '修复秘书工作流', createdAt: state.initializedAt },
      [],
    ).item;
    item.status = 'tracking';
    item.processPid = 123;
    item.processIdentity = 'old-process';
    item.orchestration = {
      ...item.orchestration!,
      formalVersionId: 'workflow-version',
      formalStage: 'development',
      processOccupied: true,
    };
    state.items.push(item);
    state.activeItemId = item.id;

    expect(closeArchivedVersionItems(state, 'workflow-version', '2026-09-21T01:00:00.000Z')).toBe(
      true,
    );
    expect(item.status).toBe('superseded');
    expect(item.processPid).toBe(0);
    expect(item.orchestration.processOccupied).toBe(false);
    expect(state.activeItemId).toBe('');
  });

  it('keeps workflow control-plane maintenance out of secretary self-dispatch', () => {
    expect(isWorkflowControlPlaneRequest('修复常驻秘书卡住后不汇报的问题')).toBe(true);
    expect(isWorkflowControlPlaneRequest('优化 Agent Workflow 的恢复调度')).toBe(true);
    expect(isWorkflowControlPlaneRequest('继续开发法术实体控制功能')).toBe(false);
    expect(isWorkflowControlPlaneRequest('让秘书安排下一个游戏版本')).toBe(false);
  });

  it('migrates stale mobile and delivered desktop candidates with stable correction facts', () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    const mobile = itemFromIntake(
      {
        id: '42c7e743-2bdc-4152-aaf4-c8cd979df279',
        idea: '开发手机 Sites 项目中枢 MVP',
        createdAt: state.initializedAt,
      },
      [],
    ).item;
    const desktop = itemFromIntake(
      {
        id: '85d190db-9843-4f83-a35f-ea0608fa9d7c',
        idea: '增强桌面项目中枢工作台',
        createdAt: state.initializedAt,
      },
      [],
    ).item;
    mobile.status = 'backlog';
    desktop.status = 'backlog';
    state.items.push(mobile, desktop);

    expect(normalizeSecretaryState(state)).toBe(true);
    expect(state.items.map((item) => item.status)).toEqual(['superseded', 'delivered']);
    expect(pendingScheduleCorrections(state)).toHaveLength(2);
    expect(projectFactsFromItems(state.items)).toEqual([]);
    expect(
      (publicSecretaryState(state) as { schedule: { pendingCount: number } }).schedule.pendingCount,
    ).toBe(0);

    const serialized = JSON.parse(JSON.stringify(state));
    expect(normalizeSecretaryState(serialized)).toBe(false);
    expect(serialized.orchestration.itemResolutions).toHaveLength(2);
  });

  it('does not text-match future mobile or desktop work during the one-time legacy migration', () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    const futureMobile = itemFromIntake(
      {
        id: 'future-mobile',
        idea: '重新设计手机优先项目中枢 MVP 的离线模式',
        createdAt: state.initializedAt,
      },
      [],
    ).item;
    const futureDesktop = itemFromIntake(
      {
        id: 'future-desktop',
        idea: '继续增强桌面项目中枢工作台的快捷键',
        createdAt: state.initializedAt,
      },
      [],
    ).item;
    futureMobile.status = 'backlog';
    futureDesktop.status = 'queued';
    state.items.push(futureMobile, futureDesktop);

    expect(normalizeSecretaryState(state)).toBe(false);
    expect(state.items.map((item) => item.status)).toEqual(['backlog', 'queued']);
    expect(state.orchestration?.itemResolutions).toEqual([]);
  });

  it('reverse-closes an original candidate through its stable secretary relation', () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    const original = itemFromIntake(
      { id: 'original', idea: '新增宗门经营', createdAt: state.initializedAt },
      [],
    ).item;
    original.status = 'backlog';
    const delivery = itemFromIntake(
      { id: 'delivery', idea: '交付宗门经营', createdAt: state.initializedAt },
      [],
    ).item;
    delivery.status = 'delivered';
    delivery.matchedFact = {
      kind: 'scheduled',
      text: original.idea,
      reference: 'secretary:original',
    };
    delivery.completedAt = '2026-09-21T01:00:00.000Z';
    state.items.push(original, delivery);

    normalizeSecretaryState(state);
    expect(original.status).toBe('delivered');
    expect(state.orchestration?.itemResolutions?.[0]).toEqual(
      expect.objectContaining({ itemId: 'original', relatedItemIds: ['delivery'] }),
    );
  });

  it('reverse-closes a merged candidate and excludes it from schedule answers', () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    const original = itemFromIntake(
      { id: 'merge-source', idea: '增加版本耗时面板', createdAt: state.initializedAt },
      [],
    ).item;
    original.status = 'backlog';
    const merged = itemFromIntake(
      { id: 'merge-target', idea: '合并到项目中枢观测工作', createdAt: state.initializedAt },
      [],
    ).item;
    merged.status = 'merged';
    merged.matchedFact = {
      kind: 'scheduled',
      text: original.idea,
      reference: 'secretary:merge-source',
    };
    state.items.push(original, merged);

    expect(normalizeSecretaryState(state)).toBe(true);
    expect(original.status).toBe('merged');
    expect(projectFactsFromItems(state.items)).toEqual([]);
    expect(state.orchestration?.itemResolutions).toContainEqual(
      expect.objectContaining({ itemId: original.id, status: 'merged' }),
    );
    const restarted = JSON.parse(JSON.stringify(state));
    expect(normalizeSecretaryState(restarted)).toBe(false);
    expect(
      (publicSecretaryState(restarted) as { schedule: { pendingCount: number } }).schedule,
    ).toEqual(expect.objectContaining({ pendingCount: 0 }));
  });

  it('reverse-closes a three-item relation chain in one reconciliation and persists it', () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    const original = itemFromIntake(
      { id: 'chain-a', idea: '原始候选', createdAt: state.initializedAt },
      [],
    ).item;
    const successor = itemFromIntake(
      { id: 'chain-b', idea: '合并后的候选', createdAt: state.initializedAt },
      [],
    ).item;
    const delivery = itemFromIntake(
      { id: 'chain-c', idea: '最终交付', createdAt: state.initializedAt },
      [],
    ).item;
    original.status = 'backlog';
    successor.status = 'backlog';
    successor.matchedFact = {
      kind: 'scheduled',
      text: original.idea,
      reference: 'secretary:chain-a',
    };
    delivery.status = 'delivered';
    delivery.completedAt = '2026-09-21T01:00:00.000Z';
    delivery.matchedFact = {
      kind: 'scheduled',
      text: successor.idea,
      reference: 'secretary:chain-b',
    };
    state.items.push(original, successor, delivery);

    expect(normalizeSecretaryState(state)).toBe(true);
    expect(state.items.map((item) => item.status)).toEqual(['delivered', 'delivered', 'delivered']);
    expect(projectFactsFromItems(state.items)).toEqual([]);
    expect(state.orchestration?.itemResolutions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: 'chain-a', relatedItemIds: ['chain-b'] }),
        expect.objectContaining({ itemId: 'chain-b', relatedItemIds: ['chain-c'] }),
      ]),
    );

    const restarted = JSON.parse(JSON.stringify(state));
    expect(normalizeSecretaryState(restarted)).toBe(false);
    expect(
      (publicSecretaryState(restarted) as { schedule: { pendingCount: number } }).schedule,
    ).toEqual(expect.objectContaining({ pendingCount: 0 }));
  });

  it('deduplicates linked schedule items and lets active status override backlog counts', () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    const backlog = itemFromIntake(
      { id: 'queued', idea: '境界成长', createdAt: state.initializedAt },
      [],
    ).item;
    backlog.status = 'backlog';
    const active = itemFromIntake(
      { id: 'active', idea: '境界成长实现', createdAt: state.initializedAt },
      [],
    ).item;
    active.status = 'active';
    active.matchedFact = { kind: 'scheduled', text: backlog.idea, reference: 'secretary:queued' };
    state.items.push(backlog, active);

    expect(projectFactsFromItems(state.items)).toEqual([
      { kind: 'active', text: active.idea, reference: 'secretary:queued' },
    ]);
    expect((publicSecretaryState(state) as { schedule: Record<string, number> }).schedule).toEqual({
      pendingCount: 1,
      activeCount: 1,
      backlogCount: 0,
    });
  });

  it('counts independent items with identical text unless an explicit relation links them', () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    const first = itemFromIntake(
      { id: 'same-text-a', idea: '整理宗门任务面板', createdAt: state.initializedAt },
      [],
    ).item;
    const second = itemFromIntake(
      { id: 'same-text-b', idea: '整理宗门任务面板', createdAt: state.initializedAt },
      [],
    ).item;
    first.status = 'backlog';
    second.status = 'queued';
    first.matchedFact = {
      kind: 'scheduled',
      text: first.idea,
      reference: 'docs/status.md#下一阶段候选',
    };
    second.matchedFact = { ...first.matchedFact };
    state.items.push(first, second);

    expect(projectFactsFromItems(state.items)).toEqual([
      { kind: 'scheduled', text: first.idea, reference: 'secretary:same-text-a' },
      { kind: 'scheduled', text: second.idea, reference: 'secretary:same-text-b' },
    ]);
    expect(
      (publicSecretaryState(state) as { schedule: { pendingCount: number } }).schedule,
    ).toEqual(expect.objectContaining({ pendingCount: 2 }));
  });
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

  it('routes only real directions by active version and scope-freeze state', () => {
    expect(directionDestination('新增宗门系统', null)).toBe('draft-version');
    expect(
      directionDestination('补齐秘书恢复对账', {
        status: 'running',
        currentStage: 'charter-draft',
        scopeFrozen: false,
        direction: '常驻秘书自适应编排',
      }),
    ).toBe('current-version');
    expect(
      directionDestination('补齐秘书恢复对账', {
        status: 'running',
        currentStage: 'development',
        scopeFrozen: true,
        direction: '常驻秘书自适应编排',
      }),
    ).toBe('next-version-candidate');
    expect(
      directionDestination('新增宗门经营玩法', {
        status: 'running',
        currentStage: 'module-design',
        scopeFrozen: false,
        direction: '常驻秘书自适应编排',
      }),
    ).toBe('scope-review');
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

  it('never treats lexical similarity as approval of changed commitments', () => {
    const direction = '新增装备交易系统，允许玩家相互交易装备';
    const version = {
      status: 'running' as const,
      currentStage: 'module-design',
      scopeFrozen: false,
      direction,
    };
    for (const idea of [
      '取消装备交易系统，禁止玩家相互交易装备',
      '删除装备交易系统',
      '将装备交易系统替换为装备赠送系统',
      '新增装备交易系统，允许玩家相互交易装备和金币',
    ]) {
      expect(intentSimilarity(idea, direction)).toBeGreaterThan(0.34);
      expect(directionDestination(idea, version)).toBe('scope-review');
      for (const kind of ['active', 'scheduled', 'completed'] as const) {
        const intake = itemFromIntake(
          { id: 'change', idea, createdAt: '2026-09-21T00:00:00.000Z' },
          [{ kind, text: direction, reference: 'secretary:trade' }],
        );
        expect(intake.item).toMatchObject({ idea, status: 'queued', matchedFact: null });
        const duplicate = itemFromIntake(
          { id: 'same', idea: direction, createdAt: '2026-09-21T00:00:00.000Z' },
          [{ kind, text: direction, reference: 'secretary:trade' }],
        );
        expect(duplicate.item.matchedFact?.text).toBe(direction);
      }
    }
    expect(directionDestination(direction, version)).toBe('current-version');
  });

  it.each(['好的。', '收到，谢谢', '明白了！辛苦', 'OK, thanks', '谢谢你，辛苦了'])(
    'keeps ordinary reply %s out of direction routing',
    (message) => {
      expect(inferMessageIntent(message, false)).toBe('reply');
    },
  );

  it('preserves explicit directions following an acknowledgement', () => {
    expect(inferMessageIntent('好的，新增装备交易系统', false)).toBe('direction');
    expect(inferMessageIntent('取消装备交易系统，禁止玩家相互交易装备', true)).toBe('direction');
    expect(inferMessageIntent('继续调整装备交易系统，禁止玩家相互交易装备', false)).toBe(
      'direction',
    );
    expect(inferMessageIntent('继续现有交易工作，但不要支持金币交易', false)).toBe('direction');
    expect(inferMessageIntent('恢复当前方案，但改成不兼容旧存档', true)).toBe('direction');
    expect(inferMessageIntent('现在不要支持金币交易', false)).toBe('direction');
  });

  it('blocks the whole queue while an existing run lacks reconciliation evidence', () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    const queued = itemFromIntake(
      { id: 'new', idea: '新增系统', createdAt: state.initializedAt },
      [],
    ).item;
    const missing = structuredClone(queued);
    missing.id = 'missing';
    missing.status = 'tracking';
    missing.orchestration!.reconciliationOutcome = 'missing';
    state.items.push(queued, missing);
    expect(nextRunnableItem(state, state.initializedAt)).toBeNull();
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
    expect(inferMessageIntent('采用兼容方案', false)).toBe('reply');
    expect(inferMessageIntent('好的', false)).toBe('reply');
    expect(inferMessageIntent('收到', false)).toBe('reply');
    expect(inferMessageIntent('ok', false)).toBe('reply');
    expect(inferMessageIntent('新增宗门系统', true)).toBe('direction');
    expect(inferMessageIntent('增加法术对比视图', true)).toBe('direction');
    expect(inferMessageIntent('另外我有一个新方向', true)).toBe('direction');
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
    waiting.orchestration!.waitingSnapshot = 'run:attempt-1:block-a';
    state.items.push(waiting);
    state.activeItemId = waiting.id;
    const direction = {
      id: 'new-direction',
      idea: '新增宗门系统',
      createdAt: '2026-09-14T00:30:00.000Z',
    };
    const beforeDirection = structuredClone(state);
    expect(
      applyWaitingReply(state, direction, inferMessageIntent(direction.idea, true)),
    ).toBeNull();
    expect(state).toEqual(beforeDirection);
    const request: IntakeRequest = {
      id: 'reply',
      idea: '现在可以继续了',
      createdAt: '2026-09-14T01:00:00.000Z',
    };
    const intent = inferMessageIntent(request.idea, true);

    expect(applyWaitingReply(state, request, intent)?.id).toBe(waiting.id);
    expect(waiting.status).toBe('retry-wait');
    expect(waiting.producerGuidance).toBe(request.idea);
    const persisted = JSON.parse(JSON.stringify(state)) as typeof state;
    normalizeSecretaryState(persisted);
    expect(persisted.items[0].orchestration!.acknowledgedWaitingSnapshot).toBe(
      'run:attempt-1:block-a',
    );
    persisted.items[0].orchestration!.waitingSnapshot = 'run:attempt-2:block-b';
    expect(persisted.items[0].orchestration!.acknowledgedWaitingSnapshot).not.toBe(
      persisted.items[0].orchestration!.waitingSnapshot,
    );
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

  it('migrates legacy v1 state conservatively and rejects future orchestration', () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    const item = itemFromIntake(
      {
        id: 'legacy',
        idea: '旧任务',
        createdAt: '2026-09-21T00:00:00.000Z',
      },
      [],
    ).item;
    Reflect.deleteProperty(state, 'orchestration');
    Reflect.deleteProperty(item, 'orchestration');
    state.items.push(item);

    expect(normalizeSecretaryState(state)).toBe(true);
    expect(state.orchestration?.migratedFrom).toBe('secretary-v1');
    expect(item.orchestration).toEqual(
      expect.objectContaining({ schemaVersion: 1, awaitingReview: false }),
    );
    if (!state.orchestration) throw new Error('迁移未生成编排扩展');
    (state.orchestration as { schemaVersion: number }).schemaVersion = 2;
    expect(() => normalizeSecretaryState(state)).toThrow('停止自动写入和派发');
  });

  it('rejects malformed nested secretary orchestration records', () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    if (!state.orchestration) throw new Error('测试状态缺少编排扩展');
    state.orchestration.intakes.push({
      requestId: 'request-1',
      intent: 'direction',
      disposition: 'draft-created',
      status: 'completed',
      targetVersionId: 'draft-1',
      scopeRevision: 1,
      reason: '已建立草案',
      createdAt: '2026-09-21T00:00:00.000Z',
      completedAt: '2026-09-21T00:01:00.000Z',
    });
    (state.orchestration.intakes[0] as { disposition: string }).disposition = 'invalid';

    expect(() => normalizeSecretaryState(state)).toThrow('嵌套记录损坏');
  });

  it.each(['waitingSnapshot', 'acknowledgedWaitingSnapshot'] as const)(
    'rejects malformed %s without inventing approval',
    (field) => {
      const state = createSecretaryState('2026-09-21T00:00:00.000Z');
      const item = itemFromIntake(
        { id: 'wait', idea: '恢复任务', createdAt: state.initializedAt },
        [],
      ).item;
      state.items.push(item);
      Reflect.set(item.orchestration!, field, null);
      expect(() => normalizeSecretaryState(state)).toThrow('停止自动写入和派发');
    },
  );

  it.each([null, false, 0])(
    'rejects an explicitly present malformed secretary orchestration value %s',
    (orchestration) => {
      const state = createSecretaryState('2026-09-21T00:00:00.000Z');
      (state as unknown as { orchestration: unknown }).orchestration = orchestration;

      expect(() => normalizeSecretaryState(state)).toThrow('停止自动写入和派发');
      expect((state as unknown as { orchestration: unknown }).orchestration).toBe(orchestration);
    },
  );

  it('rejects an explicitly present malformed item orchestration value', () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    const item = itemFromIntake(
      { id: 'invalid-item', idea: '旧任务', createdAt: state.initializedAt },
      [],
    ).item;
    (item as unknown as { orchestration: unknown }).orchestration = null;
    state.items.push(item);

    expect(() => normalizeSecretaryState(state)).toThrow('事项 invalid-item');
    expect((item as unknown as { orchestration: unknown }).orchestration).toBeNull();
  });

  it('reconciles every active, tracking and retry item plus the active pointer', () => {
    const state = createSecretaryState('2026-09-21T00:00:00.000Z');
    const make = (id: string, status: 'active' | 'tracking' | 'retry-wait' | 'queued') => ({
      ...itemFromIntake({ id, idea: id, createdAt: '2026-09-21T00:00:00.000Z' }, []).item,
      status,
    });
    state.items.push(
      make('active', 'active'),
      make('tracking', 'tracking'),
      make('retry', 'retry-wait'),
      make('pointer', 'queued'),
      make('ignored', 'queued'),
    );
    state.activeItemId = 'pointer';

    expect(reconciliationTargets(state).map((item) => item.id)).toEqual([
      'active',
      'tracking',
      'retry',
      'pointer',
    ]);
  });
});
