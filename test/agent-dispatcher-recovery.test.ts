import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCliPath = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const dispatcherTimeoutMs = 20_000;
const integrationTestTimeoutMs = dispatcherTimeoutMs + 10_000;
let temporary = '';

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
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
});
