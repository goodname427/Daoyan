import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const PUBLIC_WORK_EVENT_KINDS = [
  'input',
  'plan',
  'progress',
  'action',
  'file',
  'test',
  'error',
  'decision',
  'blocker',
  'usage',
] as const;

export type PublicWorkEventKind = (typeof PUBLIC_WORK_EVENT_KINDS)[number];
export const PUBLIC_TIME_CATEGORIES = [
  'model-compute',
  'command-execution',
  'waiting-producer',
  'waiting-quota',
  'recovery',
  'idle',
] as const;
export type PublicTimeCategory = (typeof PUBLIC_TIME_CATEGORIES)[number];

export interface PublicTokenUsage {
  input: number | null;
  output: number | null;
  total: number | null;
  source: string;
}

export interface PublicWorkEvent {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  requestId: string;
  versionId: string;
  itemId: string;
  runId: string;
  agentId: string;
  executionRound: number;
  codeRevision: string;
  timeCategory: PublicTimeCategory | null;
  kind: PublicWorkEventKind;
  payload: Record<string, string | number | boolean | string[] | null>;
  createdAt: string;
  durationMs: number | null;
  tokenUsage: PublicTokenUsage;
}

const PAYLOAD_FIELDS: Record<PublicWorkEventKind, readonly string[]> = {
  input: ['summary', 'source'],
  plan: ['stage', 'summary', 'status'],
  progress: ['stage', 'summary', 'completed', 'total'],
  action: ['action', 'summary', 'status'],
  file: ['path', 'action'],
  test: ['command', 'scope', 'exitCode', 'status', 'errorSummary'],
  error: ['summary', 'code', 'recoverable'],
  decision: ['summary', 'basis', 'status'],
  blocker: ['summary', 'category', 'recoveryCondition'],
  usage: ['source'],
};

const PRIVATE_FIELDS = new Set([
  'reasoning',
  'thought',
  'thoughts',
  'chainOfThought',
  'privateReasoning',
  'rawOutput',
  'prompt',
  'secret',
  'token',
  'credential',
]);

const publicWorkLogQueues = new Map<string, Promise<void>>();

function cleanText(value: string): string {
  return value
    .replace(/(api[_-]?key|secret|token|authorization|cookie)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/[A-Za-z]:\\[^\s]+/g, '[local-path]')
    .slice(0, 2_000);
}

function publicValue(value: unknown): string | number | boolean | string[] | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return cleanText(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.map((item) => cleanText(item)).slice(0, 100);
  }
  return undefined;
}

function scopedEventId(
  eventId: string | undefined,
  runId: string | undefined,
  executionRound: number,
  codeRevision: string,
): string {
  const base = cleanText(eventId ?? `${runId ?? 'run'}:${randomUUID()}`);
  if (/:r\d+:[^:]+$/.test(base)) return base;
  return `${base}:r${executionRound}:${cleanText(codeRevision)}`;
}

