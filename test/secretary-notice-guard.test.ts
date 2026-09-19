import { describe, expect, it } from 'vitest';
import {
  featureTaskCompletions,
  versionMessageIsNewDirection,
  versionProducerDecision,
} from '../scripts/secretary-notice-guard';

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
});
