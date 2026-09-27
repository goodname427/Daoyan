import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  areControlOnlyPredecessorPaths,
  isOrphanEvidenceReferenceCorrection,
  quarantineOrphanStageArtifact,
} from '../scripts/orphan-stage-artifact';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'daoyan-orphan-artifact-'));
  roots.push(root);
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await writeFile(resolve(root, '.gitignore'), '.daoyan-agent/\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'chore: baseline'], { cwd: root });
  const prior = resolve(root, '.daoyan-agent/runs/prior');
  const blocked = resolve(root, '.daoyan-agent/runs/blocked');
  await mkdir(prior, { recursive: true });
  await mkdir(blocked, { recursive: true });
  const source = 'docs/versions/pilot/tasks/design-review-extra-review.json';
  const sourcePath = resolve(root, source);
  await mkdir(resolve(root, 'docs/versions/pilot/tasks'), { recursive: true });
  const startedAt = new Date(Date.now() - 30_000).toISOString();
  await writeFile(sourcePath, '{"taskId":"extra-review","status":"completed"}\n');
  await writeFile(
    resolve(prior, 'report.json'),
    JSON.stringify({
      status: '已交付',
      finishedAt: new Date(Date.now() + 1_000).toISOString(),
      tasks: [{ changedFiles: [source] }],
    }),
  );
  const input = {
    root,
    versionDocumentRoot: 'docs/versions/pilot',
    stage: 'design-review',
    approvedTaskIds: ['world-review'],
    previousRunDirectory: prior,
    previousRunStartedAt: startedAt,
    blockedRunDirectory: blocked,
  };
  return { root, prior, blocked, source, sourcePath, input };
}

describe('orphan stage artifact recovery', () => {
  it('allows only independent control commits before the stopped stage run', () => {
    expect(
      areControlOnlyPredecessorPaths([
        'AGENTS.md',
        'docs/status.md',
        'docs/agent-workflow.md',
        'docs/dev/2026-09-27.md',
        'scripts/orphan-stage-artifact.ts',
        'scripts/secretary-notice-guard.ts',
        'test/orphan-stage-artifact.test.ts',
      ]),
    ).toBe(true);
    expect(areControlOnlyPredecessorPaths(['docs/versions/pilot/design-review.md'])).toBe(false);
    expect(areControlOnlyPredecessorPaths(['src/core/world.ts'])).toBe(false);
  });

  it('recognizes only an exact dead-link correction in the review evidence clause', async () => {
    const example = await fixture();
    const path = 'docs/versions/pilot/review.md';
    const file = resolve(example.root, path);
    await writeFile(
      file,
      '结论保持；程序复核见[证据](./tasks/design-review-extra-review.json)。\n',
    );
    execFileSync('git', ['add', path], { cwd: example.root });
    execFileSync('git', ['commit', '-m', 'docs: review'], { cwd: example.root });
    const baseline = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: example.root,
      encoding: 'utf8',
    }).trim();
    await writeFile(
      file,
      '结论保持；程序复核另有本机 `quarantined-task-artifacts/design-review-extra-review.json`，不作为已接纳任务证明。\n',
    );
    execFileSync('git', ['add', path], { cwd: example.root });
    execFileSync('git', ['commit', '-m', 'docs: correct evidence link'], { cwd: example.root });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: example.root,
      encoding: 'utf8',
    }).trim();
    expect(isOrphanEvidenceReferenceCorrection({ root: example.root, baseline, head, path })).toBe(
      true,
    );
    await writeFile(
      file,
      '更改结论；程序复核另有本机 `quarantined-task-artifacts/design-review-extra-review.json`，不作为已接纳任务证明。\n',
    );
    execFileSync('git', ['add', path], { cwd: example.root });
    execFileSync('git', ['commit', '-m', 'docs: change conclusion'], { cwd: example.root });
    const changedHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: example.root,
      encoding: 'utf8',
    }).trim();
    expect(
      isOrphanEvidenceReferenceCorrection({
        root: example.root,
        baseline,
        head: changedHead,
        path,
      }),
    ).toBe(false);
  });

  it("preserves only the previous delivered PM's untracked extra task JSON", async () => {
    const { root, source, sourcePath, input } = await fixture();
    const result = await quarantineOrphanStageArtifact(input);
    expect(result?.source).toBe(source);
    expect(await readFile(result!.destination, 'utf8')).toContain('extra-review');
    expect(JSON.parse(await readFile(result!.auditPath, 'utf8')).source).toBe(source);
    await expect(stat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    ).toBe('');
  });

  it('leaves ambiguous work untouched', async () => {
    const { prior, sourcePath, input } = await fixture();
    await writeFile(
      resolve(prior, 'report.json'),
      JSON.stringify({ status: '已交付', finishedAt: new Date().toISOString(), tasks: [] }),
    );
    expect(await quarantineOrphanStageArtifact(input)).toBeNull();
    expect(await readFile(sourcePath, 'utf8')).toContain('extra-review');
    expect(
      await quarantineOrphanStageArtifact({ ...input, approvedTaskIds: ['extra-review'] }),
    ).toBeNull();
  });

  it('does not move files when another writer or another untracked file may be present', async () => {
    const active = await fixture();
    await writeFile(resolve(active.blocked, 'progress.json'), '{}');
    expect(await quarantineOrphanStageArtifact(active.input)).toBeNull();
    expect(await readFile(active.sourcePath, 'utf8')).toContain('extra-review');

    const mixed = await fixture();
    await writeFile(resolve(mixed.root, 'notes.txt'), 'user work\n');
    expect(await quarantineOrphanStageArtifact(mixed.input)).toBeNull();
    expect(await readFile(mixed.sourcePath, 'utf8')).toContain('extra-review');
  });

  it('keeps a referenced extra artifact in place for an explicit link correction', async () => {
    const example = await fixture();
    await writeFile(
      resolve(example.root, 'docs/versions/pilot/review.md'),
      '[supplement](./tasks/design-review-extra-review.json)\n',
    );
    execFileSync('git', ['add', 'docs/versions/pilot/review.md'], { cwd: example.root });
    execFileSync('git', ['commit', '-m', 'docs: reference supplement'], { cwd: example.root });
    expect(await quarantineOrphanStageArtifact(example.input)).toBeNull();
    expect(await readFile(example.sourcePath, 'utf8')).toContain('extra-review');
  });
});
