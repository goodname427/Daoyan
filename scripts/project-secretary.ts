import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isOwnedProcessAlive, isProcessAlive } from './process-identity';
import {
  publicSecretaryState,
  type IntakeRequest,
  type SecretaryScope,
  type SecretaryState,
} from './secretary-state';
import { runNoticeGuard } from './secretary-notice-guard';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secretaryRoot = resolve(
  root,
  process.env.DAOYAN_SECRETARY_STATE_DIR ?? '.daoyan-agent/secretary',
);
const inboxRoot = resolve(secretaryRoot, 'inbox');
const responseRoot = resolve(secretaryRoot, 'responses');
const stateFile = resolve(secretaryRoot, 'state.json');
const lockFile = resolve(secretaryRoot, 'notice-guard.lock');
const logFile = resolve(secretaryRoot, 'notice-guard.log');
const tsxCliPath = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const scriptPath = fileURLToPath(import.meta.url);

function printHelp(): void {
  console.log(`道衍常驻秘书（外部 notice guard）

用法：
  npm run secretary -- "新的产品想法"
  npm run secretary -- --version "推进到下一个稳定版本"
  npm run secretary -- --decision "采用兼容旧存档的方案"
  npm run secretary:start
  npm run secretary:status
  npm run secretary:stop

notice guard 仅监听文件、HTTP、子进程退出和恢复定时器；空闲时不会调用模型。新消息到达时才以低成本模型做一次语义查重，随后将交付交给 producer。`);
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
  const child = spawn(process.execPath, [tsxCliPath, scriptPath, 'run'], {
    cwd: root,
    env: process.env,
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

async function enqueue(idea: string, scope: SecretaryScope, decision: boolean): Promise<void> {
  await startGuard();
  const request: IntakeRequest = {
    id: randomUUID(),
    idea,
    scope,
    decision,
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
    reviewRequired: boolean;
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
  if (publicState.reviewRequired) console.log('Review：版本已就绪，等待制作人反馈或新方向。');
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
} else if (command === 'stop') {
  await stopGuard();
} else if (command === 'status') {
  await printStatus();
} else if (command === 'help' || command === '--help' || command === '-h') {
  printHelp();
} else {
  const versionIndex = args.indexOf('--version');
  const decisionIndex = args.indexOf('--decision');
  const scope: SecretaryScope = versionIndex >= 0 ? 'version' : 'feature';
  const idea = args
    .filter((arg) => arg !== '--version' && arg !== '--decision')
    .join(' ')
    .trim();
  if (!idea) throw new Error('请提供产品想法或版本方向');
  await enqueue(idea, scope, decisionIndex >= 0);
}
