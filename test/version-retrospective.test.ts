import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { itemFromIntake } from '../scripts/secretary-state';
import { createFormalVersion } from '../scripts/version-lifecycle';
import {
  buildVersionRetrospective,
  writeVersionRetrospective,
} from '../scripts/version-retrospective';

let directory = '';
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

describe('version retrospective', () => {
  it('keeps unknown calls separate and writes one stable archive snapshot', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'daoyan-retrospective-'));
    const version = createFormalVersion({
      id: 'pilot-retro',
      title: '流程试验',
      direction: '核对工作流',
      documentRoot: 'docs/versions/pilot-retro',
      currentStage: 'archived',
      workflowRevision: 2,
      now: '2026-09-27T00:00:00.000Z',
    });
    version.approvals.push({
      id: 'return-1',
      stage: 'design-review',
      reviewer: 'lead-designer',
      decision: 'changes-requested',
      documentRevision: '1',
      comment: '接口未闭合',
      createdAt: version.createdAt,
    });
    const item = itemFromIntake(
      { id: 'run', idea: '执行正式版本', createdAt: version.createdAt },
      [],
    ).item;
    item.runDirectory = directory;
    item.recoveryAttempts = 1;
    item.orchestration!.formalVersionId = version.id;
    item.orchestration!.formalStage = 'module-design';
    await writeFile(resolve(directory, 'planner.log'), 'tokens used\n1,200');
    await writeFile(resolve(directory, 'worker-gpt-6-luna-attempt-1.log'), 'interrupted');

    const report = await buildVersionRetrospective(version, [item]);
    expect(report.totals).toEqual(
      expect.objectContaining({
        observedCalls: 2,
        knownTokensLowerBound: 1200,
        missingUsageCalls: 1,
        stageRuns: 1,
        recoveryAttempts: 1,
        designReturns: 1,
      }),
    );
    const path = await writeVersionRetrospective(directory, version, [item]);
    const first = await readFile(resolve(directory, path), 'utf8');
    expect(first).toContain('已知 token 下界：1200');
    expect(first).toContain('策划退回：1');
    await writeFile(resolve(directory, 'planner.log'), 'tokens used\n9,999');
    expect(await writeVersionRetrospective(directory, version, [item])).toBe(path);
    expect(await readFile(resolve(directory, path), 'utf8')).toBe(first);
  });
});