export function projectPublicWorkEvent(input: {
  eventId?: string;
  sequence: number;
  requestId?: string;
  versionId?: string;
  itemId?: string;
  runId?: string;
  agentId?: string;
  executionRound: number;
  codeRevision: string;
  timeCategory?: PublicTimeCategory | null;
  kind: PublicWorkEventKind;
  payload: Record<string, unknown>;
  createdAt?: string;
  durationMs?: number | null;
  tokenUsage?: Partial<PublicTokenUsage>;
}): PublicWorkEvent {
  if (!PUBLIC_WORK_EVENT_KINDS.includes(input.kind)) throw new Error('公开日志事件类型无效');
  if (!Number.isSafeInteger(input.executionRound) || input.executionRound <= 0) {
    throw new Error('公开日志必须包含真实执行轮次');
  }
  if (!input.codeRevision.trim() || input.codeRevision === 'unknown') {
    throw new Error('公开日志必须包含真实代码修订');
  }
  for (const field of Object.keys(input.payload)) {
    if (PRIVATE_FIELDS.has(field)) throw new Error(`公开日志禁止接收私有字段：${field}`);
  }
  const payload: PublicWorkEvent['payload'] = {};
  for (const field of PAYLOAD_FIELDS[input.kind]) {
    const value = publicValue(input.payload[field]);
    if (value !== undefined) payload[field] = value;
  }
  const usage = input.tokenUsage ?? {};
  const tokenUsage: PublicTokenUsage = {
    input: Number.isFinite(usage.input) ? Number(usage.input) : null,
    output: Number.isFinite(usage.output) ? Number(usage.output) : null,
    total: Number.isFinite(usage.total) ? Number(usage.total) : null,
    source: cleanText(usage.source ?? 'unavailable'),
  };
  return {
    schemaVersion: 1,
    eventId: scopedEventId(input.eventId, input.runId, input.executionRound, input.codeRevision),
    sequence: input.sequence,
    requestId: input.requestId ?? '',
    versionId: input.versionId ?? '',
    itemId: input.itemId ?? '',
    runId: input.runId ?? '',
    agentId: input.agentId ?? '',
    executionRound: input.executionRound,
    codeRevision: cleanText(input.codeRevision),
    timeCategory:
      input.timeCategory && PUBLIC_TIME_CATEGORIES.includes(input.timeCategory)
        ? input.timeCategory
        : null,
    kind: input.kind,
    payload,
    createdAt: input.createdAt ?? new Date().toISOString(),
    durationMs: Number.isFinite(input.durationMs) ? Number(input.durationMs) : null,
    tokenUsage,
  };
}

export async function appendPublicWorkEvent(
  path: string,
  input: Parameters<typeof projectPublicWorkEvent>[0],
): Promise<PublicWorkEvent> {
  let result: PublicWorkEvent | undefined;
  const previous = publicWorkLogQueues.get(path) ?? Promise.resolve();
  const queued = previous
    .catch(() => undefined)
    .then(async () => {
      const existing = await readPublicWorkEvents(path);
      const eventId = scopedEventId(
        input.eventId,
        input.runId,
        input.executionRound,
        input.codeRevision,
      );
      const duplicate = existing.find((event) => event.eventId === eventId);
      if (duplicate) {
        result = duplicate;
        return;
      }
      const event = projectPublicWorkEvent({
        ...input,
        eventId,
        sequence:
          existing.reduce((highest, candidate) => Math.max(highest, candidate.sequence), 0) + 1,
      });
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
      result = event;
    });
  publicWorkLogQueues.set(path, queued);
  try {
    await queued;
  } finally {
    if (publicWorkLogQueues.get(path) === queued) publicWorkLogQueues.delete(path);
  }
  if (!result) throw new Error('公开日志事件写入未完成');
  return result;
}

export async function readPublicWorkEvents(
  path: string,
  afterSequence = 0,
): Promise<PublicWorkEvent[]> {
  const content = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const byId = new Map<string, PublicWorkEvent>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as PublicWorkEvent;
    if (event.schemaVersion !== 1) throw new Error('公开日志包含不支持的事件版本');
    if (!byId.has(event.eventId)) byId.set(event.eventId, event);
  }
  return [...byId.values()]
    .filter((event) => event.sequence > afterSequence)
    .sort((left, right) => left.sequence - right.sequence);
}

export function totalKnownTokenUsage(events: PublicWorkEvent[]): number | null {
  const byRun = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== 'usage' || event.tokenUsage.total === null) continue;
    const key = event.runId || event.eventId;
    byRun.set(key, Math.max(byRun.get(key) ?? 0, event.tokenUsage.total));
  }
  return byRun.size > 0 ? [...byRun.values()].reduce((sum, value) => sum + value, 0) : null;
}

export function summarizePublicTiming(
  events: PublicWorkEvent[],
): Record<PublicTimeCategory, number | null> {
  const result = Object.fromEntries(
    PUBLIC_TIME_CATEGORIES.map((category) => [category, null]),
  ) as Record<PublicTimeCategory, number | null>;
  for (const event of events) {
    if (!event.timeCategory || event.durationMs === null) continue;
    result[event.timeCategory] = (result[event.timeCategory] ?? 0) + event.durationMs;
  }
  return result;
}
