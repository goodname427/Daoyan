import { test, expect } from '@playwright/test';
import { captureErrors } from './helpers';

test.describe('页面冒烟', () => {
  test('三个页签加载与切换不产生未捕获异常', async ({ page }) => {
    const sink = captureErrors(page);
    await page.goto('/');

    // 默认推演台可见
    await expect(page.getByRole('button', { name: /推演台/ }).first()).toBeVisible();

    // 切到演武场
    await page
      .getByRole('button', { name: /演武场/ })
      .first()
      .click();
    await expect(page.locator('canvas.arena')).toBeVisible();

    // 切到蓝图编辑
    await page
      .getByRole('button', { name: /蓝图编辑/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: '节点' })).toBeVisible();

    // 切回推演台
    await page
      .getByRole('button', { name: /推演台/ })
      .first()
      .click();

    sink.assert();
  });
});

test.describe('推演台功能', () => {
  test('选中法术并推演能给出结果', async ({ page }) => {
    const sink = captureErrors(page);
    await page.goto('/');

    // 选中第一个法术
    const firstSpell = page.locator('button.spell').first();
    await firstSpell.click();

    // 点推演
    await page.getByRole('button', { name: '推演一次' }).click();

    // 应当出现「施法成功」或「走火入魔」
    await expect(page.locator('.verdict')).toContainText(/施法成功|走火入魔/);
    sink.assert();
  });
});

test.describe('蓝图编辑功能', () => {
  test('空法术能编译通过', async ({ page }) => {
    const sink = captureErrors(page);
    await page.goto('/');
    await page
      .getByRole('button', { name: /蓝图编辑/ })
      .first()
      .click();

    await page.getByRole('button', { name: '编译法术' }).click();
    await expect(page.locator('.errors, .palette pre')).toContainText(/编译通过/);
    sink.assert();
  });
});

test.describe('演武场功能', () => {
  test('按数字键能起手施法', async ({ page }) => {
    const sink = captureErrors(page);
    await page.goto('/');
    await page
      .getByRole('button', { name: /演武场/ })
      .first()
      .click();

    // 点击画布让窗口聚焦
    await page.locator('canvas.arena').click();
    // 按住移动键几帧
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(200);
    await page.keyboard.up('KeyD');

    // 按数字键 1 触发疾风步（瞬时应立刻结束）
    await page.keyboard.press('Digit1');
    await page.waitForTimeout(300);

    // 不该崩，且仍在战斗中
    await expect(page.locator('canvas.arena')).toBeVisible();
    sink.assert();
  });
});
