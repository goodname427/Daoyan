import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formalDocumentSessionKey,
  formalDocumentContextPolicy,
  formalDocumentTaskId,
  formalWorkerSessionScope,
  independentReviewSessionKey,
  readWorkerSession,
  reusableWorkerSession,
  saveWorkerSession,
  workerSessionId,
  workerInvocationArgs,
} from '../scripts/worker-session-reuse';

const sessionId = '01a0e719-c049-7763-8817-dcb528f48f95';
const direction = (revision: number, paths: string[], contextPolicy?: 'continue' | 'fresh') =>
  `[formal-stage-deliverable:module-design:world-theory]
你是此项有界交付的 Feature PM。版本 pilot，节点 module-design，范围修订 ${revision}。这是已批准版本内的一项任务。
只完成本合同：
${JSON.stringify({ id: 'world-theory', stage: 'module-design', scopeRevision: revision, writePaths: paths, contextPolicy })}
直接前驱的有限证据索引：[]。来源是线索`;

describe('formal document worker sessions', () => {
  it('keys one module document by approved scope and rejects unrelated work', () => {
    const path = 'docs/versions/pilot/world-theory-draft.md';
    const key = formalDocumentSessionKey(
      direction(13, [path, 'docs/versions/pilot/tasks/module-design-world-theory.json']),
    );
    expect(key).toBe(`module-design:13:${path}`);
    expect(formalDocumentSessionKey(direction(14, [path]))).not.toBe(key);
    expect(
      formalDocumentSessionKey(direction(13, [path, 'docs/versions/pilot/player-bridge.md'])),
    ).toBeNull();
    expect(formalDocumentSessionKey('普通开发任务')).toBeNull();
    expect(formalDocumentContextPolicy(direction(13, [path], 'continue'))).toBe('continue');
    expect(formalDocumentContextPolicy(direction(13, [path], 'fresh'))).toBe('fresh');
    expect(formalDocumentContextPolicy(direction(13, [path]))).toBe('auto');
    expect(formalDocumentTaskId(direction(13, [path]))).toBe('world-theory');
  });

  it('keeps review returns in the same formal scope across code and document nodes', () => {
    const formal = (
      stage: string,
      taskId: string,
      revision: number,
      paths: string[],
      contextPolicy?: 'continue' | 'fresh',
    ) => `[formal-stage-deliverable:${stage}:${taskId}]
你是此项有界交付的 Feature PM。版本 pilot，节点 ${stage}，范围修订 ${revision}。这是已批准版本内的一项任务。
只完成本合同：
${JSON.stringify({ id: taskId, stage, stageStep: 'primary', scopeRevision: revision, writePaths: paths, contextPolicy })}
直接前驱的有限证据索引：[]。来源是线索`;
    const devPaths = ['src/core', 'docs/versions/pilot/tasks/development-dev-world-a2.json'];
    const dev = formalWorkerSessionScope(formal('development', 'dev-world-a2', 13, devPaths));
    expect(dev).toEqual({
      key: 'formal:development:13:pilot:primary:task:dev-world-a2',
      taskId: 'dev-world-a2',
      policy: 'auto',
    });
    expect(independentReviewSessionKey(dev!)).toBe(
      'independent-review:formal:development:13:pilot:primary:task:dev-world-a2:dev-world-a2',
    );
    expect(independentReviewSessionKey(dev!)).not.toBe(dev?.key);
    expect(
      formalWorkerSessionScope(formal('development', 'dev-world-a3', 13, devPaths)),
    ).toBeNull();
    expect(
      formalWorkerSessionScope(formal('development', 'dev-world-a2', 14, devPaths))?.key,
    ).not.toBe(dev?.key);
    const reviewPath = 'docs/versions/pilot/design-review.md';
    const first = formalWorkerSessionScope(
      formal('design-review', 'drb7', 13, [
        reviewPath,
        'docs/versions/pilot/tasks/design-review-drb7.json',
      ]),
    );
    const next = formalWorkerSessionScope(
      formal(
        'design-review',
        'drb8',
        13,
        [reviewPath, 'docs/versions/pilot/tasks/design-review-drb8.json'],
        'fresh',
      ),
    );
    expect(next?.key).toBe(first?.key);
    expect(next?.policy).toBe('fresh');
    expect(next?.taskId).toBe('drb8');
    expect(
      formalWorkerSessionScope(
        formal('design-review', 'drb8', 14, [
          reviewPath,
          'docs/versions/pilot/tasks/design-review-drb8.json',
        ]),
      )?.key,
    ).not.toBe(first?.key);
    expect(formalWorkerSessionScope('普通 Feature 任务')).toBeNull();
  });

  it('reuses an exact session without a fixed turn cap and honors a fresh decision', async () => {
    expect(workerSessionId(`Codex CLI\nsession id: ${sessionId}\n`)).toBe(sessionId);
    expect(workerSessionId('session id: not-a-session')).toBeNull();
    const temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-worker-session-'));
    const key = 'module-design:13:docs/versions/pilot/world-theory-draft.md';
    try {
      const entry = {
        key,
        sessionId,
        model: 'gpt-6-sol',
        reasoning: 'high',
        turns: 1,
        knownTokens: 70_000,
        updatedAt: '2026-09-28T00:00:00.000Z',
        ownerTaskId: 'prior-repair',
      };
      await saveWorkerSession(temporary, entry);
      expect(
        reusableWorkerSession(
          await readWorkerSession(temporary, key, 'gpt-6-sol', 'high'),
          key,
          'gpt-6-sol',
          'high',
        ),
      ).toEqual(entry);
      expect(reusableWorkerSession(entry, key, 'gpt-6-astra', 'high')).toBeNull();
      expect(reusableWorkerSession({ ...entry, turns: 20 }, key, 'gpt-6-sol', 'high')).toEqual({
        ...entry,
        turns: 20,
      });
      expect(reusableWorkerSession(entry, key, 'gpt-6-sol', 'high', 'fresh')).toBeNull();
      expect(
        reusableWorkerSession(entry, key, 'gpt-6-sol', 'high', 'fresh', 'prior-repair'),
      ).toEqual(entry);
      expect(reusableWorkerSession(entry, `${key}-other`, 'gpt-6-sol', 'high')).toBeNull();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('keeps different model sessions for the same document without overwriting either', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-model-sessions-'));
    const key = 'module-design:13:docs/versions/pilot/world-theory-draft.md';
    const entry = {
      key,
      sessionId,
      model: 'gpt-6-sol',
      reasoning: 'high',
      turns: 1,
      knownTokens: 70_000,
      updatedAt: '2026-09-28T00:00:00.000Z',
    };
    const luna = {
      ...entry,
      sessionId: '01a0e770-b0bb-7c10-ab50-65ea44fcb29b',
      model: 'gpt-6-luna',
      reasoning: 'medium',
    };
    try {
      await saveWorkerSession(temporary, entry);
      await saveWorkerSession(temporary, luna);
      expect(await readWorkerSession(temporary, key, 'gpt-6-sol', 'high')).toEqual(entry);
      expect(await readWorkerSession(temporary, key, 'gpt-6-luna', 'medium')).toEqual(luna);
      expect(await readWorkerSession(temporary, key, 'gpt-6-sol', 'medium')).toBeNull();
      const legacyDirectory = resolve(temporary, '.daoyan-agent', 'worker-sessions');
      await mkdir(legacyDirectory, { recursive: true });
      await writeFile(
        resolve(legacyDirectory, `${createHash('sha256').update(key).digest('hex')}.json`),
        JSON.stringify({ ...entry, model: 'gpt-6-astra' }),
      );
      expect(await readWorkerSession(temporary, key, 'gpt-6-astra', 'high')).toEqual({
        ...entry,
        model: 'gpt-6-astra',
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('uses an explicit saved id for resume and persists only eligible fresh work', () => {
    const base = ['-a', 'never', 'exec', '--ephemeral', '-s', 'workspace-write'];
    expect(workerInvocationArgs(base, 'gpt-6-sol', 'high', 'output.md', true, null)).toEqual([
      '-a',
      'never',
      'exec',
      '-s',
      'workspace-write',
      '-o',
      'output.md',
      '-',
    ]);
    expect(workerInvocationArgs(base, 'gpt-6-sol', 'high', 'output.md', false, null)).toContain(
      '--ephemeral',
    );
    expect(workerInvocationArgs(base, 'gpt-6-sol', 'high', 'output.md', true, sessionId)).toEqual([
      'exec',
      'resume',
      '-m',
      'gpt-6-sol',
      '-c',
      'model_reasoning_effort="high"',
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'approval_policy="never"',
      '-o',
      'output.md',
      sessionId,
      '-',
    ]);
    expect(
      workerInvocationArgs(
        ['-a', 'never', 'exec', '-s', 'read-only'],
        'gpt-6-sol',
        'high',
        'review.json',
        true,
        sessionId,
        ['--output-schema', 'review.schema.json'],
      ),
    ).toEqual([
      'exec',
      'resume',
      '-m',
      'gpt-6-sol',
      '-c',
      'model_reasoning_effort="high"',
      '-c',
      'sandbox_mode="read-only"',
      '-c',
      'approval_policy="never"',
      '--output-schema',
      'review.schema.json',
      '-o',
      'review.json',
      sessionId,
      '-',
    ]);
  });
});
