import { describe, expect, it } from 'vitest';

import {
  analyzeBook,
  castSpell,
  compileProgram,
  makeCaster,
  parseSpellbook,
  shenshiOf,
  T,
  World,
} from '../src/core/index';

function build(src: string, entry: string) {
  const book = parseSpellbook(src);
  return { book, program: compileProgram(book, entry) };
}

describe('资源模型：神识定价', () => {
  it('向量是两个数，列表按容量计价', () => {
    expect(shenshiOf(T.num)).toBe(1);
    expect(shenshiOf(T.vec2)).toBe(2);
    expect(shenshiOf(T.list('entity', 16))).toBe(17);
    expect(shenshiOf(T.list('vec2', 16))).toBe(33);
  });
});

describe('虚拟机基础执行', () => {
  it('能命中敌人并造成伤害', () => {
    const { program } = build(
      `
      spell 直击 {
        var self: vec2 = 自身位置()
        var e: list<entity, 4> = 感知敌人(self, 300)
        发射(self, 朝向(self, 探查(e[0])), 50)
      }
      `,
      '直击',
    );
    const world = new World();
    world.spawn(100, 0, 100);
    const caster = makeCaster(0, 0, 300, 64);
    const r = castSpell(program, '直击', world, caster);
    expect(r.ok).toBe(true);
    expect(world.entities[0].hp).toBe(50);
  });

  it('法术之间可以互相调用，消耗叠加', () => {
    const { book, program } = build(
      `
      spell 加一(甲: num) -> num {
        return 加(甲, 1)
      }
      spell 主 {
        var x: num = 加一(41)
        var y: num = 加一(x)
      }
      `,
      '主',
    );
    const cost = analyzeBook(book);
    // 主 = 两次 加一；每次 加一 = 加(1) + 调用开销(1)
    expect(cost['加一'].tickWorst).toBe(2);
    expect(cost['主'].tickWorst).toBe(5);

    const world = new World();
    const caster = makeCaster(0, 0, 300, 64);
    const r = castSpell(program, '主', world, caster);
    expect(r.ok).toBe(true);
    expect(r.ticks).toBe(5);
  });
});

describe('走火入魔：资源超限', () => {
  it('法力不足时失败并清空法力', () => {
    const { program } = build(
      `
      spell 大快照 {
        var self: vec2 = 自身位置()
        var p: list<vec2, 16> = 快照(self, 500)
      }
      `,
      '大快照',
    );
    const world = new World();
    const caster = makeCaster(0, 0, 20, 64);
    const r = castSpell(program, '大快照', world, caster);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('法力不足');
    expect(caster.mana).toBe(0);
  });

  it('神识不足时失败', () => {
    const { program } = build(
      `
      spell 巨列表 {
        var a: list<vec2, 40>
      }
      `,
      '巨列表',
    );
    const world = new World();
    const caster = makeCaster(0, 0, 300, 64);
    const r = castSpell(program, '巨列表', world, caster);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('神识不足');
  });
});

describe('静态分析', () => {
  it('拒绝递归（当前境界不允许）', () => {
    const book = parseSpellbook(`
      spell 轮回 {
        轮回()
      }
    `);
    const cost = analyzeBook(book);
    expect(cost['轮回'].errors.join()).toContain('递归');
  });

  it('静态上界不低于实测值', () => {
    const src = `
      spell 御剑术·朴 {
        var self: vec2 = 自身位置()
        var enemies: list<entity, 16> = 感知敌人(self, 400)
        var best: entity
        var bestD: num = 99999999
        var p: vec2
        var d: num
        for e in enemies {
          p = 探查(e)
          d = 距离(self, p)
          if 小于(d, bestD) {
            bestD = d
            best = e
          }
        }
        if 不等(best, 空) {
          发射(self, 朝向(self, 探查(best)), 30)
        }
      }
    `;
    const { book, program } = build(src, '御剑术·朴');
    const cost = analyzeBook(book)['御剑术·朴'];

    for (const n of [0, 1, 5, 12]) {
      const world = new World();
      for (let i = 0; i < n; i++) world.spawn(90 + i * 42, i * 6, 100);
      const caster = makeCaster(0, 0, 9999, 9999);
      const r = castSpell(program, '御剑术·朴', world, caster);
      expect(r.ok).toBe(true);
      expect(r.mana).toBeLessThanOrEqual(cost.manaWorst);
      expect(r.ticks).toBeLessThanOrEqual(cost.tickWorst);
      expect(r.shenshiPeak).toBeLessThanOrEqual(cost.shenshiPeak);
    }
  });

  it('优化写法用神识换法力：敌人多时更省', () => {
    const src = `
      spell 朴 {
        var self: vec2 = 自身位置()
        var enemies: list<entity, 16> = 感知敌人(self, 400)
        var bestD: num = 99999999
        var p: vec2
        var d: num
        for e in enemies {
          p = 探查(e)
          d = 距离(self, p)
          if 小于(d, bestD) { bestD = d }
        }
      }
      spell 慧 {
        var self: vec2 = 自身位置()
        var pts: list<vec2, 16> = 快照(self, 400)
        var bestD: num = 99999999
        var d: num
        for p in pts {
          d = 距离(self, p)
          if 小于(d, bestD) { bestD = d }
        }
      }
    `;
    const { book, program } = build(src, '朴');
    const costs = analyzeBook(book);
    // 慧剑神识更贵
    expect(costs['慧'].shenshiPeak).toBeGreaterThan(costs['朴'].shenshiPeak);

    const run = (name: string, n: number): number => {
      const world = new World();
      for (let i = 0; i < n; i++) world.spawn(90 + i * 42, i * 6, 100);
      const caster = makeCaster(0, 0, 9999, 9999);
      return castSpell(program, name, world, caster).mana;
    };

    // 敌人少：朴素更省法力
    expect(run('朴', 1)).toBeLessThan(run('慧', 1));
    // 敌人多：慧剑更省法力
    expect(run('慧', 10)).toBeLessThan(run('朴', 10));
  });
});
