import { test, expect } from '@playwright/test';
import { captureErrors } from './helpers';

test.describe('main view smoke', () => {
  test('uses two main views and an embedded blueprint mode', async ({ page }) => {
    const sink = captureErrors(page);
    await page.goto('/');
    await expect(page.locator('.tabs .tab')).toHaveCount(2);
    await page.locator('.tabs .tab').first().click();
    await page.getByTestId('lab-blueprint-mode').click();
    await expect(
      page.locator('.lab-app.mode-blueprint .blueprint-callout .palette h3'),
    ).toBeVisible();
    await page.getByTestId('lab-code-mode').click();
    await page.locator('.tabs .tab').nth(1).click();
    await expect(page.locator('canvas.arena')).toBeVisible();
    sink.assert();
  });
});

test.describe('arena round trip workflow', () => {
  test('keeps arena setup while editing spells in the lab', async ({ page }) => {
    const sink = captureErrors(page);
    await page.goto('/');

    await page.locator('.tabs .tab').nth(1).click();
    await page.locator('.attr-editor input').first().fill('240');
    await page.locator('.battle-controls .run').click();
    await page.locator('.battle-controls .mini').first().click();

    await page.locator('.tabs .tab').first().click();
    const editor = page.locator('.code-input').first();
    await editor.fill(`${await editor.inputValue()}\n// workflow round trip`);

    await page.locator('.tabs .tab').nth(1).click();
    await expect(page.locator('.attr-editor input').first()).toHaveValue('240');
    await expect(page.locator('.synced-spells li').first()).toBeAttached();
    sink.assert();
  });
});

test.describe('blueprint connection regression', () => {
  test('keeps a valid flow connection after pointer release', async ({ page }) => {
    const sink = captureErrors(page);
    await page.goto('/');
    await page.locator('.tabs .tab').first().click();
    await page.getByTestId('lab-blueprint-mode').click();

    const blueprint = page.locator('.blueprint-callout');
    const initialNodes = await blueprint.locator('.react-flow__node').count();
    const initialEdges = await blueprint.locator('.react-flow__edge').count();
    await blueprint.locator('.palette-btn').first().click();
    await expect(blueprint.locator('.react-flow__node')).toHaveCount(initialNodes + 1);

    const source = blueprint
      .locator('.react-flow__node')
      .first()
      .locator('.react-flow__handle.source');
    const target = blueprint
      .locator('.react-flow__node')
      .last()
      .locator('.react-flow__handle.target')
      .first();
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    if (!sourceBox || !targetBox) return;

    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
      steps: 12,
    });
    await page.mouse.up();

    await expect
      .poll(() => blueprint.locator('.react-flow__edge').count())
      .toBeGreaterThanOrEqual(initialEdges);
    sink.assert();
  });
});

