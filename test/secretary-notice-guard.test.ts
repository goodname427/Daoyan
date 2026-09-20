import { describe, expect, it } from 'vitest';
import {
  continueDispatchResponse,
  featureTaskCompletions,
  retryTimeFromOutput,
  runArgs,
  versionMessageIsNewDirection,
  versionProducerDecision,
  windowsCodexInvocation,
} from '../scripts/secretary-notice-guard';
import { itemFromIntake } from '../scripts/secretary-state';

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
    expect(versionMessageIsNewDirection('另外我有一个新方向')).toBe(true);
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
