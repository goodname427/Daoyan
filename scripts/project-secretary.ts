import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { isOwnedProcessAlive, isProcessAlive } from './process-identity';
import { publicSecretaryState, type IntakeRequest, type SecretaryState } from './secretary-state';
import { runNoticeGuard } from './secretary-notice-guard';
import {
  readFormalVersion,
  returnBlockedDevelopmentToDesignReview,
  resumeRepeatedDesignReview,
  withdrawRedundantDesignEscalation,
  writeFormalVersion,
} from './version-lifecycle';
import { refreshWindowsUserEnvironment } from './windows-user-environment';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secretaryRoot = resolve(
  root,
  process.env.DAOYAN_SECRETARY_STATE_DIR ?? '.daoyan-agent/secretary',
);
const inboxRoot = resolve(secretaryRoot, 'inbox');
const responseRoot = resolve(secretaryRoot, 'responses');
const stateFile = resolve(secretaryRoot, 'state.json');
const channelsFile = resolve(secretaryRoot, 'channels.json');
const lockFile = resolve(secretaryRoot, 'notice-guard.lock');
const logFile = resolve(secretaryRoot, 'notice-guard.log');
const tsxCliPath = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const scriptPath = fileURLToPath(import.meta.url);
const dingtalkEnvironmentNames = [
  'DAOYAN_DINGTALK_CLIENT_ID',
  'DAOYAN_DINGTALK_CLIENT_SECRET',
  'DAOYAN_DINGTALK_ALLOWED_SENDER_IDS',
  'DAOYAN_DINGTALK_NOTIFY_USER_ID',
  'DAOYAN_DINGTALK_ROBOT_CODE',
] as const;

function printHelp(): void {
  console.log(`道衍常驻秘书（外部 notice guard）

用法：
  npm run secretary -- "想说的话"
  npm run secretary:start
  npm run secretary:open
  npm run secretary:status
  npm run secretary:stop
  npm run secretary:resume-design-review
  npm run secretary:replan-stalled-development
  npm run secretary:withdraw-design-escalation -- <gate-id> <reason> <evidence-path>

秘书会结合对话与项目状态自行识别问题、新方向、回复和继续工作。notice guard 仅监听文件、HTTP、子进程退出和恢复定时器；空闲时不会调用模型。`);
}

function desktopEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('DAOYAN_DINGTALK_')) delete environment[key];
  }
  delete environment.DAOYAN_SECRETARY_TOKEN;
  delete environment.DAOYAN_SECRETARY_WEBHOOK_URL;
  return environment;
}

