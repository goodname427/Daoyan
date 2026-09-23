import { describe, expect, it } from 'vitest';
import {
  analyzeBook,
  compileProgram,
  migrateSpellSource,
  parseSpellbook,
  serializeBook,
  VM,
  World,
} from '../src/core/index';

describe('统一创建与旧 DSL 规范化', () => {
  it('旧发射保持实参求值顺序并归一为唯一 AST 创建调用', () => {
    const result = migrateSpellSource('spell 测试 { 发射(自身位置(), 准星方向(), 18) }');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const call = result.book.测试.body[0];
    expect(call.k).toBe('expr');
    if (call.k !== 'expr' || call.e.k !== 'call') return;
    expect(call.e.name).toBe('创建弹道');
    expect(
      call.e.args.map((arg) => (arg.k === 'call' ? arg.name : arg.k === 'lit' ? arg.v : '?')),
    ).toEqual(['自身位置', '准星方向', 380, 18, 2.4]);
    expect(result.source).not.toContain('发射(');
    expect(migrateSpellSource(result.source)).toMatchObject({ ok: true, source: result.source });
  });

  it('统一创建即激活，旧发射和新入口共享空间、伤害及价格锚点', () => {
    const world = new World();
    const caster = world.spawnActor({ faction: 'player', x: 100, y: 100 });
    caster.mana = 1000;
    const oldBook = parseSpellbook('spell 旧 { 发射(自身位置(), 准星方向(), 18) }');
    const result = migrateSpellSource(serializeBook(oldBook));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const oldCost = analyzeBook(oldBook).旧;
    const newCost = analyzeBook(result.book).旧;
    expect(newCost.manaWorst).toBe(oldCost.manaWorst);
    expect(newCost.tickWorst).toBe(oldCost.tickWorst);
    const run = new VM(compileProgram(result.book), world, caster).run('旧');
    expect(run.ok).toBe(true);
    expect(world.projectiles).toHaveLength(1);
    expect(world.projectiles[0]).toMatchObject({ active: true, speed: 380, life: 2.4 });
    expect(world.projectiles[0].damage).toBe(18 * caster.attr.power);
  });

  it('旧位置和属性调用归一，不能证明等价的句柄链不改写任何法术', () => {
    const last = parseSpellbook('spell 稳定 {}');
    const source = `spell 测试 {
      设置位置(自身实体(), 自身位置())
      疾行(2, 3)
      迟滞(自身实体(), 0.5, 2)
    }`;
    const ok = migrateSpellSource(source, last);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.source).toContain('设置位置(自身实体(), 自身位置(), 0)');
      expect(ok.source).toContain('调整速度(自身实体(), 2, 3)');
      expect(ok.source).toContain('调整速度(自身实体(), 0.5, 2)');
    }
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
