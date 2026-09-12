import { describe, expect, it } from 'vitest';

import {
  VM,
  World,
  analyzeBook,
  compileProgram,
  parseSpellbook,
  shenshiOf,
  T,
} from '../src/core/index';
import type { Actor } from '../src/core/index';

function build(src: string, entry: string) {
  const book = parseSpellbook(src);
  return { book, program: compileProgram(book, entry) };
}

/** 造一个「施法者 + n 个敌人」的世界 */
function scene(
  n: number,
  opts: { manaMax?: number; shenshiMax?: number } = {},
): { world: World; caster: Actor } {
  const world = new World();
  for (let i = 0; i < n; i++) {
    world.spawnActor({ faction: 'foe', x: 90 + i * 42, y: i * 6, hpMax: 100 });
  }
  const caster = world.spawnActor({
    name: '推演者',
    faction: 'player',
    x: 0,
    y: 0,
    manaMax: opts.manaMax ?? 400,
    shenshiMax: opts.shenshiMax ?? 64,
  });
  return { world, caster };
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
  it('发射会生成带伤害的弹道（可被躲开，因此不是瞬时命中）', () => {
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
    const { world, caster } = scene(1);
    const r = new VM(program, world, caster).run('直击');
    expect(r.ok).toBe(true);
    expect(world.projectiles).toHaveLength(1);
    expect(world.projectiles[0].damage).toBe(50);
    // 尚未飞行，敌人不该掉血
    expect(world.actors[0].hp).toBe(100);
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

    const { world, caster } = scene(0);
    const r = new VM(program, world, caster).run('主');
    expect(r.ok).toBe(true);
    expect(r.ticks).toBe(5);
  });
});

describe('走火入魔：资源超限', () => {
  it('法力不足时失败', () => {
    const { program } = build(
      `
      spell 大快照 {
        var self: vec2 = 自身位置()
        var p: list<vec2, 16> = 快照(self, 500)
      }
      `,
      '大快照',
    );
    const { world, caster } = scene(0, { manaMax: 20 });
    const r = new VM(program, world, caster).run('大快照');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('法力不足');
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
    const { world, caster } = scene(0);
    const r = new VM(program, world, caster).run('巨列表');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('神识不足');
  });
});

describe('分帧执行（施法耗时的基础）', () => {
  it('advance 按 tick 预算推进，且能被打断', () => {
    const { program } = build(
      `
      spell 长咒 {
        var self: vec2 = 自身位置()
        var p: list<vec2, 16> = 快照(self, 500)
        var i: num = 0
        var d: num
        for q in p {
          d = 距离(self, q)
          i = 加(i, 1)
        }
      }
      `,
      '长咒',
    );
    const { world, caster } = scene(5);
    const vm = new VM(program, world, caster);
    vm.start('长咒');
    expect(vm.isRunning).toBe(true);

    // 只给 1 tick，绝不该跑完
    vm.advance(1);
    expect(vm.isRunning).toBe(true);

    // 给足预算
    let guard = 0;
    while (vm.isRunning && guard++ < 1000) vm.advance(100);
    expect(vm.isDone).toBe(true);
    expect(vm.failure).toBeNull();
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
      const { world, caster } = scene(n, { manaMax: 9999, shenshiMax: 9999 });
      const r = new VM(program, world, caster).run('御剑术·朴');
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
    expect(costs['慧'].shenshiPeak).toBeGreaterThan(costs['朴'].shenshiPeak);

    const run = (name: string, n: number): number => {
      const { world, caster } = scene(n, { manaMax: 9999, shenshiMax: 9999 });
      return new VM(program, world, caster).run(name).mana;
    };

    expect(run('朴', 1)).toBeLessThan(run('慧', 1));
    expect(run('慧', 10)).toBeLessThan(run('朴', 10));
  });
});