async function dashboardReachable(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function openDashboard(): Promise<void> {
  const port = Number(process.env.DAOYAN_SECRETARY_HTTP_PORT ?? 4317);
  await startGuard();
  if (!(await dashboardReachable(port))) {
    // A guard started by older code does not have the dashboard server; restart once after upgrade.
    await stopGuard();
    await startGuard();
  }
  const target = `http://127.0.0.1:${port}/`;
  const command =
    process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', target] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [target] }
        : { file: 'xdg-open', args: [target] };
  const child = spawn(command.file, command.args, {
    cwd: root,
    detached: true,
    env: desktopEnvironment(),
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  console.log(`[常驻秘书] 项目中枢：${target}`);
}

async function readState(): Promise<SecretaryState | null> {
  try {
    const value = JSON.parse(await readFile(stateFile, 'utf8')) as SecretaryState;
    if (value.version !== 1 || !Array.isArray(value.items)) return null;
    return {
      ...value,
      processIdentity: value.processIdentity ?? '',
      items: value.items.map((item) => ({
        ...item,
        processIdentity: item.processIdentity ?? '',
        completedTasks: Array.isArray(item.completedTasks) ? item.completedTasks : [],
      })),
    };
  } catch {
    return null;
  }
}

interface LockOwner {
  pid: number;
  processIdentity: string;
}

async function waitForGuard(timeoutMs = 5_000): Promise<SecretaryState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await readState();
    if (current?.status === 'running' && isOwnedProcessAlive(current.pid, current.processIdentity))
      return current;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return null;
}

async function readLockOwner(): Promise<LockOwner> {
  try {
    const raw = (await readFile(lockFile, 'utf8')).trim();
    if (/^\d+$/.test(raw)) return { pid: Number(raw), processIdentity: '' };
    const value = JSON.parse(raw) as Partial<LockOwner>;
    return {
      pid: Number.isInteger(value.pid) ? value.pid! : 0,
      processIdentity: value.processIdentity ?? '',
    };
  } catch {
    return { pid: 0, processIdentity: '' };
  }
}

async function startGuard(): Promise<void> {
  await mkdir(inboxRoot, { recursive: true });
  await mkdir(responseRoot, { recursive: true });
  const current = await readState();
  if (current?.status === 'running' && isOwnedProcessAlive(current.pid, current.processIdentity)) {
    console.log(`[常驻秘书] notice guard 已在运行（PID ${current.pid}）。`);
    return;
  }
  if (existsSync(lockFile)) {
    const deadline = Date.now() + 1_000;
    let owner = await readLockOwner();
    while (!isOwnedProcessAlive(owner.pid, owner.processIdentity) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      owner = await readLockOwner();
    }
    if (isOwnedProcessAlive(owner.pid, owner.processIdentity)) {
      const started = await waitForGuard();
      if (!started) throw new Error(`notice guard 锁由 PID ${owner.pid} 持有，但状态尚未就绪`);
      console.log(`[常驻秘书] notice guard 已在运行（PID ${started.pid}）。`);
      return;
    }
    if (!owner.processIdentity && isProcessAlive(owner.pid)) {
      throw new Error('发现旧格式 notice guard 锁且对应进程仍存活，无法验证所有权，请先确认该进程');
    }
    await rm(lockFile, { force: true });
  }
  const output = openSync(logFile, 'a');
  const guardEnvironment = refreshWindowsUserEnvironment(process.env, dingtalkEnvironmentNames);
  const child = spawn(process.execPath, [tsxCliPath, scriptPath, 'run'], {
    cwd: root,
    env: guardEnvironment,
    detached: true,
    stdio: ['ignore', output, output],
    windowsHide: true,
  });
  child.unref();
  closeSync(output);
  const started = await waitForGuard();
  if (!started) throw new Error(`notice guard 未能启动，请查看 ${logFile}`);
  console.log(`[常驻秘书] notice guard 已启动（PID ${started.pid}），当前处于事件休眠。`);
}

async function stopGuard(): Promise<void> {
  const current = await readState();
  if (!current || !isOwnedProcessAlive(current.pid, current.processIdentity)) {
    const owner = await readLockOwner();
    if (!isOwnedProcessAlive(owner.pid, owner.processIdentity)) {
      await rm(lockFile, { force: true });
    }
    console.log('[常驻秘书] notice guard 当前未运行。');
    return;
  }
  process.kill(current.pid, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isOwnedProcessAlive(current.pid, current.processIdentity)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!isOwnedProcessAlive(current.pid, current.processIdentity)) {
    await rm(lockFile, { force: true });
  }
  console.log('[常驻秘书] notice guard 已停止；正在运行的 PM 会收到终止信号并保留恢复点。');
}

async function resumeDesignReview(): Promise<void> {
  const current = await readState();
  if (current && isOwnedProcessAlive(current.pid, current.processIdentity)) {
    throw new Error('恢复重复主策审核前必须先停止 notice guard 并核对恢复点');
  }
  if (current?.items.some((item) => isOwnedProcessAlive(item.processPid, item.processIdentity))) {
    throw new Error('恢复重复主策审核前必须等待 PM 与执行 Agent 退出');
  }
  const version = await readFormalVersion(root);
  if (!version) throw new Error('没有可恢复的正式版本');
  resumeRepeatedDesignReview(version);
  await writeFormalVersion(root, version);
  console.log(
    `[常驻秘书] 已解除“${version.title}”的重复主策审核技术暂停；请启动 notice guard 从既有节点继续。`,
  );
}

async function replanStalledDevelopment(): Promise<void> {
  const current = await readState();
  if (!current) throw new Error('缺少秘书队列，不能核实原技术阻断');
  if (isOwnedProcessAlive(current.pid, current.processIdentity)) {
    throw new Error('技术重规划前须先停止 notice guard 并保存恢复点');
  }
  if (current.items.some((item) => isOwnedProcessAlive(item.processPid, item.processIdentity))) {
    throw new Error('技术重规划前须等待 PM 与执行 Agent 退出');
  }
  const version = await readFormalVersion(root);
  if (!version?.orchestration) throw new Error('缺少正式版本编排状态');
  const startedAt = version.nodes.find((node) => node.id === 'development')?.startedAt ?? '';
  const revision = version.orchestration.scopeRevisions
    .filter((scope) => scope.status === 'approved')
    .at(-1)?.revision;
  const blocked = [...current.items]
    .reverse()
    .find(
      (item) =>
        item.status === 'failed' &&
        item.summary.startsWith('技术阻断：审查停滞：') &&
        item.orchestration?.formalVersionId === version.id &&
        item.orchestration.formalStage === 'development' &&
        item.orchestration.formalScopeRevision === revision &&
        item.createdAt >= startedAt &&
        item.runDirectory,
    );
  if (!blocked?.runDirectory || !existsSync(resolve(blocked.runDirectory, 'recovery.json'))) {
    throw new Error('缺少当前开发轮次的审查停滞恢复证据');
  }
  const checkpoint = JSON.parse(
    await readFile(resolve(blocked.runDirectory, 'recovery.json'), 'utf8'),
  ) as {
    processPid?: number;
    processIdentity?: string;
  };
  if (isOwnedProcessAlive(checkpoint.processPid ?? 0, checkpoint.processIdentity ?? '')) {
    throw new Error('原 Feature PM 仍在运行，不能重新规划');
  }
  if (
    execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
  ) {
    throw new Error('共享工作区有未提交草稿；先核实归属并保存，不能由重规划覆盖');
  }
  returnBlockedDevelopmentToDesignReview(version, {
    id: blocked.id,
    summary: blocked.summary,
    runDirectory: blocked.runDirectory,
  });
  await writeFormalVersion(root, version);
  console.log(
    `[常驻秘书] 已保留 ${blocked.id} 的阻断证据，退回主策仅复核规则冲突及 World/VM 接入；启动 notice guard 后由 Version PM 重规划。`,
  );
}

async function withdrawDesignEscalation(
  gateId: string,
  reason: string,
  evidencePath: string,
): Promise<void> {
  const current = await readState();
  if (!current || isOwnedProcessAlive(current.pid, current.processIdentity)) {
    throw new Error('撤回重复升级前须停止 notice guard 并核对秘书队列');
  }
  if (current.items.some((item) => isOwnedProcessAlive(item.processPid, item.processIdentity))) {
    throw new Error('撤回重复升级前须等待 PM 与执行 Agent 退出');
  }
  const evidenceFile = resolve(root, evidencePath);
  const relativeEvidence = relative(resolve(root, 'docs'), evidenceFile);
  if (
    !relativeEvidence ||
    relativeEvidence.startsWith('..') ||
    isAbsolute(relativeEvidence) ||
    !existsSync(evidenceFile)
  ) {
    throw new Error('必须指向仓库内现存的设计复核证据');
  }
  if (
    execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
  ) {
    throw new Error('共享工作区有未提交内容，不能撤回升级并重启规划');
  }
  const version = await readFormalVersion(root);
  if (!version) throw new Error('没有可核对的正式版本');
  withdrawRedundantDesignEscalation(version, gateId, reason, evidencePath);
  await writeFormalVersion(root, version);
  console.log(
    `[常驻秘书] 已审计撤回重复设计升级 ${gateId}；启动 notice guard 后重新安排有界主策复核。`,
  );
}

async function enqueue(idea: string): Promise<void> {
  await startGuard();
  const request: IntakeRequest = {
    id: randomUUID(),
    idea,
    createdAt: new Date().toISOString(),
  };
  const path = resolve(inboxRoot, `${request.id}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
  await rm(path, { force: true });
  await rename(temporary, path);
  const responseFile = resolve(responseRoot, `${request.id}.json`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(await readFile(responseFile, 'utf8')) as {
        response?: string;
        plannedTasks?: string[];
      };
      console.log(`\n[秘书答复] ${response.response ?? '已处理。'}`);
      if (response.plannedTasks?.length) {
        for (const task of response.plannedTasks) console.log(`- ${task}`);
      }
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  console.log(`[秘书收件] 已接收并异步处理：${request.id}`);
}

async function printStatus(): Promise<void> {
  const current = await readState();
  if (!current) {
    console.log('[常驻秘书] 尚未初始化。运行 npm run secretary:start。');
    return;
  }
  const publicState = publicSecretaryState(current) as {
    status: string;
    lastEventAt: string;
    activeItemId: string;
    items: Array<{
      status: string;
      idea: string;
      summary: string;
      retryAt: string;
      completedTasks: Array<{ taskTitle: string; parentTitle: string; completedAt: string }>;
    }>;
  };
  const running =
    current.status === 'running' && isOwnedProcessAlive(current.pid, current.processIdentity);
  console.log(
    `[常驻秘书] ${running ? '运行中（事件休眠）' : '已停止'}，PID ${running ? current.pid : '-'}`,
  );
  console.log(`最近事件：${publicState.lastEventAt}`);
  console.log(`当前任务：${publicState.activeItemId || '无'}`);
  const channelStatus = await readFile(channelsFile, 'utf8')
    .then(
      (value) =>
        JSON.parse(value) as {
          status?: string;
          activeChannelIds?: string[];
          configuredChannelIds?: string[];
        },
    )
    .catch(() => null);
  const dingtalkActive =
    running && (channelStatus?.activeChannelIds?.includes('dingtalk:stream') ?? false);
  const dingtalkConfigured =
    running && (channelStatus?.configuredChannelIds?.includes('dingtalk:stream') ?? false);
  console.log(
    `钉钉通道：${dingtalkActive ? '已由当前守卫加载' : dingtalkConfigured ? '已配置，等待连接恢复' : '当前守卫未配置'}`,
  );
  for (const item of publicState.items.slice(-12)) {
    console.log(
      `- [${item.status}] ${item.idea}${item.retryAt ? `（${item.retryAt} 后恢复）` : ''}`,
    );
  }
  const completedTasks = publicState.items
    .flatMap((item) => item.completedTasks)
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
    .slice(0, 5);
  if (completedTasks.length > 0) {
    console.log('最近完成：');
    for (const task of completedTasks) {
      console.log(`- ${task.taskTitle}（${task.parentTitle}，${task.completedAt}）`);
    }
  }
}

const args = process.argv.slice(2);
const command = args[0] ?? 'help';

if (command === 'run') {
  await runNoticeGuard();
} else if (command === 'start') {
  await startGuard();
} else if (command === 'open') {
  await openDashboard();
} else if (command === 'stop') {
  await stopGuard();
} else if (command === 'resume-design-review') {
  await resumeDesignReview();
} else if (command === 'replan-stalled-development') {
  await replanStalledDevelopment();
} else if (command === 'withdraw-design-escalation') {
  await withdrawDesignEscalation(args[1] ?? '', args[2] ?? '', args[3] ?? '');
} else if (command === 'status') {
  await printStatus();
} else if (command === 'help' || command === '--help' || command === '-h') {
  printHelp();
} else {
  const idea = args.join(' ').trim();
  if (!idea) throw new Error('请直接告诉秘书你想说的话');
  await enqueue(idea);
}
