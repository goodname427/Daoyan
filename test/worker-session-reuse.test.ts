import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formalDocumentSessionKey,
  formalDocumentContextPolicy,
  formalDocumentTaskId,
  readWorkerSession,
  reusableWorkerSession,
  saveWorkerSession,
  workerSessionId,
  workerInvocationArgs,
} from '../scripts/worker-session-reuse';

const sessionId = '01a0e719-c049-7763-8817-dcb528f48f95';
const direction = (revision: number, paths: string[], contextPolicy?: 'continue' | 'fresh') =>
  `[formal-stage-deliverable:module-design:world-theory]
只完成本合同：
${JSON.stringify({ id: 'theory-repair', scopeRevision: revision, writePaths: paths, contextPolicy })}
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
    expect(formalDocumentTaskId(direction(13, [path]))).toBe('theory-repair');
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
        reusableWorkerSession(await readWorkerSession(temporary, key), key, 'gpt-6-sol', 'high'),
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

  it('uses an explicit saved id for resume and persists only eligible fresh work', () => {
    const base = ['exec', '--ephemeral', '--sandbox', 'workspace-write'];
    expect(workerInvocationArgs(base, 'gpt-6-sol', 'high', 'output.md', true, null)).toEqual([
      'exec',
      '--sandbox',
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
      '-o',
      'output.md',
      sessionId,
      '-',
    ]);
  });
});
