import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifactContent, sanitizeDashboardForSite } from '../scripts/build-secretary-site';

afterEach(() => vi.unstubAllGlobals());

describe('mobile secretary site export', () => {
  it('keeps product context while removing machine-local agent details', () => {
    const result = sanitizeDashboardForSite({
      version: { id: 'v1', title: '测试版本' },
      agents: [
        {
          id: 'worker',
          role: 'Feature PM',
          pid: 1234,
          running: true,
          status: 'running',
          phase: '执行 E:\\private\\run\\delivery.log',
          runDirectory: 'E:\\private\\run',
          recentOutput: ['secret output'],
          error: 'raw failure',
          context: { direction: '实现手机版中枢' },
        },
      ],
      secretary: {
        status: 'running',
        lastEventAt: '2026-09-20T01:00:00.000Z',
        recentMessages: [{ role: 'secretary', content: '已收到' }],
        items: [{ runDirectory: 'E:\\private\\run' }],
      },
      todos: [
        {
          source: 'secretary',
          id: 'blocked',
          title: '恢复任务',
          detail: '查看 E:\\private\\run\\delivery.log 后继续',
          recommendedAction: 'retry-now',
          recommendedLabel: '立即重试',
          solutions: [{ id: 'defer', label: '稍后处理', description: '.daoyan-agent/runs/x' }],
          privateField: 'must not ship',
        },
      ],
    });

    expect(result.agents).toEqual([
      expect.objectContaining({
        pid: 0,
        running: false,
        status: 'waiting',
        phase: '快照时：执行 [本机路径]',
        runDirectory: '',
        recentOutput: [],
        error: '执行曾遇到错误，请回到实时中枢查看。',
        context: { direction: '实现手机版中枢' },
      }),
    ]);
    expect(result.secretary).toEqual({
      status: 'snapshot',
      lastEventAt: '2026-09-20T01:00:00.000Z',
      recentMessages: [{ role: 'secretary', content: '已收到' }],
    });
    expect(result.todos).toEqual([
      {
        source: 'secretary',
        id: 'blocked',
        title: '恢复任务',
        detail: '查看 [本机路径] 后继续',
        recommendedAction: 'retry-now',
        recommendedLabel: '立即重试',
        solutions: [
          {
            id: 'defer',
            label: '稍后处理',
            description: '[运行记录]',
          },
        ],
      },
    ]);
  });

  it('fails the build input when an associated document cannot be exported', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));

    await expect(artifactContent('https://example.test', 'v1', 'docs/missing.md')).rejects.toThrow(
      '文档 docs/missing.md 导出失败（404）',
    );
  });
});
