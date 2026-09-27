import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';

interface RunReport {
  status?: unknown;
  finishedAt?: unknown;
  tasks?: unknown;
}

export interface QuarantinedStageArtifact {
  source: string;
  destination: string;
  auditPath: string;
}

/** A repair commit may precede the failed launch, but product inputs cannot move. */
export function areControlOnlyPredecessorPaths(paths: readonly string[]): boolean {
  return paths.every(
    (path) =>
      path === 'AGENTS.md' ||
      ['docs/status.md', 'docs/workflow.md', 'docs/agent-workflow.md'].includes(path) ||
      /^docs\/dev\/\d{4}-\d{2}-\d{2}\.md$/.test(path) ||
      /^scripts\/(?:agent-|secretary-|version-|orphan-stage-artifact)[^/]*\.ts$/.test(path) ||
      /^test\/(?:agent-|secretary-|version-|orphan-stage-artifact)[^/]*\.test\.ts$/.test(path),
  );
}

/** Verify the sole product-document change only replaces a dead task link with a local audit pointer. */
export function isOrphanEvidenceReferenceCorrection(input: {
  root: string;
  baseline: string;
  head: string;
  path: string;
}): boolean {
  const { root, baseline, head, path } = input;
  const readRevision = (revision: string) =>
    spawnSync('git', ['show', `${revision}:${path}`], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
  const before = readRevision(baseline);
  const after = readRevision(head);
  if (before.status !== 0 || after.status !== 0) return false;
  const oldLines = before.stdout.split(/\r?\n/);
  const newLines = after.stdout.split(/\r?\n/);
  if (oldLines.length !== newLines.length) return false;
  const changed = oldLines.flatMap((line, index) => (line === newLines[index] ? [] : [index]));
  if (changed.length !== 1) return false;
  const oldLine = oldLines[changed[0]];
  const newLine = newLines[changed[0]];
  const clause = oldLine.lastIndexOf('；');
  if (clause < 0 || !newLine.startsWith(oldLine.slice(0, clause + 1))) return false;
  const original = oldLine.slice(clause + 1);
  const match = /\]\(\.\/tasks\/([a-z0-9-]+\.json)\)/.exec(original);
  return Boolean(
    match &&
    newLine.includes(`quarantined-task-artifacts/${match[1]}`) &&
    newLine.endsWith('不作为已接纳任务证明。') &&
    !newLine.includes(`](./tasks/${match[1]})`),
  );
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child).replaceAll('\\', '/');
  return path !== '' && path !== '..' && !path.startsWith('../') && !path.startsWith('/');
}

/**
 * Preserve a single untracked JSON proven to be an earlier delivered PM's
 * out-of-contract output. Ambiguous or user-owned work is left untouched.
 */
export async function quarantineOrphanStageArtifact(input: {
  root: string;
  versionDocumentRoot: string;
  stage: string;
  approvedTaskIds: readonly string[];
  previousRunDirectory: string;
  previousRunStartedAt: string;
  blockedRunDirectory: string;
}): Promise<QuarantinedStageArtifact | null> {
  const {
    root,
    versionDocumentRoot,
    stage,
    approvedTaskIds,
    previousRunDirectory,
    previousRunStartedAt,
    blockedRunDirectory,
  } = input;
  const absoluteRoot = resolve(root);
  const runsRoot = resolve(absoluteRoot, '.daoyan-agent/runs');
  const priorRun = resolve(previousRunDirectory);
  const blockedRun = resolve(blockedRunDirectory);
  if (!inside(runsRoot, priorRun) || !inside(runsRoot, blockedRun)) return null;
  if ((await readdir(blockedRun).catch(() => null))?.length !== 0) return null;

  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: absoluteRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (status.status !== 0) return null;
  const entries = status.stdout.split('\0').filter(Boolean);
  if (entries.length !== 1 || !entries[0].startsWith('?? ')) return null;
  const source = entries[0].slice(3).replaceAll('\\', '/');
  const prefix = `${versionDocumentRoot.replaceAll('\\', '/').replace(/\/$/, '')}/tasks/`;
  if (!source.startsWith(prefix)) return null;
  const name = source.slice(prefix.length);
  const match = new RegExp(
    `^${stage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-([a-z0-9-]+)\\.json$`,
  ).exec(name);
  if (!match || approvedTaskIds.includes(match[1])) return null;
  const linked = spawnSync(
    'git',
    ['grep', '-l', '-F', `](./tasks/${name})`, '--', versionDocumentRoot],
    { cwd: absoluteRoot, encoding: 'utf8', windowsHide: true },
  );
  if (linked.status !== 1) return null;
  const absoluteSource = resolve(absoluteRoot, source);
  if (!inside(resolve(absoluteRoot, prefix), absoluteSource)) return null;
  const file = await lstat(absoluteSource).catch(() => null);
  if (!file?.isFile() || file.isSymbolicLink()) return null;

  const report = JSON.parse(
    await readFile(resolve(priorRun, 'report.json'), 'utf8').catch(() => '{}'),
  ) as RunReport;
  const startedAt = Date.parse(previousRunStartedAt);
  const finishedAt = Date.parse(String(report.finishedAt ?? ''));
  if (
    report.status !== '已交付' ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    file.birthtimeMs < startedAt - 1_000 ||
    file.mtimeMs < startedAt - 1_000 ||
    file.mtimeMs > finishedAt + 10_000
  )
    return null;
  const taskRuns = Array.isArray(report.tasks) ? report.tasks : [];
  if (
    !taskRuns.some(
      (task) =>
        task &&
        typeof task === 'object' &&
        Array.isArray((task as { changedFiles?: unknown }).changedFiles) &&
        (task as { changedFiles: string[] }).changedFiles.includes(source),
    )
  )
    return null;
  const content = await readFile(absoluteSource);
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (result.taskId !== match[1] || result.status !== 'completed') return null;

  const targetDirectory = resolve(priorRun, 'quarantined-task-artifacts');
  const destination = resolve(targetDirectory, basename(source));
  const auditPath = resolve(targetDirectory, `${basename(source)}.audit.json`);
  if ((await stat(destination).catch(() => null)) || (await stat(auditPath).catch(() => null))) {
    return null;
  }
  await mkdir(targetDirectory, { recursive: true });
  await rename(absoluteSource, destination);
  try {
    await writeFile(
      auditPath,
      `${JSON.stringify(
        {
          reason:
            'Delivered Feature PM generated an untracked task JSON outside the approved stage manifest',
          source,
          destination: relative(absoluteRoot, destination).replaceAll('\\', '/'),
          sha256: createHash('sha256').update(content).digest('hex'),
          previousRun: relative(absoluteRoot, priorRun).replaceAll('\\', '/'),
          blockedRun: relative(absoluteRoot, blockedRun).replaceAll('\\', '/'),
          preservedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { flag: 'wx' },
    );
  } catch (error) {
    await rename(destination, absoluteSource);
    throw error;
  }
  return { source, destination, auditPath };
}
