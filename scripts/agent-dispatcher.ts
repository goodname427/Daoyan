import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  conventionalCommitOrFallback,
  canResumeCompletedCommit,
  buildLocalPlan,
  classifyAgentFailure,
  escalateTier,
  highestTier,
  isSafeRunId,
  optimizePlan,
  preferredWindowsExecutable,
  resolveProducerDirection,
  reviewRoutesForPlan,
  routeForTask,
  sortTasks,
  validatePlan,
  validatePolicy,
  validateReview,
  type ModelRoute,
  type PlannedTask,
  type ReviewResult,
  type TaskPlan,
} from './agent-routing';
import { getProcessIdentity } from './process-identity';

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
}

interface TaskRun {
  task: PlannedTask;
  route: ModelRoute;
  attempts: number;
  result: 'passed' | 'failed';
  outputFile: string;
  tokensUsed: number | null;
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

interface RecoveryCheckpoint {
  version: 1;
  status: 'active' | 'recoverable' | 'delivered';
  processPid: number;
  processIdentity: string;
  phase: string;
  direction: string;
  resolvedDirection: string;
  baseline: string;
  workspaceFingerprint: string;
  plan: TaskPlan;
  taskRuns: TaskRun[];
  review: ReviewResult | null;
  plannerTokens: number | null;
  reviewerTokens: number | null;
  repairerTokens: number | null;
  noPush: boolean;
  takeover?: boolean;
  error: string;
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
    else if (arg === '--run-id') {
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
        ...(code === undefined ? {} : { code }),
      };
      progressWrites = progressWrites.then(() =>
        writeFile(options.progressFile!, `${JSON.stringify(progress, null, 2)}\n`, 'utf8'),
      );
    };
    recordProgress('running');
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
      spawnFailed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      recordProgress('failed', 1);
      reject(error);
    });
    child.on('close', async (code) => {
      try {
        if (heartbeat) clearInterval(heartbeat);
        if (timeout) clearTimeout(timeout);
        if (options.logFile) {
          await writeFile(options.logFile, `${stdout}\n--- STDERR ---\n${stderr}`, 'utf8');
        }
        const finalCode = timedOut ? 124 : (code ?? 1);
        recordProgress(timedOut ? 'timed_out' : spawnFailed ? 'failed' : 'finished', finalCode);
        await progressWrites;
        resolvePromise({ code: finalCode, stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(options.input ?? '');
  });
}

function minutes(value: number): number {
  return value * 60_000;
}

async function git(args: string[], stream = false): Promise<ProcessResult> {
  return await runProcess('git', args, { stream });
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
  console.log(`[恢复] ${label}，${seconds} 秒后重试。`);
  if (seconds > 0)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, seconds * 1000));
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
  return {
    version: 1,
    status:
      value.status === 'delivered'
        ? 'delivered'
        : value.status === 'active'
          ? 'active'
          : 'recoverable',
    processPid: Number.isInteger(value.processPid) ? value.processPid! : 0,
    processIdentity: value.processIdentity ?? '',
    phase: value.phase ?? '未知阶段',
    direction: value.direction ?? value.plan.summary,
    resolvedDirection: value.resolvedDirection ?? value.plan.summary,
    baseline: value.baseline,
    workspaceFingerprint: value.workspaceFingerprint,
    plan: validatePlan(value.plan, policy.limits.maxTasks),
    taskRuns: value.taskRuns as TaskRun[],
    review: value.review ?? null,
    plannerTokens: value.plannerTokens ?? null,
    reviewerTokens: value.reviewerTokens ?? null,
    repairerTokens: value.repairerTokens ?? null,
    noPush: value.noPush ?? false,
    takeover: value.takeover ?? false,
    error: value.error ?? '',
    updatedAt: value.updatedAt ?? '',
  };
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
      progressFile: resolve(dirname(outputFile), 'progress.json'),
      timeoutMs: minutes(policy.timeouts.plannerMinutes),
    },
  );
  if (result.code !== 0) throw new Error(`秘书规划失败，详见 ${logFile}`);
  return {
    plan: optimizePlan(
      validatePlan(parseJsonFile(await readFile(outputFile, 'utf8')), policy.limits.maxTasks),
    ),
    tokensUsed: parseTokenUsage(`${result.stdout}\n${result.stderr}`),
  };
}

