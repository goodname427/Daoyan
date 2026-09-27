import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findTaskCommitEvidence, taskCommitOutOfScopePaths } from '../scripts/task-commit-evidence';

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

describe('task commit evidence', () => {
  it('attributes a task commit between disjoint control-plane commits', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'daoyan-task-commit-'));
    try {
      git(root, 'init');
      git(root, 'config', 'user.name', 'Test');
      git(root, 'config', 'user.email', 'test@example.com');
      await mkdir(resolve(root, 'docs'), { recursive: true });
      await writeFile(resolve(root, 'docs', 'world.md'), 'initial\n');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'chore: baseline');
      const baseline = git(root, 'rev-parse', 'HEAD');

      await writeFile(resolve(root, 'docs', 'control.md'), 'before\n');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'fix: control before');
      await writeFile(resolve(root, 'docs', 'world.md'), 'revised\n');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'docs: world task');
      const taskCommit = git(root, 'rev-parse', 'HEAD');
      await writeFile(resolve(root, 'docs', 'control.md'), 'after\n');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'fix: control after');
      const head = git(root, 'rev-parse', 'HEAD');

      const input = {
        root,
        baseline,
        head,
        expectedMessage: 'docs: world task',
        writePaths: ['docs/world.md'],
        readPaths: ['docs/world.md'],
      };
      expect(findTaskCommitEvidence(input)?.commit).toBe(taskCommit);
      expect(taskCommitOutOfScopePaths(input)).toEqual([]);
      expect(
        findTaskCommitEvidence({ ...input, expectedMessage: 'docs: another task' }),
      ).toBeNull();

      await writeFile(resolve(root, 'docs', 'world.md'), 'changed again\n');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'fix: later task change');
      expect(findTaskCommitEvidence({ ...input, head: git(root, 'rev-parse', 'HEAD') })).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a task commit that swept a concurrent control change into the same commit', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'daoyan-mixed-task-commit-'));
    try {
      git(root, 'init');
      git(root, 'config', 'user.name', 'Test');
      git(root, 'config', 'user.email', 'test@example.com');
      await mkdir(resolve(root, 'docs'), { recursive: true });
      await mkdir(resolve(root, 'scripts'), { recursive: true });
      await writeFile(resolve(root, 'docs', 'world.md'), 'old\n');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'chore: baseline');
      const baseline = git(root, 'rev-parse', 'HEAD');
      await writeFile(resolve(root, 'docs', 'world.md'), 'new\n');
      await writeFile(resolve(root, 'scripts', 'secretary-control.ts'), 'export {};\n');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'docs: world task');
      const input = {
        root,
        baseline,
        head: git(root, 'rev-parse', 'HEAD'),
        expectedMessage: 'docs: world task',
        writePaths: ['docs/world.md'],
        readPaths: ['docs/world.md'],
      };
      expect(findTaskCommitEvidence(input)).toBeNull();
      expect(taskCommitOutOfScopePaths(input)).toEqual(['scripts/secretary-control.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('isolates a version plan commit from an earlier control-plane repair', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'daoyan-stage-plan-'));
    try {
      git(root, 'init');
      git(root, 'config', 'user.name', 'Test');
      git(root, 'config', 'user.email', 'test@example.com');
      await mkdir(resolve(root, 'docs/versions/example'), { recursive: true });
      await writeFile(resolve(root, 'docs/versions/example/module-design-tasks.json'), '{}\n');
      await writeFile(resolve(root, 'docs/versions/example/module-design-tasks.md'), 'old\n');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'chore: baseline');
      const baseline = git(root, 'rev-parse', 'HEAD');

      await writeFile(resolve(root, 'docs/status.md'), 'control fix\n');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'fix: secretary control');
      await writeFile(
        resolve(root, 'docs/versions/example/module-design-tasks.json'),
        '{"tasks":[]}\n',
      );
      await writeFile(resolve(root, 'docs/versions/example/module-design-tasks.md'), 'new\n');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'chore(version): plan module-design deliverables');
      const planCommit = git(root, 'rev-parse', 'HEAD');

      const evidence = findTaskCommitEvidence({
        root,
        baseline,
        head: planCommit,
        expectedMessage: 'chore(version): plan module-design deliverables',
        writePaths: [
          'docs/versions/example/module-design-tasks.json',
          'docs/versions/example/module-design-tasks.md',
        ],
        readPaths: ['docs/versions/example'],
      });
      expect(evidence?.commit).toBe(planCommit);
      expect(evidence?.parent).toBe(git(root, 'rev-parse', `${planCommit}^`));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
