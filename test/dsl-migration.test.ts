import { describe, expect, it } from 'vitest';
import { migrateSpellSource, parseSpellbook } from '../src/core/index';

describe('统一创建与旧 DSL 规范化', () => {
  it.each([
    '探查(自身实体())',
    '生命(自身实体())',
    '自身法力率()',
    '快照(自身位置(), 20)',
    '感知敌人(自身位置(), 20)',
  ])('旧读取 %s 留原文和可定位诊断，不伪装成新查询', (call) => {
    const last = parseSpellbook('spell 稳定 {}');
    const source = `spell 旧术 {\n  ${call}\n}`;
    const result = migrateSpellSource(source, last);
    expect(result).toMatchObject({ ok: false, source, book: last });
    if (!result.ok)
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          spell: '旧术',
          line: 2,
          message: expect.stringContaining('旧读取'),
        }),
      ]);
  });

  it.each([
    ['发射(自身位置(), 准星方向(), 18)', '储能'],
    ['设置位置(自身实体(), 自身位置())', '旧两参位置'],
    ['疾行(2, 3)', '旧自身属性'],
    ['迟滞(自身实体(), 0.5, 2)', '旧目标属性'],
    ['调整速度(自身实体(), 2, 3)', '旧控制'],
    ['强化伤害(自身实体(), 2, 3)', '旧控制'],
    ['按键松开(0)', '旧按键'],
    ['自身位置()', '资源价格'],
    ['准星方向()', '资源价格'],
    ['创建弹道(自身位置(), 准星方向(), 380, 18, 2.4)', '旧五参创建'],
  ])('拒绝无法证明资源或时序等价的 %s', (call, reason) => {
    const source = `spell 旧术 {\n  ${call}\n}`;
    const last = parseSpellbook('spell 稳定 {}');
    const result = migrateSpellSource(source, last, true);
    expect(result).toMatchObject({ ok: false, source, book: last });
    if (!result.ok)
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          spell: '旧术',
          line: 2,
          message: expect.stringContaining(reason),
        }),
      ]);
  });

  it('新版五参创建在新版语义下通过，旧存档语义下拒绝', () => {
    const source = 'spell 新术 { 创建弹道(自身位置(), 准星方向(), 380, 18, 2.4) }';
    expect(migrateSpellSource(source)).toMatchObject({ ok: true });
    expect(migrateSpellSource(source, null, true)).toMatchObject({ ok: false, source });
  });

  it('定位旧发射供能缺口及没有读取调用的按键法术', () => {
    const last = parseSpellbook('spell 稳定 {}');
    const launch = migrateSpellSource(
      'spell 旧术 {\n  发射(自身位置(), 准星方向(), 18)\n}',
      last,
      true,
    );
    expect(launch).toMatchObject({ ok: false, book: last });
    if (!launch.ok) {
      expect(launch.diagnostics[0]).toMatchObject({ spell: '旧术', line: 2 });
      expect(launch.diagnostics[0].message).toContain('12.7');
      expect(launch.diagnostics[0].message).toContain('25.000004');
    }
    const keyed = 'spell 蓄力 @kind=duration @period=1 @duration=2 @keys=蓄力 {}';
    const result = migrateSpellSource(keyed, last, true);
    expect(result).toMatchObject({ ok: false, source: keyed, book: last });
    if (!result.ok) expect(result.diagnostics[0]).toMatchObject({ spell: '蓄力', line: 1 });
  });

  it('旧位置、属性与句柄链不等价时整本保留', () => {
    const last = parseSpellbook('spell 稳定 {}');
    const source = `spell 测试 {
      设置位置(自身实体(), 自身位置())
      疾行(2, 3)
      迟滞(自身实体(), 0.5, 2)
    }`;
    const ok = migrateSpellSource(source, last);
    expect(ok).toMatchObject({ ok: false, source, book: last });
    for (const unsafe of [
      'var p: entity = 创建弹道(3) 设置弹道速度(p, 200) 设置弹道威力(p, 5) 激活弹道(p)',
      'var p: entity = 创建弹道(3) var q: entity = p p = 创建弹道(4) 激活弹道(p)',
    ]) {
      const original = `spell 测试 { ${unsafe} }`;
      const result = migrateSpellSource(original, last);
      expect(result).toMatchObject({ ok: false, source: original, book: last });
      if (!result.ok) expect(result.diagnostics[0]).toMatchObject({ spell: '测试', line: 1 });
    }
  });
});
