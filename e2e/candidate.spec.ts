import { expect, test } from '@playwright/test';
import { captureErrors } from './helpers';

test('candidate-first-batch-same-book', async ({ page }) => {
  const sink = captureErrors(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  for (const label of ['加入J1执行', '加入D1执行', '加入B4修壳'])
    await page.getByRole('button', { name: label }).click();
  await page.getByRole('button', { name: /^J1执行/ }).click();
  const identity = page.getByLabel('首批程序身份');
  const before = (await identity.textContent())?.match(/[a-f0-9]{64}/)?.[0];
  expect(before).toMatch(/^[a-f0-9]{64}$/);
  await page.locator('.tabs .tab').nth(1).click();
  const slot = page.locator('.bindings select').nth(1);
  await slot.selectOption('J1执行');
  await page.getByRole('button', { name: '有源执行' }).click();
  await expect(page.getByLabel('有限世界收据')).toContainText('原读收据 15');
  await expect(page.getByLabel('有限世界收据')).toContainText('本人已付 32 M');
  await page.getByRole('button', { name: '无源反例' }).click();
  await expect(page.getByLabel('有限世界收据')).toContainText('作用未提交');
  await slot.selectOption('D1执行');
  await expect(page.getByLabel('有限世界收据')).toHaveCount(0);
  await page.getByRole('button', { name: '有源执行' }).click();
  await expect(page.getByLabel('有限世界收据')).toContainText('原读收据 14');
  await slot.selectOption('B4修壳');
  await page.getByRole('button', { name: 'B1首撞后修壳' }).click();
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('原读收据 19');
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('当前普通壳 3、废料 1');
  await page.getByRole('button', { name: '修壳后获准空读' }).click();
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('本人已付 46 M');
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('空结果收据已提交');
  await page.getByRole('button', { name: '同刻 lot 竞争' }).click();
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('作用事实 0');
  await page.getByRole('button', { name: 'POST 失证' }).click();
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('POST 失证');
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('壳修作用已提交');
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('全链未证成');
  await page.getByRole('button', { name: '容量未知' }).click();
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('VM 未准入');
  await page.getByRole('button', { name: 'FIFO 实满', exact: true }).click();
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('queueFull');
  await page.getByRole('button', { name: '域外回路修复' }).click();
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('未尝试付款');
  await page.getByRole('button', { name: '修壳后再撞（未获准读容量）' }).click();
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('自然接触 2');
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('首次壳修作用已提交');
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('全链未证成');
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText(
    '报价已撤销、容量 capacityUnknown',
  );
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('新读收据 0；第二 VM 未执行');
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('本人容量新读 0 笔 / 已付 0 M');
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText(
    '再撞后未获准重读的普通壳 未知',
  );
  await page.getByRole('button', { name: '再撞容量足额' }).click();
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText(
    '报价已撤销、容量 sufficient、本人容量新读 2 笔 / 已付 4 M',
  );
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('本人已付 48 M');
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('第二 VM 未执行');
  await page.getByRole('button', { name: '再撞 FIFO 实满' }).click();
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText(
    '报价已撤销、容量 queueFull、本人容量新读 2 笔 / 已付 4 M',
  );
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText(
    '同版本体 FIFO 已被在途意图占满',
  );
  await expect(page.getByLabel('B1与B4有限世界收据')).toContainText('全链未证成');
  await page.locator('.tabs .tab').first().click();
  await page.getByRole('button', { name: /^J1执行/ }).click();
  const editor = page.locator('.code-input');
  await editor.fill((await editor.inputValue()).replace('首批J1原读(1, 14)', '首批J1原读(1, 13)'));
  await expect
    .poll(async () => (await identity.textContent())?.match(/[a-f0-9]{64}/)?.[0])
    .not.toBe(before);
  await page.locator('.tabs .tab').nth(1).click();
  await expect(page.getByLabel('有限世界收据')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.locator('.tabs .tab').first().click();
  await expect(page.getByRole('button', { name: '加入B4修壳' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  sink.assert();
});

test('candidate-first-batch-helper-edit', async ({ page }) => {
  const sink = captureErrors(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: '加入J1执行' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem('daoyan.player-state')?.includes('J1执行') ?? false),
    )
    .toBe(true);
  await page.evaluate(() => {
    const key = 'daoyan.player-state';
    const save = JSON.parse(localStorage.getItem(key)!);
    save.spellSource =
      save.spellSource.replace('spell J1执行 -> bool {', 'spell J1执行 -> bool {\n旁注()') +
      '\nspell 二级 -> num { return 0 }\nspell 旁注 -> num { return 二级() }';
    localStorage.setItem(key, JSON.stringify(save));
  });
  await page.reload();
  await page.getByRole('button', { name: /^J1执行/ }).click();
  const identity = page.getByLabel('首批程序身份');
  const before = (await identity.textContent())?.match(/[a-f0-9]{64}/)?.[0];
  expect(before).toMatch(/^[a-f0-9]{64}$/);
  await page.locator('.tabs .tab').nth(1).click();
  await page.locator('.bindings select').nth(1).selectOption('J1执行');
  await page.getByRole('button', { name: '有源执行' }).click();
  await expect(page.getByLabel('有限世界收据')).toContainText('原读收据 15');
  await page.locator('.tabs .tab').first().click();
  await page.getByRole('button', { name: /^二级/ }).click();
  const editor = page.locator('.code-input');
  await editor.fill((await editor.inputValue()).replace('return 0', 'return 1'));
  await page.getByRole('button', { name: /^J1执行/ }).click();
  await expect
    .poll(async () => (await identity.textContent())?.match(/[a-f0-9]{64}/)?.[0])
    .not.toBe(before);
  await page.locator('.tabs .tab').nth(1).click();
  await expect(page.getByLabel('有限世界收据')).toHaveCount(0);
  await page.getByRole('button', { name: '有源执行' }).click();
  await expect(page.getByLabel('有限世界收据')).toContainText('原读收据 15');
  sink.assert();
});

test('candidate-journey', async ({ page }) => {
  const sink = captureErrors(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: '查看用户法术预设' }).click();
  await page.getByRole('checkbox', { name: '对手减速' }).check();
  await page.getByRole('checkbox', { name: '对手破防' }).check();
  await page.getByRole('button', { name: '导入选中预设' }).click();
  await expect(page.getByRole('status')).toContainText('已导入');
  await page.getByRole('button', { name: '收起用户法术预设' }).click();
  await page.getByRole('button', { name: /^对手减速/ }).click();
  await page.getByRole('button', { name: /推演一次/ }).click();
  await expect(page.locator('.verdict')).toContainText(/施法成功|走火入魔/);
  await page.locator('.tabs .tab').nth(1).click();
  await expect(page.locator('.synced-spells')).toContainText('对手减速');
  await expect(page.locator('.synced-spells')).toContainText('对手破防');
  await page.locator('.bindings select').first().selectOption('对手减速');
  await page.locator('.attr-editor input').nth(1).fill('800');
  await page.locator('.attr-editor input').nth(3).fill('80');
  await page
    .getByRole('button', { name: /开始演武/ })
    .first()
    .click();
  await page.locator('canvas.arena').click();
  await page.keyboard.press('Digit1');
  await expect(page.getByLabel('账户与会话摘要')).toContainText('账目守恒');
  await page.locator('.tabs .tab').first().click();
  await expect(page.getByRole('button', { name: /^对手减速/ })).toBeVisible();
  sink.assert();
});

test('candidate-narrow', async ({ page }) => {
  const sink = captureErrors(page);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/');
  await expect(page.getByLabel('第三期沙盒复现')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.tabs .tab').nth(1).click();
  await expect(page.locator('canvas.arena')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  sink.assert();
});

test('candidate-ledger', async ({ page }) => {
  const sink = captureErrors(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: '查看用户法术预设' }).click();
  await page.getByRole('checkbox', { name: '对手减速' }).check();
  await page.getByRole('button', { name: '导入选中预设' }).click();
  await page.locator('.tabs .tab').nth(1).click();
  await page.locator('.bindings select').first().selectOption('对手减速');
  await page.locator('.attr-editor input').nth(1).fill('400');
  await page.locator('.attr-editor input').nth(3).fill('80');
  await page
    .getByRole('button', { name: /开始演武/ })
    .first()
    .click();
  await page.locator('canvas.arena').click();
  await page.keyboard.press('Digit1');
  await expect
    .poll(async () => {
      const text = (await page.getByLabel('账户与会话摘要').textContent()) ?? '';
      return Number(/累计付款\s+([\d.]+)/.exec(text)?.[1] ?? 0);
    })
    .toBeGreaterThan(0);
  await expect(page.getByLabel('账户与会话摘要')).toContainText('账目守恒');
  sink.assert();
});
