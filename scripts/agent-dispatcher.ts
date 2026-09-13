import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  conventionalCommitOrFallback,
  buildLocalPlan,
  escalateTier,
  highestTier,
  optimizePlan,
  preferredWindowsExecutable,
  resolveProducerDirection,
  reviewRouteForPlan,
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
}

function printHelp() {
  console.log(`道衍制作人工作流

用法：
  npm run producer -- "描述产品方向或问题"
  npm run producer:plan -- "描述产品方向或问题"

选项：
  --plan-only  只让秘书分析、拆分和分配模型，不修改代码
  --deep-plan  额外调用模型进行规划；默认使用零-token 本地路由
  --doctor     检查 Codex 与 npm 子进程入口，不调用模型
  --no-push    完成交付和提交，但不推送远端
  --help       显示帮助

完整执行要求开始时 Git 工作区干净；制作人不需要判断任务复杂度。`);
}

function parseArgs(argv: string[]): CliOptions {
  let planOnly = false;
  let deepPlan = false;
  let doctor = false;
  let noPush = false;
  const direction: string[] = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--plan-only') planOnly = true;
    else if (arg === '--deep-plan') deepPlan = true;
    else if (arg === '--doctor') doctor = true;
    else if (arg === '--no-push') noPush = true;
    else direction.push(arg);
  }
  const joined = direction.join(' ').trim();
  if (!joined && !doctor) {
    throw new Error('请提供产品方向，例如：npm run producer -- "增加法术单步推演"');
  }
  return { direction: joined || 'doctor', planOnly, deepPlan, doctor, noPush };
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
  const maxAttempts = policy.limits.maxEscalationsPerTask + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const outputFile = resolve(runDirectory, `${task.id}-attempt-${attempt}.md`);
    const logFile = resolve(runDirectory, `${task.id}-attempt-${attempt}.log`);
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
    tokensUsed = addTokenUsage(tokensUsed, parseTokenUsage(`${result.stdout}\n${result.stderr}`));
    if (result.code === 0) {
      return {
        task,
        route,
        attempts: attempt,
        result: 'passed',
        outputFile,
        tokensUsed,
      };
    }
    const next = escalateTier(tier);
    if (!next || attempt === maxAttempts) {
      return {
        task,
        route,
        attempts: attempt,
        result: 'failed',
        outputFile,
        tokensUsed,
      };
    }
    failureContext = `上一次执行失败，请检查并修复，不要简单重复。失败摘要：\n${(
      result.stderr || result.stdout
    ).slice(-4000)}`;
    tier = next;
    route = routeForTask(policy, tier);
    console.log(`[升级] ${task.id} -> ${route.model}`);
  }
  throw new Error('不可达的任务状态');
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

async function askReviewer(
  plan: TaskPlan,
  route: ModelRoute,
  baseline: string,
  runDirectory: string,
  round: number,
): Promise<ReviewRun> {
  const outputFile = resolve(runDirectory, `review-${round}.json`);
  const logFile = resolve(runDirectory, `review-${round}.log`);
  const inputFile = await writeReviewInput(baseline, runDirectory, round);
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
  if (result.code !== 0) throw new Error(`独立审查失败，详见 ${logFile}`);
  return {
    result: validateReview(parseJsonFile(await readFile(outputFile, 'utf8'))),
    tokensUsed: parseTokenUsage(`${result.stdout}\n${result.stderr}`),
  };
}

