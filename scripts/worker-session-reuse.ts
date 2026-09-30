import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface WorkerSession {
  key: string;
  sessionId: string;
  model: string;
  reasoning: string;
  turns: number;
  knownTokens: number | null;
  updatedAt: string;
  ownerTaskId?: string;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type DocumentContextPolicy = 'auto' | 'continue' | 'fresh';

interface FormalStageContext {
  stage: string;
  taskId: string;
  versionId: string;
  scopeRevision: number;
  stageStep: string;
  contract: Record<string, unknown>;
}

function formalStageContext(direction: string): FormalStageContext | null {
  const header = direction.match(
    /^\[formal-stage-(?:deliverable|verification):([a-z][a-z-]*):([a-zA-Z0-9_-]+)\]\n你是此项有界交付的 Feature PM。版本 ([a-z0-9._-]+)，节点 ([a-z][a-z-]*)，范围修订 (\d+)。/u,
  );
  if (!header || header[1] !== header[4]) return null;
  const prefix = '只完成本合同：\n';
  const suffix = '\n直接前驱的有限证据索引：';
  const start = direction.indexOf(prefix);
  const end = start < 0 ? -1 : direction.indexOf(suffix, start + prefix.length);
  if (end < 0) return null;
  try {
    const value: unknown = JSON.parse(direction.slice(start + prefix.length, end));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const contract = value as Record<string, unknown>;
    const scopeRevision = Number(header[5]);
    if (
      contract.id !== header[2] ||
      contract.stage !== header[1] ||
      contract.scopeRevision !== scopeRevision ||
      !Number.isSafeInteger(scopeRevision) ||
      !Array.isArray(contract.writePaths) ||
      !contract.writePaths.every((path) => typeof path === 'string')
    )
      return null;
    const versionRoot = `docs/versions/${header[3]}/`;
    const evidence = contract.writePaths.some(
      (path) =>
        typeof path === 'string' &&
        path.replaceAll('\\', '/').startsWith(`${versionRoot}tasks/`) &&
        path.replaceAll('\\', '/').endsWith(`-${header[2]}.json`),
    );
    if (!evidence) return null;
    return {
      stage: header[1],
      taskId: header[2],
      versionId: header[3],
      scopeRevision,
      stageStep: typeof contract.stageStep === 'string' ? contract.stageStep : 'primary',
      contract,
    };
  } catch {
    return null;
  }
}

function formalDocumentContract(direction: string): Record<string, unknown> | null {
  if (!/^\[formal-stage-deliverable:module-design:[a-zA-Z0-9_-]+\]/u.test(direction)) return null;
  const prefix = '只完成本合同：\n';
  const suffix = '\n直接前驱的有限证据索引：';
  const start = direction.indexOf(prefix);
  const end = start < 0 ? -1 : direction.indexOf(suffix, start + prefix.length);
  if (end < 0) return null;
  try {
    const value: unknown = JSON.parse(direction.slice(start + prefix.length, end));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Reuse only an exact formal module document within the same approved scope. */
export function formalDocumentSessionKey(direction: string): string | null {
  const contract = formalDocumentContract(direction);
  if (!contract) return null;
  try {
    if (!Number.isSafeInteger(contract.scopeRevision) || !Array.isArray(contract.writePaths))
      return null;
    const documents = contract.writePaths.filter(
      (path): path is string =>
        typeof path === 'string' &&
        /^docs\/versions\/[a-z0-9._-]+\/.+\.md$/i.test(path.replaceAll('\\', '/')) &&
        !path.replaceAll('\\', '/').includes('/tasks/'),
    );
    if (documents.length !== 1) return null;
    return `module-design:${contract.scopeRevision}:${documents[0].replaceAll('\\', '/')}`;
  } catch {
    return null;
  }
}

export interface WorkerSessionScope {
  key: string;
  taskId: string;
  policy: DocumentContextPolicy;
}

/** Reviewers keep their own history, never the writer's editable session. */
export function independentReviewSessionKey(scope: WorkerSessionScope): string {
  return `independent-review:${scope.key}:${scope.taskId}`;
}

/** One rule for formal task execution, node review and their repair rounds. */
export function formalWorkerSessionScope(direction: string): WorkerSessionScope | null {
  const context = formalStageContext(direction);
  if (!context) return null;
  const { stage, taskId, versionId, scopeRevision, stageStep, contract } = context;
  const policy =
    contract.contextPolicy === 'continue' || contract.contextPolicy === 'fresh'
      ? contract.contextPolicy
      : 'auto';
  const documentKey = stage === 'module-design' ? formalDocumentSessionKey(direction) : null;
  const versionRoot = `docs/versions/${versionId}/`;
  const writes = (contract.writePaths as string[]).map((path) => path.replaceAll('\\', '/'));
  const artifacts = writes.filter((path) => !path.startsWith(`${versionRoot}tasks/`));
  const documentOnly =
    artifacts.length > 0 && artifacts.every((path) => path.startsWith(versionRoot));
  const key =
    documentKey ??
    (documentOnly
      ? `formal:${stage}:${scopeRevision}:${versionId}:${stageStep}:artifacts:${JSON.stringify(artifacts.sort())}`
      : `formal:${stage}:${scopeRevision}:${versionId}:${stageStep}:task:${taskId}`);
  return { key, taskId, policy };
}

/** Version PM decides whether old reasoning is useful; absent policy preserves old manifests. */
export function formalDocumentContextPolicy(direction: string): DocumentContextPolicy {
  const policy = formalDocumentContract(direction)?.contextPolicy;
  return policy === 'continue' || policy === 'fresh' ? policy : 'auto';
}

export function formalDocumentTaskId(direction: string): string | null {
  const id = formalDocumentContract(direction)?.id;
  return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) ? id : null;
}

export function workerSessionId(output: string): string | null {
  const match = output.match(/(?:^|\n)session id:\s*([0-9a-f-]{36})(?:\s|$)/i);
  return match && SESSION_ID.test(match[1]) ? match[1].toLowerCase() : null;
}

export function reusableWorkerSession(
  entry: WorkerSession | null,
  key: string,
  model: string,
  reasoning: string,
  policy: DocumentContextPolicy = 'auto',
  taskId: string | null = null,
): WorkerSession | null {
  return (policy !== 'fresh' || (taskId !== null && entry?.ownerTaskId === taskId)) &&
    entry?.key === key &&
    SESSION_ID.test(entry.sessionId) &&
    entry.model === model &&
    entry.reasoning === reasoning &&
    entry.turns >= 1
    ? entry
    : null;
}

export function workerInvocationArgs(
  freshArgs: string[],
  model: string,
  reasoning: string,
  outputFile: string,
  persistent: boolean,
  resumeSessionId: string | null,
  resumeOptions: string[] = [],
): string[] {
  if (resumeSessionId) {
    if (!SESSION_ID.test(resumeSessionId)) throw new Error('无效的待续接会话 ID');
    const sandboxFlag = freshArgs.indexOf('-s');
    const approvalFlag = freshArgs.indexOf('-a');
    const sandbox = sandboxFlag >= 0 ? freshArgs[sandboxFlag + 1] : '';
    const approval = approvalFlag >= 0 ? freshArgs[approvalFlag + 1] : '';
    return [
      'exec',
      'resume',
      '-m',
      model,
      '-c',
      `model_reasoning_effort="${reasoning}"`,
      ...(sandbox === 'read-only' || sandbox === 'workspace-write'
        ? ['-c', `sandbox_mode="${sandbox}"`]
        : []),
      ...(approval === 'never' ? ['-c', 'approval_policy="never"'] : []),
      ...resumeOptions,
      '-o',
      outputFile,
      resumeSessionId,
      '-',
    ];
  }
  return [
    ...freshArgs.filter((arg) => !persistent || arg !== '--ephemeral'),
    '-o',
    outputFile,
    '-',
  ];
}

function sessionPath(root: string, key: string, model: string, reasoning: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([key, model, reasoning]))
    .digest('hex');
  return resolve(root, '.daoyan-agent', 'worker-sessions', `${digest}.json`);
}

export async function readWorkerSession(
  root: string,
  key: string,
  model: string,
  reasoning: string,
): Promise<WorkerSession | null> {
  const legacyPath = resolve(
    root,
    '.daoyan-agent',
    'worker-sessions',
    `${createHash('sha256').update(key).digest('hex')}.json`,
  );
  for (const path of [sessionPath(root, key, model, reasoning), legacyPath]) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as WorkerSession;
      if (
        value.key === key &&
        value.model === model &&
        value.reasoning === reasoning &&
        SESSION_ID.test(value.sessionId)
      ) {
        return value;
      }
    } catch {
      // A missing or damaged slot cannot authorize cross-model reuse.
    }
  }
  return null;
}

export async function saveWorkerSession(root: string, entry: WorkerSession): Promise<void> {
  if (!SESSION_ID.test(entry.sessionId) || entry.turns < 1) throw new Error('无效执行会话记录');
  const path = sessionPath(root, entry.key, entry.model, entry.reasoning);
  await mkdir(resolve(root, '.daoyan-agent', 'worker-sessions'), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}