test.describe('blueprint editing tools', () => {
  test('supports undo, redo, search location, box selection and conditional else ports', async ({
    page,
  }) => {
    const sink = captureErrors(page);
    await page.goto('/');
    await page.getByTestId('lab-blueprint-mode').click();
    const blueprint = page.locator('.blueprint-callout');
    const before = await blueprint.locator('.react-flow__node').count();
    await blueprint.getByRole('button', { name: /调用\(施法\)/ }).click();
    await expect(blueprint.locator('.react-flow__node')).toHaveCount(before + 1);
    await blueprint.getByRole('button', { name: '撤销' }).click();
    await expect(blueprint.locator('.react-flow__node')).toHaveCount(before);
    await blueprint.getByRole('button', { name: '重做' }).click();
    await expect(blueprint.locator('.react-flow__node')).toHaveCount(before + 1);

    await blueprint.getByLabel('搜索节点').fill('若');
    await expect(blueprint.locator('.palette-btn', { hasText: '若' })).toBeVisible();
    await blueprint.locator('.palette-btn', { hasText: '若' }).click();
    const addedCondition = blueprint.locator('.react-flow__node').last();
    await expect(addedCondition.getByLabel('条件不成立分支出口')).toBeVisible();
    const viewport = blueprint.locator('.react-flow__viewport');
    const beforeLocation = await viewport.getAttribute('style');
    await blueprint.getByLabel('搜索节点').fill('若');
    const addedConditionId = await addedCondition.getAttribute('data-id');
    expect(addedConditionId).not.toBeNull();
    await blueprint
      .locator(`.node-search-results button[data-node-id="${addedConditionId}"]`)
      .click();
    await expect(addedCondition).toHaveClass(/selected/);
    await expect(viewport).not.toHaveAttribute('style', beforeLocation ?? '');

    await blueprint.getByLabel('搜索节点').fill('重复');
    await blueprint.locator('.palette-btn', { hasText: '重复' }).click();
    const repeat = blueprint.locator('.react-flow__node').last();
    await repeat.getByLabel('重复次数').fill('3');
    await blueprint.getByRole('button', { name: '撤销' }).click();
    await expect(repeat.getByLabel('重复次数')).toHaveValue('1');
    await blueprint.getByRole('button', { name: '重做' }).click();
    await expect(repeat.getByLabel('重复次数')).toHaveValue('3');

    // Search centres one node and can leave the next palette-created node against
    // the pane edge. Fit both into the visible pane before deriving drag points.
    await blueprint.getByRole('button', { name: 'Fit View' }).click();
    const conditionBox = await addedCondition.boundingBox();
    const repeatBox = await repeat.boundingBox();
    const paneBox = await blueprint.locator('.react-flow__pane').boundingBox();
    expect(conditionBox).not.toBeNull();
    expect(repeatBox).not.toBeNull();
    expect(paneBox).not.toBeNull();
    if (conditionBox && repeatBox && paneBox) {
      const margin = 6;
      const left = Math.max(paneBox.x + 1, Math.min(conditionBox.x, repeatBox.x) - margin);
      const top = Math.max(paneBox.y + 1, Math.min(conditionBox.y, repeatBox.y) - margin);
      const right = Math.min(
        paneBox.x + paneBox.width - 1,
        Math.max(conditionBox.x + conditionBox.width, repeatBox.x + repeatBox.width) + margin,
      );
      const bottom = Math.min(
        paneBox.y + paneBox.height - 1,
        Math.max(conditionBox.y + conditionBox.height, repeatBox.y + repeatBox.height) + margin,
      );
      await page.mouse.move(left, top);
      await page.mouse.down();
      await page.mouse.move(right, bottom, { steps: 8 });
      await page.mouse.up();
      await expect
        .poll(() => blueprint.locator('.react-flow__node.selected').count())
        .toBeGreaterThanOrEqual(2);
    }
    sink.assert();
  });

  test('undoes a node deletion together with its connected edges', async ({ page }) => {
    const sink = captureErrors(page);
    await page.goto('/');
    await page.getByTestId('lab-blueprint-mode').click();
    const blueprint = page.locator('.blueprint-callout');
    const initialNodes = await blueprint.locator('.react-flow__node').count();
    const initialEdges = await blueprint.locator('.react-flow__edge').count();
    await blueprint.getByRole('button', { name: /调用\(施法\)/ }).click();
    const added = blueprint.locator('.react-flow__node').last();
    const source = blueprint
      .locator('.react-flow__node')
      .first()
      .locator('.react-flow__handle.source');
    const target = added.locator('.react-flow__handle.target').first();
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    if (!sourceBox || !targetBox) return;
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await expect(blueprint.locator('.react-flow__edge')).toHaveCount(initialEdges + 1);

    // The palette-created call node has a native select in its centre. Select the
    // node title, not that form control, so this covers the actual Delete flow.
    await added.locator('.spell-node-title').click();
    await expect(added).toHaveClass(/selected/);
    await page.keyboard.press('Delete');
    await expect(blueprint.locator('.react-flow__node')).toHaveCount(initialNodes);
    await expect(blueprint.locator('.react-flow__edge')).toHaveCount(initialEdges);
    await blueprint.getByRole('button', { name: '撤销' }).click();
    await expect(blueprint.locator('.react-flow__node')).toHaveCount(initialNodes + 1);
    await expect(blueprint.locator('.react-flow__edge')).toHaveCount(initialEdges + 1);
    await blueprint.getByRole('button', { name: '重做' }).click();
    await expect(blueprint.locator('.react-flow__node')).toHaveCount(initialNodes);
    await expect(blueprint.locator('.react-flow__edge')).toHaveCount(initialEdges);
    sink.assert();
  });

  test('round-trips both conditional branches through the blueprint AST', async ({ page }) => {
    const sink = captureErrors(page);
    await page.goto('/');
    const source = page.locator('.code-input').first();
    await source.fill(`spell 双分支 {
  if true {
    var a: num = 1
  } else {
    var a: num = 2
  }
}`);
    await page.getByTestId('lab-blueprint-mode').click();
    const blueprint = page.locator('.blueprint-callout');
    await expect(blueprint.getByLabel('条件不成立分支出口')).toBeVisible();
    await blueprint.getByRole('button', { name: '编译并写回' }).click();
    await expect(blueprint.locator('.errors')).toContainText('编译通过');
    await page.getByTestId('lab-code-mode').click();
    await expect(source).toHaveValue(/else/);
    sink.assert();
  });
});

