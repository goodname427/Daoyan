import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canRebaseEmptyRecovery,
  advanceReviewStall,
  canReuseFullGateEvidence,
  changedPathsSinceWorkspaceBaseline,
  commitBodyForPlan,
  conventionalCommitOrFallback,
  canResumeCompletedCommit,
  buildLocalPlan,
  classifyAgentFailure,
  escalateTier,
  fastGateCommandProgress,
  failedNpmCommandFromOutput,
  highestTier,
  isSafeRunId,
  optimizePlan,
  planTaskLimit,
  npmRunCommandsFromScript,
  pendingValidationStages,
  preferredWindowsExecutable,
  resolveProducerDirection,
  reviewRoutesForPlan,
  routeForTask,
  selectReusableTaskIds,
  sortTasks,
  taskInputPaths,
  taskOutputPaths,
  relativeModuleSpecifiers,
  recoveryCountersAfterResume,
  validationProfileForPlan,
  validationStagesForPlan,
  validatePlan,
  validatePolicy,
  validateReview,
  type ModelRoute,
  type PlannedTask,
  type ReviewResult,
  type TaskPlan,
  type WorkspaceChangeBaseline,
} from './agent-routing';
import { candidateManifestPath, parseCandidateEvidence } from './candidate-evidence';
import { endChildInput } from './child-process-input';
import { treeFingerprint as validationTreeFingerprint } from './pre-push-verify.mjs';
import { getProcessIdentity, waitForProcessIdentity } from './process-identity';
import { appendPublicWorkEvent } from './public-work-log';
import { taskDependencyContext } from './task-context';
import { runInvocationUsage } from './version-usage';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policyPath = resolve(root, 'agents/policy.json');
const planSchemaPath = resolve(root, 'agents/plan.schema.json');
const reviewSchemaPath = resolve(root, 'agents/review.schema.json');

interface CliOptions {
  direction: string;
  planOnly: boolean;
  deepPlan: boolean;
  doctor: boolean;
  noPush: boolean;
  takeover: boolean;
  decisionConfirmed: boolean;
  producerGuidance: string;
  resumeDirectory: string | null;
  runId: string | null;
}

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ProcessOptions {
  input?: string;
  logFile?: string;
  stream?: boolean;
  heartbeatLabel?: string;
  progressFile?: string;
  timeoutMs?: number;
  workerModel?: string;
  workerRole?: string;
}

interface TaskRun {
  task: PlannedTask;
  route: ModelRoute;
  attempts: number;
  result: 'passed' | 'failed';
  outputFile: string;
  changedFiles: string[];
  tests: string[];
  tokensUsed: number | null;
  completedAt: string;
  inputPaths?: string[];
  inputFingerprint?: string;
  outputFingerprint?: string;
  commandFingerprint?: string;
  configFingerprint?: string;
}

interface PlannerRun {
  plan: TaskPlan;
  tokensUsed: number | null;
}

interface ReviewRun {
  result: ReviewResult;
  tokensUsed: number | null;
  route: ModelRoute;
  attempts: number;
}

interface ReviewBoundary {
  fingerprint: string;
  files: Map<string, Buffer | null>;
  findings: ReviewResult;
}

interface VerificationRun extends ProcessResult {
  invocation: string[];
  failedCommand: string[];
}

interface ValidationStageFingerprint {
  workspaceFingerprint: string;
  configFingerprint: string;
}

interface FastGateProgress extends ValidationStageFingerprint {
  completedCommands: string[][];
  pendingCommands: string[][];
  passed: boolean;
  attempts: number;
}

interface IndependentReviewProgress extends ValidationStageFingerprint {
  result: ReviewResult;
  passed: boolean;
  attempts: number;
}

interface ValidationProgress {
  fastGate: FastGateProgress | null;
  independentReview: IndependentReviewProgress | null;
}

interface RecoveryCheckpoint {
  version: 1;
  status: 'active' | 'recoverable' | 'waiting-producer' | 'delivered';
  processPid: number;
  processIdentity: string;
  phase: string;
  direction: string;
  resolvedDirection: string;
  baseline: string;
  workspaceFingerprint: string;
  workspaceChangeBaseline?: WorkspaceChangeBaseline;
  plan: TaskPlan;
  taskRuns: TaskRun[];
  review: ReviewResult | null;
  reviewStall?: { signature: string; count: number };
  validationProgress?: ValidationProgress;
  plannerTokens: number | null;
  reviewerTokens: number | null;
  repairerTokens: number | null;
  noPush: boolean;
  takeover?: boolean;
  error: string;
  actualLaunchCount: number | null;
  abnormalRecoveryCount: number | null;
  localRepairRoundCount: number | null;
  updatedAt: string;
}

class AgentCallError extends Error {
  constructor(
    message: string,
    readonly kind: ReturnType<typeof classifyAgentFailure>,
    readonly tokensUsed: number | null,
  ) {
    super(message);
  }
}

function printHelp() {
  console.log(`道衍制作人工作流

用法：
  npm run producer -- "描述产品方向或问题"
  npm run producer:plan -- "描述产品方向或问题"
  npm run producer:resume -- ".daoyan-agent/runs/<运行目录>"

选项：
  --plan-only  只让秘书分析、拆分和分配模型，不修改代码
  --deep-plan  额外调用模型进行规划；默认使用零-token 本地路由
  --doctor     检查 Codex 与 npm 子进程入口，不调用模型
  --no-push    完成交付和提交，但不推送远端
  --takeover   强制秘书接管当前现场，记录快照后保留并审查现有改动
  --decision-confirmed  制作人已对当前不可逆或发布边界给出明确决定
  --producer-guidance  传入制作人决定正文，供恢复后的 Agent 执行
  --resume     从失败运行的恢复点续跑，不重复已完成任务
  --run-id     为版本级调度指定稳定的运行目录名
  --help       显示帮助

完整执行要求开始时 Git 工作区干净；若上一执行 Agent 异常退出并留下受控恢复点，秘书会自动审查并接管遗留改动。若现场需要人工确认过后直接交给秘书，可使用 --takeover；制作人不需要判断任务复杂度。`);
}

function parseArgs(argv: string[]): CliOptions {
  let planOnly = false;
  let deepPlan = false;
  let doctor = false;
  let noPush = false;
  let takeover = false;
  let decisionConfirmed = false;
  let producerGuidance = '';
  let resumeDirectory: string | null = null;
  let runId: string | null = null;
  let resumeRequested = false;
  const direction: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--plan-only') planOnly = true;
    else if (arg === '--deep-plan') deepPlan = true;
    else if (arg === '--doctor') doctor = true;
    else if (arg === '--no-push') noPush = true;
    else if (arg === '--takeover' || arg === '--force-takeover') takeover = true;
    else if (arg === '--decision-confirmed') decisionConfirmed = true;
    else if (arg === '--producer-guidance') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--producer-guidance 后需要决定正文');
      producerGuidance = value;
      index += 1;
    } else if (arg === '--run-id') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--run-id 后需要目录名');
      runId = value;
      index += 1;
    } else if (arg === '--resume') {
      resumeRequested = true;
      const value = argv[index + 1];
      if (value && !value.startsWith('--')) {
        resumeDirectory = value;
        index += 1;
      }
    } else if (resumeRequested && !resumeDirectory) resumeDirectory = arg;
    else direction.push(arg);
  }
  const joined = direction.join(' ').trim();
  if (resumeRequested && !resumeDirectory) throw new Error('--resume 后需要运行目录');
  if (!joined && !doctor && !resumeDirectory) {
    throw new Error('请提供产品方向，例如：npm run producer -- "增加法术单步推演"');
  }
  if (resumeDirectory && (planOnly || deepPlan || doctor)) {
    throw new Error('--resume 不能与 --plan-only、--deep-plan 或 --doctor 同时使用');
  }
  if (resumeDirectory && runId) throw new Error('--resume 不能与 --run-id 同时使用');
  if (runId && !isSafeRunId(runId)) {
    throw new Error('--run-id 只能包含字母、数字、点、下划线和连字符');
  }
  return {
    direction: joined || (doctor ? 'doctor' : 'resume'),
    planOnly,
    deepPlan,
    doctor,
    noPush,
    takeover,
    decisionConfirmed,
    producerGuidance,
    resumeDirectory,
    runId,
  };
}

