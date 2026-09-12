// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

// jsdom 缺失的 API 用最小桩补上，避免 React Flow / canvas 因环境（而非真 bug）报错
class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
HTMLCanvasElement.prototype.getContext = (() =>
  null) as unknown as typeof HTMLCanvasElement.prototype.getContext;

const errors: string[] = [];
beforeEach(() => {
  errors.length = 0;
  const orig = console.error;
  console.error = (...a: unknown[]): void => {
    const s = a.map(String).join(' ');
    if (/Cannot read|is not a function|is not defined|TypeError|ReferenceError/.test(s)) {
      errors.push(s);
    }
    orig(...(a as unknown as Parameters<typeof console.error>));
  };
});
afterEach(() => {
  cleanup();
  if (errors.length > 0) throw new Error('控制台报错:\n' + errors.join('\n---\n'));
});

async function loadApp(): Promise<React.FC> {
  const mod = await import('../src/app/App');
  return mod.App;
}

describe('页面渲染冒烟', () => {
  it('三个页签切换都不抛运行时报错', async () => {
    const App = await loadApp();
    const { getAllByText } = render(<App />);
    expect(getAllByText('推演台').length).toBeGreaterThan(0);

    // 切到演武场
    fireEvent.click(getAllByText('演武场')[0]);
    // 切到蓝图编辑
    fireEvent.click(getAllByText('蓝图编辑')[0]);
    // 切回推演台
    fireEvent.click(getAllByText('推演台')[0]);
  });
});
