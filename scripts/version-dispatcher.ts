import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canRefreshVersionRecoveryFingerprint,
  validatePolicy,
  versionTasksFromStatus,
  type AgentPolicy,
} from './agent-routing';
import { getProcessIdentity } from './process-identity';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const versionsRoot = resolve(root, '.daoyan-agent', 'versions');
const runsRoot = resolve(root, '.daoyan-agent', 'runs');
const dispatcherPath = resolve(root, 'scripts/agent-dispatcher.ts');
const tsxCliPath = resolve(root, 'node_modules/tsx/dist/cli.mjs');

type VersionStatus = 'planned' | 'running' | 'recoverable' | 'waiting-producer' | 'review-ready';
type FeatureStatus = 'pending' | 'running' | 'recoverable' | 'waiting-producer' | 'delivered';

interface CliOptions {
  objective: string;
  planOnly: boolean;
  noPush: boolean;
  resumeDirectory: string | null;
  maxRounds: number | null;
}

interface VersionFeature {
  id: string;
  direction: string;
  status: FeatureStatus;
  attempts: number;
  runDirectory: string;
  reportStatus: string;
  commit: string;
  controlledFingerprint: string;
  decisionConfirmed: boolean;
  producerGuidance: string;
  completedAt: string;
}

interface VersionManifest {
  version: 1;
  objective: string;
  status: VersionStatus;
  processPid: number;
  processIdentity: string;
  baseline: string;
  maxFeatureRounds: number;
  deferredTasks: string[];
  features: VersionFeature[];
  noPush: boolean;
  finalVerification: 'pending' | 'passed' | 'failed' | 'skipped';
  error: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  controlledFingerprint: string;
}

interface FeatureReport {
  status?: string;
  tokenUsage?: { knownTotal?: number | null };
  extra?: string;
}

interface FeatureRecovery {
  status?: string;
  workspaceFingerprint?: string;
}

function printHelp(): void {
  console.log(`道衍版本迭代工作流

用法：
  npm run producer:version -- "推进到下一个可玩版本"
  npm run producer:version:plan -- "推进到下一个可玩版本"
  npm run producer:version:resume -- ".daoyan-agent/versions/<运行目录>"
  npm run producer:version:resume -- ".daoyan-agent/versions/<运行目录>" "制作人补充决策"

选项：
  --plan-only   只冻结版本 feature 队列，不修改工作区
  --resume      从版本运行清单继续，不重复已交付 feature
  --max-rounds  降低本次最大 feature 轮数，不能突破策略上限
  --no-push     各 feature 仍提交，但不推送远端
  --help        显示帮助

默认从 docs/status.md 按顺序冻结候选队列。每个 feature 都由现有 producer 完成实现、完整门禁、独立审查、提交和推送。`);
}

function parseArgs(argv: string[]): CliOptions {
  let planOnly = false;
  let noPush = false;
  let resumeDirectory: string | null = null;
  let maxRounds: number | null = null;
  const objective: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--plan-only') planOnly = true;
    else if (arg === '--no-push') noPush = true;
    else if (arg === '--resume') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--resume 后需要版本运行目录');
      resumeDirectory = value;
      index += 1;
    } else if (arg === '--max-rounds') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value <= 0) throw new Error('--max-rounds 必须是正整数');
      maxRounds = value;
      index += 1;
    } else objective.push(arg);
  }
  if (resumeDirectory && planOnly) throw new Error('--resume 不能与 --plan-only 同时使用');
  if (resumeDirectory && maxRounds !== null) {
    throw new Error('版本队列已冻结，--resume 不能再修改 --max-rounds');
  }
  const joined = objective.join(' ').trim();
  if (!joined && !resumeDirectory) {
    throw new Error('请提供版本目标，例如：npm run producer:version -- "推进到下一个可玩版本"');
  }
  return { objective: joined, planOnly, noPush, resumeDirectory, maxRounds };
}

