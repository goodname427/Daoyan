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
  ChargeSession,
} from '../src/core/index';
import type { Actor } from '../src/core/index';

describe('蓄力会话终态', () => {
  it('只记录第一个终止原因，重复终止不改写', () => {
    const session = new ChargeSession(1, '5', 'projectile', 2, 0.25, null);
    expect(session.finish('interrupted')).toBe(true);
    expect(session.finish('released')).toBe(false);
    expect(session.terminal).toBe('interrupted');
  });

  it('新蓄力注解能往返且不改变旧 kind', () => {
    const book = parseSpellbook(
      'spell 球 @charge=projectile @chargeMana=10 @duration=2 @period=0.25 { }',
    );
    const again = parseSpellbook(serializeBook(book));
    expect(again['球'].meta?.charge).toBe('projectile');
    expect(again['球'].meta?.chargeMana).toBe(10);
    const quote = analyzeBook(book)['球'];
    expect(quote.errors).toEqual([]);
    expect(quote.manaWorst).toBeGreaterThanOrEqual(96.5);
    expect(quote.periodic[0].intervalSeconds).toBe(0.25);
    expect(quote.shenshiPeak).toBeGreaterThanOrEqual(1);
  });

  it('持球体不能暗中执行额外效果', () => {
    const book = parseSpellbook('spell 球 @charge=projectile { 自身位置() }');
    expect(analyzeBook(book)['球'].errors.join(' ')).toContain('蓄力会话配置无效');
  });
});

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
  for (const foe of world.hostilesOf(caster.faction)) {
    world.grantSenseField(caster.id, foe.id, 'position', {
      shenshiUpperBound: foe.attr.shenshiMax,
      resistanceUpperBound: 0,
    });
  }
  return { world, caster };
}

