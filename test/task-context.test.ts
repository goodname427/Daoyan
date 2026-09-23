import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlannedTask } from '../scripts/agent-routing';
import { taskDependencyContext } from '../scripts/task-context';

let directory = '';
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

describe('direct dependency context', () => {
  it('shares bounded, source-linked conclusions only from passed direct dependencies', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'daoyan-task-context-'));
    const output = resolve(directory, 'base.md');
    await writeFile(output, '已实现统一属性绑定。'.repeat(200));
    const task = { dependsOn: ['base'] } as PlannedTask;
    const context = await taskDependencyContext(task, [
      {
        task: { id: 'base', title: '基础绑定' },
        result: 'passed',
        outputFile: output,
        changedFiles: ['src/core/attributes.ts'],
        tests: ['npm run typecheck'],
      },
      {
        task: { id: 'unrelated', title: '无关任务' },
        result: 'passed',
        outputFile: output,
        changedFiles: ['docs/status.md'],
        tests: [],
      },
    ]);
    expect(context).toContain(output);
    expect(context).toContain('src/core/attributes.ts');
    expect(context).not.toContain('无关任务');
    expect(context.length).toBeLessThan(1300);
    const missing = await taskDependencyContext(task, [
      {
        task: { id: 'base', title: '基础绑定' },
        result: 'passed',
        outputFile: resolve(directory, 'missing.md'),
        changedFiles: [],
        tests: [],
      },
    ]);
    expect(missing).toContain('来源文件不可读');
  });
});
