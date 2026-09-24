import { spawnSync } from 'node:child_process';

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(
      `版本 Git 交付失败：git ${args.join(' ')}：${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

/** The producer gate is complete before this is called. Retrying is safe after a push failure. */
export function deliverArchivedVersionBranch(
  root: string,
  branch: string,
  remote = 'origin',
  proxyFallback = '',
): string {
  if (!/^codex\/version-[a-zA-Z0-9_-]+$/.test(branch)) {
    throw new Error('正式版本集成分支名无效');
  }
  const current = git(root, ['branch', '--show-current']);
  if (current !== branch && current !== 'master') {
    throw new Error(`正式版本只能从 ${branch} 或 master 交付，当前位于 ${current || 'detached'}`);
  }
  if (git(root, ['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('版本归档合并前存在未提交的受跟踪改动');
  }
  git(root, ['rev-parse', '--verify', branch]);
  if (current === branch) git(root, ['switch', 'master']);
  git(root, ['merge', '--ff-only', branch]);
  const head = git(root, ['rev-parse', 'HEAD']);
  try {
    git(root, ['push', remote, 'master']);
  } catch (error) {
    if (!proxyFallback) throw error;
    git(root, [
      '-c',
      `http.proxy=${proxyFallback}`,
      '-c',
      `https.proxy=${proxyFallback}`,
      'push',
      remote,
      'master',
    ]);
  }
  return head;
}