describe('权威离散事件', () => {
  function grantEvents(world: World, reader: Actor, target: Actor) {
    world.grantSenseField(reader.id, target.id, 'events', {
      shenshiUpperBound: target.attr.shenshiMax,
      resistanceUpperBound: 0,
    });
  }

  it('按世界序和订阅序派发；同事件顺序竞争账户且后继排在候选之后', () => {
    const { world, caster } = scene(2, { manaMax: 5 });
    const [first, second] = world.actors;
    grantEvents(world, caster, first);
    grantEvents(world, caster, second);
    const order: string[] = [];
    world.subscribeEvent(
      caster.id,
      'first',
      'damage',
      (event) => {
        order.push(`first:${event.targetId}`);
        expect(world.resourceLedger.payMana(caster.id, 3, 'response')).toBe(3);
        world.damage(second.id, 1);
      },
      { targetId: first.id },
    );
    world.subscribeEvent(
      caster.id,
      'second',
      'damage',
      (event) => {
        order.push(`second:${event.targetId}`);
        expect(world.resourceLedger.payMana(caster.id, 3, 'response')).toBeNull();
      },
      { targetId: first.id },
    );
    world.subscribeEvent(
      caster.id,
      'later',
      'damage',
      (event) => {
        order.push(`later:${event.targetId}`);
      },
      { targetId: second.id },
    );
    world.damage(first.id, 1);
    expect(order).toEqual([]);
    world.dispatchWorldEvents();
    expect(order).toEqual([`first:${first.id}`, `second:${first.id}`, `later:${second.id}`]);
    expect(caster.mana).toBe(2);
  });

  it('提交时快照，注销立即失效，新订阅不追收；耗尽仅在成功跨越时发出', () => {
    const { world, caster } = scene(1, { manaMax: 2 });
    const target = world.actors[0];
    const seen: string[] = [];
    const old = world.subscribeEvent(caster.id, 'old', 'damage', () => seen.push('old'))!;
    grantEvents(world, caster, target);
    world.damage(target.id, 1);
    world.unsubscribeEvent(old);
    world.subscribeEvent(caster.id, 'new', 'damage', () => seen.push('new'));
    world.dispatchWorldEvents();
    expect(seen).toEqual([]);
    world.damage(target.id, 1);
    world.dispatchWorldEvents();
    expect(seen).toEqual(['new']);
    world.subscribeEvent(caster.id, 'empty', 'mana-exhausted', () => seen.push('empty'));
    expect(world.resourceLedger.payMana(caster.id, 3, 'failed')).toBeNull();
    world.dispatchWorldEvents();
    expect(seen).toEqual(['new']);
    expect(world.resourceLedger.payMana(caster.id, 2, 'spent')).toBe(2);
    world.dispatchWorldEvents();
    expect(seen).toEqual(['new', 'empty']);
    world.observeManaThreshold(caster.id);
    world.dispatchWorldEvents();
    expect(seen).toHaveLength(2);
    caster.mana = 2;
    world.observeManaThreshold(caster.id);
    world.resourceLedger.payMana(caster.id, 2, 'again');
    world.dispatchWorldEvents();
    expect(seen).toEqual(['new', 'empty', 'empty']);
  });

  it('死亡先撤销自身订阅，仅向存活观察者发布只读消失摘要', () => {
    const { world, caster } = scene(1);
    const target = world.actors[0];
    const received: Array<{ type: string; summary: object }> = [];
    grantEvents(world, caster, target);
    world.subscribeEvent(target.id, 'self', 'disappear', () =>
      received.push({ type: 'self', summary: {} }),
    );
    world.subscribeEvent(caster.id, 'observer', 'disappear', (event) => {
      received.push({ type: event.type, summary: event.summary });
    });
    world.damage(target.id, 999);
    world.dispatchWorldEvents();
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('disappear');
    expect(received[0].summary).toEqual({ x: target.x, y: target.y });
    expect(Object.isFrozen(received[0].summary)).toBe(true);
    world.damage(target.id, 999);
    world.dispatchWorldEvents();
    expect(received).toHaveLength(1);
  });

  it('碰撞只在接触开始时发布，分离后再次接触才重发', () => {
    const { world, caster } = scene(1);
    const target = world.actors[0];
    const seen: number[] = [];
    world.subscribeEvent(caster.id, 'contact', 'collision', (event) =>
      seen.push(event.worldSequence),
    );
    const contact = { sourceId: caster.id, targetId: target.id, x: 2, y: 3 };
    world.commitActorContacts([contact]);
    world.commitActorContacts([contact]);
    world.dispatchWorldEvents();
    expect(seen).toHaveLength(1);
    world.commitActorContacts([]);
    world.commitActorContacts([contact]);
    world.dispatchWorldEvents();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0]);
  });

  it('弹道移除先结算，仅产生一次只读消失事实', () => {
    const { world, caster } = scene(0);
    const projectile = world.spawnProjectile({
      faction: 'player',
      ownerId: caster.id,
      x: 10,
      y: 20,
      dx: 1,
      dy: 0,
      speed: 0,
      damage: 0,
    })!;
    const received: object[] = [];
    world.grantSenseField(caster.id, projectile.id, 'events', {
      shenshiUpperBound: 0,
      resistanceUpperBound: 0,
    });
    world.subscribeEvent(caster.id, 'gone', 'disappear', (event) => received.push(event.summary));
    expect(world.removeProjectile(projectile.id)).toBe(true);
    expect(world.removeProjectile(projectile.id)).toBe(false);
    world.dispatchWorldEvents();
    expect(received).toEqual([{ x: 10, y: 20 }]);
  });

  it('同根同绑定去重，订阅神识占用并受容量约束', () => {
    const { world, caster } = scene(1, { shenshiMax: 2 });
    const target = world.actors[0];
    let calls = 0;
    grantEvents(world, caster, target);
    const first = world.subscribeEvent(caster.id, 'loop', 'damage', () => {
      calls++;
      world.damage(target.id, 1);
    });
    expect(first).not.toBeNull();
    expect(world.subscribeEvent(caster.id, 'other', 'damage', () => {})).not.toBeNull();
    expect(world.subscribeEvent(caster.id, 'third', 'damage', () => {})).toBeNull();
    world.damage(target.id, 1);
    world.dispatchWorldEvents();
    expect(calls).toBe(1);
    world.unsubscribeEvent(first!);
    expect(world.subscribeEvent(caster.id, 'third', 'damage', () => {})).not.toBeNull();
  });

  it('深度 8 可响应而深度 9 丢弃，周期第 257 次尝试丢弃', () => {
    const { world, caster } = scene(10, { shenshiMax: 64 });
    const targets = world.actors.filter((actor) => actor.id !== caster.id);
    const depths: number[] = [];
    caster.attr.perception = 10;
    for (const target of targets) grantEvents(world, caster, target);
    for (let i = 0; i < targets.length; i++) {
      world.subscribeEvent(
        caster.id,
        `chain-${i}`,
        'damage',
        (event) => {
          depths.push(event.depth);
          if (i + 1 < targets.length) world.damage(targets[i + 1].id, 1);
        },
        { targetId: targets[i].id },
      );
    }
    world.damage(targets[0].id, 1);
    world.dispatchWorldEvents();
    expect(depths).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(world.eventDrops.depth).toBe(1);

    const bounded = new World();
    const owners = Array.from({ length: 8 }, (_, i) =>
      bounded.spawnActor({ faction: 'player', x: i, y: 0, attrs: { shenshiMax: 40 } }),
    );
    const victim = bounded.spawnActor({ faction: 'foe', x: 20, y: 0 });
    let attempts = 0;
    for (const owner of owners) {
      grantEvents(bounded, owner, victim);
      for (let i = 0; i < 32; i++)
        expect(
          bounded.subscribeEvent(owner.id, `${owner.id}-${i}`, 'damage', () => {
            attempts++;
          }),
        ).not.toBeNull();
    }
    bounded.damage(victim.id, 1);
    bounded.damage(victim.id, 1);
    bounded.dispatchWorldEvents();
    expect(attempts).toBe(256);
    expect(bounded.eventDrops.cycle).toBe(256);
  });
});

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

  it('兼容读取旧冷却注解，但规范化后不再保留', () => {
    const book = parseSpellbook('spell 旧术 @cooldown=12 { 自身位置() }');
    const source = serializeBook(book);

    expect(book['旧术'].meta).not.toHaveProperty('cooldown');
    expect(source).not.toContain('@cooldown');
    expect(parseSpellbook(source)['旧术'].name).toBe('旧术');
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
  it('单帧剩余预算继续偿还后续元法术，分帧与整帧完成相同工作', () => {
    const { book, program } = build('spell 内视 { repeat 10 { 自身位置() } }', '内视');
    const budget = analyzeBook(book)['内视'].tickWorst + 1;
    const results = [budget, 0.25].map((slice) => {
      const { world, caster } = scene(0);
      const vm = new VM(program, world, caster);
      vm.start('内视');
      let spent = 0;
      for (let elapsed = 0; elapsed < budget; elapsed += slice) {
        spent += vm.advance(Math.min(slice, budget - elapsed));
        if (slice < 1) expect(vm.spentMana).toBeLessThanOrEqual(Math.ceil(elapsed + slice));
      }
      expect(vm.isDone).toBe(true);
      expect(vm.pendingTickDebt).toBe(0);
      expect(spent).toBe(vm.spentTicks - 1); // start 已记调用起手的 1 tick。
      expect(vm.result()).toMatchObject({ ok: true, mana: 10, ticks: 11 });
      return vm.result();
    });
    expect(results[0]).toEqual(results[1]);
  });

  it('发射会生成带伤害的弹道（可被躲开，因此不是瞬时命中）', () => {
    const { program } = build(
      `
      spell 直击 {
        var self: vec2 = 自身位置()
        var e: list<entity, 4> = 查询实体列表(扫描敌人(self, 300))
        创建弹道(self, 朝向(self, 查询向量(读取位置(e[0]))), 380, 50, 2.4)
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
          return 查询向量(读取位置(sword))
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
        var p: list<vec2, 16> = 查询坐标列表(扫描坐标(self, 500))
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
        var enemies: list<entity, 16> = 查询实体列表(扫描敌人(self, 400))
        var best: entity
        var bestD: num = 99999999
        var p: vec2
        var d: num
        for e in enemies {
          p = 查询向量(读取位置(e))
          d = 距离(self, p)
          if 小于(d, bestD) {
            bestD = d
            best = e
          }
        }
        if 不等(best, 空) {
          创建弹道(self, 朝向(self, 查询向量(读取位置(best))), 380, 30, 2.4)
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
      expect(world.projectiles).toHaveLength(n > 0 ? 1 : 0);
    }
  });

  it('优化写法用神识换法力：敌人多时更省', () => {
    const src = `
      spell 朴 {
        var self: vec2 = 自身位置()
        var enemies: list<entity, 16> = 查询实体列表(扫描敌人(self, 400))
        var bestD: num = 99999999
        var p: vec2
        var d: num
        for e in enemies {
          p = 查询向量(读取位置(e))
          d = 距离(self, p)
          if 小于(d, bestD) { bestD = d }
        }
      }
      spell 慧 {
        var self: vec2 = 自身位置()
        var pts: list<vec2, 16> = 查询坐标列表(扫描坐标(self, 400))
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
      // 让十个获准目标均处于半径内，避免把越距过滤当成优化收益。
      world.hostilesOf(caster.faction).forEach((foe, index) => {
        foe.x = 120 + index * 10;
        foe.y = 0;
      });
      const result = new VM(program, world, caster).run(name);
      expect(result.ok).toBe(true);
      return result.mana;
    };

    expect(run('朴', 1)).toBeLessThan(run('慧', 1));
    expect(run('慧', 10)).toBeLessThan(run('朴', 10));
  });
});
