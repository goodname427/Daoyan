import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceVersion, createFormalVersion, setNodeEvidence } from '../scripts/version-lifecycle';
import { captureErrors } from './helpers';
import { stopSecretaryDashboard, waitForSecretaryDashboard } from '../test/helpers/secretary-guard';

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
    await page.addInitScript(() => {
      const layoutKey = 'daoyan-secretary-workspace-layout-v1';
      const initializedKey = 'daoyan-secretary-dashboard-e2e-layout-initialized';
      if (sessionStorage.getItem(initializedKey)) return;
      localStorage.removeItem(layoutKey);
      sessionStorage.setItem(initializedKey, '1');
    });
    await waitForSecretaryDashboard(child, `http://127.0.0.1:${port}`);
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.getByRole('heading', { name: '可视化秘书验收版本' })).toBeVisible();
    const runningAgentStartedAt = new Date(Date.now() - 12_000).toISOString();
    let dashboardRefreshes = 0;
    await page.route('**/api/dashboard*', async (route) => {
      const response = await route.fetch();
      const dashboard = (await response.json()) as {
        agents?: Array<{
          id: string;
          running: boolean;
          startedAt: string;
          elapsedSeconds: number;
          updatedAt: string;
        }>;
      };
      const secretary = dashboard.agents?.find((agent) => agent.id === 'notice-guard');
      if (secretary) {
        dashboardRefreshes += 1;
        secretary.running = true;
        secretary.startedAt = runningAgentStartedAt;
        secretary.elapsedSeconds = 10;
        secretary.updatedAt = new Date().toISOString();
      }
      await route.fulfill({ response, json: dashboard });
    });
    await page.reload();
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
    await expect(page.locator('#detail-meta')).toContainText('Agent 调用');
    await expect(page.locator('#detail-meta')).toContainText('暂无调用记录');
    await page.getByRole('button', { name: '版本策划案' }).click();
    await expect(page.locator('#artifact-content')).toContainText('版本策划案');

    await page.locator('#agent-list button').filter({ hasText: '常驻秘书' }).click();
    await expect(page.locator('#agent-workflow-title')).toContainText('维护项目总状态');
    await expect(page.locator('#agent-workflow-meta')).toContainText('无模型常驻');
    await expect(page.locator('#agent-workflow-events')).toContainText('阶段说明');
    const elapsed = page.locator('[data-agent-elapsed="notice-guard"]');
    const initialElapsed = await elapsed.textContent();
    await expect.poll(() => elapsed.textContent()).not.toBe(initialElapsed);
    const elapsedBeforeRefresh = await elapsed.textContent();
    await expect.poll(() => dashboardRefreshes).toBeGreaterThanOrEqual(2);
    await expect
      .poll(async () => Number((await elapsed.textContent())?.match(/\d+/)?.[0] ?? 0))
      .toBeGreaterThanOrEqual(Number(elapsedBeforeRefresh?.match(/\d+/)?.[0] ?? 0));
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

    await page.getByRole('button', { name: '折叠 Agent' }).click();
    await expect(page.locator('[data-workspace-section="agents"]')).toHaveClass(/is-collapsed/);
    await page.reload();
    await expect(page.locator('[data-workspace-section="agents"]')).toHaveClass(/is-collapsed/);
    await page.getByRole('button', { name: '展开 Agent' }).click();
    await expect(page.getByRole('button', { name: '折叠 Agent' })).toBeVisible();
    const agentHeight = await page
      .locator('[data-workspace-section="agents"]')
      .evaluate((node) => node.clientHeight);
    await page.locator('[data-section-resize="agents"]').press('ArrowDown');
    await expect
      .poll(() =>
        page.locator('[data-workspace-section="agents"]').evaluate((node) => node.clientHeight),
      )
      .toBeGreaterThan(agentHeight);
    await page
      .locator('[data-workspace-section="agents"] .pane-heading')
      .dragTo(page.locator('[data-workspace-section="work"] .pane-heading'));
    await expect
      .poll(() =>
        page
          .locator('.flow-pane')
          .evaluate((pane) =>
            [...pane.querySelectorAll(':scope > [data-workspace-section]')].map(
              (section) => section.dataset.workspaceSection,
            ),
          ),
      )
      .toEqual(['stages', 'work', 'agents', 'bugs']);
    await page.reload();
    await expect
      .poll(() =>
        page
          .locator('.flow-pane')
          .evaluate((pane) =>
            [...pane.querySelectorAll(':scope > [data-workspace-section]')].map(
              (section) => section.dataset.workspaceSection,
            ),
          ),
      )
      .toEqual(['stages', 'work', 'agents', 'bugs']);

    const workResizer = page.locator('[data-section-resize="work"]');
    for (let index = 0; index < 10; index += 1) {
      await workResizer.press('ArrowDown');
    }
    for (let index = 0; index < 10; index += 1) {
      await page.locator('[data-section-resize="agents"]').press('ArrowDown');
    }
    const overflowedFlow = await page.locator('.flow-pane').evaluate((pane) => ({
      clientHeight: pane.clientHeight,
      scrollHeight: pane.scrollHeight,
    }));
    expect(overflowedFlow.scrollHeight).toBeGreaterThan(overflowedFlow.clientHeight);
    const bottomBugReachable = await page.locator('.flow-pane').evaluate((pane) => {
      pane.scrollTop = pane.scrollHeight;
      const bug = pane.querySelector('[data-workspace-section="bugs"]');
      if (!bug) return false;
      const paneBounds = pane.getBoundingClientRect();
      const bugBounds = bug.getBoundingClientRect();
      return bugBounds.bottom <= paneBounds.bottom && bugBounds.top >= paneBounds.top;
    });
    expect(bottomBugReachable).toBe(true);

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
    await stopSecretaryDashboard(child);
    await rm(temporary, { recursive: true, force: true });
  }
});

