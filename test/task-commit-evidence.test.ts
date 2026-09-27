import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findTaskCommitEvidence } from '../scripts/task-commit-evidence';

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
});
