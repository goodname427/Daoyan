import { spawnSync } from 'node:child_process';

export interface TaskCommitEvidence {
  commit: string;
  parent: string;
}

export function findCommitByMessage(input: {
  root: string;
  baseline: string;
  head: string;
  expectedMessage: string;
}): TaskCommitEvidence | null {
  const { root, baseline, head, expectedMessage } = input;
  if (!baseline || !head || !expectedMessage) return null;
  if (git(root, ['merge-base', '--is-ancestor', baseline, head]).code !== 0) return null;
  const history = git(root, ['rev-list', '--first-parent', `${baseline}..${head}`]);
  if (history.code !== 0) return null;
  const matches: TaskCommitEvidence[] = [];
  for (const commit of history.output.trim().split(/\s+/).filter(Boolean)) {
    const message = git(root, ['show', '-s', '--format=%s', commit]);
    if (message.code !== 0 || message.output.trim() !== expectedMessage) continue;
    const parent = git(root, ['rev-parse', `${commit}^`]);
    if (parent.code === 0) matches.push({ commit, parent: parent.output.trim() });
  }
  return matches.length === 1 ? matches[0] : null;
}

export function taskCommitOutOfScopePaths(input: {
  root: string;
  baseline: string;
  head: string;
  expectedMessage: string;
  writePaths: string[];
}): string[] {
  const { root, baseline, head, expectedMessage, writePaths } = input;
  if (!baseline || !head || !expectedMessage || writePaths.length === 0) return [];
  if (git(root, ['merge-base', '--is-ancestor', baseline, head]).code !== 0) return [];
  const history = git(root, ['rev-list', '--first-parent', `${baseline}..${head}`]);
  if (history.code !== 0) return [];
  const violations = new Set<string>();
  for (const commit of history.output.trim().split(/\s+/).filter(Boolean)) {
    const message = git(root, ['show', '-s', '--format=%s', commit]);
    if (message.code !== 0 || message.output.trim() !== expectedMessage) continue;
    const parent = git(root, ['rev-parse', `${commit}^`]);
    if (parent.code !== 0) continue;
    const files = changedPaths(root, parent.output.trim(), commit);
    if (!files?.some((path) => writePaths.some((scope) => inScope(path, scope)))) continue;
    for (const path of files) {
      if (!writePaths.some((scope) => inScope(path, scope))) violations.add(path);
    }
  }
  return [...violations];
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

function normalizedLocalEvidenceLinks(content: string): string {
  return content
    .replace(
      /\[([^\]]+)\]\(((?:\.\.\/){3}\.daoyan-agent\/[^)\r\n]+)\)/g,
      (_whole, label: string, target: string) => `${label}（本机证据：\`${target}\`）`,
    )
    .replace(/） (?=[\u3400-\u9fff])/g, '）');
}

/** A local runtime link becoming a plain path does not change planning rules. */
function referenceOnlyPredecessorChange(
  root: string,
  baseline: string,
  parent: string,
  taskCommit: string,
  path: string,
): boolean {
  if (!path.endsWith('.md')) return false;
  const before = git(root, ['show', `${baseline}:${path}`]);
  const after = git(root, ['show', `${parent}:${path}`]);
  const delivered = git(root, ['show', `${taskCommit}:${path}`]);
  if (before.code !== 0 || after.code !== 0 || delivered.code !== 0) return false;
  if (normalizedLocalEvidenceLinks(before.output) !== normalizedLocalEvidenceLinks(after.output)) {
    return false;
  }
  const references = [...after.output.matchAll(/(?:\.\.\/){3}\.daoyan-agent\/[^`\s)]+/g)].map(
    (match) => match[0],
  );
  return references.every((reference) => delivered.output.includes(reference));
}

export function findTaskCommitEvidence(input: {
  root: string;
  baseline: string;
  head: string;
  expectedMessage: string;
  writePaths: string[];
  readPaths: string[];
  allowReferenceOnlyPredecessorChanges?: boolean;
  allowPrecedingOwnedWriteChanges?: boolean;
}): TaskCommitEvidence | null {
  const {
    root,
    baseline,
    head,
    expectedMessage,
    writePaths,
    readPaths,
    allowReferenceOnlyPredecessorChanges = false,
    allowPrecedingOwnedWriteChanges = false,
  } = input;
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
    const relevantBefore = before?.filter((path) => scopes.some((scope) => inScope(path, scope)));
    const predecessorSafe =
      relevantBefore?.length === 0 ||
      relevantBefore?.every((path) =>
        allowPrecedingOwnedWriteChanges &&
        own?.includes(path) &&
        writePaths.some((scope) => inScope(path, scope))
          ? true
          : allowReferenceOnlyPredecessorChanges &&
            referenceOnlyPredecessorChange(root, baseline, parentRevision, commit, path),
      );
    if (
      before === null ||
      own === null ||
      after === null ||
      own.length === 0 ||
      !predecessorSafe ||
      own.some((path) => !writePaths.some((scope) => inScope(path, scope))) ||
      after.some((path) => scopes.some((scope) => inScope(path, scope)))
    )
      continue;
    candidates.push({ commit, parent: parentRevision });
  }
  return candidates.length === 1 ? candidates[0] : null;
}
