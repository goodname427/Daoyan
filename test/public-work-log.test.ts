import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendPublicWorkEvent,
  projectPublicWorkEvent,
  readPublicWorkEvents,
  totalKnownTokenUsage,
  summarizePublicTiming,
} from '../scripts/public-work-log';

describe('public work log', () => {
  it('binds generated ids to execution round and revision and separates six timing categories', () => {
    const event = projectPublicWorkEvent({
      sequence: 1,
      runId: 'run-a',
      executionRound: 2,
      codeRevision: 'abc123',
      timeCategory: 'command-execution',
      durationMs: 40,
      kind: 'test',
      payload: { command: 'npm test', scope: 'task', exitCode: 0, status: 'passed' },
    });
    expect(event.eventId).toContain('r2:abc123');
    expect(summarizePublicTiming([event])).toEqual({
      'model-compute': null,
      'command-execution': 40,
      'waiting-producer': null,
      'waiting-quota': null,
      recovery: null,
      idle: null,
    });
  });
  it('projects only explicit public fields and rejects private reasoning', () => {
    const event = projectPublicWorkEvent({
      sequence: 1,
      runId: 'run-1',
      executionRound: 3,
      codeRevision: 'revision-3',
      kind: 'test',
      payload: {
        command: 'npm test -- focused',
        scope: 'orchestration',
        exitCode: 1,
        errorSummary: 'token=private C:\\Users\\dev\\secret.log',
        ignored: 'must not be persisted',
      },
      tokenUsage: {},
    });

    expect(event.payload).not.toHaveProperty('ignored');
    expect(event.payload.errorSummary).not.toContain('private');
    expect(event.payload.errorSummary).not.toContain('C:\\Users');
    expect(event.tokenUsage.total).toBeNull();
    expect(() =>
      projectPublicWorkEvent({
        sequence: 2,
        executionRound: 3,
        codeRevision: 'revision-3',
        kind: 'action',
        payload: { action: '实现', reasoning: '私有思维链' },
      }),
    ).toThrow('禁止接收私有字段');
    expect(() =>
      projectPublicWorkEvent({
        sequence: 3,
        executionRound: 1,
        codeRevision: 'unknown',
        kind: 'action',
        payload: { action: '执行' },
      }),
    ).toThrow('真实代码修订');
  });

  it('deduplicates events, resumes from a cursor and counts tokens once per run', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'daoyan-public-log-'));
    const path = resolve(directory, 'events.jsonl');
    try {
      await appendPublicWorkEvent(path, {
        eventId: 'usage-1',
        sequence: 0,
        runId: 'run-1',
        executionRound: 2,
        codeRevision: 'revision-a',
        kind: 'usage',
        payload: { source: 'report' },
        tokenUsage: { total: 120, source: 'report' },
      });
      await appendPublicWorkEvent(path, {
        eventId: 'usage-1',
        sequence: 0,
        runId: 'run-1',
        executionRound: 3,
        codeRevision: 'revision-b',
        kind: 'usage',
        payload: { source: 'report' },
        tokenUsage: { total: 140, source: 'report' },
      });
      await appendPublicWorkEvent(path, {
        eventId: 'usage-1',
        sequence: 0,
        runId: 'run-1',
        executionRound: 2,
        codeRevision: 'revision-a',
        kind: 'usage',
        payload: { source: 'report' },
        tokenUsage: { total: 120, source: 'report' },
      });
      await appendPublicWorkEvent(path, {
        eventId: 'progress-1',
        sequence: 0,
        runId: 'run-1',
        executionRound: 2,
        codeRevision: 'revision-a',
        kind: 'progress',
        payload: { stage: '实现', summary: '已完成', completed: 1, total: 1 },
      });

      const events = await readPublicWorkEvents(path);
      expect(events).toHaveLength(3);
      expect((await readPublicWorkEvents(path, 1)).map((event) => event.eventId)).toEqual([
        'usage-1:r3:revision-b',
        'progress-1:r2:revision-a',
      ]);
      expect(totalKnownTokenUsage(events)).toBe(140);
      expect(totalKnownTokenUsage([events[2]])).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serializes concurrent appends without duplicate ids or sequence numbers', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'daoyan-public-log-concurrent-'));
    const path = resolve(directory, 'events.jsonl');
    try {
      await Promise.all([
        ...Array.from({ length: 12 }, (_, index) =>
          appendPublicWorkEvent(path, {
            eventId: `progress-${index}`,
            sequence: 0,
            runId: 'run-concurrent',
            executionRound: 4,
            codeRevision: 'revision-concurrent',
            kind: 'progress' as const,
            payload: { stage: '测试', summary: `事件 ${index}`, completed: index, total: 12 },
          }),
        ),
        appendPublicWorkEvent(path, {
          eventId: 'progress-0',
          sequence: 0,
          runId: 'run-concurrent',
          executionRound: 4,
          codeRevision: 'revision-concurrent',
          kind: 'progress',
          payload: { stage: '测试', summary: '重复事件', completed: 0, total: 12 },
        }),
      ]);

      const events = await readPublicWorkEvents(path);
      expect(events).toHaveLength(12);
      expect(events.map((event) => event.sequence)).toEqual(
        Array.from({ length: 12 }, (_, index) => index + 1),
      );
      expect((await readFile(path, 'utf8')).trim().split(/\r?\n/)).toHaveLength(12);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
