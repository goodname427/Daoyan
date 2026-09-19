import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFormalVersion, setNodeEvidence } from '../scripts/version-lifecycle';
import { captureErrors } from './helpers';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCliPath = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const secretaryPath = resolve(root, 'scripts/project-secretary.ts');

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.on('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        rejectPort(new Error('无法分配测试端口'));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

test('shows the version flow, opens evidence and talks to the secretary', async ({ page }) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-dashboard-e2e-'));
  const releaseState = resolve(temporary, 'releases');
  const secretaryState = resolve(temporary, 'secretary');
  await mkdir(releaseState, { recursive: true });
  await mkdir(secretaryState, { recursive: true });
  const version = createFormalVersion({
    id: 'dashboard-e2e',
    title: '可视化秘书验收版本',
    direction: '验证完整项目中枢体验',
    documentRoot: 'docs/versions/workflow-foundation-2026-09-20',
    currentStage: 'development',
  });
  setNodeEvidence(version, 'charter-review', {
    artifact: 'docs/versions/workflow-foundation-2026-09-20/charter.md',
    summary: '制作人已批准版本策划案。',
  });
  await writeFile(resolve(releaseState, 'current.json'), JSON.stringify(version), 'utf8');
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [tsxCliPath, secretaryPath, 'run'], {
    cwd: root,
    env: {
      ...process.env,
      DAOYAN_SECRETARY_STATE_DIR: secretaryState,
      DAOYAN_RELEASE_STATE_DIR: releaseState,
      DAOYAN_SECRETARY_HTTP_PORT: String(port),
      DAOYAN_SECRETARY_LOCAL_ONLY: '1',
      DAOYAN_SECRETARY_NO_DISPATCH: '1',
    },
    stdio: 'ignore',
    windowsHide: true,
  });

  try {
    const errors = captureErrors(page);
    await expect
      .poll(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/api/dashboard`)).ok;
        } catch {
          return false;
        }
      })
      .toBe(true);
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.getByRole('heading', { name: '可视化秘书验收版本' })).toBeVisible();
    await expect(page.locator('#current-stage')).toContainText('开发执行');

    await page.locator('[data-stage="charter-review"]').click();
    await expect(page.locator('#detail-title')).toHaveText('立项评审');
    await page.getByRole('button', { name: '查看节点文档' }).click();
    await expect(page.locator('#artifact-content')).toContainText('版本策划案');

    await page.getByLabel('发给秘书').fill('现在正式版本处于什么阶段？');
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.locator('#send-state')).toHaveText('秘书已收到');
    await expect(page.locator('.message.secretary').last()).toContainText('开发执行', {
      timeout: 5_000,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
    errors.assert();
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(temporary, { recursive: true, force: true });
  }
});
