import { expect, test } from '@playwright/test';
import { captureErrors } from './helpers';

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