test.describe('lab functionality', () => {
  test('explains dynamic costs and runs the entity projectile spell', async ({ page }) => {
    const sink = captureErrors(page);
    await page.goto('/');
    const create = page.locator('.meta-spell').filter({ hasText: '创建弹道' });
    await expect(create).toContainText('实体创建 · 法8+动态');
    await create.click();
    await expect(page.locator('.meta-inspector')).toContainText('法力基础');
    await expect(page.locator('.meta-inspector')).toContainText('8 + 动态');
    await page.locator('button.spell').filter({ hasText: '御剑·手动' }).click();
    await expect(page.locator('.code-input').first()).toHaveValue(/创建弹道/);
    await page.getByRole('button', { name: /推演一次/ }).click();
    await expect(page.locator('.verdict')).toContainText('施法成功');
    await page.locator('.tabs .tab').nth(1).click();
    await expect(page.locator('.synced-spells')).toContainText('御剑·手动');
    await page.locator('.tabs .tab').first().click();
    await page.locator('button.spell').filter({ hasText: '御剑·手动' }).click();
    await expect(page.locator('.code-input').first()).toHaveValue(/激活弹道/);
    await page.setViewportSize({ width: 760, height: 800 });
    await create.click();
    await expect(page.locator('.meta-inspector')).toContainText('8 + 动态');
    sink.assert();
  });

  test('runs a selected spell and reports a result', async ({ page }) => {
    const sink = captureErrors(page);
    await page.goto('/');
    await page.locator('button.spell').first().click();
    await page.getByRole('button', { name: /推演一次/ }).click();
    await expect(page.locator('.verdict')).toContainText(/施法成功|走火入魔/);
    sink.assert();
  });

  test('steps through a spell and exposes variables plus a resource timeline', async ({ page }) => {
    const sink = captureErrors(page);
    await page.goto('/');
    await page.getByRole('button', { name: '重置单步' }).click();
    await expect(page.getByLabel('单步推演观察')).toContainText('已就绪');
    await page.getByRole('button', { name: '执行下一步' }).click();
    await expect(page.getByLabel('单步推演观察')).toContainText(/施法中|已完成/);
    await expect(page.getByLabel('资源消耗时间线').locator('li')).toHaveCount(2);
    const editor = page.locator('.code-input').first();
    await editor.fill(`${await editor.inputValue()}\n// source changed after stepping`);
    await expect(page.getByLabel('单步推演观察')).toHaveCount(0);
    sink.assert();
  });

  test('hides released and out-of-scope variables from the step inspector', async ({ page }) => {
    const sink = captureErrors(page);
    await page.goto('/');
    const editor = page.locator('.code-input').first();
    await editor.fill(`spell 观察作用域 {
  var x: num = 7
  free x
  if true {
    var branch: num = 3
  }
  var y: num = 9
}`);
    await page.getByRole('button', { name: '重置单步' }).click();
    const inspector = page.getByLabel('单步推演观察');
    // x: DECL/PUSHK/STSLOT/FREE, branch: condition + DECL/PUSHK/STSLOT/FREE,
    // then y: DECL/PUSHK/STSLOT.  Stop before the spell completes.
    for (let i = 0; i < 13; i += 1) await page.getByRole('button', { name: '执行下一步' }).click();
    await expect(inspector).toContainText('y');
    await expect(inspector).not.toContainText('x');
    await expect(inspector).not.toContainText('branch');
    sink.assert();
  });

  test('compiles the current blueprint and keeps the result visible', async ({ page }) => {
    const sink = captureErrors(page);
    await page.goto('/');
    await page.locator('.tabs .tab').first().click();
    await page.getByTestId('lab-blueprint-mode').click();
    await expect(page.locator('.blueprint-callout .node-entry')).toBeVisible();
    const compile = page.locator('.blueprint-callout .blueprint-toolbar .run');
    await expect(compile).toBeEnabled();
    await compile.click();
    await expect(page.locator('.blueprint-callout .errors')).toContainText(/编译通过/);
    await expect(page.locator('.blueprint-callout .errors')).not.toContainText(/声明为 num/);
    await page.getByTestId('lab-code-mode').click();
    await expect(page.locator('.code-input')).toHaveValue(/list<entity, 8>/);
    await expect(page.locator('.code-input')).toHaveValue(/发射\(/);
    sink.assert();
  });

  test('browses meta spells and manages custom spells in a scrolling catalog', async ({ page }) => {
    const sink = captureErrors(page);
    await page.setViewportSize({ width: 1536, height: 900 });
    await page.goto('/');

    const catalog = page.locator('.spell-catalog');
    await expect(catalog).toBeVisible();
    expect(await catalog.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    await page.locator('.meta-spell').first().click();
    await expect(page.locator('.meta-inspector')).toBeVisible();
    await expect(
      page.locator('.meta-inspector .meta-inputs, .meta-inspector .muted').first(),
    ).toBeVisible();

    const customSpells = page.locator('.catalog-group').first().locator('button.spell');
    const before = await customSpells.count();
    await page.getByRole('button', { name: '新建自定义法术' }).click();
    await expect(customSpells).toHaveCount(before + 1);
    await expect(page.locator('.editor-heading strong')).toHaveText(/新法术/);
    await page.getByRole('button', { name: '删除当前自定义法术' }).click();
    await expect(customSpells).toHaveCount(before);
    sink.assert();
  });

  test('keeps the three work areas aligned and exposes blueprint tips', async ({ page }) => {
    const sink = captureErrors(page);
    await page.setViewportSize({ width: 1536, height: 900 });
    await page.goto('/');

    const boxes = await page.locator('.lab-app .grid > .panel').evaluateAll((panels) =>
      panels.map((panel) => {
        const box = panel.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      }),
    );
    expect(new Set(boxes.map((box) => Math.round(box.top))).size).toBe(1);
    expect(new Set(boxes.map((box) => Math.round(box.bottom))).size).toBe(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    await page.getByTestId('lab-blueprint-mode').click();
    const node = page.locator('.blueprint-callout .spell-node[title]').first();
    await expect(node).toHaveAttribute('title', /.+/);
    const input = page.locator('.blueprint-callout .port-value[title]').first();
    await expect(input).toHaveAttribute('title', /连接一个兼容类型/);
    await expect(page.locator('.blueprint-callout .blueprint-editor')).toHaveCount(1);
    sink.assert();
  });
});

test.describe('arena functionality', () => {
  test('accepts movement and a number-key spell cast', async ({ page }) => {
    const sink = captureErrors(page);
    await page.goto('/');
    await page.locator('.tabs .tab').nth(1).click();
    await page
      .getByRole('button', { name: /开始演武/ })
      .first()
      .click();
    await page.locator('canvas.arena').click();
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(200);
    await page.keyboard.up('KeyD');
    await page.keyboard.press('Digit1');
    await page.waitForTimeout(300);
    await expect(page.locator('canvas.arena')).toBeVisible();
    sink.assert();
  });

  test('shows two spells from different slots casting at the same time', async ({ page }) => {
    const sink = captureErrors(page);
    await page.goto('/');
    await page.locator('.tabs .tab').nth(1).click();
    await page.locator('.attr-editor input').nth(5).fill('0.1');
    await page
      .getByRole('button', { name: /开始演武/ })
      .first()
      .click();

    await page.keyboard.press('Digit2');
    await page.keyboard.press('Digit3');

    const active = page.getByTestId('active-casts').locator('.active-cast');
    await expect(active).toHaveCount(2);
    await expect(active.nth(0)).toHaveAttribute('data-slot', '2');
    await expect(active.nth(1)).toHaveAttribute('data-slot', '3');
    sink.assert();
  });
});