async function runProcess(
  command: string,
  args: string[],
  logFile: string,
  timeoutMs?: number,
  heartbeatLabel?: string,
): Promise<number> {
  await mkdir(dirname(logFile), { recursive: true });
  const log = createWriteStream(logFile, { flags: 'a' });
  return await new Promise<number>((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let timedOut = false;
    let interrupted = false;
    const terminateTree = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else child.kill('SIGTERM');
    };
    const onInterrupt = () => {
      interrupted = true;
      process.exitCode = 130;
      terminateTree();
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    const startedAt = Date.now();
    const heartbeat = heartbeatLabel
      ? setInterval(() => {
          console.log(
            `[等待] ${heartbeatLabel} 已运行 ${Math.round((Date.now() - startedAt) / 1000)} 秒，仍在工作...`,
          );
        }, 20_000)
      : null;
    heartbeat?.unref();
    const timeout = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          const message = `[version-dispatcher] ${heartbeatLabel ?? command} 超过 ${Math.round(timeoutMs / 1000)} 秒限制\n`;
          process.stderr.write(message);
          log.write(message);
          terminateTree();
        }, timeoutMs)
      : null;
    timeout?.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      log.write(chunk);
    });
    child.on('error', (error) => {
      if (heartbeat) clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onInterrupt);
      log.end();
      rejectProcess(error);
    });
    child.on('close', (code) => {
      if (heartbeat) clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onInterrupt);
      log.end();
      resolveProcess(interrupted ? 130 : timedOut ? 124 : (code ?? 1));
    });
  });
}

async function gitHead(): Promise<string> {
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  return await new Promise<string>((resolveHead, rejectHead) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.on('error', rejectHead);
    child.on('close', (code) => {
      if (code !== 0) {
        rejectHead(
          new Error(`无法读取 Git HEAD：${Buffer.concat(errors).toString('utf8').trim()}`),
        );
      } else resolveHead(Buffer.concat(chunks).toString('utf8').trim());
    });
  });
}

