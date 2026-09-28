import { readFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';

/** Only a failed task with no edits and routing errors in every attempt qualifies. */
export async function isRecoverableRoutingOutage(directory: string): Promise<boolean> {
  const recovery = await readFile(resolve(directory, 'recovery.json'), 'utf8')
    .then((value) => JSON.parse(value) as Record<string, unknown>)
    .catch(() => null);
  if (recovery?.status !== 'recoverable' || !Array.isArray(recovery.taskRuns)) return false;
  const latest = recovery.taskRuns.at(-1);
  if (
    typeof latest !== 'object' ||
    latest === null ||
    latest.result !== 'failed' ||
    !Array.isArray(latest.changedFiles) ||
    latest.changedFiles.length > 0 ||
    !Number.isInteger(latest.attempts) ||
    Number(latest.attempts) < 1 ||
    typeof latest.outputFile !== 'string'
  )
    return false;
  const output = resolve(latest.outputFile);
  if (!output.startsWith(`${resolve(directory)}${sep}`)) return false;
  const match = /^(.*)-attempt-\d+\.md$/.exec(basename(output));
  if (!match) return false;
  for (let attempt = 1; attempt <= Number(latest.attempts); attempt += 1) {
    const log = await readFile(
      resolve(directory, `${match[1]}-attempt-${attempt}.log`),
      'utf8',
    ).catch(() => '');
    if (
      !/ERROR: workspace routing discovery failed/.test(log) ||
      /usage limit|rate limit|unauthorized|forbidden|insufficient.credits/i.test(log)
    )
      return false;
  }
  return true;
}

export function canRebaseFailedRoutingRecovery(input: {
  worktreeClean: boolean;
  baselineIsAncestor: boolean;
  committedAdvancePaths: string[];
  taskScopes: string[];
}): boolean {
  return (
    input.worktreeClean &&
    input.baselineIsAncestor &&
    input.committedAdvancePaths.length > 0 &&
    input.committedAdvancePaths.every(
      (path) =>
        !input.taskScopes.some(
          (scope) => path === scope || path.startsWith(`${scope.replace(/\/$/, '')}/`),
        ),
    )
  );
}
