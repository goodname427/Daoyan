import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deliverArchivedVersionBranch } from '../scripts/version-git-delivery';

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

describe('archived version Git delivery', () => {
  it('merges only after the gate and resumes a failed push from master', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-version-git-'));
    const repo = resolve(temporary, 'repo');
    const remote = resolve(temporary, 'remote.git');
    try {
      git(temporary, 'init', '-b', 'master', repo);
      git(temporary, 'init', '--bare', remote);
      git(repo, 'config', 'user.email', 'test@example.com');
      git(repo, 'config', 'user.name', 'Test');
      await writeFile(resolve(repo, 'README.md'), 'base\n');
      git(repo, 'add', 'README.md');
      git(repo, 'commit', '-m', 'chore: base');
      git(repo, 'remote', 'add', 'origin', remote);
      git(repo, 'push', 'origin', 'master');
      git(repo, 'switch', '-c', 'codex/version-demo');
      await writeFile(resolve(repo, 'README.md'), 'version\n');
      git(repo, 'commit', '-am', 'feat: version');
      const expected = git(repo, 'rev-parse', 'HEAD');
      expect(() => deliverArchivedVersionBranch(repo, 'codex/version-demo', 'missing')).toThrow(
        '版本 Git 交付失败',
      );
      expect(git(repo, 'branch', '--show-current')).toBe('master');
      expect(deliverArchivedVersionBranch(repo, 'codex/version-demo')).toBe(expected);
      expect(git(remote, 'rev-parse', 'refs/heads/master')).toBe(expected);
      expect(deliverArchivedVersionBranch(repo, 'codex/version-demo')).toBe(expected);
    } finally {
      await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