test('shows the inferred product principle before charter approval', async ({ page }) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'daoyan-intent-review-e2e-'));
  const releaseState = resolve(temporary, 'releases');
  const secretaryState = resolve(temporary, 'secretary');
  await mkdir(releaseState, { recursive: true });
  await mkdir(secretaryState, { recursive: true });
  const version = createFormalVersion({
    id: 'intent-review-e2e',
    title: '产品意图对齐验收版本',
    direction: '以减速为例提出统一控制规则',
    documentRoot: 'docs/versions/intent-review-e2e',
    currentStage: 'charter-draft',
  });
  setNodeEvidence(version, 'charter-draft', {
    artifact: 'docs/versions/intent-review-e2e/charter-draft.md',
    summary:
      '策划推断的核心原则：所有属性控制遵循同一合同。相邻情形：施法速度→统一定价；法球上限→统一结算。建议玩家体验：玩家能自由组合控制效果。待确认：开放范围。',
  });
  advanceVersion(version, 'charter-review');
  await writeFile(resolve(releaseState, 'current.json'), JSON.stringify(version), 'utf8');
  const port = await freePort();
  const child = spawn(process.execPath, [tsxCliPath, secretaryPath, 'run'], {
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
    await waitForSecretaryDashboard(child, `http://127.0.0.1:${port}`);
    await page.goto(`http://127.0.0.1:${port}`);
    const todo = page.locator('#producer-todos .todo');
    await expect(todo).toContainText('确认版本产品意图与策划案');
    await expect(todo).toContainText('所有属性控制遵循同一合同');
    await expect(todo).toContainText('施法速度→统一定价');
    await expect(todo).toContainText('玩家能自由组合控制效果');
    await expect(todo).toContainText('待确认：开放范围');
  } finally {
    await stopSecretaryDashboard(child);
    await rm(temporary, { recursive: true, force: true });
  }
});
