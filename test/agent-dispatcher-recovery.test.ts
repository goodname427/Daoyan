import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(process.cwd());
const tsxCliPath = resolve(root, 'node_modules/tsx/dist/cli.mjs');
// Windows process startup plus recovery fingerprint checks can cross 20 seconds
// under a loaded full-suite run even after the delivery report is written.
const dispatcherTimeoutMs = 30_000;
const integrationTestTimeoutMs = dispatcherTimeoutMs + 10_000;
let temporary = '';

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

function stringFingerprint(values: string[]) {
  return createHash('sha256').update(values.join('\0')).digest('hex');
}

async function pathFingerprint(cwd: string, paths: string[]) {
  const files = git(cwd, ['-c', 'core.quotePath=false', 'ls-files', '-z', '--', ...paths])
    .split('\0')
    .filter(Boolean)
    .sort();
  const hash = createHash('sha256');
  for (const path of files) {
    hash.update(path);
    hash.update('\0');
    hash.update(await readFile(resolve(cwd, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function configFingerprint(cwd: string) {
  const hash = createHash('sha256');
  for (const path of [
    'package.json',
    'package-lock.json',
    'agents/policy.json',
    'vite.config.ts',
  ]) {
    hash.update(path);
    hash.update(await readFile(resolve(cwd, path)).catch(() => Buffer.from('[missing]')));
  }
  return hash.digest('hex');
}

async function workspaceFingerprint(cwd: string) {
  const hash = createHash('sha256');
  hash.update(git(cwd, ['rev-parse', 'HEAD']));
  hash.update('\0STATUS\0');
  hash.update(git(cwd, ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z']));
  hash.update('\0DIFF\0');
  hash.update(git(cwd, ['diff', '--binary', 'HEAD', '--']));
  const untracked = git(cwd, [
    '-c',
    'core.quotePath=false',
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
  for (const path of untracked) {
    hash.update('\0UNTRACKED\0');
    hash.update(path);
    hash.update('\0');
    hash.update(await readFile(resolve(cwd, path)));
  }
  return hash.digest('hex');
}

async function workspaceChangeBaseline(cwd: string) {
  const tracked = git(cwd, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--name-only',
    '-z',
    'HEAD',
    '--',
  ]);
  const untracked = git(cwd, [
    '-c',
    'core.quotePath=false',
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  const paths = [...new Set(`${tracked}\0${untracked}`.split('\0').filter(Boolean))].sort();
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => {
        const content = await readFile(resolve(cwd, path)).catch(() => null);
        return [
          path.replaceAll('\\', '/'),
          content === null ? null : createHash('sha256').update(content).digest('hex'),
        ] as const;
      }),
    ),
  );
}

describe('Feature PM recovery checkpoint', () => {
  afterEach(async () => {
    if (temporary) {
      await rm(resolve(temporary, 'node_modules'), { recursive: true, force: true }).catch(
        () => {},
      );
      await rm(temporary, { recursive: true, force: true });
    }
    temporary = '';
  });

  it(
    'persists a real resumable checkpoint before requesting a producer decision',
    async () => {
      temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-dispatcher-decision-'));
      await cp(resolve(root, 'scripts'), resolve(temporary, 'scripts'), { recursive: true });
      await cp(resolve(root, 'agents'), resolve(temporary, 'agents'), { recursive: true });
      await mkdir(resolve(temporary, 'docs'), { recursive: true });
      await writeFile(resolve(temporary, 'docs/status.md'), '# 当前状态\n', 'utf8');
      await writeFile(
        resolve(temporary, 'package.json'),
        JSON.stringify({ type: 'module' }),
        'utf8',
      );
      await writeFile(resolve(temporary, '.gitignore'), '.daoyan-agent/\nnode_modules/\n', 'utf8');
      git(temporary, ['init']);
      git(temporary, ['config', 'user.email', 'test@daoyan.local']);
      git(temporary, ['config', 'user.name', 'Daoyan Test']);
      git(temporary, ['add', '.']);
      git(temporary, ['commit', '-m', 'test fixture']);
      await symlink(resolve(root, 'node_modules'), resolve(temporary, 'node_modules'), 'junction');

      const result = spawnSync(
        process.execPath,
        [
          tsxCliPath,
          resolve(temporary, 'scripts/agent-dispatcher.ts'),
          '--run-id',
          'producer-decision',
          '正式发布大版本 1.0',
        ],
        { cwd: temporary, encoding: 'utf8', timeout: dispatcherTimeoutMs },
      );
      expect(result.status).toBe(2);
      const checkpoint = JSON.parse(
        await readFile(
          resolve(temporary, '.daoyan-agent/runs/producer-decision/recovery.json'),
          'utf8',
        ),
      ) as Record<string, unknown>;
      expect(checkpoint).toMatchObject({
        version: 1,
        status: 'waiting-producer',
        phase: '等待制作人决策',
        processPid: 0,
      });
      expect(checkpoint.baseline).toMatch(/^[0-9a-f]{40}$/);
      expect(checkpoint.workspaceFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(checkpoint.error).toContain('确认是否正式发布大版本');
    },
    integrationTestTimeoutMs,
  );

  it(
    'reaches selective Task reuse when a resumable workspace change belongs to the plan',
    async () => {
      temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-dispatcher-selective-resume-'));
      await cp(resolve(root, 'scripts'), resolve(temporary, 'scripts'), { recursive: true });
      await cp(resolve(root, 'agents'), resolve(temporary, 'agents'), { recursive: true });
      const policyPath = resolve(temporary, 'agents/policy.json');
      const policy = JSON.parse(await readFile(policyPath, 'utf8')) as {
        git: { autoCommit: boolean; autoPush: boolean };
      };
      policy.git.autoCommit = false;
      policy.git.autoPush = false;
      await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
      await mkdir(resolve(temporary, 'docs'), { recursive: true });
      await writeFile(resolve(temporary, 'docs/status.md'), '# 当前状态\n', 'utf8');
      await writeFile(resolve(temporary, 'docs/first.md'), '# 第一项\n', 'utf8');
      await writeFile(resolve(temporary, 'docs/second.md'), '# 第二项\n', 'utf8');
      await writeFile(resolve(temporary, 'module-design.md'), '# 既有模块设计\n', 'utf8');
      await writeFile(
        resolve(temporary, 'package.json'),
        JSON.stringify({ type: 'module' }),
        'utf8',
      );
      await writeFile(resolve(temporary, '.gitignore'), '.daoyan-agent/\nnode_modules/\n', 'utf8');
      git(temporary, ['init']);
      git(temporary, ['config', 'user.email', 'test@daoyan.local']);
      git(temporary, ['config', 'user.name', 'Daoyan Test']);
      git(temporary, ['add', '.']);
      git(temporary, ['commit', '-m', 'test fixture']);
      await symlink(resolve(root, 'node_modules'), resolve(temporary, 'node_modules'), 'junction');
      await writeFile(
        resolve(temporary, 'module-design.md'),
        '# 既有模块设计\n\n接管前未提交现场，必须原样保留。\n',
        'utf8',
      );
      await writeFile(resolve(temporary, 'docs/first.md'), '# 第一项\n\n已完成。\n', 'utf8');
      await writeFile(resolve(temporary, 'docs/second.md'), '# 第二项\n\n已完成。\n', 'utf8');

      const task = (id: string, title: string) => ({
        id,
        title,
        objective: title,
        type: 'documentation',
        tier: 'economy',
        reasoning: '文档任务使用轻量验证',
        dependsOn: [],
        paths: ['docs/'],
        deliverables: [title],
        verification: [],
      });
      const firstTask = task('first', '第一项');
      const secondTask = task('second', '第二项');
      const plan = {
        version: 1,
        title: '选择性恢复测试',
        summary: '工作区变化属于计划时逐项复用完成任务',
        producerDecisionRequired: false,
        producerQuestion: '',
        riskSignals: [],
        acceptanceCriteria: ['恢复成功'],
        nonGoals: [],
        tasks: [firstTask, secondTask],
        commitMessage: 'test: selective recovery',
      };
      const currentConfigFingerprint = await configFingerprint(temporary);
      const taskRun = async (plannedTask: typeof firstTask, path: string) => {
        const fingerprint = await pathFingerprint(temporary, [path]);
        return {
          task: plannedTask,
          route: { model: 'test', reasoning: 'low' },
          attempts: 1,
          result: 'passed',
          outputFile: '',
          changedFiles: [path],
          tests: [],
          tokensUsed: 0,
          completedAt: '2026-09-21T00:00:00.000Z',
          inputPaths: [path],
          inputFingerprint: fingerprint,
          outputFingerprint: fingerprint,
          commandFingerprint: stringFingerprint([]),
          configFingerprint: currentConfigFingerprint,
        };
      };
      const runDirectory = resolve(temporary, '.daoyan-agent/runs/selective-resume');
      await mkdir(runDirectory, { recursive: true });
      const checkpointWorkspaceFingerprint = await workspaceFingerprint(temporary);
      const checkpointWorkspaceChangeBaseline = await workspaceChangeBaseline(temporary);
      await writeFile(
        resolve(runDirectory, 'recovery.json'),
        `${JSON.stringify(
          {
            version: 1,
            status: 'recoverable',
            processPid: 0,
            processIdentity: '',
            phase: '执行任务',
            direction: plan.summary,
            resolvedDirection: plan.summary,
            baseline: git(temporary, ['rev-parse', 'HEAD']).trim(),
            workspaceFingerprint: checkpointWorkspaceFingerprint,
            workspaceChangeBaseline: checkpointWorkspaceChangeBaseline,
            plan,
            taskRuns: [
              await taskRun(firstTask, 'docs/first.md'),
              await taskRun(secondTask, 'docs/second.md'),
            ],
            review: null,
            plannerTokens: 0,
            reviewerTokens: null,
            repairerTokens: null,
            noPush: true,
            takeover: true,
            error: '模拟进程异常',
            actualLaunchCount: 1,
            abnormalRecoveryCount: 0,
            localRepairRoundCount: 0,
            updatedAt: '2026-09-21T00:00:00.000Z',
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      await writeFile(
        resolve(temporary, 'docs/recovery-note.md'),
        '# 计划范围内的恢复增量\n',
        'utf8',
      );

      const result = spawnSync(
        process.execPath,
        [
          tsxCliPath,
          resolve(temporary, 'scripts/agent-dispatcher.ts'),
          '--resume',
          '.daoyan-agent/runs/selective-resume',
        ],
        { cwd: temporary, encoding: 'utf8', timeout: dispatcherTimeoutMs },
      );
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('[选择性恢复] 工作区变化均可归属到当前计划');
      expect(result.stdout).toContain('[选择性恢复] 保留 2/2');
      expect(result.stdout).toContain('[恢复] 跳过已完成任务 first');
      expect(result.stdout).toContain('[恢复] 跳过已完成任务 second');
      expect(await readFile(resolve(temporary, 'module-design.md'), 'utf8')).toContain(
        '接管前未提交现场，必须原样保留。',
      );
      const checkpoint = JSON.parse(
        await readFile(resolve(runDirectory, 'recovery.json'), 'utf8'),
      ) as { status: string; taskRuns: unknown[] };
      expect(checkpoint.status).toBe('delivered');
      expect(checkpoint.taskRuns).toHaveLength(2);
    },
    integrationTestTimeoutMs,
  );

  it(
    'attributes a plan-scoped file restored to HEAD from the persisted checkpoint baseline',
    async () => {
      temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-dispatcher-restored-output-'));
      await cp(resolve(root, 'scripts'), resolve(temporary, 'scripts'), { recursive: true });
      await cp(resolve(root, 'agents'), resolve(temporary, 'agents'), { recursive: true });
      const policyPath = resolve(temporary, 'agents/policy.json');
      const policy = JSON.parse(await readFile(policyPath, 'utf8')) as {
        git: { autoCommit: boolean; autoPush: boolean };
      };
      policy.git.autoCommit = false;
      policy.git.autoPush = false;
      await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
      await mkdir(resolve(temporary, 'docs'), { recursive: true });
      await writeFile(resolve(temporary, 'docs/status.md'), '# 当前状态\n', 'utf8');
      await writeFile(resolve(temporary, 'docs/completed.md'), '# 已完成任务\n', 'utf8');
      await writeFile(
        resolve(temporary, 'package.json'),
        JSON.stringify({ type: 'module' }),
        'utf8',
      );
      await writeFile(resolve(temporary, '.gitignore'), '.daoyan-agent/\nnode_modules/\n', 'utf8');
      git(temporary, ['init']);
      git(temporary, ['config', 'user.email', 'test@daoyan.local']);
      git(temporary, ['config', 'user.name', 'Daoyan Test']);
      git(temporary, ['add', '.']);
      git(temporary, ['commit', '-m', 'test fixture']);
      await symlink(resolve(root, 'node_modules'), resolve(temporary, 'node_modules'), 'junction');

      const task = {
        id: 'completed',
        title: '已完成任务',
        objective: '保留仍有效的完成证据',
        type: 'documentation',
        tier: 'economy',
        reasoning: '文档任务使用轻量验证',
        dependsOn: [],
        paths: ['docs/'],
        deliverables: ['已完成任务'],
        verification: [],
      };
      const plan = {
        version: 1,
        title: '还原输出恢复测试',
        summary: '恢复点之后还原到 HEAD 的计划内文件仍可归属',
        producerDecisionRequired: false,
        producerQuestion: '',
        riskSignals: [],
        acceptanceCriteria: ['恢复成功'],
        nonGoals: [],
        tasks: [task],
        commitMessage: 'test: restored output recovery',
      };
      const taskFingerprint = await pathFingerprint(temporary, ['docs/completed.md']);
      const taskRun = {
        task,
        route: { model: 'test', reasoning: 'low' },
        attempts: 1,
        result: 'passed',
        outputFile: '',
        changedFiles: ['docs/completed.md'],
        tests: [],
        tokensUsed: 0,
        completedAt: '2026-09-21T00:00:00.000Z',
        inputPaths: ['docs/completed.md'],
        inputFingerprint: taskFingerprint,
        outputFingerprint: taskFingerprint,
        commandFingerprint: stringFingerprint([]),
        configFingerprint: await configFingerprint(temporary),
      };
      await writeFile(
        resolve(temporary, 'docs/in-progress.md'),
        '# 恢复点中的计划内输出\n',
        'utf8',
      );
      const runDirectory = resolve(temporary, '.daoyan-agent/runs/restored-output');
      await mkdir(runDirectory, { recursive: true });
      await writeFile(
        resolve(runDirectory, 'recovery.json'),
        `${JSON.stringify(
          {
            version: 1,
            status: 'recoverable',
            processPid: 0,
            processIdentity: '',
            phase: '执行任务',
            direction: plan.summary,
            resolvedDirection: plan.summary,
            baseline: git(temporary, ['rev-parse', 'HEAD']).trim(),
            workspaceFingerprint: await workspaceFingerprint(temporary),
            workspaceChangeBaseline: await workspaceChangeBaseline(temporary),
            plan,
            taskRuns: [taskRun],
            review: null,
            plannerTokens: 0,
            reviewerTokens: null,
            repairerTokens: null,
            noPush: true,
            takeover: true,
            error: '模拟进程异常',
            actualLaunchCount: 1,
            abnormalRecoveryCount: 0,
            localRepairRoundCount: 0,
            updatedAt: '2026-09-21T00:00:00.000Z',
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      await rm(resolve(temporary, 'docs/in-progress.md'));
      expect(git(temporary, ['status', '--porcelain'])).toBe('');

      const result = spawnSync(
        process.execPath,
        [
          tsxCliPath,
          resolve(temporary, 'scripts/agent-dispatcher.ts'),
          '--resume',
          '.daoyan-agent/runs/restored-output',
        ],
        { cwd: temporary, encoding: 'utf8', timeout: dispatcherTimeoutMs },
      );
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('[选择性恢复] 工作区变化均可归属到当前计划');
      expect(result.stdout).toContain('[选择性恢复] 保留 1/1');
      expect(result.stdout).toContain('[恢复] 跳过已完成任务 completed');
    },
    integrationTestTimeoutMs,
  );
});
