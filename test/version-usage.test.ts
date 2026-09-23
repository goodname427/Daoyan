import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSecretaryState, itemFromIntake } from '../scripts/secretary-state';
import { parseInvocationTokens, versionStageUsage } from '../scripts/version-usage';

let directory = '';
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

describe('version stage usage', () => {
  it('reads the last published token footer only', () => {
    expect(parseInvocationTokens('tokens used\n1,200\nnoise\ntokens used\n3,400')).toBe(3400);
    expect(parseInvocationTokens('unfinished call')).toBeNull();
  });

  it('counts observed calls and unknown usage without treating missing data as zero', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'daoyan-usage-'));
    await writeFile(resolve(directory, 'task-gpt-6-sol-attempt-1.log'), 'tokens used\n120,000');
    await writeFile(resolve(directory, 'review-1-gpt-6-sol-attempt-1.log'), 'interrupted');
    await writeFile(resolve(directory, 'fast-verify-1.log'), 'not a model call');
    const state = createSecretaryState('2026-09-23T00:00:00.000Z');
    const item = itemFromIntake(
      { id: 'stage', idea: '执行版本', createdAt: state.initializedAt },
      [],
    ).item;
    item.runDirectory = directory;
    item.orchestration!.formalVersionId = 'version-1';
    item.orchestration!.formalStage = 'candidate';
    state.items.push(item);
    expect(await versionStageUsage('version-1', 'candidate', state.items)).toEqual({
      observedCalls: 2,
      knownTokens: 120000,
      missingUsageCalls: 1,
      unavailableRunDirectories: 0,
      referenceTokens: 120000,
      overReference: false,
      source: 'invocation-logs',
    });
    expect(
      (await versionStageUsage('other-version', 'candidate', state.items)).knownTokens,
    ).toBeNull();
    item.runDirectory = resolve(directory, 'removed');
    expect(await versionStageUsage('version-1', 'candidate', state.items)).toEqual(
      expect.objectContaining({
        observedCalls: 0,
        knownTokens: null,
        unavailableRunDirectories: 1,
      }),
    );
  });
});
