import type { Page } from '@playwright/test';

/**
 * 收集页面未捕获异常与「真错误」级控制台输出。
 *
 * 只把会导致页面崩溃 / 行为异常的报错记为失败，
 * 跳过 React dev 模式的 act 警告、ResizeObserver 警告等噪声 ——
 * 否则 E2E 会被海量 dev 警告淹没，失去信号。
 */
const FAIL_PATTERN =
  /Cannot read propert|is not a function|is not defined|TypeError|ReferenceError|Failed to execute|undefined is not/i;

export interface ErrorSink {
  errors: string[];
  assert: () => void;
}

export function captureErrors(page: Page): ErrorSink {
  const errors: string[] = [];
  page.on('pageerror', (e) => {
    errors.push(`pageerror: ${e.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (FAIL_PATTERN.test(text)) errors.push(`console.error: ${text}`);
  });
  return {
    errors,
    assert() {
      if (errors.length === 0) return;
      throw new Error(`页面产生了 ${errors.length} 处异常:\n${errors.join('\n---\n')}`);
    },
  };
}