async function runReviewFix(
  plan: TaskPlan,
  review: ReviewResult,
  route: ModelRoute,
  runDirectory: string,
  round: number,
): Promise<number | null> {
  const outputFile = resolve(runDirectory, `review-fix-${round}.md`);
  const logFile = resolve(runDirectory, `review-fix-${round}.log`);
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
  if (result.code !== 0) throw new Error(`审查修复失败，详见 ${logFile}`);
  return parseTokenUsage(`${result.stdout}\n${result.stderr}`);
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

async function ensureCleanWorktree() {
  const repository = await git(['rev-parse', '--show-toplevel']);
  if (repository.code !== 0) throw new Error('当前目录不是 Git 仓库');
  const status = await git(['status', '--porcelain']);
  if (status.stdout.trim()) {
    throw new Error(
      '完整执行要求 Git 工作区干净。请先处理现有改动，或使用 producer:plan 只做规划。',
    );
  }
}

async function commitAndPush(plan: TaskPlan, noPush: boolean): Promise<string> {
  const status = await git(['status', '--porcelain']);
  if (!status.stdout.trim()) return '没有产生文件改动，无需提交。';
  const diffCheck = await git(['diff', '--check']);
  if (diffCheck.code !== 0)
    throw new Error(`git diff --check 失败：\n${diffCheck.stdout}${diffCheck.stderr}`);

  const add = await git(['add', '-A'], true);
  if (add.code !== 0) throw new Error('git add 失败');
  const message = conventionalCommitOrFallback(plan.commitMessage, plan.title);
  const commit = await git(['commit', '-m', message], true);
  if (commit.code !== 0) throw new Error('Git 提交失败');
  const sha = (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim();

  if (noPush || !policy.git.autoPush) return `已提交 ${sha}，按参数未推送。`;
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
  return `已提交并推送 ${sha}。`;
}

const options = parseArgs(process.argv.slice(2));
const policy = validatePolicy(JSON.parse(await readFile(policyPath, 'utf8')));
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${options.direction
  .slice(0, 24)
  .replace(/[^\p{L}\p{N}]+/gu, '-')
  .replace(/^-|-$/g, '')}`;
const runDirectory = resolve(root, '.daoyan-agent', 'runs', runId);
await mkdir(runDirectory, { recursive: true });

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
  if (!options.planOnly) await ensureCleanWorktree();
  console.log(`[秘书] 正在分析制作人方向，运行记录：${runDirectory}`);
  const statusSource = await readFile(resolve(root, 'docs/status.md'), 'utf8');
  const resolvedDirection = resolveProducerDirection(options.direction, statusSource);
  if (resolvedDirection !== options.direction.trim()) {
    console.log(`[秘书] 已将模糊续作解析为：${resolvedDirection}`);
  }
  const plannerRun = options.deepPlan
    ? await askPlanner(
        resolvedDirection,
        policy.planner,
        resolve(runDirectory, 'plan.json'),
        resolve(runDirectory, 'planner.log'),
      )
    : {
        plan: validatePlan(buildLocalPlan(resolvedDirection), policy.limits.maxTasks),
        tokensUsed: 0,
      };
  const plan = plannerRun.plan;
  const plannerTokens = plannerRun.tokensUsed;
  if (!options.deepPlan) {
    await writeFile(resolve(runDirectory, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  }
  await writeFile(
    resolve(runDirectory, 'plan.validated.json'),
    `${JSON.stringify(plan, null, 2)}\n`,
  );

  console.log(`\n[计划] ${plan.title}`);
  console.log(plan.summary);
  for (const task of sortTasks(plan.tasks)) {
    const route = routeForTask(policy, task.tier);
    console.log(`- ${task.id}: ${task.title} -> ${route.model} (${route.reasoning})`);
  }

  if (plan.producerDecisionRequired) {
    await writeReport(
      runDirectory,
      '等待制作人决策',
      plan,
      [],
      null,
      plan.producerQuestion,
      plannerTokens,
    );
    console.log(`\n[需要制作人决定] ${plan.producerQuestion}`);
    process.exit(2);
  }
  if (options.planOnly) {
    await writeReport(runDirectory, '规划完成', plan, [], null, '', plannerTokens);
    console.log('\n[完成] 仅生成计划，未修改工作区。');
    process.exit(0);
  }

  const baseline = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const taskRuns: TaskRun[] = [];
  for (const task of sortTasks(plan.tasks)) {
    const run = await runTask(plan, task, routeForTask(policy, task.tier), runDirectory);
    taskRuns.push(run);
    if (run.result === 'failed') {
      await writeReport(
        runDirectory,
        '执行失败',
        plan,
        taskRuns,
        null,
        `任务 ${task.id} 失败`,
        plannerTokens,
      );
      throw new Error(`任务 ${task.id} 在自动升级后仍然失败`);
    }
  }

  let review: ReviewResult | null = null;
  let reviewerTokens: number | null = null;
  let repairerTokens: number | null = null;
  for (let round = 1; round <= policy.limits.maxReviewRounds; round += 1) {
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
          taskRuns,
          syntheticReview,
          '',
          plannerTokens,
          reviewerTokens,
          repairerTokens,
        );
        throw new Error(`交付门禁失败，详见 ${resolve(runDirectory, `verify-${round}.log`)}`);
      }
      repairerTokens = addTokenUsage(
        repairerTokens,
        await runReviewFix(
          plan,
          syntheticReview,
          reviewRouteForPlan(policy, plan),
          runDirectory,
          round,
        ),
      );
      continue;
    }

    const reviewRoute = reviewRouteForPlan(policy, plan);
    const reviewRun = await askReviewer(plan, reviewRoute, baseline, runDirectory, round);
    review = reviewRun.result;
    reviewerTokens = addTokenUsage(reviewerTokens, reviewRun.tokensUsed);
    console.log(`[独立审查] ${review.verdict}: ${review.summary}`);
    if (review.verdict === 'pass') break;
    if (round === policy.limits.maxReviewRounds) {
      await writeReport(
        runDirectory,
        '审查未通过',
        plan,
        taskRuns,
        review,
        '',
        plannerTokens,
        reviewerTokens,
        repairerTokens,
      );
      throw new Error('独立审查在自动修复后仍未通过');
    }
    repairerTokens = addTokenUsage(
      repairerTokens,
      await runReviewFix(plan, review, reviewRoute, runDirectory, round),
    );
  }

  if (!review || review.verdict !== 'pass') throw new Error('交付审查没有通过');
  const gitResult = policy.git.autoCommit
    ? await commitAndPush(plan, options.noPush)
    : '策略已关闭自动提交。';
  await writeReport(
    runDirectory,
    '已交付',
    plan,
    taskRuns,
    review,
    gitResult,
    plannerTokens,
    reviewerTokens,
    repairerTokens,
  );
  console.log(`\n[交付完成] ${gitResult}`);
  console.log(`报告：${resolve(runDirectory, 'report.md')}`);
} catch (error) {
  console.error(`\n[秘书中止] ${error instanceof Error ? error.message : String(error)}`);
  console.error(`运行记录保留在：${runDirectory}`);
  process.exit(1);
}
