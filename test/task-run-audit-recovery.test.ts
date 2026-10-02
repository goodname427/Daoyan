import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { taskRunsFromAuditedHistory } from '../scripts/task-run-audit-recovery';

describe('task run audit recovery', () => {
  it('reconstructs only a uniquely passed task with its original output and log', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'daoyan-task-audit-'));
    try {
      await writeFile(resolve(directory, 'player-validation-gpt-6-sol-attempt-1.md'), 'checked\n');
      await writeFile(resolve(directory, 'player-validation-gpt-6-sol-attempt-1.log'), 'done\n');
      await writeFile(
        resolve(directory, 'public-events.jsonl'),
        [
          {
            eventId: 'task-player-validation:r1:tree',
            createdAt: '2026-10-01T00:00:00.000Z',
            payload: { status: 'passed' },
          },
          {
            eventId: 'task-player-validation-file-0:r1:tree',
            createdAt: '2026-10-01T00:00:00.000Z',
            payload: { path: 'test/render.test.tsx' },
          },
        ]
          .map((event) => JSON.stringify(event))
          .join('\n'),
      );
      const runs = await taskRunsFromAuditedHistory(directory, ['player-validation']);
      expect(runs).toMatchObject([
        {
          taskId: 'player-validation',
          model: 'gpt-6-sol',
          attempts: 1,
          changedFiles: ['test/render.test.tsx'],
          completedAt: '2026-10-01T00:00:00.000Z',
        },
      ]);
      await writeFile(resolve(directory, 'player-validation-gpt-6-sol-attempt-2.md'), 'again\n');
      await expect(taskRunsFromAuditedHistory(directory, ['player-validation'])).rejects.toThrow(
        '执行产物不唯一',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
