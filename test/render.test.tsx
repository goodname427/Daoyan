// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import * as externalMetas from '../src/game/externalMetas';
import { defMeta, getMeta, T } from '../src/core/index';
import { SAVE_INCREMENTAL_KEY, SAVE_STORAGE_KEY } from '../src/app/persistence';

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
  it('shows a paid unavailable sense result in the lab sandbox', async () => {
    const { LabView } = await import('../src/app/LabView');
    const view = render(
      <LabView
        source="spell 试探 -> query<num> { return 读取生命(空) }"
        onSourceChange={() => {}}
      />,
    );
    fireEvent.click(view.getByRole('button', { name: '推演一次' }));
    expect(view.getByTestId('lab-return-value').textContent).toContain('unavailable');
    expect(view.container.querySelector('.result')?.textContent).toContain('法力');
  });

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
    expect((view.getByRole('combobox', { name: '1' }) as HTMLSelectElement).value).toBe('扩展存档');
    const hp = view.getAllByRole('spinbutton')[0] as HTMLInputElement;
    expect(hp.value).toBe('321');
    fireEvent.change(hp, { target: { value: '322' } });
    await waitFor(() => {
      const restored = JSON.parse(localStorage.getItem(SAVE_INCREMENTAL_KEY)!);
      expect(restored.arenaAttrs.hpMax).toBe(322);
      expect(restored.spellSource).toContain('启动恢复测试扩展()');
      expect(restored.arenaBindings['1']).toBe('扩展存档');
    });
    expect(localStorage.getItem(SAVE_STORAGE_KEY)).toBe(saved);
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

  it('keeps an old launch when new energy payment cannot preserve its price', async () => {
    const old = JSON.stringify({ spellSource: 'spell 旧术 { 发射(自身位置(), 准星方向(), 18) }' });
    localStorage.setItem('daoyan.player-state', old);
    const { App } = await import('../src/app/App');
    const { container, getByRole } = await renderReady(<App />);
    expect(getByRole('status').textContent).toContain('无法解析或安全迁移');
    expect((container.querySelector('.code-input') as HTMLTextAreaElement).value).not.toContain(
      '旧术',
    );
    expect(localStorage.getItem('daoyan.player-state')).toBe(old);
  });

  it('keeps an unsafe editor draft and shows its AST migration location', async () => {
    const { LabView } = await import('../src/app/LabView');
    const source = 'spell 旧术 {\n  发射(自身位置(), 准星方向(), 18)\n}';
    const view = render(<LabView source={source} onSourceChange={() => {}} />);
    expect((view.container.querySelector('.code-input') as HTMLTextAreaElement).value).toBe(source);
    expect(view.container.querySelector('.errors')?.textContent).toContain('第 2 行');
    expect(view.container.querySelector('.errors')?.textContent).toContain('储能');
    expect(
      (view.getByRole('button', { name: '复现事件与双法术' }) as HTMLButtonElement).disabled,
    ).toBe(true);
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

  it('shows motion and sense prices, and keeps combat snapshots explicit across page trips', async () => {
    const { App } = await import('../src/app/App');
    const view = await renderReady(<App />);
    fireEvent.click(view.getByRole('button', { name: /施加冲量.*实体控制/ }));
    expect(view.container.querySelector('.meta-inspector')?.textContent).toContain('一次冲量');
    expect(view.container.querySelector('.meta-inspector')?.textContent).toContain('2 + 动态');
    fireEvent.click(view.getByRole('button', { name: /^读取生命探查 · 状态探查/ }));
    expect(view.container.querySelector('.meta-inspector')?.textContent).toContain('权限');
    expect(view.container.querySelector('.meta-inspector')?.textContent).toContain('1 + 动态');

    fireEvent.click(view.getByRole('button', { name: /演武场/ }));
    expect(view.getByLabelText('授权属性面板').textContent).toContain('无目标');
    expect(view.getByLabelText('授权属性面板').textContent).not.toContain('speedMax');
    fireEvent.click(view.getAllByRole('button', { name: '开始演武' })[0]);
    fireEvent.click(view.getByRole('button', { name: '读取自身快照' }));
    const panel = view.getByLabelText('授权属性面板');
    expect(panel.textContent).toContain('模拟时刻');
    expect(panel.textContent).toContain('speedMax');
    const target = view.getByRole('combobox', { name: '探查目标' }) as HTMLSelectElement;
    expect(target.options.length).toBeGreaterThan(1);
    fireEvent.change(target, { target: { value: target.options[1].value } });
    fireEvent.click(view.getByRole('button', { name: '读取目标快照' }));
    expect(panel.textContent).toContain('不可探查');
    expect(panel.textContent).toContain('尚无获准快照');

    fireEvent.click(view.getByRole('button', { name: /推演台/ }));
    fireEvent.click(view.getByRole('button', { name: /演武场/ }));
    expect(view.getByLabelText('授权属性面板').textContent).toContain('尚无获准快照');
    expect(view.getByLabelText('授权属性面板').textContent).toContain('无目标');
  });

  it('finds legacy aliases and imports one previewed preset into the shared combat book', async () => {
    const { App } = await import('../src/app/App');
    const view = await renderReady(<App />);
    for (const name of ['法球·冲量滑行', '法球·持续推进', '法球·目标追踪']) {
      expect(view.getByRole('button', { name: new RegExp(name) })).toBeTruthy();
    }
    expect(view.getByLabelText('第二期预算速览').textContent).toContain('余额耗尽');
    expect(view.getByLabelText('第二期预算速览').textContent).toContain('六项属性');
    fireEvent.change(view.getByRole('textbox', { name: '搜索元法术' }), {
      target: { value: '迟滞' },
    });
    expect(view.getByText(/旧名“迟滞”请改用“调整速度”/)).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: /调整速度.*实体控制/ }));
    expect(view.container.querySelector('.meta-inspector')?.textContent).toContain('speedMax');
    expect(view.container.querySelector('.meta-inspector')?.textContent).toContain('拒绝原因');
    fireEvent.click(view.getByRole('button', { name: '查看用户法术预设' }));
    fireEvent.click(view.getAllByText('预览源码与推演配置')[0]);
    expect(view.getAllByText('预设法术').length).toBeGreaterThan(0);
    fireEvent.click(view.getByRole('checkbox', { name: '对手减速' }));
    fireEvent.click(view.getByRole('button', { name: '导入选中预设' }));
    expect(view.getByRole('status').textContent).toContain('已导入：对手减速');
    expect((view.container.querySelector('.code-input') as HTMLTextAreaElement).value).toContain(
      '对手减速',
    );
    fireEvent.click(view.getByRole('button', { name: /演武场/ }));
    expect(view.getAllByText('对手减速').length).toBeGreaterThan(0);
    const binding = view.getByRole('combobox', { name: '1' }) as HTMLSelectElement;
    fireEvent.change(binding, { target: { value: '对手减速' } });
    expect(binding.value).toBe('对手减速');
    fireEvent.click(view.getByRole('button', { name: /推演台/ }));
    expect(view.getByRole('button', { name: /^对手减速/ })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: /演武场/ }));
    expect((view.getByRole('combobox', { name: '1' }) as HTMLSelectElement).value).toBe('对手减速');
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
    const { getAllByRole, getByRole } = await renderReady(<App />);
    const tabs = getAllByRole('button', { name: /^(推演台|演武场)/ });
    fireEvent.click(tabs[1]);

    const binding = getByRole('combobox', { name: '1' }) as HTMLSelectElement;
    expect(binding.value).toBe('疾风步');
    expect(binding.selectedOptions[0].textContent).toContain('当前法术书中不存在');
  });

  it('rehearses four committed events, two responses, paid monitoring and charge endings in the lab', async () => {
    const { LabView } = await import('../src/app/LabView');
    const view = render(<LabView source="spell 空术 {}" onSourceChange={() => {}} />);
    const event = view.getByRole('combobox', { name: '沙盒事件' });
    for (const type of ['damage', 'collision', 'mana-exhausted', 'disappear']) {
      fireEvent.change(event, { target: { value: type } });
      fireEvent.click(view.getByRole('button', { name: '复现事件与双法术' }));
      expect(view.getByTestId('event-rehearsal').textContent).toContain('获准订阅 2 个');
      expect(view.getByTestId('event-rehearsal').textContent).not.toContain('沙盒失败');
      if (type === 'damage') {
        const text = view.getByTestId('event-rehearsal').textContent ?? '';
        expect(text).toContain('沙盒回响甲：成功');
        expect(text).toContain('沙盒回响乙：失败');
        expect(text.indexOf('沙盒回响甲')).toBeLessThan(text.indexOf('沙盒回响乙'));
      }
    }
    fireEvent.click(view.getByRole('button', { name: '复现付费监控与关闭' }));
    expect(view.getByTestId('monitor-rehearsal').textContent).toContain('关闭后新增费用 0');
    expect(view.getByTestId('monitor-rehearsal').textContent).toContain('扫描已付');

    const charge = view.getByRole('combobox', { name: '沙盒蓄力法术' });
    for (const [spell, endings] of [
      [
        '沙盒蓄时',
        [
          '合法松开',
          '提前松开',
          '受击打断',
          '主动取消',
          '施法者死亡',
          '法力耗尽',
          '持有到期',
          '暂停并恢复',
        ],
      ],
      [
        '沙盒持球',
        [
          '合法松开',
          '提前松开',
          '受击打断',
          '主动取消',
          '施法者死亡',
          '法力耗尽',
          '目标失效',
          '持有到期',
          '暂停并恢复',
        ],
      ],
    ] as const) {
      fireEvent.change(charge, { target: { value: spell } });
      for (const ending of endings) {
        fireEvent.click(view.getByRole('button', { name: ending }));
        const result = view.getByTestId('charge-rehearsal').textContent ?? '';
        expect(result).toContain(ending === '暂停并恢复' ? '暂停时' : spell);
        expect(result).not.toContain('沙盒失败');
      }
    }
  });

  it('keeps the rehearsal useful when the shared spellbook is empty', async () => {
    const { LabView } = await import('../src/app/LabView');
    const view = render(<LabView source="" onSourceChange={() => {}} />);
    expect((view.getByRole('button', { name: '推演一次' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(view.getByRole('button', { name: '复现事件与双法术' }));
    expect(view.getByTestId('event-rehearsal').textContent).toContain('获准订阅 2 个');
  });

  it('exposes real arena subscriptions, account costs and manual charge controls', async () => {
    const { App } = await import('../src/app/App');
    const view = await renderReady(<App />);
    fireEvent.click(view.getByRole('button', { name: /演武场/ }));
    expect(view.getByLabelText('账户与会话摘要').textContent).toContain('本人法力');
    fireEvent.change(view.getByRole('combobox', { name: '响应法术 1' }), {
      target: { value: '基础剑气' },
    });
    fireEvent.change(view.getByRole('combobox', { name: '响应法术 2' }), {
      target: { value: '基础剑气' },
    });
    fireEvent.click(view.getByRole('button', { name: '登记事件响应' }));
    expect(view.getByLabelText('事件与主动监控').textContent).toContain('2 个独立响应');
    expect((view.getByRole('button', { name: '开启目标监控' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(view.getAllByRole('button', { name: '开始演武' })[0]);
    const target = view.getByRole('combobox', { name: '探查目标' }) as HTMLSelectElement;
    fireEvent.change(target, { target: { value: target.options[1].value } });
    fireEvent.change(view.getByRole('combobox', { name: '主动监控字段' }), {
      target: { value: 'hp' },
    });
    fireEvent.click(view.getByRole('button', { name: '开启目标监控' }));
    expect(view.getByLabelText('事件与主动监控').textContent).toContain('监控被拒绝');
    expect(view.getByLabelText('账户与会话摘要').textContent).toContain('累计付款 1.0');
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
