// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

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
  console.error = (...args: unknown[]): void => {
    const message = args.map(String).join(' ');
    if (/Cannot read|is not a function|is not defined|TypeError|ReferenceError/.test(message)) {
      errors.push(message);
    }
    orig(...(args as Parameters<typeof console.error>));
  };
});
afterEach(() => {
  cleanup();
  if (errors.length > 0) throw new Error(errors.join('\n---\n'));
});

describe('app rendering smoke test', () => {
  it('labels dynamic prices as upper bounds and runs the default entity spell', async () => {
    const { App } = await import('../src/app/App');
    const { container, getByRole } = render(<App />);
    fireEvent.click(getByRole('button', { name: /创建弹道.*实体创建/ }));
    expect(container.querySelector('.meta-inspector')?.textContent).toContain('法力基础');
    expect(container.querySelector('.meta-inspector')?.textContent).toContain('8 + 动态');
    fireEvent.click(getByRole('button', { name: /^御剑·手动/ }));
    fireEvent.click(getByRole('button', { name: /推演一次/ }));
    expect(container.querySelector('.verdict')?.textContent).toContain('施法成功');
  });

  it('switches the two main views and the embedded blueprint mode', async () => {
    const { App } = await import('../src/app/App');
    const { getAllByRole, getByTestId } = render(<App />);
    const tabs = getAllByRole('button', { name: /^(推演台|演武场)/ });
    expect(tabs).toHaveLength(2);

    fireEvent.click(tabs[1]);
    fireEvent.click(tabs[0]);
    fireEvent.click(getByTestId('lab-blueprint-mode'));
    fireEvent.click(getByTestId('lab-code-mode'));
  });

  it('keeps an imported binding visible when its spell is absent from that save book', async () => {
    localStorage.clear();
    localStorage.setItem(
      'daoyan.player-state',
      JSON.stringify({
        version: 1,
        spellSource: 'spell 基础剑气 {}',
        arenaAttrs: { hpMax: 180 },
        arenaBindings: { '1': '疾风步' },
      }),
    );

    const { App } = await import('../src/app/App');
    const { getAllByRole } = render(<App />);
    const tabs = getAllByRole('button', { name: /^(推演台|演武场)/ });
    fireEvent.click(tabs[1]);

    expect((getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('疾风步');
  });

  it('does not overwrite a rejected future local save during initial mount', async () => {
    localStorage.clear();
    const futureSave = JSON.stringify({ version: 99, spellSource: 'spell 未来法术 {}' });
    localStorage.setItem('daoyan.player-state', futureSave);

    const { App } = await import('../src/app/App');
    const { getByRole } = render(<App />);

    expect(getByRole('status').textContent).toContain('存档来自更新版本');
    expect(localStorage.getItem('daoyan.player-state')).toBe(futureSave);
  });
});
