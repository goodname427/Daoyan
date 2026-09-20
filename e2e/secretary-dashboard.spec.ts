import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFormalVersion, setNodeEvidence } from '../scripts/version-lifecycle';
import { captureErrors } from './helpers';
import { waitForSecretaryDashboard } from '../test/helpers/secretary-guard';

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

test('shows the version flow, opens evidence and talks to the secretary', async ({
  browser,
  page,
}) => {
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
    currentStage: 'producer-acceptance',
  });
  setNodeEvidence(version, 'charter-review', {
    artifact: 'docs/versions/workflow-foundation-2026-09-20/charter.md',
    summary: '制作人已批准版本策划案。',
  });
  version.workItems.push({
    id: 'dashboard-work',
    title: '整理项目中枢工作台',
    owner: 'Feature PM',
    status: 'active',
    dependsOn: [],
    summary: '将中间区域收束为单一阅读工作区。',
    evidence: '',
  });
  version.bugs.push({
    id: 'dashboard-bug',
    title: '折叠后剩余区域未铺满',
    severity: 'high',
    status: 'fixing',
    expected: '剩余面板填满工作台宽度。',
    actual: '折叠后存在空白列。',
    evidence: '',
    linkedWorkItemId: 'dashboard-work',
  });
  await writeFile(resolve(releaseState, 'current.json'), JSON.stringify(version), 'utf8');
  const previous = createFormalVersion({
    id: 'dashboard-e2e-previous',
    title: '上一轮工作流版本',
    direction: '验证版本历史查阅',
    documentRoot: 'docs/versions/workflow-foundation-2026-09-20',
    currentStage: 'archived',
    now: '2026-09-19T00:00:00.000Z',
  });
  await mkdir(resolve(releaseState, 'versions'), { recursive: true });
  await writeFile(
    resolve(releaseState, 'versions', `${previous.id}.json`),
    JSON.stringify(previous),
    'utf8',
  );
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
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  try {
    const errors = captureErrors(page);
    await waitForSecretaryDashboard(child, `http://127.0.0.1:${port}`);
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.getByRole('heading', { name: '可视化秘书验收版本' })).toBeVisible();
    await expect(page.locator('#current-stage')).toContainText('制作人体验');
    const hasPageScroll = await page.evaluate(
      () => document.documentElement.scrollHeight > document.documentElement.clientHeight,
    );
    expect(hasPageScroll).toBe(false);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false);

    await page.locator('[data-stage="charter-review"]').click();
    await expect(page.locator('#detail-title')).toHaveText('立项评审');
    await page.getByRole('button', { name: '版本策划案' }).click();
    await expect(page.locator('#artifact-content')).toContainText('版本策划案');

    await page.locator('#agent-list button').filter({ hasText: '常驻秘书' }).click();
    await expect(page.locator('#agent-workflow-title')).toContainText('维护项目总状态');
    await expect(page.locator('#agent-workflow-meta')).toContainText('无模型常驻');
    await expect(page.locator('#agent-workflow-events')).toContainText('阶段说明');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByRole('button', { name: '整理项目中枢工作台' }).click();
    await expect(page.locator('#detail-kicker')).toHaveText('开发任务');
    await expect(page.locator('#delivery-detail')).toContainText('单一阅读工作区');
    await expect(page.locator('.document-workspace')).toBeHidden();
    await expect(page.locator('#agent-workflow')).toBeHidden();
    await page.getByRole('button', { name: '折叠后剩余区域未铺满' }).click();
    await expect(page.locator('#detail-kicker')).toHaveText('版本缺陷');
    await expect(page.locator('#delivery-detail')).toContainText('剩余面板填满工作台宽度');

    const desktopWidth = await page.locator('.flow-pane').evaluate((node) => node.clientWidth);
    await page.locator('[data-resize="left"]').dragTo(page.locator('.focus-pane'));
    await expect
      .poll(() => page.locator('.flow-pane').evaluate((node) => node.clientWidth))
      .not.toBe(desktopWidth);
    const rightWidth = await page.locator('.control-pane').evaluate((node) => node.clientWidth);
    await page.locator('[data-resize="right"]').press('ArrowRight');
    await expect
      .poll(() => page.locator('.control-pane').evaluate((node) => node.clientWidth))
      .toBeLessThan(rightWidth);
    await page.getByRole('button', { name: '折叠左侧面板' }).click();
    await expect(page.locator('.workbench')).toHaveClass(/collapsed-left/);
    const collapsedLeftBounds = await page.locator('.workbench').evaluate((workbench) => {
      const focus = workbench.querySelector('.focus-pane')?.getBoundingClientRect();
      const control = workbench.querySelector('.control-pane')?.getBoundingClientRect();
      const bounds = workbench.getBoundingClientRect();
      return {
        startsAtLeft: Math.abs((focus?.left ?? bounds.left) - bounds.left) < 1,
        endsAtRight: Math.abs((control?.right ?? bounds.right) - bounds.right) < 1,
      };
    });
    expect(collapsedLeftBounds).toEqual({ startsAtLeft: true, endsAtRight: true });
    await page.getByRole('button', { name: '恢复左侧' }).click();
    await expect(page.locator('.workbench')).not.toHaveClass(/collapsed-left/);
    await page.getByRole('button', { name: '折叠中间面板' }).click();
    await expect(page.locator('.workbench')).toHaveClass(/collapsed-center/);
    await page.getByRole('button', { name: '恢复中间' }).click();
    await page.getByRole('button', { name: '折叠右侧面板' }).click();
    await expect(page.locator('.workbench')).toHaveClass(/collapsed-right/);
    await page.getByRole('button', { name: '恢复右侧' }).click();

    await page.getByLabel('发给秘书').fill('现在正式版本处于什么阶段？');
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.locator('#send-state')).toHaveText('秘书已收到');
    await expect(page.locator('.message.secretary').last()).toContainText('制作人体验', {
      timeout: 5_000,
    });

    await page.locator('#producer-todos .recommended').click();
    await expect(page.locator('#progress-value')).toHaveText('100%');
    await expect(page.locator('#current-stage')).toContainText('版本归档');

    await page.getByLabel('左侧选择正式版本').selectOption('dashboard-e2e-previous');
    await expect(page.getByRole('heading', { name: '上一轮工作流版本' })).toBeVisible();
    await expect(page.locator('#history-badge')).toBeVisible();
    await expect(page.locator('#producer-todos')).toContainText('暂无记录');
    await page.getByLabel('左侧选择正式版本').selectOption('dashboard-e2e');
    await expect(page.getByRole('heading', { name: '可视化秘书验收版本' })).toBeVisible();

    await page.route('**/api/dashboard?version=dashboard-e2e-previous', async (route) => {
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
      await route.continue();
    });
    await page.getByLabel('左侧选择正式版本').selectOption('dashboard-e2e-previous');
    await page.getByLabel('左侧选择正式版本').selectOption('dashboard-e2e');
    await page.waitForTimeout(450);
    await expect(page.getByRole('heading', { name: '可视化秘书验收版本' })).toBeVisible();
    await page.unroute('**/api/dashboard?version=dashboard-e2e-previous');

    await page.setViewportSize({ width: 1024, height: 768 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight > document.documentElement.clientHeight,
      ),
    ).toBe(false);

    await page.setViewportSize({ width: 721, height: 768 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false);

    await page.setViewportSize({ width: 390, height: 844 });
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
    await page.getByRole('button', { name: '详情', exact: true }).click();
    await expect
      .poll(() => page.locator('.workbench').evaluate((node) => node.scrollLeft))
      .toBeGreaterThan(0);
    await page.getByRole('button', { name: '流程', exact: true }).click();
    await expect(page.locator('#sidebar-version-select')).toBeVisible();
    await page.locator('#agent-list button').first().click();
    await expect
      .poll(() => page.locator('.workbench').evaluate((node) => node.scrollLeft))
      .toBeGreaterThan(0);
    await expect(page.locator('#agent-workflow-events')).toContainText('阶段说明');

    const staticDashboard = (await (
      await fetch(`http://127.0.0.1:${port}/api/dashboard`)
    ).json()) as {
      version: { id: string; documents: Array<{ path: string }> };
    };
    const firstDocument = staticDashboard.version.documents[0];
    await page.route('**/api/dashboard*', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );
    await page.route('**/snapshot.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generatedAt: '2026-09-20T02:00:00.000Z',
          defaultVersionId: staticDashboard.version.id,
          dashboards: {
            [staticDashboard.version.id]: {
              ...staticDashboard,
              artifacts: firstDocument ? { [firstDocument.path]: '手机版快照文档内容' } : {},
            },
          },
        }),
      }),
    );
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByText('云端预览快照')).toBeVisible();
    await expect(page.locator('#guard-state')).toContainText('云端快照');
    await page.getByRole('button', { name: '控制台', exact: true }).click();
    await page.getByLabel('发给秘书').fill('手机端留言测试');
    await page.getByRole('button', { name: '保存留言' }).click();
    await expect(page.locator('.message.pending')).toContainText('手机端留言测试');
    await expect(page.locator('.message.pending')).toContainText('待同步');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false);

    const embeddedMobileContext = await browser.newContext({
      viewport: { width: 980, height: 844 },
      screen: { width: 390, height: 844 },
      hasTouch: true,
    });
    try {
      const embeddedMobilePage = await embeddedMobileContext.newPage();
      await embeddedMobilePage.goto(`http://127.0.0.1:${port}`);
      expect(await embeddedMobilePage.evaluate(() => window.innerWidth)).toBe(980);
      expect(await embeddedMobilePage.evaluate(() => window.screen.width)).toBe(390);
      await expect(embeddedMobilePage.locator('.mobile-pane-nav')).toBeVisible();
      await embeddedMobilePage.getByRole('button', { name: '详情', exact: true }).click();
      await expect
        .poll(() => embeddedMobilePage.locator('.workbench').evaluate((node) => node.scrollLeft))
        .toBeGreaterThan(0);
    } finally {
      await embeddedMobileContext.close();
    }
    errors.assert();
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(temporary, { recursive: true, force: true });
  }
});
