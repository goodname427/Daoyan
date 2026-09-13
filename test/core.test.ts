import { describe, expect, it } from 'vitest';

import {
  VM,
  World,
  analyzeBook,
  compileProgram,
  parseSpellbook,
  serializeBook,
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
    world.spawnActor({ faction: 'foe', x: 90 + i * 42, y: i * 6, attrs: { hpMax: 100 } });
  }
  const caster = world.spawnActor({
    name: '推演者',
    faction: 'player',
    x: 0,
    y: 0,
    attrs: { manaMax: opts.manaMax ?? 400, shenshiMax: opts.shenshiMax ?? 64 },
  });
  return { world, caster };
}

describe('AST ↔ DSL 序列化', () => {
  it('序列化后能重新解析成等价法术书（往返一致）', () => {
    const src = `
      spell 往返 @kind=duration @period=1 @duration=3 @keys=蓄力 {
        var self: vec2 = 自身位置()
        var foes: list<entity, 4> = 感知敌人(self, 300)
        for f in foes {
          if 小于(距离(self, 探查(f)), 200) {
            伤害(f, 20)
          }
        }
        return 自身法力率()
      }
    `;
    const book = parseSpellbook(src);
    const ser = serializeBook(book);
    const book2 = parseSpellbook(ser);
    expect(Object.keys(book2)).toEqual(Object.keys(book));
    // 关键结构：法术名、声明数、for/嵌套层级应一致
    expect(book2['往返'].body.length).toBe(book['往返'].body.length);
    expect(book2['往返'].meta?.kind).toBe('duration');
    expect(book2['往返'].meta?.keys).toEqual(['蓄力']);
  });
});

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

  it('统一实体句柄支持创建、控制、激活与探查弹道的完整链路', () => {
    const { book, program } = build(
      `
      spell 炼剑 -> vec2 {
        var sword: entity = 创建弹道(3)
        if 不等(sword, 空) {
          设置弹道方向(sword, 向量(0, 1))
          设置弹道速度(sword, 420)
          设置弹道威力(sword, 36)
          激活弹道(sword)
          return 探查(sword)
        }
        return 向量(0, 0)
      }
      `,
      '炼剑',
    );
    const { world, caster } = scene(1, { manaMax: 9999 });
    const actorIds = new Set(world.actors.map((actor) => actor.id));
    const result = new VM(program, world, caster).run('炼剑');
    const projectile = world.projectiles[0];

    expect(result.ok).toBe(true);
    expect(projectile).toMatchObject({
      kind: 'projectile',
      ownerId: caster.id,
      active: true,
      dx: 0,
      dy: 1,
      speed: 420,
      damage: 36,
    });
    expect(actorIds.has(projectile.id)).toBe(false);
    expect(world.entityById(projectile.id)).toBe(projectile);
    expect(world.hasCapability(projectile, 'transform')).toBe(true);
    expect(world.hasCapability(projectile, 'vitality')).toBe(false);
    expect(result.returnValue).toEqual({
      x: caster.x,
      y: caster.y + caster.radius + projectile.radius,
    });
    expect(result.mana).toBeGreaterThan(analyzeBook(book)['炼剑'].manaWorst);
    expect(analyzeBook(book)['炼剑'].manaBudget.dynamic).toBe(true);
  });

  it('能力或所有权不匹配时控制元法术返回 false 且不修改目标', () => {
    const { program } = build(
      `
      spell 越权 -> bool {
        var self: vec2 = 自身位置()
        var foes: list<entity, 1> = 感知敌人(self, 500)
        return 设置弹道速度(foes[0], 500)
      }
      `,
      '越权',
    );
    const { world, caster } = scene(1, { manaMax: 9999 });
    const target = world.actors[0];
    const originalSpeed = target.attr.speed;
    const result = new VM(program, world, caster).run('越权');

    expect(result.ok).toBe(true);
    expect(result.returnValue).toBe(false);
    expect(target.attr.speed).toBe(originalSpeed);
  });

  it('每位施法者最多保有 16 个弹道，创建失败返回空句柄', () => {
    const { program } = build(
      `
      spell 铸剑海 -> entity {
        var last: entity
        repeat 17 {
          last = 创建弹道(5)
        }
        return last
      }
      `,
      '铸剑海',
    );
    const { world, caster } = scene(0, { manaMax: 9999 });
    const result = new VM(program, world, caster).run('铸剑海');

    expect(result.ok).toBe(true);
    expect(world.projectiles).toHaveLength(16);
    expect(result.returnValue).toBeNull();
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
  it('单步观察保留当前指令、具名变量和逐步资源状态', () => {
    const { program } = build(
      `
      spell 观照 {
        var x: num = 7
        var self: vec2 = 自身位置()
      }
      `,
      '观照',
    );
    const { world, caster } = scene(0);
    const vm = new VM(program, world, caster);
    vm.start('观照');
    expect(vm.snapshot().instruction).toBeNull();

    vm.step(); // DECL x
    vm.step(); // PUSHK 7
    const stored = vm.step(); // STSLOT x
    expect(stored.instruction).toMatchObject({ fn: '观照', op: 'STSLOT' });
    expect(stored.variables.find((variable) => variable.name === 'x')?.value).toBe(7);
    expect(stored.shenshi).toBe(1);

    while (vm.isRunning) vm.step();
    const done = vm.snapshot();
    expect(done.status).toBe('done');
    expect(done.mana).toBeGreaterThan(0);
    expect(done.ticks).toBeGreaterThan(1);
  });

  it('单步观察只显示仍在生命周期内的变量，并正确处理槽位复用', () => {
    const { program } = build(
      `
      spell 观察作用域 {
        var x: num = 7
        free x
        if true {
          var branch: num = 3
        }
        repeat 1 {
          var loopLocal: num = 4
        }
        var y: num = 9
      }
      `,
      '观察作用域',
    );
    const { world, caster } = scene(0);
    const vm = new VM(program, world, caster);
    vm.start('观察作用域');

    const names = () => vm.snapshot().variables.map((variable) => variable.name);
    while (vm.isRunning && vm.snapshot().instruction?.op !== 'FREE') vm.step();
    expect(names()).not.toContain('x');

    while (vm.isRunning && !names().includes('branch')) vm.step();
    expect(names()).toContain('branch');
    while (vm.isRunning && names().includes('branch')) vm.step();
    expect(names()).not.toContain('branch');

    while (vm.isRunning && !names().includes('loopLocal')) vm.step();
    expect(names()).toContain('loopLocal');
    while (vm.isRunning && names().includes('loopLocal')) vm.step();
    expect(names()).not.toContain('loopLocal');

    while (vm.isRunning && !names().includes('y')) vm.step();
    expect(names()).toEqual(['y']);
    expect(vm.snapshot().variables[0]?.value).toBeNull();
    while (vm.isRunning && vm.snapshot().variables[0]?.value !== 9) vm.step();
    expect(vm.snapshot().variables[0]?.value).toBe(9);
  });

  it('单步观察不会在参数声明时清空调用值', () => {
    const { program } = build(
      `
      spell 两倍(x: num) -> num { return 加(x, x) }
      spell 入口 { var result: num = 两倍(6) }
      `,
      '入口',
    );
    const { world, caster } = scene(0);
    const vm = new VM(program, world, caster);
    vm.start('入口');

    while (vm.isRunning && !vm.snapshot().variables.some((variable) => variable.name === 'x')) {
      vm.step();
    }

    expect(vm.snapshot().variables.find((variable) => variable.name === 'x')?.value).toBe(6);
    while (vm.isRunning) vm.step();
    expect(vm.result().ok).toBe(true);
  });

  it('repeat 会执行声明的次数', () => {
    const { program } = build(
      `
      spell 三次 {
        var x: num = 0
        repeat 3 { x = 加(x, 1) }
        return x
      }
      `,
      '三次',
    );
    const { world, caster } = scene(0);
    const r = new VM(program, world, caster).run('三次');

    expect(r.ok).toBe(true);
    expect(r.returnValue).toBe(3);
  });

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

  it('动态预算不会伪装成固定上界，神识上界仍保持可信', () => {
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
      expect(cost.manaBudget.dynamic).toBe(true);
      expect(cost.tickBudget.dynamic).toBe(true);
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