function executable(name: string, args: string[]): { command: string; args: string[] } {
  const configured = name === 'codex' ? process.env.CODEX_BIN : undefined;
  if (process.platform !== 'win32') return { command: configured ?? name, args };
  const found = spawnSync('where.exe', [name], { encoding: 'utf8' });
  const candidates = found.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const selected = configured ?? preferredWindowsExecutable(candidates) ?? name;
  if (selected.toLowerCase().endsWith('.exe')) return { command: selected, args };

  const base = dirname(selected);
  const entry =
    name === 'codex'
      ? resolve(base, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      : name === 'npm'
        ? resolve(base, 'node_modules', 'npm', 'bin', 'npm-cli.js')
        : null;
  if (entry && existsSync(entry)) {
    return { command: process.execPath, args: [entry, ...args] };
  }
  return { command: selected, args };
}

async function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  return await new Promise((resolvePromise, reject) => {
    const invocation = executable(command, args);
    const startedAt = Date.now();
    const child = spawn(invocation.command, invocation.args, {
      cwd: root,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnFailed = false;
    let workerFinished = false;
    let workerProcessIdentity = '';
    let progressWrites = Promise.resolve();
    const recordProgress = (
      status: 'running' | 'finished' | 'failed' | 'timed_out',
      code?: number,
    ) => {
      if (!options.progressFile || !options.heartbeatLabel) return;
      const progress = {
        phase: options.heartbeatLabel,
        status,
        startedAt: new Date(startedAt).toISOString(),
        updatedAt: new Date().toISOString(),
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        workerPid: status === 'running' ? (child.pid ?? 0) : 0,
        workerProcessIdentity: status === 'running' ? workerProcessIdentity : '',
        workerModel: status === 'running' ? (options.workerModel ?? '') : '',
        workerRole: status === 'running' ? (options.workerRole ?? '') : '',
        ...(code === undefined ? {} : { code }),
      };
      progressWrites = progressWrites.then(() =>
        writeFile(options.progressFile!, `${JSON.stringify(progress, null, 2)}\n`, 'utf8'),
      );
    };
    recordProgress('running');
    if (child.pid) {
      void waitForProcessIdentity(child.pid).then((identity) => {
        if (workerFinished) return;
        workerProcessIdentity = identity;
        recordProgress('running');
      });
    }
    const heartbeat = options.heartbeatLabel
      ? setInterval(() => {
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          console.log(`[等待] ${options.heartbeatLabel} 已运行 ${elapsed} 秒，仍在工作...`);
          recordProgress('running');
        }, policy.timeouts.heartbeatSeconds * 1000)
      : null;
    heartbeat?.unref();
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          const timeoutSeconds = Math.round(options.timeoutMs! / 1000);
          const message = `${options.heartbeatLabel ?? command} 超过 ${timeoutSeconds} 秒限制`;
          stderr += `\n[dispatcher] ${message}\n`;
          console.error(`[超时] ${message}，正在停止该子进程。`);
          recordProgress('timed_out', 124);
          if (child.pid && process.platform === 'win32') {
            spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          } else {
            child.kill('SIGTERM');
          }
        }, options.timeoutMs)
      : null;
    timeout?.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (options.stream) process.stdout.write(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (options.stream) process.stderr.write(text);
    });
    child.on('error', (error) => {
      workerFinished = true;
      spawnFailed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      recordProgress('failed', 1);
      reject(error);
    });
    child.on('close', async (code) => {
      try {
        workerFinished = true;
        if (heartbeat) clearInterval(heartbeat);
        if (timeout) clearTimeout(timeout);
        if (options.logFile) {
          await writeFile(options.logFile, `${stdout}\n--- STDERR ---\n${stderr}`, 'utf8');
        }
        const finalCode = timedOut ? 124 : (code ?? 1);
        recordProgress(timedOut ? 'timed_out' : spawnFailed ? 'failed' : 'finished', finalCode);
        await progressWrites;
        if (options.workerModel && options.progressFile) {
          const codeRevision = await workspaceFingerprint();
          await appendPublicWorkEvent(
            resolve(dirname(options.progressFile), 'public-events.jsonl'),
            {
              eventId: `model-${(
                options.heartbeatLabel ??
                options.workerRole ??
                options.workerModel
              )
                .replace(/[^\p{L}\p{N}_-]+/gu, '-')
                .replace(/^-|-$/g, '')}-${startedAt}`,
              sequence: 0,
              runId: basename(dirname(options.progressFile)),
              agentId: options.workerModel,
              executionRound: activeActualLaunchCount ?? 1,
              codeRevision,
              timeCategory: 'model-compute',
              kind: 'action',
              payload: {
                action: options.workerRole ?? '模型调用',
                summary: options.heartbeatLabel ?? options.workerModel,
                status: finalCode === 0 ? 'passed' : 'failed',
              },
              createdAt: new Date(startedAt).toISOString(),
              durationMs: Date.now() - startedAt,
            },
          );
        }
        resolvePromise({ code: finalCode, stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
    endChildInput(child.stdin, options.input ?? '', (error) => {
      stderr += `\n[dispatcher] 无法向子进程写入输入：${error.message}\n`;
      if (!workerFinished) child.kill('SIGTERM');
    });
  });
}

function minutes(value: number): number {
  return value * 60_000;
}

async function git(args: string[], stream = false): Promise<ProcessResult> {
  return await runProcess('git', args, { stream });
}

async function workspaceFileSnapshot(): Promise<Map<string, string>> {
  const [tracked, untracked] = await Promise.all([
    git(['diff', '--name-only', '-z', 'HEAD', '--']),
    git(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  if (tracked.code !== 0 || untracked.code !== 0) return new Map();
  const paths = new Set(
    `${tracked.stdout}\0${untracked.stdout}`
      .split('\0')
      .map((path) => path.trim())
      .filter(Boolean),
  );
  const snapshot = new Map<string, string>();
  await Promise.all(
    [...paths].map(async (path) => {
      const fingerprint = await readFile(resolve(root, path))
        .then((content) => createHash('sha256').update(content).digest('hex'))
        .catch(() => '[deleted]');
      snapshot.set(path.replace(/\\/g, '/'), fingerprint);
    }),
  );
  return snapshot;
}

async function changedFilesSince(before: Map<string, string>): Promise<string[]> {
  const after = await workspaceFileSnapshot();
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort((left, right) => left.localeCompare(right));
}

function stringFingerprint(values: string[]): string {
  return createHash('sha256').update(values.join('\0')).digest('hex');
}

async function taskPathFingerprint(paths: string[]): Promise<string> {
  const normalized = [...new Set(paths.map((path) => path.replaceAll('\\', '/')))].sort();
  if (normalized.length === 0) return stringFingerprint([]);
  const tracked = await git(['-c', 'core.quotePath=false', 'ls-files', '-z', '--', ...normalized]);
  const untracked = await git([
    '-c',
    'core.quotePath=false',
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    ...normalized,
  ]);
  if (tracked.code !== 0 || untracked.code !== 0) return '';
  const files = [
    ...new Set(`${tracked.stdout}\0${untracked.stdout}`.split('\0').filter(Boolean)),
  ].sort();
  const hash = createHash('sha256');
  for (const path of files) {
    hash.update(path);
    hash.update('\0');
    hash.update(await readFile(resolve(root, path)).catch(() => Buffer.from('[deleted]')));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function filesForTaskPaths(paths: string[]): Promise<string[]> {
  const normalized = [...new Set(paths.map((path) => path.replaceAll('\\', '/')))].sort();
  if (normalized.length === 0) return [];
  const [tracked, untracked] = await Promise.all([
    git(['-c', 'core.quotePath=false', 'ls-files', '-z', '--', ...normalized]),
    git([
      '-c',
      'core.quotePath=false',
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      ...normalized,
    ]),
  ]);
  if (tracked.code !== 0 || untracked.code !== 0) return [];
  return [...new Set(`${tracked.stdout}\0${untracked.stdout}`.split('\0').filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

const moduleDependencyExtensions = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.d.ts',
  '.d.mts',
  '.d.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
];

async function resolveRelativeModule(importer: string, specifier: string): Promise<string | null> {
  const base = resolve(root, dirname(importer), specifier);
  const candidates = [
    base,
    ...moduleDependencyExtensions.map((extension) => `${base}${extension}`),
    ...moduleDependencyExtensions.map((extension) => resolve(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    if (!info?.isFile()) continue;
    const path = relative(root, candidate).replaceAll('\\', '/');
    if (path && !path.startsWith('../') && !isAbsolute(path)) return path;
  }
  return null;
}

async function collectTaskInputPaths(
  declaredPaths: string[],
  changedFiles: string[],
): Promise<string[]> {
  const seedFiles = await filesForTaskPaths([...declaredPaths, ...changedFiles]);
  const dependencies = new Set<string>();
  await Promise.all(
    seedFiles.map(async (path) => {
      const source = await readFile(resolve(root, path), 'utf8').catch(() => '');
      for (const specifier of relativeModuleSpecifiers(source)) {
        const dependency = await resolveRelativeModule(path, specifier);
        if (dependency) dependencies.add(dependency);
      }
    }),
  );
  return taskInputPaths(declaredPaths, [...dependencies]);
}

async function workspaceTreeFingerprint(): Promise<string> {
  // Dispatcher evidence and the pre-push hook must hash the exact same tree.
  // Keeping a second implementation here previously made valid evidence look
  // stale immediately after commit and restarted the whole validation chain.
  return validationTreeFingerprint(root);
}

async function workspaceContentSnapshot(): Promise<Map<string, Buffer | null>> {
  const [tracked, untracked] = await Promise.all([
    git(['-c', 'core.quotePath=false', 'ls-files', '-z']),
    git(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  if (tracked.code !== 0 || untracked.code !== 0) {
    throw new Error('无法建立增量审查边界');
  }
  const paths = [
    ...new Set(`${tracked.stdout}\0${untracked.stdout}`.split('\0').filter(Boolean)),
  ].sort();
  const snapshot = new Map<string, Buffer | null>();
  await Promise.all(
    paths.map(async (path) => {
      snapshot.set(path.replace(/\\/g, '/'), await readFile(resolve(root, path)).catch(() => null));
    }),
  );
  return snapshot;
}

function buffersEqual(left: Buffer | null | undefined, right: Buffer | null | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function reviewFileContent(content: Buffer | null | undefined, maxBytes: number): string {
  if (content === undefined || content === null) return '[deleted or absent]';
  if (content.length > maxBytes) return `[file too large: ${content.length} bytes]`;
  return content.includes(0) ? '[binary content omitted]' : content.toString('utf8');
}

async function reportedTests(outputFile: string): Promise<string[]> {
  const source = await readFile(outputFile, 'utf8').catch(() => '');
  return [
    ...new Set(
      source
        .split(/\r?\n/)
        .map((line) =>
          line
            .replace(/^\s*(?:[-*]|\d+\.)\s*/, '')
            .replaceAll('`', '')
            .trim(),
        )
        .filter((line) =>
          /\b(?:npm|pnpm|yarn|npx)\s+(?:run\s+)?(?:test|verify|lint|typecheck|build|coverage|sandbox)\b/i.test(
            line,
          ),
        )
        .map((line) => line.slice(0, 240)),
    ),
  ].slice(0, 8);
}

function parseJsonFile(source: string): unknown {
  const trimmed = source.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  return JSON.parse(withoutFence);
}

function parseTokenUsage(output: string): number | null {
  const match = /tokens used\s*\r?\n\s*([\d,]+)/i.exec(output);
  return match ? Number(match[1].replaceAll(',', '')) : null;
}

function addTokenUsage(current: number | null, addition: number | null): number | null {
  if (addition === null) return current;
  return (current ?? 0) + addition;
}

function failureText(result: ProcessResult): string {
  return `${result.stderr}\n${result.stdout}`.trim();
}

async function waitForRetry(label: string) {
  const seconds = policy.recovery.retryBackoffSeconds;
  const startedAt = Date.now();
  console.log(`[恢复] ${label}，${seconds} 秒后重试。`);
  if (seconds > 0)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, seconds * 1000));
  await appendPublicWorkEvent(resolve(runDirectory, 'public-events.jsonl'), {
    eventId: `recovery-backoff-${startedAt}`,
    sequence: 0,
    runId: basename(runDirectory),
    agentId: 'feature-pm',
    executionRound: activeActualLaunchCount ?? 1,
    codeRevision: await workspaceFingerprint(),
    timeCategory: 'recovery',
    kind: 'action',
    payload: { action: 'retry-backoff', summary: label, status: 'completed' },
    createdAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
  });
}

async function writeCheckpoint(
  runDirectory: string,
  checkpoint: Omit<RecoveryCheckpoint, 'updatedAt'>,
) {
  await writeFile(
    resolve(runDirectory, 'recovery.json'),
    `${JSON.stringify({ ...checkpoint, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
}

async function workspaceFingerprint(): Promise<string> {
  const [head, status, diff, untracked] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z']),
    git(['diff', '--binary', 'HEAD', '--']),
    git(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  if ([head, status, diff, untracked].some((result) => result.code !== 0)) {
    throw new Error('无法计算恢复点工作区指纹');
  }
  const hash = createHash('sha256');
  hash.update(head.stdout);
  hash.update('\0STATUS\0');
  hash.update(status.stdout);
  hash.update('\0DIFF\0');
  hash.update(diff.stdout);
  const untrackedPaths = untracked.stdout.split('\0').filter(Boolean).sort();
  for (const path of untrackedPaths) {
    hash.update('\0UNTRACKED\0');
    hash.update(path);
    hash.update('\0');
    hash.update(await readFile(resolve(root, path)));
  }
  return hash.digest('hex');
}

async function workspaceChangedPaths(): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    git(['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', 'HEAD', '--']),
    git(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  if (tracked.code !== 0 || untracked.code !== 0) {
    throw new Error('无法归属恢复点之后的工作区变化');
  }
  return [...new Set(`${tracked.stdout}\0${untracked.stdout}`.split('\0').filter(Boolean))]
    .map((path) => path.replaceAll('\\', '/'))
    .sort((left, right) => left.localeCompare(right));
}

async function captureWorkspaceChangeBaseline(): Promise<WorkspaceChangeBaseline> {
  const paths = await workspaceChangedPaths();
  const entries = await Promise.all(
    paths.map(async (path) => {
      const content = await readFile(resolve(root, path)).catch(() => null);
      return [
        path,
        content === null ? null : createHash('sha256').update(content).digest('hex'),
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

function pathMatchesTaskScope(path: string, scope: string): boolean {
  const normalizedPath = path.replaceAll('\\', '/').replace(/^\.\//, '');
  const normalizedScope = scope.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  return (
    normalizedScope.length > 0 &&
    (normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`))
  );
}

async function changesBelongToRecoveryPlan(
  plan: TaskPlan,
  taskRuns: TaskRun[],
  checkpointBaseline?: WorkspaceChangeBaseline,
): Promise<boolean> {
  const changedPaths = checkpointBaseline
    ? changedPathsSinceWorkspaceBaseline(checkpointBaseline, await captureWorkspaceChangeBaseline())
    : await workspaceChangedPaths();
  if (changedPaths.length === 0) return false;
  const scopes = [
    ...plan.tasks.flatMap((task) => task.paths),
    ...taskRuns.flatMap((run) => run.inputPaths ?? []),
    ...taskRuns.flatMap((run) => taskOutputPaths(run.task.paths, run.changedFiles)),
  ];
  return changedPaths.every((path) => scopes.some((scope) => pathMatchesTaskScope(path, scope)));
}

async function readCheckpoint(runDirectory: string): Promise<RecoveryCheckpoint> {
  const value = JSON.parse(
    await readFile(resolve(runDirectory, 'recovery.json'), 'utf8'),
  ) as Partial<RecoveryCheckpoint>;
  if (
    value.version !== 1 ||
    !value.plan ||
    !value.baseline ||
    !value.workspaceFingerprint ||
    !Array.isArray(value.taskRuns)
  ) {
    throw new Error(`恢复点无效：${resolve(runDirectory, 'recovery.json')}`);
  }
  if (
    value.workspaceChangeBaseline !== undefined &&
    (value.workspaceChangeBaseline === null ||
      Array.isArray(value.workspaceChangeBaseline) ||
      typeof value.workspaceChangeBaseline !== 'object' ||
      Object.entries(value.workspaceChangeBaseline).some(
        ([path, contentHash]) =>
          path.length === 0 ||
          path.includes('\\') ||
          isAbsolute(path) ||
          path.split('/').includes('..') ||
          (contentHash !== null &&
            (typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(contentHash))),
      ))
  ) {
    throw new Error(`恢复点工作区路径基线无效：${resolve(runDirectory, 'recovery.json')}`);
  }
  return {
    version: 1,
    status:
      value.status === 'delivered'
        ? 'delivered'
        : value.status === 'active'
          ? 'active'
          : value.status === 'waiting-producer'
            ? 'waiting-producer'
            : 'recoverable',
    processPid: Number.isInteger(value.processPid) ? value.processPid! : 0,
    processIdentity: value.processIdentity ?? '',
    phase: value.phase ?? '未知阶段',
    direction: value.direction ?? value.plan.summary,
    resolvedDirection: value.resolvedDirection ?? value.plan.summary,
    baseline: value.baseline,
    workspaceFingerprint: value.workspaceFingerprint,
    workspaceChangeBaseline: value.workspaceChangeBaseline,
    plan: validatePlan(
      value.plan,
      planTaskLimit(
        value.resolvedDirection ?? value.direction ?? value.plan.summary,
        policy.limits.maxTasks,
      ),
    ),
    taskRuns: value.taskRuns as TaskRun[],
    review: value.review ?? null,
    reviewStall:
      value.reviewStall &&
      typeof value.reviewStall.signature === 'string' &&
      Number.isSafeInteger(value.reviewStall.count) &&
      value.reviewStall.count > 0
        ? value.reviewStall
        : undefined,
    validationProgress: value.validationProgress ?? {
      fastGate: null,
      independentReview: null,
    },
    plannerTokens: value.plannerTokens ?? null,
    reviewerTokens: value.reviewerTokens ?? null,
    repairerTokens: value.repairerTokens ?? null,
    noPush: value.noPush ?? false,
    takeover: value.takeover ?? false,
    error: value.error ?? '',
    actualLaunchCount: Number.isSafeInteger(value.actualLaunchCount)
      ? Number(value.actualLaunchCount)
      : null,
    abnormalRecoveryCount: Number.isSafeInteger(value.abnormalRecoveryCount)
      ? Number(value.abnormalRecoveryCount)
      : null,
    localRepairRoundCount: Number.isSafeInteger(value.localRepairRoundCount)
      ? Number(value.localRepairRoundCount)
      : null,
    updatedAt: value.updatedAt ?? '',
  };
}

async function reviewStallFromRunHistory(
  directory: string,
): Promise<{ signature: string; count: number } | undefined> {
  const files = (await readdir(directory))
    .map((name) => ({ name, round: Number(/^review-(\d+)-.*\.json$/.exec(name)?.[1] ?? 0) }))
    .filter((entry) => entry.round > 0)
    .sort((left, right) => left.round - right.round);
  let stalled: { signature: string; count: number } | undefined;
  for (const file of files) {
    try {
      const review = validateReview(
        JSON.parse(await readFile(resolve(directory, file.name), 'utf8')),
      );
      stalled = advanceReviewStall(stalled, review);
    } catch {
      // A damaged old review cannot prove consecutive unresolved findings.
      stalled = undefined;
    }
  }
  return stalled;
}

async function compactProjectContext(): Promise<string> {
  const status = (await readFile(resolve(root, 'docs/status.md'), 'utf8')).slice(0, 5000);
  return `模块边界：src/core 是无头 DSL/AST/编译器/VM；src/game 是战斗运行时；src/app 是推演台和演武场；test 与 e2e 是验证；docs 保存长期事实。\n\n当前状态摘要：\n${status}`;
}

function codexArgs(route: ModelRoute, sandbox: 'read-only' | 'workspace-write'): string[] {
  return [
    '-a',
    'never',
    'exec',
    '-C',
    root,
    '--ephemeral',
    '--color',
    'never',
    '-s',
    sandbox,
    '-m',
    route.model,
    '-c',
    `model_reasoning_effort="${route.reasoning}"`,
  ];
}

async function askPlanner(
  direction: string,
  route: ModelRoute,
  outputFile: string,
  logFile: string,
): Promise<PlannerRun> {
  const prompt = `你是道衍项目的秘书兼项目经理。制作人只负责方向，不负责判断复杂度。

不要调用工具、shell 或读取其他文件。下面已经提供规划所需的压缩项目上下文；深入调查属于最终执行者的职责。直接输出结构化计划。

把制作人方向转换为一个最小但完整的交付计划：
- 写出可观察的验收标准与非目标。
- 只在真正能降低上下文或需要不同专长时拆分，避免为了多 Agent 而拆分。
- 任务顺序执行，使用 dependsOn 表达依赖；最多 4 个任务。
- 不单独建立“阅读现状”“运行门禁”任务；这些是每个执行者和调度器的固定责任。同一模型可以连续完成的实现、测试和文档应保持为一个任务。
- economy 用于检索、文档与机械工作；standard 用于常规 UI/功能/测试；advanced 用于 core、DSL、VM、并发、共享契约和困难调试；critical 只用于 ADR、不可逆架构和重大迁移。
- 若缺少的是实现细节，请自行做保守决定；只有产品方向冲突、不可逆选择或大版本发布才设置 producerDecisionRequired=true。
- commitMessage 使用 Conventional Commits。
- 不创建单独的 review 任务，调度器会统一进行独立审查。

压缩项目上下文：
<project-context>
${await compactProjectContext()}
</project-context>

制作人方向：
<producer-direction>
${direction}
</producer-direction>`;
  const result = await runProcess(
    'codex',
    [...codexArgs(route, 'read-only'), '--output-schema', planSchemaPath, '-o', outputFile, '-'],
    {
      input: prompt,
      logFile,
      heartbeatLabel: '深度规划',
      workerModel: route.model,
      workerRole: '规划 Agent',
      progressFile: resolve(dirname(outputFile), 'progress.json'),
      timeoutMs: minutes(policy.timeouts.plannerMinutes),
    },
  );
  if (result.code !== 0) throw new Error(`秘书规划失败，详见 ${logFile}`);
  return {
    plan: optimizePlan(
      validatePlan(
        parseJsonFile(await readFile(outputFile, 'utf8')),
        planTaskLimit(direction, policy.limits.maxTasks),
      ),
    ),
    tokensUsed: parseTokenUsage(`${result.stdout}\n${result.stderr}`),
  };
}

function workerPrompt(
  plan: TaskPlan,
  task: PlannedTask,
  failureContext: string,
  priorTaskRuns: TaskRun[] = [],
  sharedContext = '',
): string {
  const takeoverInstruction = activeTakeover
    ? '\n这是秘书强制接管现场：工作区中可能已有执行 Agent 的部分改动。先区分与本目标相关的改动和无关改动，保留相关改动并审查其正确性；禁止为了恢复而清空或覆盖无关现场。\n'
    : '';
  const priorEvidence =
    task.id === 'formal-development-summary'
      ? `\n前序 Task 证据索引（只读；需要时打开输出文件核实）：\n${priorTaskRuns
          .map(
            (run) =>
              `- ${run.task.id}: 输出 ${run.outputFile}; 报告命令 ${run.tests.join('、') || '无'}; 改动 ${run.changedFiles.join('、') || '无'}`,
          )
          .join('\n')}\n`
      : '';
  return `你是道衍项目的执行 Agent。只承接下面这一项任务，不重新规划整个项目，也不要创建其他 Agent。

必须遵守 AGENTS.md 和 docs/workflow.md。开始前读取任务相关代码、文档和测试；优先限制在建议路径与直接依赖，不要扫描无关路线图、历史日志或整个仓库。在当前工作区直接实现。不要 commit、push、tag 或发布，这些由秘书统一处理。不要覆盖无关改动。

总体目标：${plan.summary}
总体验收标准：
${plan.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}

当前任务：${task.title}
目标：${task.objective}
建议关注路径：${task.paths.join(', ') || '按仓库事实判断'}
交付物：
${task.deliverables.map((item) => `- ${item}`).join('\n') || '- 完成目标所需的最小改动'}
建议验证：
${task.verification.map((item) => `- ${item}`).join('\n') || '- 运行与风险相称的测试'}

${failureContext}
${takeoverInstruction}
${priorEvidence}
${sharedContext}

完成实现后只运行改动直接相关的类型检查、定向测试或文档校验；不要运行统一 npm run verify 或 npm run verify:full，它们由 Feature PM 在汇总后的最终代码树负责。简洁报告修改、验证与剩余风险。`;
}

async function runTask(
  plan: TaskPlan,
  task: PlannedTask,
  initialRoute: ModelRoute,
  runDirectory: string,
  priorTaskRuns: TaskRun[] = [],
): Promise<TaskRun> {
  const taskStartFiles = await workspaceFileSnapshot();
  const sharedContext =
    task.id === 'formal-development-summary'
      ? ''
      : await taskDependencyContext(task, priorTaskRuns);
  let tier = task.tier;
  let route = initialRoute;
  let failureContext = '';
  let tokensUsed: number | null = null;
  let totalAttempts = 0;
  let escalations = 0;
  let lastOutputFile = '';

  while (true) {
    let routeFailure = '';
    for (let retry = 0; retry <= policy.recovery.transientRetries; retry += 1) {
      totalAttempts += 1;
      const slug = route.model.replace(/[^a-z0-9.-]+/gi, '-');
      const outputFile = resolve(runDirectory, `${task.id}-${slug}-attempt-${totalAttempts}.md`);
      const logFile = resolve(runDirectory, `${task.id}-${slug}-attempt-${totalAttempts}.log`);
      lastOutputFile = outputFile;
      console.log(`\n[执行 ${task.id}] ${task.title} -> ${route.model} (${route.reasoning})`);
      const result = await runProcess(
        'codex',
        [...codexArgs(route, 'workspace-write'), '-o', outputFile, '-'],
        {
          input: workerPrompt(plan, task, failureContext, priorTaskRuns, sharedContext),
          logFile,
          stream: true,
          heartbeatLabel: `执行 ${task.id} / ${route.model}`,
          workerModel: route.model,
          workerRole: '执行 Agent',
          progressFile: resolve(runDirectory, 'progress.json'),
          timeoutMs: minutes(policy.timeouts.workers[tier]),
        },
      );
      tokensUsed = addTokenUsage(tokensUsed, parseTokenUsage(failureText(result)));
      if (result.code === 0) {
        const changedFiles = await changedFilesSince(taskStartFiles);
        const inputPaths = await collectTaskInputPaths(task.paths, changedFiles);
        return {
          task,
          route,
          attempts: totalAttempts,
          result: 'passed',
          outputFile,
          changedFiles,
          tests: await reportedTests(outputFile),
          tokensUsed,
          completedAt: new Date().toISOString(),
          inputPaths,
          inputFingerprint: await taskPathFingerprint(inputPaths),
          outputFingerprint: await taskPathFingerprint(taskOutputPaths(task.paths, changedFiles)),
          commandFingerprint: stringFingerprint(task.verification),
          configFingerprint: await verificationConfigFingerprint(),
        };
      }

      routeFailure = failureText(result).slice(-4000);
      const kind = classifyAgentFailure(routeFailure, result.code);
      if (kind === 'external-blocker') {
        throw new AgentCallError(
          `执行 ${task.id} 遇到账号或鉴权阻塞，详见 ${logFile}`,
          kind,
          tokensUsed,
        );
      }
      if (kind === 'transient' && retry < policy.recovery.transientRetries) {
        await waitForRetry(`${route.model} 出现临时故障`);
        continue;
      }
      break;
    }

    const next = escalateTier(tier);
    if (!next || escalations >= policy.limits.maxEscalationsPerTask) {
      const changedFiles = await changedFilesSince(taskStartFiles);
      const inputPaths = await collectTaskInputPaths(task.paths, changedFiles);
      return {
        task,
        route,
        attempts: totalAttempts,
        result: 'failed',
        outputFile: lastOutputFile,
        changedFiles,
        tests: await reportedTests(lastOutputFile),
        tokensUsed,
        completedAt: new Date().toISOString(),
        inputPaths,
        inputFingerprint: await taskPathFingerprint(inputPaths),
        outputFingerprint: await taskPathFingerprint(taskOutputPaths(task.paths, changedFiles)),
        commandFingerprint: stringFingerprint(task.verification),
        configFingerprint: await verificationConfigFingerprint(),
      };
    }
    failureContext = `上一条执行路由失败，请接管当前工作区并完成任务，不要简单重复。失败摘要：\n${routeFailure}`;
    escalations += 1;
    tier = next;
    route = routeForTask(policy, tier);
    console.log(`[接管] ${task.id} -> ${route.model}`);
  }
}

async function runDeliveryVerification(
  runDirectory: string,
  round: number,
  scope: 'fast' | 'full' = 'full',
  retryCommand: string[] = [],
): Promise<VerificationRun> {
  const invocation =
    retryCommand.length > 0
      ? retryCommand
      : scope === 'fast'
        ? ['npm', 'run', 'verify']
        : policy.verification.delivery;
  const [command, ...args] = invocation;
  const isRetry = retryCommand.length > 0;
  console.log(
    `\n[${scope === 'fast' ? '快速' : '完整'}门禁${isRetry ? '定向复核' : ''}] ${invocation.join(' ')}`,
  );
  const startedAt = Date.now();
  const result = await runProcess(command, args, {
    logFile: resolve(runDirectory, `${scope}-verify-${round}.log`),
    stream: true,
    heartbeatLabel: `${scope === 'fast' ? '快速' : '完整'}门禁 / 第 ${round} 轮`,
    progressFile: resolve(runDirectory, 'progress.json'),
    timeoutMs: minutes(policy.timeouts.verificationMinutes),
  });
  const codeRevision = await workspaceFingerprint();
  await appendPublicWorkEvent(resolve(runDirectory, 'public-events.jsonl'), {
    eventId: `${scope}-verification-r${round}-${codeRevision.slice(0, 12)}`,
    sequence: 0,
    runId: basename(runDirectory),
    agentId: 'feature-pm',
    executionRound: activeActualLaunchCount ?? 1,
    codeRevision,
    timeCategory: 'command-execution',
    kind: 'test',
    payload: {
      command: invocation.join(' '),
      scope:
        scope === 'fast'
          ? isRetry
            ? 'feature-fast-gate-targeted-recheck'
            : 'feature-fast-gate'
          : 'feature-full-gate',
      exitCode: result.code,
      status: result.code === 0 ? 'passed' : 'failed',
      errorSummary: result.code === 0 ? '' : (result.stderr || result.stdout).slice(-2_000),
    },
    durationMs: Date.now() - startedAt,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    ...result,
    invocation,
    failedCommand: result.code === 0 ? [] : failedNpmCommandFromOutput(output, invocation),
  };
}

interface FullGateEvidence {
  schemaVersion: 1;
  workspaceFingerprint: string;
  configFingerprint: string;
  command: string;
  commandFingerprint: string;
  executionRound: number;
  log: string;
  exitCode: 0;
  createdAt: string;
}

async function verificationConfigFingerprint(): Promise<string> {
  const hash = createHash('sha256');
  for (const path of [
    'package.json',
    'package-lock.json',
    'agents/policy.json',
    'vite.config.ts',
  ]) {
    hash.update(path);
    hash.update(await readFile(resolve(root, path)).catch(() => Buffer.from('[missing]')));
  }
  return hash.digest('hex');
}

async function validationStageFingerprint(): Promise<ValidationStageFingerprint> {
  const [workspace, config] = await Promise.all([
    workspaceTreeFingerprint(),
    verificationConfigFingerprint(),
  ]);
  return { workspaceFingerprint: workspace, configFingerprint: config };
}

async function validationStageMatches(
  evidence: ValidationStageFingerprint | null | undefined,
): Promise<boolean> {
  if (!evidence) return false;
  const current = await validationStageFingerprint();
  return (
    evidence.workspaceFingerprint === current.workspaceFingerprint &&
    evidence.configFingerprint === current.configFingerprint
  );
}

async function configuredFastGateCommands(): Promise<string[][]> {
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const commands = npmRunCommandsFromScript(packageJson.scripts?.verify ?? '');
  if (commands.length === 0)
    throw new Error('package.json 的 verify 未包含可续跑的 npm run 子命令');
  return commands;
}

async function reusableFullGateEvidence(runDirectory: string): Promise<FullGateEvidence | null> {
  const path = resolve(runDirectory, 'full-gate-evidence.json');
  const value = await readFile(path, 'utf8')
    .then((source) => JSON.parse(source) as Partial<FullGateEvidence>)
    .catch(() => null);
  if (!value || value.schemaVersion !== 1 || value.exitCode !== 0) return null;
  const [workspace, config] = await Promise.all([
    workspaceTreeFingerprint(),
    verificationConfigFingerprint(),
  ]);
  return canReuseFullGateEvidence(value, workspace, config, policy.verification.delivery.join(' '))
    ? (value as FullGateEvidence)
    : null;
}

async function writeFullGateEvidence(
  runDirectory: string,
  round: number,
): Promise<FullGateEvidence> {
  const command = policy.verification.delivery.join(' ');
  const evidence: FullGateEvidence = {
    schemaVersion: 1,
    workspaceFingerprint: await workspaceTreeFingerprint(),
    configFingerprint: await verificationConfigFingerprint(),
    command,
    commandFingerprint: stringFingerprint([command]),
    executionRound: activeActualLaunchCount ?? 1,
    log: relative(root, resolve(runDirectory, `full-verify-${round}.log`)).replace(/\\/g, '/'),
    exitCode: 0,
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    resolve(runDirectory, 'full-gate-evidence.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  return evidence;
}

async function writeReviewInput(
  baseline: string,
  runDirectory: string,
  round: number,
  boundary: ReviewBoundary | null,
): Promise<string> {
  const maxReviewBytes = 500_000;
  const inputFile = resolve(runDirectory, `review-input-${round}.patch`);
  if (boundary) {
    const current = await workspaceContentSnapshot();
    const paths = [...new Set([...boundary.files.keys(), ...current.keys()])]
      .filter((path) => !buffersEqual(boundary.files.get(path), current.get(path)))
      .sort();
    const sections = paths.map(
      (path) =>
        `\n--- REPAIR DELTA: ${path} ---\nBEFORE REPAIR:\n${reviewFileContent(boundary.files.get(path), maxReviewBytes)}\n\nAFTER REPAIR:\n${reviewFileContent(current.get(path), maxReviewBytes)}`,
    );
    await writeFile(
      inputFile,
      `REVIEW MODE: incremental-repair\nREPAIR BOUNDARY: ${boundary.fingerprint}\nOPEN FINDINGS BEFORE REPAIR:\n${JSON.stringify(boundary.findings.findings, null, 2)}\nCHANGED PATHS: ${paths.join(', ') || '[none]'}\n${sections.join('\n')}\n`,
      'utf8',
    );
    return inputFile;
  }
  const diff = await git(['diff', '--no-ext-diff', baseline, '--']);
  if (diff.code !== 0) throw new Error('无法生成审查差异');
  let trackedChanges = diff.stdout;
  if (Buffer.byteLength(trackedChanges, 'utf8') > maxReviewBytes) {
    const summary = await git(['diff', '--stat', baseline, '--']);
    const names = await git(['diff', '--name-only', baseline, '--']);
    trackedChanges = `${summary.stdout}\n变更过大，未内联完整补丁。审查者按需读取以下文件：\n${names.stdout}`;
  }
  const untracked = await git([
    '-c',
    'core.quotePath=false',
    'ls-files',
    '--others',
    '--exclude-standard',
  ]);
  if (untracked.code !== 0) throw new Error('无法读取未跟踪文件清单');
  const untrackedPaths = untracked.stdout.split(/\r?\n/).filter(Boolean);
  const untrackedSections: string[] = [];
  for (const path of untrackedPaths) {
    let content = '[无法按文本读取]';
    try {
      const absolutePath = resolve(root, path);
      const fileStat = await stat(absolutePath);
      if (fileStat.size > maxReviewBytes) {
        content = `[文件过大，${fileStat.size} bytes；审查者按需读取]`;
      } else {
        const buffer = await readFile(absolutePath);
        content = buffer.includes(0) ? '[二进制文件；未内联内容]' : buffer.toString('utf8');
      }
    } catch {
      // 保留默认说明，让审查者知道该文件未能内联。
    }
    untrackedSections.push(`\n--- UNTRACKED FILE: ${path} ---\n${content}`);
  }
  await writeFile(
    inputFile,
    `BASELINE: ${baseline}\n\n${trackedChanges}${untrackedSections.join('')}\n`,
    'utf8',
  );
  return inputFile;
}

async function askReviewerAttempt(
  plan: TaskPlan,
  route: ModelRoute,
  baseline: string,
  runDirectory: string,
  round: number,
  attempt: number,
  inputFile: string,
  incremental: boolean,
): Promise<ReviewRun> {
  const slug = route.model.replace(/[^a-z0-9.-]+/gi, '-');
  const outputFile = resolve(runDirectory, `review-${round}-${slug}-attempt-${attempt}.json`);
  const logFile = resolve(runDirectory, `review-${round}-${slug}-attempt-${attempt}.log`);
  const prompt = `你是道衍项目的独立审查 Agent。不要修改文件。

${incremental ? '这是修复后的增量复审。只复核未关闭 finding、修复边界之后的改动和直接受影响契约；不要重新审查整版基线差异。' : '这是首次独立审查。'} 不要再次运行测试、构建或 Git 命令，也不要把当前沙盒不能启动子进程当作缺陷。先阅读 AGENTS.md，再只审查 ${inputFile} 中${incremental ? '记录的修复增量' : `从基线 ${baseline} 开始的差异`}；仅在确认具体问题时读取差异涉及的文件或直接契约，不要扫描整个仓库、路线图或历史日志。

优先寻找行为缺陷、架构不变量破坏、缺失测试、文档与实现不一致、乱码和 UI 工作流回归。最多报告 5 个具体发现；没有交付阻断问题就通过，不用为了显得完整而继续探索。

制作人目标：${plan.summary}
验收标准：
${plan.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}

只有存在必须在交付前修复的问题时 verdict=fix；纯建议或未来增强使用 low finding 且 verdict=pass。`;
  const result = await runProcess(
    'codex',
    [...codexArgs(route, 'read-only'), '--output-schema', reviewSchemaPath, '-o', outputFile, '-'],
    {
      input: prompt,
      logFile,
      heartbeatLabel: `独立审查 / 第 ${round} 轮 / ${route.model}`,
      workerModel: route.model,
      workerRole: '审查 Agent',
      progressFile: resolve(runDirectory, 'progress.json'),
      timeoutMs: minutes(policy.timeouts.reviewers[highestTier(plan.tasks)]),
    },
  );
  const tokensUsed = parseTokenUsage(failureText(result));
  if (result.code !== 0) {
    throw new AgentCallError(
      `独立审查失败，详见 ${logFile}`,
      classifyAgentFailure(failureText(result), result.code),
      tokensUsed,
    );
  }
  return {
    result: validateReview(parseJsonFile(await readFile(outputFile, 'utf8'))),
    tokensUsed,
    route,
    attempts: attempt,
  };
}

async function askReviewerWithRecovery(
  plan: TaskPlan,
  baseline: string,
  runDirectory: string,
  round: number,
  boundary: ReviewBoundary | null = null,
): Promise<ReviewRun> {
  const inputFile = await writeReviewInput(baseline, runDirectory, round, boundary);
  const routes = reviewRoutesForPlan(policy, plan);
  let attempts = 0;
  let tokensUsed: number | null = null;
  let lastError: unknown = null;

  for (const route of routes) {
    for (let retry = 0; retry <= policy.recovery.transientRetries; retry += 1) {
      attempts += 1;
      try {
        const run = await askReviewerAttempt(
          plan,
          route,
          baseline,
          runDirectory,
          round,
          attempts,
          inputFile,
          boundary !== null,
        );
        return {
          ...run,
          attempts,
          tokensUsed: addTokenUsage(tokensUsed, run.tokensUsed),
        };
      } catch (error) {
        lastError = error;
        if (error instanceof AgentCallError) {
          tokensUsed = addTokenUsage(tokensUsed, error.tokensUsed);
          if (error.kind === 'external-blocker') throw error;
          if (error.kind === 'transient' && retry < policy.recovery.transientRetries) {
            await waitForRetry(`${route.model} 审查通道暂时不可用`);
            continue;
          }
        }
        break;
      }
    }
    const nextRoute = routes[routes.indexOf(route) + 1];
    if (nextRoute) console.log(`[审查接管] ${route.model} -> ${nextRoute.model}`);
  }

  throw new AgentCallError(
    `所有独立审查路由均失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    lastError instanceof AgentCallError ? lastError.kind : 'execution',
    tokensUsed,
  );
}

async function runReviewFix(
  plan: TaskPlan,
  review: ReviewResult,
  route: ModelRoute,
  runDirectory: string,
  round: number,
  attempt: number,
): Promise<number | null> {
  const slug = route.model.replace(/[^a-z0-9.-]+/gi, '-');
  const outputFile = resolve(runDirectory, `review-fix-${round}-${slug}-attempt-${attempt}.md`);
  const logFile = resolve(runDirectory, `review-fix-${round}-${slug}-attempt-${attempt}.log`);
  const prompt = `你是道衍项目的修复 Agent。遵守 AGENTS.md，在当前工作区修复独立审查发现的问题；不要 commit、push 或 tag。

原始目标：${plan.summary}
审查结论：${review.summary}
问题：
${review.findings
  .map((finding) => `- [${finding.severity}] ${finding.title}: ${finding.detail}`)
  .join('\n')}

完成必要的代码、测试和文档修改，并运行最相关的验证。`;
  const result = await runProcess(
    'codex',
    [...codexArgs(route, 'workspace-write'), '-o', outputFile, '-'],
    {
      input: prompt,
      logFile,
      stream: true,
      heartbeatLabel: `审查修复 / 第 ${round} 轮 / ${route.model}`,
      workerModel: route.model,
      workerRole: '修复 Agent',
      progressFile: resolve(runDirectory, 'progress.json'),
      timeoutMs: minutes(policy.timeouts.repairs[highestTier(plan.tasks)]),
    },
  );
  const tokensUsed = parseTokenUsage(failureText(result));
  if (result.code !== 0) {
    throw new AgentCallError(
      `审查修复失败，详见 ${logFile}`,
      classifyAgentFailure(failureText(result), result.code),
      tokensUsed,
    );
  }
  return tokensUsed;
}

async function runReviewFixWithRecovery(
  plan: TaskPlan,
  review: ReviewResult,
  runDirectory: string,
  round: number,
): Promise<number | null> {
  const routes = reviewRoutesForPlan(policy, plan);
  let attempts = 0;
  let tokensUsed: number | null = null;
  let lastError: unknown = null;
  for (const route of routes) {
    for (let retry = 0; retry <= policy.recovery.transientRetries; retry += 1) {
      attempts += 1;
      try {
        return addTokenUsage(
          tokensUsed,
          await runReviewFix(plan, review, route, runDirectory, round, attempts),
        );
      } catch (error) {
        lastError = error;
        if (error instanceof AgentCallError) {
          tokensUsed = addTokenUsage(tokensUsed, error.tokensUsed);
          if (error.kind === 'external-blocker') throw error;
          if (error.kind === 'transient' && retry < policy.recovery.transientRetries) {
            await waitForRetry(`${route.model} 修复通道暂时不可用`);
            continue;
          }
        }
        break;
      }
    }
    const nextRoute = routes[routes.indexOf(route) + 1];
    if (nextRoute) console.log(`[修复接管] ${route.model} -> ${nextRoute.model}`);
  }
  throw new AgentCallError(
    `所有审查修复路由均失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    lastError instanceof AgentCallError ? lastError.kind : 'execution',
    tokensUsed,
  );
}

async function writeReport(
  runDirectory: string,
  status: string,
  plan: TaskPlan,
  taskRuns: TaskRun[],
  review: ReviewResult | null,
  extra = '',
  plannerTokens: number | null = null,
  reviewerTokens: number | null = null,
  repairerTokens: number | null = null,
) {
  const knownTokens = [
    plannerTokens,
    reviewerTokens,
    repairerTokens,
    ...taskRuns.map((run) => run.tokensUsed),
  ].filter((tokens): tokens is number => tokens !== null);
  const invocationUsage = await runInvocationUsage(runDirectory);
  const aggregatedKnownTotal =
    knownTokens.length > 0 ? knownTokens.reduce((sum, tokens) => sum + tokens, 0) : null;
  const observedKnownTotal = invocationUsage.knownTokens;
  const knownTotal =
    aggregatedKnownTotal === null
      ? observedKnownTotal
      : observedKnownTotal === null
        ? aggregatedKnownTotal
        : Math.max(aggregatedKnownTotal, observedKnownTotal);
  const report = {
    status,
    finishedAt: new Date().toISOString(),
    plan,
    tasks: taskRuns,
    review,
    validation: {
      profile: validationProfileForPlan(plan),
      stages: validationStagesForPlan(plan),
      executionRound: activeActualLaunchCount ?? 1,
    },
    tokenUsage: {
      planner: plannerTokens,
      workers: taskRuns.map((run) => ({ id: run.task.id, tokens: run.tokensUsed })),
      reviewer: reviewerTokens,
      repairs: repairerTokens,
      knownTotal,
      observedCalls: invocationUsage.observedCalls,
      missingUsageCalls: invocationUsage.missingUsageCalls,
      source: 'invocation-logs-and-dispatcher-aggregate',
    },
    extra,
  };
  const publicContext = {
    executionRound: activeActualLaunchCount ?? 1,
    codeRevision: await workspaceFingerprint(),
  };
  await writeFile(
    resolve(runDirectory, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    resolve(runDirectory, 'report.md'),
    `# ${plan.title}\n\n- 状态：${status}\n- 摘要：${plan.summary}\n- 任务：${taskRuns.length}/${plan.tasks.length}\n- 审查：${review?.verdict ?? '未执行'}\n- 已知模型 tokens：${report.tokenUsage.knownTotal ?? '不可用'}\n\n${extra}\n`,
    'utf8',
  );
  const publicLog = resolve(runDirectory, 'public-events.jsonl');
  await appendPublicWorkEvent(publicLog, {
    eventId: 'input',
    sequence: 0,
    runId: basename(runDirectory),
    agentId: 'feature-pm',
    ...publicContext,
    kind: 'input',
    payload: { summary: plan.summary, source: 'approved-task-contract' },
    createdAt: report.finishedAt,
  });
  await appendPublicWorkEvent(publicLog, {
    eventId: 'plan',
    sequence: 0,
    runId: basename(runDirectory),
    agentId: 'feature-pm',
    ...publicContext,
    kind: 'plan',
    payload: { stage: 'feature-delivery', summary: plan.title, status: 'established' },
    createdAt: report.finishedAt,
  });
  const reportEventKey =
    status.replace(/[^a-z0-9_-]/gi, '-') ||
    createHash('sha256').update(status).digest('hex').slice(0, 12);
  await appendPublicWorkEvent(publicLog, {
    eventId: `progress-${reportEventKey}`,
    sequence: 0,
    runId: basename(runDirectory),
    agentId: 'feature-pm',
    ...publicContext,
    kind: 'progress',
    payload: {
      stage: status,
      summary: extra || plan.summary,
      completed: taskRuns.filter((run) => run.result === 'passed').length,
      total: plan.tasks.length,
    },
    createdAt: report.finishedAt,
  });
  for (const taskRun of taskRuns) {
    await appendPublicWorkEvent(publicLog, {
      eventId: `task-${taskRun.task.id}`,
      sequence: 0,
      runId: basename(runDirectory),
      agentId: taskRun.route.model,
      ...publicContext,
      kind: 'action',
      payload: {
        action: taskRun.task.title,
        summary: taskRun.task.objective,
        status: taskRun.result,
      },
      createdAt: taskRun.completedAt,
    });
    for (const [index, path] of taskRun.changedFiles.entries()) {
      await appendPublicWorkEvent(publicLog, {
        eventId: `task-${taskRun.task.id}-file-${index}`,
        sequence: 0,
        runId: basename(runDirectory),
        agentId: taskRun.route.model,
        ...publicContext,
        kind: 'file',
        payload: { path, action: 'changed' },
        createdAt: taskRun.completedAt,
      });
    }
    for (const [index, command] of taskRun.tests.entries()) {
      await appendPublicWorkEvent(publicLog, {
        eventId: `task-${taskRun.task.id}-test-${index}`,
        sequence: 0,
        runId: basename(runDirectory),
        agentId: taskRun.route.model,
        ...publicContext,
        kind: 'test',
        payload: { command, scope: taskRun.task.id, status: 'reported', exitCode: null },
        createdAt: taskRun.completedAt,
      });
    }
  }
  if (extra && status !== '已交付') {
    await appendPublicWorkEvent(publicLog, {
      eventId: `error-${reportEventKey}`,
      sequence: 0,
      runId: basename(runDirectory),
      agentId: 'feature-pm',
      ...publicContext,
      kind: 'error',
      payload: { summary: extra, code: status, recoverable: status !== '失败' },
      createdAt: report.finishedAt,
    });
  }
  await appendPublicWorkEvent(publicLog, {
    eventId: `usage-${reportEventKey}-${report.tokenUsage.knownTotal ?? 'unavailable'}`,
    sequence: 0,
    runId: basename(runDirectory),
    agentId: 'feature-pm',
    ...publicContext,
    kind: 'usage',
    payload: { source: 'dispatcher-report' },
    tokenUsage: { total: report.tokenUsage.knownTotal, source: 'dispatcher-report' },
    createdAt: report.finishedAt,
  });
}

async function latestAbandonedRun(): Promise<string | null> {
  const head = await git(['rev-parse', 'HEAD']);
  if (head.code !== 0) return null;
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name))) {
    try {
      const checkpoint = JSON.parse(
        await readFile(resolve(runsRoot, entry.name, 'recovery.json'), 'utf8'),
      ) as Partial<RecoveryCheckpoint>;
      if (
        (checkpoint.status === 'active' || checkpoint.status === 'recoverable') &&
        checkpoint.baseline === head.stdout.trim() &&
        Array.isArray(checkpoint.taskRuns) &&
        checkpoint.taskRuns.length === 0
      ) {
        return resolve(runsRoot, entry.name);
      }
    } catch {
      // Ignore incomplete or unrelated run directories.
    }
  }
  return null;
}

async function writeTakeoverManifest(runDirectory: string, reason: string): Promise<void> {
  const [head, status, diffStat, untracked, fingerprint] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['-c', 'core.quotePath=false', 'status', '--porcelain=v1']),
    git(['-c', 'core.quotePath=false', 'diff', '--stat', 'HEAD', '--']),
    git(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard']),
    workspaceFingerprint(),
  ]);
  if ([head, status, diffStat, untracked].some((result) => result.code !== 0)) {
    throw new Error('无法记录强制接管现场');
  }
  await writeFile(
    resolve(runDirectory, 'takeover.json'),
    `${JSON.stringify(
      {
        mode: 'forced-secretary-takeover',
        reason,
        capturedAt: new Date().toISOString(),
        head: head.stdout.trim(),
        workspaceFingerprint: fingerprint,
        status: status.stdout,
        diffStat: diffStat.stdout,
        untracked: untracked.stdout,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function ensureCleanWorktree(runDirectory: string, takeover: boolean) {
  const repository = await git(['rev-parse', '--show-toplevel']);
  if (repository.code !== 0) throw new Error('当前目录不是 Git 仓库');
  const status = await git(['status', '--porcelain']);
  if (takeover) {
    await writeTakeoverManifest(
      runDirectory,
      status.stdout.trim()
        ? '制作人显式要求强制接管当前工作区；秘书负责区分相关改动与无关改动。'
        : '制作人显式要求强制接管当前工作区；现场当前干净，仍记录接管快照。',
    );
    console.log(`[秘书强制接管] 已记录当前工作区现场：${resolve(runDirectory, 'takeover.json')}`);
    return;
  }
  if (status.stdout.trim()) {
    const abandonedRun = await latestAbandonedRun();
    if (abandonedRun) {
      console.log(
        `[秘书接管] 检测到 ${abandonedRun} 的执行 Agent 异常退出，保留现有改动并重新接管。`,
      );
      return;
    }
    throw new Error(
      '完整执行要求 Git 工作区干净。请先处理现有改动，或使用 --takeover 让秘书记录并接管当前现场。',
    );
  }
}

async function commitAndPush(plan: TaskPlan, noPush: boolean, baseline: string): Promise<string> {
  const status = await git(['status', '--porcelain']);
  let createdCommit = false;
  if (status.stdout.trim()) {
    const diffCheck = await git(['diff', '--check']);
    if (diffCheck.code !== 0)
      throw new Error(`git diff --check 失败：\n${diffCheck.stdout}${diffCheck.stderr}`);

    const add = await git(['add', '-A'], true);
    if (add.code !== 0) throw new Error('git add 失败');
    const message = conventionalCommitOrFallback(plan.commitMessage, plan.title);
    const staged = await git(['diff', '--cached', '--name-only', '-z']);
    if (staged.code !== 0) throw new Error('Git 暂存文件检查失败');
    const changedFiles = staged.stdout.split('\0').filter(Boolean);
    const body = commitBodyForPlan(plan, changedFiles);
    // The final tree already has matching fast/full gate evidence. Avoid the
    // repository hook replaying npm run verify on the same tree; the message is
    // normalized locally before this non-interactive commit.
    const commit = await git(['commit', '--no-verify', '-m', message, '-m', body], true);
    if (commit.code !== 0) throw new Error('Git 提交失败');
    createdCommit = true;
  }
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const sha = (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim();
  if (!createdCommit && head === baseline) return '没有产生文件改动，无需提交。';

  if (noPush || !policy.git.autoPush) {
    return `${createdCommit ? '已提交' : '已恢复到提交'} ${sha}，按参数未推送。`;
  }
  const pushArgs = [
    'push',
    ...(validationStagesForPlan(plan).includes('full-gate') ? [] : ['--no-verify']),
    policy.git.remote,
    'HEAD',
  ];
  let push = await git(pushArgs, true);
  if (push.code !== 0 && policy.git.proxyFallback) {
    console.log(`[Git] 默认网络失败，临时使用 ${policy.git.proxyFallback} 重试，不修改全局配置。`);
    push = await git(
      [
        '-c',
        `http.proxy=${policy.git.proxyFallback}`,
        '-c',
        `https.proxy=${policy.git.proxyFallback}`,
        ...pushArgs,
      ],
      true,
    );
  }
  if (push.code !== 0) throw new Error(`提交 ${sha} 已创建，但推送失败`);
  return `${createdCommit ? '已提交并推送' : '已续传'} ${sha}。`;
}

const options = parseArgs(process.argv.slice(2));
const policy = validatePolicy(JSON.parse(await readFile(policyPath, 'utf8')));
const runsRoot = resolve(root, '.daoyan-agent', 'runs');
let runDirectory: string;
if (options.resumeDirectory) {
  runDirectory = resolve(root, options.resumeDirectory);
  const relativeRun = relative(runsRoot, runDirectory);
  if (relativeRun.startsWith('..') || isAbsolute(relativeRun)) {
    throw new Error(`只能恢复 ${runsRoot} 中的运行目录`);
  }
} else if (options.runId) {
  runDirectory = resolve(runsRoot, options.runId);
} else {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${options.direction
    .slice(0, 24)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')}`;
  runDirectory = resolve(runsRoot, runId);
}
await mkdir(runDirectory, { recursive: true });
const [canonicalRunsRoot, canonicalRunDirectory] = await Promise.all([
  realpath(runsRoot),
  realpath(runDirectory),
]);
const canonicalRelativeRun = relative(canonicalRunsRoot, canonicalRunDirectory);
if (canonicalRelativeRun.startsWith('..') || isAbsolute(canonicalRelativeRun)) {
  throw new Error(`运行目录的真实路径必须位于 ${runsRoot} 内`);
}

let activePlan: TaskPlan | null = null;
let activeBaseline = '';
let activeDirection = options.direction;
let activeResolvedDirection = options.direction;
let activeTaskRuns: TaskRun[] = [];
let activeReview: ReviewResult | null = null;
let activeReviewStall: { signature: string; count: number } | undefined;
let activeValidationProgress: ValidationProgress = {
  fastGate: null,
  independentReview: null,
};
let activePlannerTokens: number | null = null;
let activeReviewerTokens: number | null = null;
let activeRepairerTokens: number | null = null;
let activeNoPush = options.noPush;
let activeTakeover = options.takeover;
let activeCompletedDeliveryCommit = false;
let activeActualLaunchCount: number | null = 1;
let activeAbnormalRecoveryCount: number | null = 0;
let activeLocalRepairRoundCount: number | null = 0;
let currentPhase = '初始化';
const currentProcessIdentity = getProcessIdentity(process.pid);

function throwIfReviewStalled(review: ReviewResult): void {
  if (activeReviewStall && activeReviewStall.count >= 3) {
    throw new Error(
      `审查停滞：同一范围和等级的问题已连续 ${activeReviewStall.count} 轮未关闭，已停止自动修复与复审；请核查失败命令、真实产物及运行环境。最近结论：${review.summary}`,
    );
  }
}

function applyProducerGuidance(direction: string): string {
  return options.producerGuidance
    ? `${direction}\n\n制作人已确认的决定：${options.producerGuidance}`
    : direction;
}

async function persistCheckpoint(status: RecoveryCheckpoint['status'], error = ''): Promise<void> {
  if (!activePlan || !activeBaseline) return;
  await writeCheckpoint(runDirectory, {
    version: 1,
    status,
    processPid: status === 'active' ? process.pid : 0,
    processIdentity: status === 'active' ? currentProcessIdentity : '',
    phase: currentPhase,
    direction: activeDirection,
    resolvedDirection: activeResolvedDirection,
    baseline: activeBaseline,
    workspaceFingerprint: await workspaceFingerprint(),
    workspaceChangeBaseline: await captureWorkspaceChangeBaseline(),
    plan: activePlan,
    taskRuns: activeTaskRuns,
    review: activeReview,
    reviewStall: activeReviewStall,
    validationProgress: activeValidationProgress,
    plannerTokens: activePlannerTokens,
    reviewerTokens: activeReviewerTokens,
    repairerTokens: activeRepairerTokens,
    noPush: activeNoPush,
    takeover: activeTakeover,
    error,
    actualLaunchCount: activeActualLaunchCount,
    abnormalRecoveryCount: activeAbnormalRecoveryCount,
    localRepairRoundCount: activeLocalRepairRoundCount,
  });
}

async function recordCheckpointInterval(checkpoint: RecoveryCheckpoint): Promise<void> {
  const startedAt = Date.parse(checkpoint.updatedAt);
  if (!Number.isFinite(startedAt)) return;
  const externalWait = classifyAgentFailure(checkpoint.error, 1) === 'external-blocker';
  const timeCategory = externalWait
    ? 'waiting-quota'
    : checkpoint.status === 'waiting-producer'
      ? 'waiting-producer'
      : checkpoint.status === 'recoverable'
        ? 'recovery'
        : null;
  if (!timeCategory) return;
  await appendPublicWorkEvent(resolve(runDirectory, 'public-events.jsonl'), {
    eventId: `checkpoint-interval-${checkpoint.status}-${checkpoint.updatedAt}`,
    sequence: 0,
    runId: basename(runDirectory),
    agentId: 'feature-pm',
    executionRound: activeActualLaunchCount ?? 1,
    codeRevision: await workspaceFingerprint(),
    timeCategory,
    kind: 'action',
    payload: {
      action: 'resume-checkpoint',
      summary: checkpoint.phase,
      status: 'resumed',
    },
    createdAt: checkpoint.updatedAt,
    durationMs: Math.max(0, Date.now() - startedAt),
  });
}

try {
  if (options.doctor) {
    const progressFile = resolve(runDirectory, 'progress.json');
    const codex = await runProcess('codex', ['--version'], {
      heartbeatLabel: '环境诊断 / Codex',
      progressFile,
      timeoutMs: minutes(1),
    });
    const npm = await runProcess('npm', ['--version'], {
      heartbeatLabel: '环境诊断 / npm',
      progressFile,
      timeoutMs: minutes(1),
    });
    if (codex.code !== 0 || npm.code !== 0) {
      throw new Error(`子进程检查失败：\n${codex.stderr}${npm.stderr}`);
    }
    console.log(`[doctor] ${codex.stdout.trim()}`);
    console.log(`[doctor] npm ${npm.stdout.trim()}`);
    process.exit(0);
  }
  if (options.resumeDirectory) {
    const checkpoint = await readCheckpoint(runDirectory);
    const resumedCounters = recoveryCountersAfterResume(
      checkpoint.status,
      checkpoint.actualLaunchCount,
      checkpoint.abnormalRecoveryCount,
    );
    activeActualLaunchCount = resumedCounters.actualLaunchCount;
    activeAbnormalRecoveryCount = resumedCounters.abnormalRecoveryCount;
    activeLocalRepairRoundCount = checkpoint.localRepairRoundCount;
    await recordCheckpointInterval(checkpoint);
    if (checkpoint.status === 'delivered') throw new Error('该运行已经交付，无需恢复');
    const currentFingerprint = await workspaceFingerprint();
    const [currentHead, currentStatus, currentParent, currentMessage, baselineAncestor] =
      await Promise.all([
        git(['rev-parse', 'HEAD']),
        git(['status', '--porcelain']),
        git(['rev-parse', 'HEAD^']),
        git(['log', '-1', '--pretty=%s']),
        git(['merge-base', '--is-ancestor', checkpoint.baseline, 'HEAD']),
      ]);
    const expectedCommitMessage = conventionalCommitOrFallback(
      checkpoint.plan.commitMessage,
      checkpoint.plan.title,
    );
    const completedCommitCanResume =
      currentHead.code === 0 &&
      currentStatus.code === 0 &&
      currentParent.code === 0 &&
      currentMessage.code === 0 &&
      canResumeCompletedCommit({
        phase: checkpoint.phase,
        baseline: checkpoint.baseline,
        currentHead: currentHead.stdout.trim(),
        currentParent: currentParent.stdout.trim(),
        currentMessage: currentMessage.stdout.trim(),
        expectedMessage: expectedCommitMessage,
        worktreeClean: currentStatus.stdout.trim().length === 0,
      });
    activeCompletedDeliveryCommit = completedCommitCanResume;
    const emptyRecoveryCanRebase = canRebaseEmptyRecovery({
      status: checkpoint.status,
      taskRunCount: checkpoint.taskRuns.length,
      baseline: checkpoint.baseline,
      currentHead: currentHead.stdout.trim(),
      worktreeClean: currentStatus.code === 0 && currentStatus.stdout.trim().length === 0,
      baselineIsAncestor: baselineAncestor.code === 0,
    });
    const canAdoptAbandonedChanges =
      checkpoint.status === 'active' && checkpoint.taskRuns.length === 0;
    const fingerprintMismatch = currentFingerprint !== checkpoint.workspaceFingerprint;
    let selectivelyReusableTaskRuns: TaskRun[] | null = null;
    let selectiveRecoverySafe = false;
    if (
      fingerprintMismatch &&
      checkpoint.taskRuns.length > 0 &&
      currentHead.code === 0 &&
      currentHead.stdout.trim() === checkpoint.baseline &&
      !emptyRecoveryCanRebase &&
      !completedCommitCanResume
    ) {
      const currentConfigFingerprint = await verificationConfigFingerprint();
      const reuseEvidence = await Promise.all(
        checkpoint.taskRuns.map(async (run) => ({
          taskId: run.task.id,
          passed: run.result === 'passed',
          inputFingerprint: run.inputFingerprint ?? run.outputFingerprint ?? '',
          currentInputFingerprint: await taskPathFingerprint(run.inputPaths ?? run.task.paths),
          outputFingerprint: run.outputFingerprint ?? '',
          currentOutputFingerprint: await taskPathFingerprint(
            taskOutputPaths(run.task.paths, run.changedFiles),
          ),
          commandFingerprint: run.commandFingerprint ?? '',
          currentCommandFingerprint: stringFingerprint(run.task.verification),
          configFingerprint: run.configFingerprint ?? '',
          currentConfigFingerprint,
        })),
      );
      const reusableIds = new Set(selectReusableTaskIds(checkpoint.plan.tasks, reuseEvidence));
      selectivelyReusableTaskRuns = checkpoint.taskRuns.filter((run) =>
        reusableIds.has(run.task.id),
      );
      selectiveRecoverySafe = await changesBelongToRecoveryPlan(
        checkpoint.plan,
        checkpoint.taskRuns,
        checkpoint.workspaceChangeBaseline,
      );
    }
    if (
      fingerprintMismatch &&
      !options.takeover &&
      !canAdoptAbandonedChanges &&
      !emptyRecoveryCanRebase &&
      !completedCommitCanResume &&
      !selectiveRecoverySafe
    ) {
      throw new Error(
        '当前工作区与恢复点不一致，且变化无法安全归属到计划任务。为避免跳过必要实现或提交无关改动，秘书已拒绝续跑；如需接管当前现场，请追加 --takeover。',
      );
    }
    if (options.takeover) {
      activeTakeover = true;
      await writeTakeoverManifest(
        runDirectory,
        '制作人显式要求从指定恢复点强制接管当前工作区；秘书放弃旧跳过记录并重新审查。',
      );
      console.log(`[秘书强制接管] 已记录当前工作区现场：${resolve(runDirectory, 'takeover.json')}`);
    } else if (completedCommitCanResume) {
      console.log('[秘书接管] 检测到 Git 提交已完成，将续传并重新验证。');
    } else if (emptyRecoveryCanRebase) {
      console.log('[秘书接管] 任务尚未开始且仓库仅向前演进，已将空恢复点更新到当前基线。');
    } else if (fingerprintMismatch && selectiveRecoverySafe) {
      console.log('[选择性恢复] 工作区变化均可归属到当前计划，将逐项复核已有 Task 证据。');
    } else if (fingerprintMismatch) {
      console.log(
        '[秘书接管] 上一执行 Agent 在首个任务中异常退出，放弃旧跳过记录并审查当前遗留改动。',
      );
    }
    activePlan = checkpoint.plan;
    activeBaseline = emptyRecoveryCanRebase ? currentHead.stdout.trim() : checkpoint.baseline;
    activeDirection = checkpoint.direction;
    activeResolvedDirection = applyProducerGuidance(checkpoint.resolvedDirection);
    const resetCompletedWork =
      (fingerprintMismatch && !completedCommitCanResume && !emptyRecoveryCanRebase) ||
      options.takeover;
    if (options.takeover) {
      activeTaskRuns = [];
    } else if (resetCompletedWork && checkpoint.taskRuns.length > 0) {
      activeTaskRuns = selectivelyReusableTaskRuns ?? [];
      console.log(
        `[选择性恢复] 保留 ${activeTaskRuns.length}/${checkpoint.taskRuns.length} 个输入、输出与证据仍有效的已完成任务。`,
      );
    } else {
      activeTaskRuns = checkpoint.taskRuns;
    }
    activeReview = resetCompletedWork ? null : checkpoint.review;
    activeReviewStall = checkpoint.reviewStall ?? (await reviewStallFromRunHistory(runDirectory));
    activeValidationProgress = resetCompletedWork
      ? { fastGate: null, independentReview: null }
      : (checkpoint.validationProgress ?? { fastGate: null, independentReview: null });
    activePlannerTokens = checkpoint.plannerTokens;
    activeReviewerTokens = checkpoint.reviewerTokens;
    activeRepairerTokens = checkpoint.repairerTokens;
    activeNoPush = options.noPush || checkpoint.noPush;
    activeTakeover =
      options.takeover ||
      (fingerprintMismatch && !completedCommitCanResume && !emptyRecoveryCanRebase) ||
      checkpoint.takeover === true;
    console.log(`[秘书接管] 从 ${checkpoint.phase} 的恢复点继续：${runDirectory}`);
  } else {
    if (!options.planOnly) await ensureCleanWorktree(runDirectory, options.takeover);
    console.log(`[秘书] 正在分析制作人方向，运行记录：${runDirectory}`);
    const statusSource = await readFile(resolve(root, 'docs/status.md'), 'utf8');
    activeResolvedDirection = applyProducerGuidance(
      resolveProducerDirection(options.direction, statusSource),
    );
    if (activeResolvedDirection !== options.direction.trim()) {
      console.log(`[秘书] 已将模糊续作解析为：${activeResolvedDirection}`);
    }
    let plannerRun: PlannerRun;
    let localPlannerUsed = !options.deepPlan;
    if (options.deepPlan) {
      try {
        plannerRun = await askPlanner(
          activeResolvedDirection,
          policy.planner,
          resolve(runDirectory, 'plan.json'),
          resolve(runDirectory, 'planner.log'),
        );
      } catch (error) {
        console.warn(
          `[规划接管] 深度规划不可用，改用本地零 token 路由：${error instanceof Error ? error.message : String(error)}`,
        );
        plannerRun = {
          plan: validatePlan(
            buildLocalPlan(activeResolvedDirection),
            planTaskLimit(activeResolvedDirection, policy.limits.maxTasks),
          ),
          tokensUsed: null,
        };
        localPlannerUsed = true;
      }
    } else {
      plannerRun = {
        plan: validatePlan(
          buildLocalPlan(activeResolvedDirection),
          planTaskLimit(activeResolvedDirection, policy.limits.maxTasks),
        ),
        tokensUsed: 0,
      };
    }
    activePlan = plannerRun.plan;
    activePlannerTokens = plannerRun.tokensUsed;
    if (localPlannerUsed) {
      await writeFile(
        resolve(runDirectory, 'plan.json'),
        `${JSON.stringify(activePlan, null, 2)}\n`,
      );
    }
    await writeFile(
      resolve(runDirectory, 'plan.validated.json'),
      `${JSON.stringify(activePlan, null, 2)}\n`,
    );
  }

  const plan = activePlan;

  console.log(`\n[计划] ${plan.title}`);
  console.log(plan.summary);
  for (const task of sortTasks(plan.tasks)) {
    const route = routeForTask(policy, task.tier);
    console.log(`- ${task.id}: ${task.title} -> ${route.model} (${route.reasoning})`);
  }

  if (plan.producerDecisionRequired && !options.decisionConfirmed) {
    if (!activeBaseline) activeBaseline = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    currentPhase = '等待制作人决策';
    await persistCheckpoint('waiting-producer', plan.producerQuestion);
    await writeReport(
      runDirectory,
      '等待制作人决策',
      plan,
      [],
      null,
      plan.producerQuestion,
      activePlannerTokens,
    );
    console.log(`\n[需要制作人决定] ${plan.producerQuestion}`);
    process.exit(2);
  }
  if (options.planOnly) {
    await writeReport(runDirectory, '规划完成', plan, [], null, '', activePlannerTokens);
    console.log('\n[完成] 仅生成计划，未修改工作区。');
    process.exit(0);
  }

  if (!activeBaseline) activeBaseline = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  currentPhase = '执行任务';
  await persistCheckpoint('active');
  for (const task of sortTasks(plan.tasks)) {
    const completed = activeTaskRuns.find(
      (run) => run.task.id === task.id && run.result === 'passed',
    );
    if (completed) {
      console.log(`[恢复] 跳过已完成任务 ${task.id}`);
      continue;
    }
    const run = await runTask(
      plan,
      task,
      routeForTask(policy, task.tier),
      runDirectory,
      activeTaskRuns,
    );
    activeTaskRuns = [...activeTaskRuns.filter((item) => item.task.id !== task.id), run];
    await persistCheckpoint('active');
    if (run.result === 'failed') {
      await writeReport(
        runDirectory,
        '执行失败',
        plan,
        activeTaskRuns,
        null,
        `任务 ${task.id} 失败`,
        activePlannerTokens,
      );
      throw new Error(`任务 ${task.id} 在自动升级后仍然失败`);
    }
  }

  const candidateTask = plan.tasks.find((task) => task.id === 'formal-candidate');
  if (candidateTask) {
    const manifest = candidateManifestPath(candidateTask.objective);
    if (!manifest) throw new Error('候选环境阻断：任务未声明结构化候选证据路径');
    let candidate: ReturnType<typeof parseCandidateEvidence>;
    try {
      candidate = parseCandidateEvidence(
        JSON.parse(await readFile(resolve(root, manifest), 'utf8')),
      );
    } catch (error) {
      throw new Error(
        `候选环境阻断：缺少有效候选证据 ${manifest}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (candidate.status === 'blocked') {
      throw new Error(`候选环境阻断：${candidate.blocker}`);
    }
  }

  const configuredValidationStages = validationStagesForPlan(plan);
  const reusableFullGateAtStart = configuredValidationStages.includes('full-gate')
    ? await reusableFullGateEvidence(runDirectory)
    : null;
  const reusableFastGate =
    activeValidationProgress.fastGate?.passed === true &&
    (await validationStageMatches(activeValidationProgress.fastGate));
  const reusableIndependentReview =
    activeValidationProgress.independentReview?.passed === true &&
    activeValidationProgress.independentReview.result.verdict === 'pass' &&
    (await validationStageMatches(activeValidationProgress.independentReview));
  if (reusableIndependentReview) {
    activeReview = activeValidationProgress.independentReview!.result;
  } else if (!reusableFullGateAtStart) {
    activeReview = null;
  }
  const validationStages = new Set(
    pendingValidationStages(configuredValidationStages, {
      fullGate: Boolean(reusableFullGateAtStart),
      fastGate: reusableFastGate,
      independentReview: reusableIndependentReview,
      completedDeliveryCommit: activeCompletedDeliveryCommit,
    }),
  );
  const validationProfile = validationProfileForPlan(plan);
  console.log(
    `[验证策略] ${validationProfile}: ${[...validationStages].join(', ') || (reusableFullGateAtStart ? '复用匹配最终树的完整门禁证据' : 'Task 直接检查')}`,
  );
  let localRepairRound = 0;
  let reviewRound = 0;
  let repeatedNoProgress = 0;
  let previousFailureSignature = '';
  const repairAndCheckProgress = async (
    finding: ReviewResult,
    label: string,
  ): Promise<ReviewBoundary> => {
    localRepairRound += 1;
    activeLocalRepairRoundCount =
      activeLocalRepairRoundCount === null ? null : activeLocalRepairRoundCount + 1;
    const before = await workspaceFingerprint();
    const beforeFiles = await workspaceContentSnapshot();
    currentPhase = `${label} / 局部修复第 ${localRepairRound} 轮`;
    activeRepairerTokens = addTokenUsage(
      activeRepairerTokens,
      await runReviewFixWithRecovery(plan, finding, runDirectory, localRepairRound),
    );
    const after = await workspaceFingerprint();
    const signature = JSON.stringify(
      finding.findings.map((entry) => [entry.title, entry.detail, entry.paths]).sort(),
    );
    repeatedNoProgress =
      before === after && signature === previousFailureSignature ? repeatedNoProgress + 1 : 0;
    previousFailureSignature = signature;
    activeValidationProgress.independentReview = null;
    const validationFingerprint = await validationStageFingerprint();
    if (activeValidationProgress.fastGate) {
      activeValidationProgress.fastGate = {
        ...activeValidationProgress.fastGate,
        ...validationFingerprint,
      };
    }
    await persistCheckpoint('active');
    if (repeatedNoProgress >= 1) {
      throw new Error(`局部修复对同一未关闭 finding 无进展：${finding.summary}`);
    }
    return { fingerprint: before, files: beforeFiles, findings: finding };
  };

  let fastGateRound = activeValidationProgress.fastGate?.attempts ?? 0;
  if (validationStages.has('fast-gate')) {
    const commandSequence = await configuredFastGateCommands();
    let pendingCommands =
      activeValidationProgress.fastGate &&
      !activeValidationProgress.fastGate.passed &&
      (await validationStageMatches(activeValidationProgress.fastGate))
        ? activeValidationProgress.fastGate.pendingCommands
        : [];
    let completedCommands =
      pendingCommands.length > 0 ? activeValidationProgress.fastGate!.completedCommands : [];
    let failedCommand: string[] = pendingCommands[0] ?? [];
    while (true) {
      fastGateRound += 1;
      currentPhase = `Feature 快速门禁${failedCommand.length > 0 ? '定向复核' : ''}第 ${fastGateRound} 轮`;
      await persistCheckpoint('active');
      const verification = await runDeliveryVerification(
        runDirectory,
        fastGateRound,
        'fast',
        failedCommand,
      );
      if (verification.code === 0) {
        if (failedCommand.length === 0) {
          completedCommands = commandSequence;
          pendingCommands = [];
        } else {
          completedCommands = [...completedCommands, failedCommand];
          pendingCommands = pendingCommands.slice(1);
        }
        const validationFingerprint = await validationStageFingerprint();
        activeValidationProgress.fastGate = {
          ...validationFingerprint,
          completedCommands,
          pendingCommands,
          passed: pendingCommands.length === 0,
          attempts: fastGateRound,
        };
        await persistCheckpoint('active');
        if (pendingCommands.length === 0) break;
        failedCommand = pendingCommands[0];
        continue;
      }
      failedCommand = verification.failedCommand;
      if (pendingCommands.length === 0) {
        const progress = fastGateCommandProgress(commandSequence, failedCommand);
        completedCommands = progress.completedCommands;
        pendingCommands = progress.pendingCommands;
      }
      const validationFingerprint = await validationStageFingerprint();
      activeValidationProgress.fastGate = {
        ...validationFingerprint,
        completedCommands,
        pendingCommands,
        passed: false,
        attempts: fastGateRound,
      };
      await persistCheckpoint('active');
      await repairAndCheckProgress(
        {
          verdict: 'fix',
          summary: `Feature 快速门禁的失败命令 ${failedCommand.join(' ')} 留在原 PM 运行内修复。`,
          findings: [
            {
              severity: 'high',
              title: `修复失败命令：${failedCommand.join(' ')}`,
              detail: (verification.stderr || verification.stdout).slice(-5000),
              paths: [],
            },
          ],
        },
        '门禁失败',
      );
      failedCommand = pendingCommands[0] ?? failedCommand;
    }
  }

  if (validationStages.has('independent-review')) {
    let reviewBoundary: ReviewBoundary | null = null;
    while (true) {
      reviewRound += 1;
      currentPhase = `${reviewBoundary ? '增量复审' : '独立审查'}第 ${reviewRound} 轮`;
      await persistCheckpoint('active');
      const reviewRun = await askReviewerWithRecovery(
        plan,
        activeBaseline,
        runDirectory,
        reviewRound,
        reviewBoundary,
      );
      activeReview = reviewRun.result;
      activeReviewerTokens = addTokenUsage(activeReviewerTokens, reviewRun.tokensUsed);
      activeReviewStall = advanceReviewStall(activeReviewStall, activeReview);
      console.log(
        `[${reviewBoundary ? '增量复审' : '独立审查'}] ${activeReview.verdict}: ${activeReview.summary} (${reviewRun.route.model}, ${reviewRun.attempts} 次尝试)`,
      );
      await persistCheckpoint('active');
      throwIfReviewStalled(activeReview);
      if (activeReview.verdict === 'pass') {
        activeValidationProgress.independentReview = {
          ...(await validationStageFingerprint()),
          result: activeReview,
          passed: true,
          attempts: reviewRound,
        };
        await persistCheckpoint('active');
        break;
      }
      reviewBoundary = await repairAndCheckProgress(activeReview, '审查 finding');
    }
  }

  let fullGateRound = 0;
  while (validationStages.has('full-gate') && !(await reusableFullGateEvidence(runDirectory))) {
    fullGateRound += 1;
    currentPhase = `Feature 完整门禁第 ${fullGateRound} 轮`;
    await persistCheckpoint('active');
    const verification = await runDeliveryVerification(runDirectory, fullGateRound, 'full');
    if (verification.code === 0) {
      await writeFullGateEvidence(runDirectory, fullGateRound);
      break;
    }
    let reviewBoundary = await repairAndCheckProgress(
      {
        verdict: 'fix',
        summary: `最终完整门禁中的 ${verification.failedCommand.join(' ')} 失败，保留已通过的 Task/快速门禁事实并修复失败增量。`,
        findings: [
          {
            severity: 'high',
            title: `修复失败命令：${verification.failedCommand.join(' ')}`,
            detail: (verification.stderr || verification.stdout).slice(-5000),
            paths: [],
          },
        ],
      },
      '完整门禁失败',
    );
    // 修复可能改变实现；在再次运行完整门禁前只重审修复增量，不重放已通过快速门禁。
    do {
      reviewRound += 1;
      const reviewRun = await askReviewerWithRecovery(
        plan,
        activeBaseline,
        runDirectory,
        reviewRound,
        reviewBoundary,
      );
      activeReview = reviewRun.result;
      activeReviewerTokens = addTokenUsage(activeReviewerTokens, reviewRun.tokensUsed);
      activeReviewStall = advanceReviewStall(activeReviewStall, activeReview);
      await persistCheckpoint('active');
      throwIfReviewStalled(activeReview);
      if (activeReview.verdict === 'fix') {
        reviewBoundary = await repairAndCheckProgress(activeReview, '增量审查 finding');
      } else {
        activeValidationProgress.independentReview = {
          ...(await validationStageFingerprint()),
          result: activeReview,
          passed: true,
          attempts: reviewRound,
        };
        await persistCheckpoint('active');
      }
    } while (activeReview.verdict === 'fix');
  }

  if (
    configuredValidationStages.includes('independent-review') &&
    !reusableFullGateAtStart &&
    (!activeReview || activeReview.verdict !== 'pass')
  ) {
    throw new Error('交付审查没有通过');
  }
  currentPhase = 'Git 交付';
  await persistCheckpoint('active');
  if (
    configuredValidationStages.includes('full-gate') &&
    !(await reusableFullGateEvidence(runDirectory))
  ) {
    throw new Error('pre-push 前完整门禁证据与当前代码树或配置指纹不匹配');
  }
  const gitResult = policy.git.autoCommit
    ? await commitAndPush(plan, activeNoPush, activeBaseline)
    : '策略已关闭自动提交。';
  await writeReport(
    runDirectory,
    '已交付',
    plan,
    activeTaskRuns,
    activeReview,
    gitResult,
    activePlannerTokens,
    activeReviewerTokens,
    activeRepairerTokens,
  );
  currentPhase = '已交付';
  await persistCheckpoint('delivered');
  console.log(`\n[交付完成] ${gitResult}`);
  console.log(`报告：${resolve(runDirectory, 'report.md')}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (activePlan && activeBaseline) {
    await persistCheckpoint('recoverable', message);
    const resumePath = relative(root, runDirectory);
    const recoveryMessage = `恢复点已保存，无需重新描述需求。\n\n续跑：\`npm run producer:resume -- "${resumePath}"\``;
    await writeReport(
      runDirectory,
      '可恢复中止',
      activePlan,
      activeTaskRuns,
      activeReview,
      `${message}\n\n${recoveryMessage}`,
      activePlannerTokens,
      activeReviewerTokens,
      activeRepairerTokens,
    );
  }
  console.error(`\n[秘书暂停] ${message}`);
  if (activePlan && activeBaseline) {
    console.error(
      `恢复点已保存，可续跑：npm run producer:resume -- "${relative(root, runDirectory)}"`,
    );
  }
  console.error(`运行记录保留在：${runDirectory}`);
  process.exitCode = 1;
}
