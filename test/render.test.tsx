// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import * as externalMetas from '../src/game/externalMetas';
import { defMeta, getMeta, T } from '../src/core/index';

async function renderReady(element: ReactElement) {
  const view = render(element);
  await view.findByRole('button', { name: /推演台/ });
  return view;
}

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
  localStorage.clear();
  errors.length = 0;
  const orig = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]): void => {
    const message = args.map(String).join(' ');
    if (/Cannot read|is not a function|is not defined|TypeError|ReferenceError/.test(message)) {
      errors.push(message);
    }
    orig(...(args as Parameters<typeof console.error>));
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  if (errors.length > 0) throw new Error(errors.join('\n---\n'));
});

describe('app rendering smoke test', () => {
  it('waits for extension registration before restoring and autosaving the original book', async () => {
    const saved = JSON.stringify({
      version: 1,
      spellSource: 'spell 扩展存档 { 启动恢复测试扩展() }',
      arenaAttrs: { hpMax: 321 },
      arenaBindings: { '1': '扩展存档' },
    });
    localStorage.setItem('daoyan.player-state', saved);
    expect(getMeta('启动恢复测试扩展')).toBeNull();
    let finish!: (names: string[]) => void;
    vi.spyOn(externalMetas, 'loadExternalMetas').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const read = vi.spyOn(Storage.prototype, 'getItem');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const { App } = await import('../src/app/App');
    const view = render(<App />);
    expect(view.getByRole('status').textContent).toContain('正在加载');
    expect(view.queryByRole('button', { name: /演武场/ })).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    await act(async () => {
      defMeta({
        name: '启动恢复测试扩展',
        group: '自定义',
        params: [],
        ret: T.void,
        mana: 0,
        ticks: 0,
        desc: '启动回归',
        impl: () => null,
      });
      finish(['启动恢复测试扩展']);
    });
    expect((view.container.querySelector('.code-input') as HTMLTextAreaElement).value).toContain(
      '启动恢复测试扩展()',
    );
    fireEvent.click(view.getByRole('button', { name: /演武场/ }));
    expect((view.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('扩展存档');
    const hp = view.getAllByRole('spinbutton')[0] as HTMLInputElement;
    expect(hp.value).toBe('321');
    fireEvent.change(hp, { target: { value: '322' } });
    await waitFor(() => {
      const restored = JSON.parse(localStorage.getItem('daoyan.player-state')!);
      expect(restored.arenaAttrs.hpMax).toBe(322);
      expect(restored.spellSource).toContain('启动恢复测试扩展()');
      expect(restored.arenaBindings['1']).toBe('扩展存档');
    });
  });

  it('preserves the raw save if extension discovery rejects', async () => {
    const saved = JSON.stringify({ spellSource: 'spell 待恢复 { 未加载扩展() }' });
    localStorage.setItem('daoyan.player-state', saved);
    vi.spyOn(externalMetas, 'loadExternalMetas').mockRejectedValue(new Error('host unavailable'));
    const { App } = await import('../src/app/App');
    const view = render(<App />);
    await waitFor(() => expect(view.getByRole('status').textContent).toContain('加载失败'));
    expect(localStorage.getItem('daoyan.player-state')).toBe(saved);
    expect(view.queryByRole('button', { name: /导出存档/ })).toBeNull();
  });

  it('loads an old launch through AST migration and shows the canonical editor source', async () => {
    localStorage.setItem(
      'daoyan.player-state',
      JSON.stringify({ spellSource: 'spell 旧术 { 发射(自身位置(), 准星方向(), 18) }' }),
    );
    const { App } = await import('../src/app/App');
    const { container, getByRole } = await renderReady(<App />);
    expect(getByRole('status').textContent).toContain('已迁移本地旧存档');
    expect((container.querySelector('.code-input') as HTMLTextAreaElement).value).toContain(
      '创建弹道(自身位置(), 准星方向(), 380, 18, 2.4)',
    );
  });

  it('labels dynamic prices as upper bounds and runs the default entity spell', async () => {
    const { App } = await import('../src/app/App');
    const { container, getByRole } = await renderReady(<App />);
    fireEvent.click(getByRole('button', { name: /创建弹道.*实体创建/ }));
    expect(container.querySelector('.meta-inspector')?.textContent).toContain('法力基础');
    expect(container.querySelector('.meta-inspector')?.textContent).toContain('10 + 动态');
    fireEvent.click(getByRole('button', { name: /^御剑·手动/ }));
    fireEvent.click(getByRole('button', { name: /推演一次/ }));
    expect(container.querySelector('.verdict')?.textContent).toContain('施法成功');
  });

  it('explains unified control domains, binding and periodic costs without legacy entries', async () => {
    const { App } = await import('../src/app/App');
    const { container, getByRole, queryByRole, getByTestId } = await renderReady(<App />);
    expect(queryByRole('button', { name: /^发射 ·/ })).toBeNull();
    fireEvent.click(getByRole('button', { name: /调整护体.*实体控制/ }));
    const inspector = container.querySelector('.meta-inspector')?.textContent ?? '';
    expect(inspector).toContain('属性 armor');
    expect(inspector).toContain('效果域');
    expect(inspector).toContain('binding');
    expect(inspector).toContain('时间 0 表示无限');
    expect(inspector).toContain('每 0.25 秒另付法力');
    expect(inspector).toContain('目标是否仍有该属性 binding');
    expect(inspector).toContain('关系是否允许控制');
    expect(inspector).toContain('法力余额不足');
    fireEvent.click(getByRole('button', { name: /^基础剑气/ }));
    fireEvent.click(getByTestId('lab-blueprint-mode'));
    expect(container.querySelector('.react-flow')).toBeTruthy();
  });

  it('switches the two main views and the embedded blueprint mode', async () => {
    const { App } = await import('../src/app/App');
    const { getAllByRole, getByTestId } = await renderReady(<App />);
    const tabs = getAllByRole('button', { name: /^(推演台|演武场)/ });
    expect(tabs).toHaveLength(2);

    fireEvent.click(tabs[1]);
    fireEvent.click(tabs[0]);
    fireEvent.click(getByTestId('lab-blueprint-mode'));
    fireEvent.click(getByTestId('lab-code-mode'));
  });

  it('keeps an imported binding visible when its spell is absent from that save book', async () => {
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
    const { getAllByRole } = await renderReady(<App />);
    const tabs = getAllByRole('button', { name: /^(推演台|演武场)/ });
    fireEvent.click(tabs[1]);

    expect((getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('疾风步');
  });

  it('does not overwrite a rejected future local save during initial mount', async () => {
    const futureSave = JSON.stringify({ version: 99, spellSource: 'spell 未来法术 {}' });
    localStorage.setItem('daoyan.player-state', futureSave);

    const { App } = await import('../src/app/App');
    const { getByRole } = await renderReady(<App />);

    expect(getByRole('status').textContent).toContain('存档来自更新版本');
    expect(localStorage.getItem('daoyan.player-state')).toBe(futureSave);
  });
});