function workerPrompt(plan: TaskPlan, task: PlannedTask, failureContext: string): string {
  const takeoverInstruction = activeTakeover
    ? '\n这是秘书强制接管现场：工作区中可能已有执行 Agent 的部分改动。先区分与本目标相关的改动和无关改动，保留相关改动并审查其正确性；禁止为了恢复而清空或覆盖无关现场。\n'
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

完成实现后运行聚焦测试和 npm run verify；不要运行 npm run verify:full，它由秘书统一执行。简洁报告修改、验证与剩余风险。`;
}

async function runTask(
  plan: TaskPlan,
  task: PlannedTask,
  initialRoute: ModelRoute,
  runDirectory: string,
): Promise<TaskRun> {
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
          input: workerPrompt(plan, task, failureContext),
          logFile,
          stream: true,
          heartbeatLabel: `执行 ${task.id} / ${route.model}`,
          progressFile: resolve(runDirectory, 'progress.json'),
          timeoutMs: minutes(policy.timeouts.workers[tier]),
        },
      );
      tokensUsed = addTokenUsage(tokensUsed, parseTokenUsage(failureText(result)));
      if (result.code === 0) {
        return {
          task,
          route,
          attempts: totalAttempts,
          result: 'passed',
          outputFile,
          tokensUsed,
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
      return {
        task,
        route,
        attempts: totalAttempts,
        result: 'failed',
        outputFile: lastOutputFile,
        tokensUsed,
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
): Promise<ProcessResult> {
  const [command, ...args] = policy.verification.delivery;
  console.log(`\n[交付门禁] ${policy.verification.delivery.join(' ')}`);
  return await runProcess(command, args, {
    logFile: resolve(runDirectory, `verify-${round}.log`),
    stream: true,
    heartbeatLabel: `交付门禁 / 第 ${round} 轮`,
    progressFile: resolve(runDirectory, 'progress.json'),
    timeoutMs: minutes(policy.timeouts.verificationMinutes),
  });
}

async function writeReviewInput(
  baseline: string,
  runDirectory: string,
  round: number,
): Promise<string> {
  const diff = await git(['diff', '--no-ext-diff', baseline, '--']);
  if (diff.code !== 0) throw new Error('无法生成审查差异');
  const maxReviewBytes = 500_000;
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
  const inputFile = resolve(runDirectory, `review-input-${round}.patch`);
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
): Promise<ReviewRun> {
  const slug = route.model.replace(/[^a-z0-9.-]+/gi, '-');
  const outputFile = resolve(runDirectory, `review-${round}-${slug}-attempt-${attempt}.json`);
  const logFile = resolve(runDirectory, `review-${round}-${slug}-attempt-${attempt}.log`);
  const prompt = `你是道衍项目的独立审查 Agent。不要修改文件。

父进程已经成功运行完整交付门禁，不要再次运行测试、构建或 Git 命令，也不要把当前沙盒不能启动子进程当作缺陷。先阅读 AGENTS.md，再只审查 ${inputFile} 中从基线 ${baseline} 开始的差异；仅在确认具体问题时读取差异涉及的文件或直接契约，不要扫描整个仓库、路线图或历史日志。

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
): Promise<ReviewRun> {
  const inputFile = await writeReviewInput(baseline, runDirectory, round);
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
  const report = {
    status,
    finishedAt: new Date().toISOString(),
    plan,
    tasks: taskRuns,
    review,
    tokenUsage: {
      planner: plannerTokens,
      workers: taskRuns.map((run) => ({ id: run.task.id, tokens: run.tokensUsed })),
      reviewer: reviewerTokens,
      repairs: repairerTokens,
      knownTotal:
        knownTokens.length > 0 ? knownTokens.reduce((sum, tokens) => sum + tokens, 0) : null,
    },
    extra,
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
    const commit = await git(['commit', '-m', message], true);
    if (commit.code !== 0) throw new Error('Git 提交失败');
    createdCommit = true;
  }
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const sha = (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim();
  if (!createdCommit && head === baseline) return '没有产生文件改动，无需提交。';

  if (noPush || !policy.git.autoPush) {
    return `${createdCommit ? '已提交' : '已恢复到提交'} ${sha}，按参数未推送。`;
  }
  let push = await git(['push', policy.git.remote, 'HEAD'], true);
  if (push.code !== 0 && policy.git.proxyFallback) {
    console.log(`[Git] 默认网络失败，临时使用 ${policy.git.proxyFallback} 重试，不修改全局配置。`);
    push = await git(
      [
        '-c',
        `http.proxy=${policy.git.proxyFallback}`,
        '-c',
        `https.proxy=${policy.git.proxyFallback}`,
        'push',
        policy.git.remote,
        'HEAD',
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
let activePlannerTokens: number | null = null;
let activeReviewerTokens: number | null = null;
let activeRepairerTokens: number | null = null;
let activeNoPush = options.noPush;
let activeTakeover = options.takeover;
let currentPhase = '初始化';
const currentProcessIdentity = getProcessIdentity(process.pid);

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
    plan: activePlan,
    taskRuns: activeTaskRuns,
    review: activeReview,
    plannerTokens: activePlannerTokens,
    reviewerTokens: activeReviewerTokens,
    repairerTokens: activeRepairerTokens,
    noPush: activeNoPush,
    takeover: activeTakeover,
    error,
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
    if (checkpoint.status === 'delivered') throw new Error('该运行已经交付，无需恢复');
    const currentFingerprint = await workspaceFingerprint();
    const [currentHead, currentStatus, currentParent, currentMessage] = await Promise.all([
      git(['rev-parse', 'HEAD']),
      git(['status', '--porcelain']),
      git(['rev-parse', 'HEAD^']),
      git(['log', '-1', '--pretty=%s']),
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
    const canAdoptAbandonedChanges =
      checkpoint.status === 'active' && checkpoint.taskRuns.length === 0;
    const fingerprintMismatch = currentFingerprint !== checkpoint.workspaceFingerprint;
    if (
      fingerprintMismatch &&
      !options.takeover &&
      !canAdoptAbandonedChanges &&
      !completedCommitCanResume
    ) {
      throw new Error(
        '当前工作区与恢复点不一致。为避免跳过必要实现或提交无关改动，秘书已拒绝续跑；如需接管当前现场，请追加 --takeover。',
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
    } else if (fingerprintMismatch) {
      console.log(
        '[秘书接管] 上一执行 Agent 在首个任务中异常退出，放弃旧跳过记录并审查当前遗留改动。',
      );
    }
    activePlan = checkpoint.plan;
    activeBaseline = checkpoint.baseline;
    activeDirection = checkpoint.direction;
    activeResolvedDirection = checkpoint.resolvedDirection;
    const resetCompletedWork =
      (fingerprintMismatch && !completedCommitCanResume) || options.takeover;
    activeTaskRuns = resetCompletedWork ? [] : checkpoint.taskRuns;
    activeReview = resetCompletedWork ? null : checkpoint.review;
    activePlannerTokens = checkpoint.plannerTokens;
    activeReviewerTokens = checkpoint.reviewerTokens;
    activeRepairerTokens = checkpoint.repairerTokens;
    activeNoPush = options.noPush || checkpoint.noPush;
    activeTakeover =
      options.takeover ||
      (fingerprintMismatch && !completedCommitCanResume) ||
      checkpoint.takeover === true;
    console.log(`[秘书接管] 从 ${checkpoint.phase} 的恢复点继续：${runDirectory}`);
  } else {
    if (!options.planOnly) await ensureCleanWorktree(runDirectory, options.takeover);
    console.log(`[秘书] 正在分析制作人方向，运行记录：${runDirectory}`);
    const statusSource = await readFile(resolve(root, 'docs/status.md'), 'utf8');
    activeResolvedDirection = resolveProducerDirection(options.direction, statusSource);
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
          plan: validatePlan(buildLocalPlan(activeResolvedDirection), policy.limits.maxTasks),
          tokensUsed: null,
        };
        localPlannerUsed = true;
      }
    } else {
      plannerRun = {
        plan: validatePlan(buildLocalPlan(activeResolvedDirection), policy.limits.maxTasks),
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
    const run = await runTask(plan, task, routeForTask(policy, task.tier), runDirectory);
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

  activeReview = null;
  for (let round = 1; round <= policy.limits.maxReviewRounds; round += 1) {
    currentPhase = `交付门禁第 ${round} 轮`;
    await persistCheckpoint('active');
    const verification = await runDeliveryVerification(runDirectory, round);
    if (verification.code !== 0) {
      const syntheticReview: ReviewResult = {
        verdict: 'fix',
        summary: '交付门禁失败',
        findings: [
          {
            severity: 'high',
            title: '修复交付门禁',
            detail: (verification.stderr || verification.stdout).slice(-5000),
            paths: [],
          },
        ],
      };
      if (round === policy.limits.maxReviewRounds) {
        await writeReport(
          runDirectory,
          '验证失败',
          plan,
          activeTaskRuns,
          syntheticReview,
          '',
          activePlannerTokens,
          activeReviewerTokens,
          activeRepairerTokens,
        );
        throw new Error(`交付门禁失败，详见 ${resolve(runDirectory, `verify-${round}.log`)}`);
      }
      currentPhase = `门禁修复第 ${round} 轮`;
      activeRepairerTokens = addTokenUsage(
        activeRepairerTokens,
        await runReviewFixWithRecovery(plan, syntheticReview, runDirectory, round),
      );
      await persistCheckpoint('active');
      continue;
    }

    currentPhase = `独立审查第 ${round} 轮`;
    await persistCheckpoint('active');
    const reviewRun = await askReviewerWithRecovery(plan, activeBaseline, runDirectory, round);
    activeReview = reviewRun.result;
    activeReviewerTokens = addTokenUsage(activeReviewerTokens, reviewRun.tokensUsed);
    console.log(
      `[独立审查] ${activeReview.verdict}: ${activeReview.summary} (${reviewRun.route.model}, ${reviewRun.attempts} 次尝试)`,
    );
    await persistCheckpoint('active');
    if (activeReview.verdict === 'pass') break;
    if (round === policy.limits.maxReviewRounds) {
      await writeReport(
        runDirectory,
        '审查未通过',
        plan,
        activeTaskRuns,
        activeReview,
        '',
        activePlannerTokens,
        activeReviewerTokens,
        activeRepairerTokens,
      );
      throw new Error('独立审查在自动修复后仍未通过');
    }
    currentPhase = `审查修复第 ${round} 轮`;
    activeRepairerTokens = addTokenUsage(
      activeRepairerTokens,
      await runReviewFixWithRecovery(plan, activeReview, runDirectory, round),
    );
    await persistCheckpoint('active');
  }

  if (!activeReview || activeReview.verdict !== 'pass') throw new Error('交付审查没有通过');
  currentPhase = 'Git 交付';
  await persistCheckpoint('active');
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
