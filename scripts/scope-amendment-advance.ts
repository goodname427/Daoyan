export const scopeAmendmentControlPaths = [
  'docs/agent-workflow.md',
  'docs/status.md',
  'docs/dev/2026-10-01.md',
  'package.json',
  'scripts/agent-dispatcher.ts',
  'scripts/project-secretary.ts',
  'scripts/scope-amendment-advance.ts',
  'test/scope-amendment-advance.test.ts',
] as const;

function inWriteScope(path: string, scope: string): boolean {
  const normalizedPath = path.replaceAll('\\', '/');
  const normalizedScope = scope.replaceAll('\\', '/').replace(/\/$/u, '');
  return (
    normalizedScope.length > 0 &&
    (normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`))
  );
}

export function classifyScopeAmendmentAdvance(paths: string[], writePaths: string[]) {
  const controlPaths: string[] = [];
  const taskPaths: string[] = [];
  const unrelatedPaths: string[] = [];
  for (const path of paths) {
    if (scopeAmendmentControlPaths.includes(path as (typeof scopeAmendmentControlPaths)[number])) {
      controlPaths.push(path);
    } else if (writePaths.some((scope) => inWriteScope(path, scope))) {
      taskPaths.push(path);
    } else {
      unrelatedPaths.push(path);
    }
  }
  return { controlPaths, taskPaths, unrelatedPaths };
}

export interface ScopeAmendmentAdvanceAudit {
  previousWritePaths?: string[];
  addedWritePaths?: string[];
  interveningControlPaths?: string[];
  interveningTaskPaths?: string[];
}

export function scopeAmendmentAdvanceMatches(
  audit: ScopeAmendmentAdvanceAudit | null,
  committedPaths: string[],
  amendedWritePaths: string[],
): boolean {
  if (!audit || !Array.isArray(audit.previousWritePaths) || !Array.isArray(audit.addedWritePaths))
    return false;
  const classified = classifyScopeAmendmentAdvance(committedPaths, audit.previousWritePaths);
  return (
    classified.unrelatedPaths.length === 0 &&
    JSON.stringify(classified.controlPaths) ===
      JSON.stringify(audit.interveningControlPaths ?? []) &&
    JSON.stringify(classified.taskPaths) === JSON.stringify(audit.interveningTaskPaths ?? []) &&
    JSON.stringify([...new Set([...audit.previousWritePaths, ...audit.addedWritePaths])]) ===
      JSON.stringify(amendedWritePaths)
  );
}
