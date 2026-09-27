import { spawnSync } from 'node:child_process';

export interface TaskCommitEvidence {
  commit: string;
  parent: string;
}

function git(root: string, args: string[]): { code: number | null; output: string } {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return { code: result.status, output: result.stdout };
}

function changedPaths(root: string, from: string, to: string): string[] | null {
  const result = git(root, ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', from, to]);
  return result.code === 0 ? result.output.split('\0').filter(Boolean) : null;
}

function inScope(path: string, scope: string): boolean {
  const normalizedPath = path.replaceAll('\\', '/').replace(/^\.\//, '');
  const normalizedScope = scope.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  return Boolean(
    normalizedScope &&
    (normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`)),
  );
}

export function findTaskCommitEvidence(input: {
  root: string;
  baseline: string;
  head: string;
  expectedMessage: string;
  writePaths: string[];
  readPaths: string[];
}): TaskCommitEvidence | null {
  const { root, baseline, head, expectedMessage, writePaths, readPaths } = input;
  if (!baseline || !head || !expectedMessage || writePaths.length === 0) return null;
  if (git(root, ['merge-base', '--is-ancestor', baseline, head]).code !== 0) return null;
  const history = git(root, ['rev-list', '--first-parent', '--reverse', `${baseline}..${head}`]);
  if (history.code !== 0) return null;
  const scopes = [...readPaths, ...writePaths];
  const candidates: TaskCommitEvidence[] = [];
  for (const commit of history.output.trim().split(/\s+/).filter(Boolean)) {
    const message = git(root, ['show', '-s', '--format=%s', commit]);
    if (message.code !== 0 || message.output.trim() !== expectedMessage) continue;
    const parent = git(root, ['rev-parse', `${commit}^`]);
    if (parent.code !== 0) continue;
    const parentRevision = parent.output.trim();
    const [before, own, after] = [
      changedPaths(root, baseline, parentRevision),
      changedPaths(root, parentRevision, commit),
      changedPaths(root, commit, head),
    ];
    if (
      before === null ||
      own === null ||
      after === null ||
      own.length === 0 ||
      before.some((path) => scopes.some((scope) => inScope(path, scope))) ||
      own.some((path) => !writePaths.some((scope) => inScope(path, scope))) ||
      after.some((path) => scopes.some((scope) => inScope(path, scope)))
    )
      continue;
    candidates.push({ commit, parent: parentRevision });
  }
  return candidates.length === 1 ? candidates[0] : null;
}