interface CapturedProcess {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

async function capture(command: string, args: string[]): Promise<CapturedProcess> {
  return await new Promise<CapturedProcess>((resolveProcess, rejectProcess) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(command, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', rejectProcess);
    child.on('close', (code) => {
      resolveProcess({
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

async function workspaceFingerprint(): Promise<string> {
  const [head, status, diff, untracked] = await Promise.all([
    capture('git', ['rev-parse', 'HEAD']),
    capture('git', ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z']),
    capture('git', ['diff', '--binary', 'HEAD', '--']),
    capture('git', [
      '-c',
      'core.quotePath=false',
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]),
  ]);
  if ([head, status, diff, untracked].some((result) => result.code !== 0)) {
    throw new Error('无法计算版本恢复的工作区指纹');
  }
  const hash = createHash('sha256');
  hash.update(head.stdout);
  hash.update('\0STATUS\0');
  hash.update(status.stdout);
  hash.update('\0DIFF\0');
  hash.update(diff.stdout);
  const untrackedPaths = untracked.stdout.toString('utf8').split('\0').filter(Boolean).sort();
  for (const path of untrackedPaths) {
    hash.update('\0UNTRACKED\0');
    hash.update(path);
    hash.update('\0');
    hash.update(await readFile(resolve(root, path)));
  }
  return hash.digest('hex');
}

async function isCleanWorktree(): Promise<boolean> {
  const status = await capture('git', ['status', '--porcelain']);
  if (status.code !== 0) throw new Error('无法检查 Git 工作区');
  return status.stdout.toString('utf8').trim().length === 0;
}

async function refreshMaintenanceOnlyRecovery(
  directory: string,
  manifest: VersionManifest,
): Promise<boolean> {
  const feature = manifest.features.find((candidate) => candidate.status !== 'delivered');
  if (!feature) return false;
  const currentFingerprint = await workspaceFingerprint();
  if (
    manifest.controlledFingerprint === currentFingerprint &&
    (!feature.controlledFingerprint || feature.controlledFingerprint === currentFingerprint)
  ) {
    return false;
  }
  const [cleanWorktree, ancestor, changed] = await Promise.all([
    isCleanWorktree(),
    capture('git', ['merge-base', '--is-ancestor', manifest.baseline, 'HEAD']),
    capture('git', [
      '-c',
      'core.quotePath=false',
      'diff',
      '--name-only',
      `${manifest.baseline}..HEAD`,
      '--',
    ]),
  ]);
  if (changed.code !== 0) return false;
  const changedPaths = changed.stdout.toString('utf8').split(/\r?\n/).filter(Boolean);
  const canRefresh = canRefreshVersionRecoveryFingerprint({
    recoverable: manifest.status === 'recoverable' && feature.status === 'recoverable',
    cleanWorktree,
    baselineIsAncestor: ancestor.code === 0,
    hasChildRecovery: existsSync(resolve(feature.runDirectory, 'recovery.json')),
    hasChildReport: existsSync(resolve(feature.runDirectory, 'report.json')),
    changedPaths,
  });
  if (!canRefresh) return false;

  // The active feature owns recovery protection once maintenance migration succeeds.
  manifest.controlledFingerprint = '';
  feature.controlledFingerprint = currentFingerprint;
  manifest.error = '';
  await writeManifest(directory, manifest);
  console.log(`[版本迁移] ${feature.id} 仅因调度器维护提交改变，已安全刷新恢复指纹。`);
  return true;
}

async function writeManifest(directory: string, manifest: VersionManifest): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  manifest.processPid = manifest.status === 'running' ? process.pid : 0;
  manifest.processIdentity = manifest.status === 'running' ? currentProcessIdentity : '';
  const target = resolve(directory, 'version.json');
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

async function readFeatureReport(runDirectory: string): Promise<FeatureReport> {
  try {
    return JSON.parse(
      await readFile(resolve(runDirectory, 'report.json'), 'utf8'),
    ) as FeatureReport;
  } catch {
    return {};
  }
}

async function readFeatureRecovery(runDirectory: string): Promise<FeatureRecovery> {
  try {
    return JSON.parse(
      await readFile(resolve(runDirectory, 'recovery.json'), 'utf8'),
    ) as FeatureRecovery;
  } catch {
    return {};
  }
}

function featureDirection(objective: string, feature: VersionFeature): string {
  const guidance = feature.producerGuidance
    ? `\n\n制作人对本 feature 的补充决策：${feature.producerGuidance}`
    : '';
  return `版本目标：${objective}\n\n当前独立 feature：${feature.direction}${guidance}\n\n只完成本轮 feature 的交付闭环，不提前实现后续 feature。交付时同步 docs/status.md，将已完成事项移出下一阶段候选并记录新的项目事实。`;
}

async function executeFeature(
  directory: string,
  manifest: VersionManifest,
  feature: VersionFeature,
  policy: AgentPolicy,
): Promise<boolean> {
  const existingReport = await readFeatureReport(feature.runDirectory);
  const existingRecovery = await readFeatureRecovery(feature.runDirectory);
  if (existingRecovery.status === 'delivered') {
    if (
      existingRecovery.workspaceFingerprint &&
      existingRecovery.workspaceFingerprint !== (await workspaceFingerprint())
    ) {
      manifest.status = 'recoverable';
      manifest.error = `${feature.id} 已交付，但当前工作区与子运行交付指纹不一致，拒绝自动补记。`;
      await writeManifest(directory, manifest);
      return false;
    }
    feature.status = 'delivered';
    feature.reportStatus = existingReport.status ?? '已交付';
    feature.commit = await gitHead();
    feature.controlledFingerprint = '';
    feature.completedAt ||= new Date().toISOString();
    await writeManifest(directory, manifest);
    console.log(`[版本恢复] ${feature.id} 子运行已交付，外层清单已补记。`);
    return true;
  }
  if (existingReport.status === '已交付') {
    console.log(`[版本恢复] ${feature.id} 交付报告已存在，子恢复点尚未收束，交由子秘书续传。`);
  }
  if (
    feature.controlledFingerprint &&
    feature.controlledFingerprint !== (await workspaceFingerprint())
  ) {
    manifest.status = 'recoverable';
    manifest.error = `${feature.id} 暂停后工作区已变化；为避免接管外部改动，版本秘书拒绝强制恢复。`;
    await writeManifest(directory, manifest);
    return false;
  }
  feature.status = 'running';
  manifest.status = 'running';
  manifest.error = '';
  await writeManifest(directory, manifest);

  const relativeRun = relative(root, feature.runDirectory);
  const logFile = resolve(directory, `${feature.id}.log`);
  const baseArgs = [tsxCliPath, dispatcherPath];
  const deliveryArgs = [
    ...baseArgs,
    '--run-id',
    basename(feature.runDirectory),
    ...(feature.decisionConfirmed ? ['--decision-confirmed'] : []),
    ...(manifest.noPush ? ['--no-push'] : []),
    featureDirection(manifest.objective, feature),
  ];

  let code: number;
  if (existsSync(resolve(feature.runDirectory, 'recovery.json'))) {
    code = await runProcess(
      process.execPath,
      [
        ...baseArgs,
        '--resume',
        ...(feature.decisionConfirmed ? ['--decision-confirmed'] : []),
        ...(manifest.noPush ? ['--no-push'] : []),
        relativeRun,
      ],
      logFile,
    );
  } else {
    code = await runProcess(process.execPath, deliveryArgs, logFile);
  }
  feature.attempts += 1;
  if (code !== 0) {
    const failedReport = await readFeatureReport(feature.runDirectory);
    if (!failedReport.extra?.includes('当前工作区与恢复点不一致')) {
      feature.controlledFingerprint = await workspaceFingerprint();
      await writeManifest(directory, manifest);
    }
  }
  if (code === 130) throw new Error('版本运行被用户或主机中断');

  for (
    let recoveryAttempt = 1;
    code !== 0 && recoveryAttempt <= policy.versionCycle.featureRecoveryAttempts;
    recoveryAttempt += 1
  ) {
    const report = await readFeatureReport(feature.runDirectory);
    feature.reportStatus = report.status ?? '';
    if (report.status === '等待制作人决策') break;

    const hasRecovery = existsSync(resolve(feature.runDirectory, 'recovery.json'));
    if (recoveryAttempt > 1) {
      const currentFingerprint = await workspaceFingerprint();
      if (!feature.controlledFingerprint || currentFingerprint !== feature.controlledFingerprint) {
        manifest.status = 'recoverable';
        manifest.error = `${feature.id} 强制接管前工作区指纹已变化，已停止以保护外部改动。`;
        break;
      }
    }
    console.log(
      `\n[版本恢复] ${feature.id} 第 ${recoveryAttempt} 次自动接管${recoveryAttempt > 1 ? '（强制模式）' : ''}`,
    );
    const retryArgs = hasRecovery
      ? [
          ...baseArgs,
          '--resume',
          ...(feature.decisionConfirmed ? ['--decision-confirmed'] : []),
          ...(recoveryAttempt > 1 ? ['--takeover'] : []),
          ...(manifest.noPush ? ['--no-push'] : []),
          relativeRun,
        ]
      : deliveryArgs;
    code = await runProcess(process.execPath, retryArgs, logFile);
    feature.attempts += 1;
    if (code !== 0) {
      const failedReport = await readFeatureReport(feature.runDirectory);
      if (failedReport.extra?.includes('当前工作区与恢复点不一致')) {
        feature.controlledFingerprint = '';
        manifest.error = failedReport.extra;
        break;
      }
      feature.controlledFingerprint = await workspaceFingerprint();
      await writeManifest(directory, manifest);
    }
  }

  const report = await readFeatureReport(feature.runDirectory);
  feature.reportStatus = report.status ?? '';
  if (code === 0 && report.status === '已交付') {
    feature.status = 'delivered';
    feature.commit = await gitHead();
    feature.controlledFingerprint = '';
    feature.completedAt = new Date().toISOString();
    await writeManifest(directory, manifest);
    return true;
  }
  if (report.status === '等待制作人决策') {
    feature.status = 'waiting-producer';
    manifest.status = 'waiting-producer';
    manifest.error = report.extra ?? '当前 feature 需要制作人决策。';
  } else {
    feature.status = 'recoverable';
    manifest.status = 'recoverable';
    manifest.error = report.extra ?? `${feature.id} 在自动恢复后仍未交付。`;
  }
  await writeManifest(directory, manifest);
  return false;
}

async function runFinalVerification(directory: string): Promise<boolean> {
  const npmExecPath = process.env.npm_execpath;
  const logFile = resolve(directory, 'verify-full.log');
  if (npmExecPath) {
    return (
      (await runProcess(
        process.execPath,
        [npmExecPath, 'run', 'verify:full'],
        logFile,
        policy.timeouts.verificationMinutes * 60_000,
        '版本最终完整门禁',
      )) === 0
    );
  }
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const args =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm run verify:full']
      : ['run', 'verify:full'];
  return (
    (await runProcess(
      command,
      args,
      logFile,
      policy.timeouts.verificationMinutes * 60_000,
      '版本最终完整门禁',
    )) === 0
  );
}

async function writeReport(directory: string, manifest: VersionManifest): Promise<void> {
  const tokenTotals: number[] = [];
  for (const feature of manifest.features) {
    const report = await readFeatureReport(feature.runDirectory);
    const tokens = report.tokenUsage?.knownTotal;
    if (typeof tokens === 'number') tokenTotals.push(tokens);
  }
  const delivered = manifest.features.filter((feature) => feature.status === 'delivered').length;
  const featureLines = manifest.features.map(
    (feature) =>
      `- [${feature.status === 'delivered' ? 'x' : ' '}] ${feature.direction} - ${feature.status} (${feature.attempts} 次调用)`,
  );
  const deferredLines = manifest.deferredTasks.map((task) => `- ${task}`);
  const stopReason =
    manifest.error ||
    (manifest.status === 'review-ready'
      ? '已到达制作人 Review 节点。'
      : manifest.status === 'planned'
        ? '只读规划已冻结，尚未开始执行。'
        : '版本运行尚未完成。');
  await writeFile(
    resolve(directory, 'report.md'),
    `# 版本迭代报告\n\n- 状态：${manifest.status}\n- 目标：${manifest.objective}\n- 基线：${manifest.baseline}\n- feature：${delivered}/${manifest.features.length}\n- 最终门禁：${manifest.finalVerification}\n- 已知模型 tokens：${tokenTotals.length > 0 ? tokenTotals.reduce((sum, value) => sum + value, 0) : '不可用'}\n\n## Feature 轮次\n\n${featureLines.join('\n')}\n\n## 留待后续版本\n\n${deferredLines.join('\n') || '- 无'}\n\n## 停止原因\n\n${stopReason}\n`,
    'utf8',
  );
}

async function createManifest(
  directory: string,
  options: CliOptions,
  policy: AgentPolicy,
): Promise<VersionManifest> {
  const status = await readFile(resolve(root, 'docs/status.md'), 'utf8');
  const candidates = versionTasksFromStatus(status);
  if (candidates.length === 0)
    throw new Error('docs/status.md 中没有可进入版本队列的当前任务或下一阶段候选');
  const requestedRounds = options.maxRounds ?? policy.versionCycle.maxFeatureRounds;
  if (requestedRounds > policy.versionCycle.maxFeatureRounds) {
    throw new Error(`--max-rounds 不能超过策略上限 ${policy.versionCycle.maxFeatureRounds}`);
  }
  const maxFeatureRounds = requestedRounds;
  const selected = candidates.slice(0, maxFeatureRounds);
  const versionId = basename(directory);
  const now = new Date().toISOString();
  return {
    version: 1,
    objective: options.objective,
    status: 'planned',
    processPid: 0,
    processIdentity: '',
    baseline: await gitHead(),
    maxFeatureRounds,
    deferredTasks: candidates.slice(maxFeatureRounds),
    features: selected.map((direction, index) => ({
      id: `feature-${String(index + 1).padStart(2, '0')}`,
      direction,
      status: 'pending',
      attempts: 0,
      runDirectory: resolve(runsRoot, `${versionId}-feature-${String(index + 1).padStart(2, '0')}`),
      reportStatus: '',
      commit: '',
      controlledFingerprint: '',
      decisionConfirmed: false,
      producerGuidance: '',
      completedAt: '',
    })),
    noPush: options.noPush,
    finalVerification: 'pending',
    error: '',
    createdAt: now,
    updatedAt: now,
    completedAt: '',
    controlledFingerprint: '',
  };
}

const options = parseArgs(process.argv.slice(2));
const currentProcessIdentity = getProcessIdentity(process.pid);
const policy = validatePolicy(
  JSON.parse(await readFile(resolve(root, 'agents/policy.json'), 'utf8')),
);
await mkdir(versionsRoot, { recursive: true });

let directory: string;
let manifest: VersionManifest;
if (options.resumeDirectory) {
  directory = resolve(root, options.resumeDirectory);
  const relativeVersion = relative(versionsRoot, directory);
  if (relativeVersion.startsWith('..') || isAbsolute(relativeVersion)) {
    throw new Error(`只能恢复 ${versionsRoot} 中的版本运行目录`);
  }
  manifest = JSON.parse(
    await readFile(resolve(directory, 'version.json'), 'utf8'),
  ) as VersionManifest;
  manifest.processPid = Number.isInteger(manifest.processPid) ? manifest.processPid : 0;
  manifest.processIdentity = manifest.processIdentity ?? '';
  if (manifest.status === 'review-ready') throw new Error('该版本运行已到达 Review 节点，无需恢复');
  const waitingFeatures = manifest.features.filter(
    (feature) => feature.status === 'waiting-producer',
  );
  if (manifest.status === 'waiting-producer' && !options.objective) {
    throw new Error('该版本正在等待制作人决策，请在恢复目录后附上补充决策');
  }
  if (options.objective && waitingFeatures.length === 0) {
    throw new Error('只有等待制作人决策的版本恢复才能附加补充决策');
  }
  if (options.objective) {
    for (const feature of waitingFeatures) {
      feature.status = 'pending';
      feature.decisionConfirmed = true;
      feature.producerGuidance = options.objective;
    }
    manifest.status = 'recoverable';
    manifest.error = '';
  }
  if (options.noPush) manifest.noPush = true;
  console.log(`[版本秘书] 从恢复点继续：${directory}`);
} else {
  const slug = options.objective
    .slice(0, 24)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug || 'version'}`;
  directory = resolve(versionsRoot, runId);
  await mkdir(directory, { recursive: true });
  manifest = await createManifest(directory, options, policy);
  await writeManifest(directory, manifest);
}

console.log(`\n[版本计划] ${manifest.objective}`);
for (const feature of manifest.features) console.log(`- ${feature.id}: ${feature.direction}`);
if (manifest.deferredTasks.length > 0) {
  console.log(`- 另有 ${manifest.deferredTasks.length} 项留待后续版本`);
}
console.log(`运行记录：${directory}`);

if (options.planOnly) {
  await writeReport(directory, manifest);
  console.log('\n[完成] 版本队列已冻结，未修改工作区。');
  process.exit(0);
}

try {
  if (manifest.status === 'planned' && !(await isCleanWorktree())) {
    throw new Error('完整版本执行要求 Git 工作区干净；只读规划不受此限制');
  }
  if (options.resumeDirectory) await refreshMaintenanceOnlyRecovery(directory, manifest);
  if (
    manifest.controlledFingerprint &&
    manifest.controlledFingerprint !== (await workspaceFingerprint())
  ) {
    throw new Error('版本暂停后工作区已变化，拒绝在外部改动上继续收束');
  }
  for (const feature of manifest.features) {
    if (feature.status === 'delivered') {
      console.log(`[版本恢复] 跳过已交付 ${feature.id}`);
      continue;
    }
    console.log(`\n[版本轮次] ${feature.id}: ${feature.direction}`);
    if (!(await executeFeature(directory, manifest, feature, policy))) {
      await writeReport(directory, manifest);
      console.error(`\n[版本暂停] ${manifest.error}`);
      console.error(`恢复：npm run producer:version:resume -- "${relative(root, directory)}"`);
      process.exit(manifest.status === 'waiting-producer' ? 2 : 1);
    }
  }

  console.log('\n[版本收束] 重新运行完整门禁确认跨 feature 状态。');
  const passed = await runFinalVerification(directory);
  manifest.finalVerification = passed ? 'passed' : 'failed';
  if (!passed) throw new Error('版本最终完整门禁失败');
  manifest.status = 'review-ready';
  manifest.completedAt = new Date().toISOString();
  manifest.error = '';
  manifest.controlledFingerprint = '';
  await writeManifest(directory, manifest);
  await writeReport(directory, manifest);
  console.log(
    `\n[版本已就绪] 已完成 ${manifest.features.length} 个 feature，可以交给制作人 Review。`,
  );
  console.log(`报告：${resolve(directory, 'report.md')}`);
} catch (error) {
  manifest.status = 'recoverable';
  manifest.error = error instanceof Error ? error.message : String(error);
  manifest.controlledFingerprint = await workspaceFingerprint().catch(() => '');
  await writeManifest(directory, manifest);
  await writeReport(directory, manifest);
  console.error(`\n[版本暂停] ${manifest.error}`);
  console.error(`恢复：npm run producer:version:resume -- "${relative(root, directory)}"`);
  process.exitCode = process.exitCode || 1;
}
