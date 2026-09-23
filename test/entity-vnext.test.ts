import { describe, expect, it, vi } from 'vitest';
import {
  World,
  VM,
  analyzeBook,
  compileProgram,
  parseSpellbook,
  getMeta,
  publicMetas,
  defMeta,
  fixedCost,
  knownCostArg,
  type Ctx,
  type Value,
  CONTROL_PROPERTY_KEYS,
  getControlPropertyDescriptor,
  controlPrice,
  controlRecordPrice,
} from '../src/core/index';
import { T } from '../src/core/types';
import { Battle } from '../src/game/battle';

function setup() {
  const world = new World();
  const caster = world.spawnActor({ faction: 'player', x: 100, y: 100, attrs: { manaMax: 9999 } });
  const ctx: Ctx = { world, caster, keys: null, log: [], endRequested: false };
  const call = (name: string, ...args: Value[]) => getMeta(name)!.impl(ctx, args);
  return { world, caster, ctx, call };
}

describe('公开统一创建与具名属性入口', () => {
  it.each([1, 2])('旧两参位置经 VM 只按旧价格扣费一次（倍率 %s）', (multiplier) => {
    const { world, caster } = setup();
    caster.base.manaCostMul = multiplier;
    world.recompute(caster);
    const book = parseSpellbook(`spell 旧位置 -> bool {
      return 设置位置(自身实体(), 向量(100, 100))
    }`);
    caster.mana = 5 * multiplier;
    const result = new VM(compileProgram(book), world, caster).run('旧位置');
    expect(result.ok).toBe(true);
    expect(result.returnValue).toBe(true);
    expect(result.mana).toBe(5 * multiplier);
    expect(world.positionOf(caster.id)).toEqual({ x: 100, y: 100 });
    expect(world.controlRecordSnapshot()).toEqual([]);
  });

  it('旧位置移动只扣旧距离价，余额不足不移动或部分扣款', () => {
    const { world, caster } = setup();
    const book = parseSpellbook(`spell 旧位置 -> bool {
      return 设置位置(自身实体(), 向量(200, 100))
    }`);
    const program = compileProgram(book);
    caster.mana = 9;
    const failed = new VM(program, world, caster).run('旧位置');
    expect(failed.ok).toBe(false);
    expect(failed.mana).toBe(0);
    expect(world.positionOf(caster.id)).toEqual({ x: 100, y: 100 });
    caster.mana = 10;
    const result = new VM(program, world, caster).run('旧位置');
    expect(result.ok).toBe(true);
    expect(result.returnValue).toBe(true);
    expect(result.mana).toBe(10);
    expect(world.positionOf(caster.id)).toEqual({ x: 200, y: 100 });
  });

  it('同一 AST 控制调用经 VM 作用于不同实体，缺少 binding 时明确拒绝', () => {
    const { world, caster } = setup();
    const foe = world.spawnActor({ faction: 'foe', x: 180, y: 100 });
    const source = `spell 跨实体 -> bool {
      var p: entity = 创建弹道(自身位置(), 向量(1, 0), 100, 2, 3)
      var foes: list<entity, 1> = 感知敌人(自身位置(), 300)
      设置位置(foes[0], 向量(240, 180), 0)
      设置位置(p, 向量(240, 180), 0)
      return 调整感知(p, 2, 0)
    }`;
    const book = parseSpellbook(source);
    expect(analyzeBook(book).跨实体.errors).toEqual([]);
    const result = new VM(compileProgram(book), world, caster).run('跨实体');
    expect(result.ok).toBe(true);
    expect(result.returnValue).toBe(false);
    const created = world.projectiles[0];
    expect(created.active).toBe(true);
    for (const id of [foe.id, created.id]) {
      expect(world.positionOf(id)).toEqual({ x: 240, y: 180 });
    }
    expect(world.events.join(' ')).toMatch(/控制失败.*(?:binding|能力)/);
  });

  it('只展示立即激活的五参创建和七个三参属性节点', () => {
    const visible = publicMetas();
    const create = getMeta('创建弹道')!;
    expect(visible).toContain(create);
    expect(create.params.map((param) => param.name)).toEqual([
      '起点',
      '方向',
      '速度',
      '基础伤害',
      '存活时间',
    ]);
    for (const name of [
      '发射',
      '设置弹道方向',
      '设置弹道速度',
      '设置弹道威力',
      '激活弹道',
      '疾行',
      '迟滞',
      '增威',
      '虚弱',
      '洞察',
      '蔽识',
      '护体',
      '破防',
    ])
      expect(visible.some((meta) => meta.name === name)).toBe(false);
    for (const name of [
      '设置位置',
      '设置朝向',
      '调整速度',
      '强化伤害',
      '设置存活时间',
      '调整感知',
      '调整护体',
    ]) {
      expect(visible.find((meta) => meta.name === name)?.params.map((param) => param.name)).toEqual(
        ['目标', '效果', '时间'],
      );
    }
  });

  it('创建成功立即激活并返回句柄，非法输入和名额不足不写入实体或特效', () => {
    const { world, caster, call } = setup();
    const create = (...args: Value[]) => call('创建弹道', ...args);
    const origin = { x: 100, y: 100 };
    const direction = { x: 1e-100, y: 0 };
    const before = { projectiles: world.projectiles.length, fx: world.fx.length };
    for (const args of [
      [null, direction, 380, 2, 2.4],
      [origin, { x: 0, y: 0 }, 380, 2, 2.4],
      [origin, { x: Infinity, y: 0 }, 380, 2, 2.4],
      [origin, direction, 0, 2, 2.4],
      [origin, direction, 380, Infinity, 2.4],
      [origin, direction, 380, 2, -1],
      [origin, direction, 380, 2, 2.4, 9],
    ])
      expect(create(...(args as Value[]))).toBeNull();
    expect({ projectiles: world.projectiles.length, fx: world.fx.length }).toEqual(before);
    const id = create(origin, direction, 380, 2, 2.4) as number;
    const projectile = world.projectiles.find((item) => item.id === id)!;
    expect(projectile).toMatchObject({ active: true, ownerId: caster.id, speed: 380 });
    expect(world.positionOf(id)!.x).toBeGreaterThan(origin.x);
    expect(world.fx).toHaveLength(1);
    for (let index = 1; index < 16; index++) create(origin, direction, 380, 2, 2.4);
    expect(create(origin, direction, 380, 2, 2.4)).toBeNull();
    expect(world.projectiles).toHaveLength(16);
    expect(world.fx).toHaveLength(16);
  });

  it('七个具名节点通过目标 binding 生效，失败返回 false 且不留下局部写入', () => {
    const { world, caster, ctx, call } = setup();
    const id = call('创建弹道', { x: 100, y: 100 }, { x: 1, y: 0 }, 100, 2, 3) as number;
    const projectile = world.projectiles.find((item) => item.id === id)!;
    const session = world.createControlSession(caster.id, () => true)!;
    ctx.controlSession = session;
    expect(call('设置位置', caster.id, { x: 130, y: 140 }, 0)).toBe(true);
    expect(call('设置朝向', caster.id, { x: 0, y: 2 }, 0)).toBe(true);
    expect(call('设置朝向', id, { x: 0, y: 2 }, 0)).toBe(true);
    expect(call('调整速度', caster.id, 2, 0)).toBe(true);
    expect(call('调整速度', id, 2, 0)).toBe(true);
    expect(call('强化伤害', caster.id, 2, 0)).toBe(true);
    expect(call('强化伤害', id, 2, 0)).toBe(true);
    expect(call('设置存活时间', id, 4, 0)).toBe(true);
    expect(call('调整感知', caster.id, 2, 0)).toBe(true);
    expect(call('调整护体', caster.id, 3, 0)).toBe(true);
    expect(caster.attr.speed).toBe(caster.base.speed * 2);
    expect(projectile.speed).toBe(200);
    expect(caster.attr.power).toBe(caster.base.power * 2);
    expect(projectile.damage).toBe(4);
    expect(projectile.life).toBe(4);
    expect(caster.attr.perception).toBe(caster.base.perception * 2);
    expect(caster.attr.armor).toBe(caster.base.armor + 3);

    const before = {
      caster: structuredClone(caster),
      projectile: structuredClone(projectile),
      records: world.controlRecordSnapshot(),
      fx: world.fx.length,
    };
    for (const [name, args] of [
      ['设置位置', [id, { x: 200, y: 200 }, 1]],
      ['设置朝向', [id, { x: 0, y: 0 }, 0]],
      ['调整速度', [id, 0, 0]],
      ['强化伤害', [999999, 2, 0]],
      ['设置存活时间', [caster.id, 4, 0]],
      ['调整感知', [id, 2, 0]],
      ['调整护体', [id, 2, 0]],
      ['调整速度', [id, 2]],
      ['调整速度', [id, 2, 'invalid']],
    ] as Array<[string, Value[]]>)
      expect(call(name, ...args)).toBe(false);
    expect(caster).toEqual(before.caster);
    expect(projectile).toEqual(before.projectile);
    expect(world.controlRecordSnapshot()).toEqual(before.records);
    expect(world.fx).toHaveLength(before.fx);
  });
});

describe('控制定价与周期预算', () => {
  const price = (
    relation: number,
    resistance: number,
    duration: number,
    mode: 'write' | 'maintain' = 'write',
  ) =>
    controlPrice({
      relation,
      resistance,
      strength: 1,
      duration,
      mode,
      writePolicy: mode === 'write' ? 'overlay' : null,
    });

  it('双资源保留己方正价、敌方固定门槛与抗性单调加价', () => {
    const self = price(1, 0, 1);
    const ally = price(2, 0, 1);
    const enemy = price(8, 0, 1);
    const resistant = price(8, 1, 1);
    expect(self.mana.value).toBeGreaterThan(0);
    expect(self.ticks.value).toBeGreaterThan(0);
    expect(ally.mana.value).toBeGreaterThan(self.mana.value);
    expect(enemy.mana.value).toBeGreaterThan(8 * self.mana.value);
    expect(enemy.ticks.value).toBeGreaterThan(Math.ceil(8 * 1.35));
    expect(resistant.mana.value).toBeGreaterThan(enemy.mana.value);
    expect(resistant.ticks.value).toBeGreaterThan(enemy.ticks.value);
    expect(() => price(1, -1, 1)).toThrow();
  });

  it('有限维持列出最多周期，无限及未知维持显式标记', () => {
    expect(price(1, 0, 0.1, 'maintain').periodic?.count).toEqual({ kind: 'finite', max: 1 });
    expect(price(1, 0, 0.5, 'maintain').periodic?.count).toEqual({ kind: 'finite', max: 2 });
    expect(price(1, 0, 0, 'maintain').periodic?.count).toEqual({ kind: 'unbounded' });
    expect(price(1, 0, 0.5, 'maintain').periodic?.mana.dynamic).toBe(true);
    expect(
      controlPrice({
        relation: null,
        resistance: null,
        strength: null,
        duration: null,
        mode: null,
        writePolicy: null,
      }).periodic?.count,
    ).toEqual({ kind: 'dynamic' });
  });

  it('分析器跨重复与函数调用传播周期明细和无界标记', () => {
    defMeta({
      name: '周期预算测试',
      group: '测试',
      params: [],
      ret: T.bool,
      mana: 2,
      ticks: 1,
      cost: () => ({
        mana: fixedCost(2),
        ticks: fixedCost(1),
        periodic: {
          intervalSeconds: 0.25,
          mana: fixedCost(3),
          ticks: fixedCost(2),
          count: { kind: 'finite', max: 2 },
        },
      }),
      desc: '测试',
      impl: () => true,
    });
    const finite = analyzeBook(
      parseSpellbook(`spell 子 { 周期预算测试() }
      spell 主 { repeat 2 { 子() } }`),
    )['主'];
    expect(finite.periodic).toHaveLength(1);
    expect(finite.periodic[0].count).toEqual({ kind: 'finite', max: 4 });
    expect(finite.manaBudget.dynamic).toBe(false);
    expect(finite.manaWorst).toBe(finite.startMana + 12);
    defMeta({
      name: '实时控制预算测试',
      group: '测试',
      params: [],
      ret: T.bool,
      mana: 2,
      ticks: 1,
      cost: () => price(1, 0, 0.5, 'maintain'),
      desc: '测试',
      impl: () => true,
    });
    const repriced = analyzeBook(parseSpellbook('spell 实时 { 实时控制预算测试() }'))['实时'];
    expect(repriced.periodic[0].count).toEqual({ kind: 'finite', max: 2 });
    expect(repriced.manaBudget.dynamic).toBe(true);
    expect(repriced.tickBudget.dynamic).toBe(true);
    defMeta({
      name: '无界预算测试',
      group: '测试',
      params: [],
      ret: T.bool,
      mana: 1,
      ticks: 1,
      cost: () => ({
        mana: fixedCost(1),
        ticks: fixedCost(1),
        periodic: {
          intervalSeconds: 0.25,
          mana: fixedCost(1),
          ticks: fixedCost(1),
          count: { kind: 'unbounded' },
        },
      }),
      desc: '测试',
      impl: () => true,
    });
    const unlimited = analyzeBook(parseSpellbook('spell 无界 { 无界预算测试() }'))['无界'];
    expect(unlimited.periodicUnbounded).toBe(true);
    expect(unlimited.manaBudget.dynamic).toBe(true);
    expect(unlimited.tickBudget.dynamic).toBe(true);
  });

  it('VM 每次成功周期重算价格、原子扣法力并登记 tick 债务', () => {
    const { world, caster } = setup();
    const program = compileProgram(parseSpellbook('spell 测试 { return 1 }'), '测试');
    const vm = new VM(program, world, caster, { retainControlSessionOnCompletion: true });
    vm.start('测试');
    const session = vm.controlSession!;
    const binding = world.controlPropertyBinding(caster, 'speed')!;
    let resistance = 0;
    Object.defineProperty(binding, 'resistance', { value: () => resistance });
    expect(world.applyEntityControl(caster.id, 'speed', 2, 0.5, { session })).toBe(true);
    const record = world.controlRecordSnapshot()[0];
    const first = controlRecordPrice(world, caster, record);
    expect(vm.spentMana).toBeCloseTo(first.mana.value + first.periodic!.mana.value);
    const debt = vm.pendingTickDebt;
    const steps = vm.result().steps;
    vm.advance(1);
    expect(vm.result().steps).toBe(steps);
    expect(vm.pendingTickDebt).toBe(debt - 1);
    vm.advance(1000);
    expect(vm.isDone).toBe(true);
    expect(session.active).toBe(true);
    resistance = 1;
    const before = vm.spentMana;
    world.advanceControlTime(0.25);
    const renewed = controlRecordPrice(world, caster, world.controlRecordSnapshot()[0]);
    expect(vm.spentMana - before).toBeCloseTo(renewed.periodic!.mana.value);
    expect(vm.pendingTickDebt).toBeGreaterThan(0);
    expect(vm.advance(1)).toBe(1);
    world.advanceControlTime(0.25);
    expect(world.controlRecordSnapshot()).toEqual([]);
    session.end();
  });

  it('法力或 tick 上限不足时不发布周期效果', () => {
    const { world, caster } = setup();
    const program = compileProgram(parseSpellbook('spell 测试 { return 1 }'), '测试');
    const vm = new VM(program, world, caster, { maxTicks: 1 });
    vm.start('测试');
    expect(world.applyEntityControl(caster.id, 'speed', 2, 0, { session: vm.controlSession })).toBe(
      false,
    );
    expect(world.controlRecordSnapshot()).toEqual([]);
    expect(caster.attr.speed).toBe(caster.base.speed);
    expect(vm.spentMana).toBe(0);
    const { world: lowWorld, caster: lowCaster } = setup();
    lowCaster.mana = 0;
    const lowVm = new VM(program, lowWorld, lowCaster);
    lowVm.start('测试');
    expect(
      lowWorld.applyEntityControl(lowCaster.id, 'speed', 2, 0, { session: lowVm.controlSession }),
    ).toBe(false);
    expect(lowVm.spentMana).toBe(0);
    expect(lowWorld.controlRecordSnapshot()).toEqual([]);
  });

  it('一次写入也经同一会话结算，位置按裁剪后的实际距离计价', () => {
    const { world, caster } = setup();
    const program = compileProgram(parseSpellbook('spell 测试 { return 1 }'), '测试');
    const vm = new VM(program, world, caster);
    vm.start('测试');
    const to = { x: 140, y: 100 };
    expect(
      world.applyEntityControl(caster.id, 'position', to, 0, { session: vm.controlSession }),
    ).toBe(true);
    const expected = controlPrice({
      relation: 1,
      resistance: 0,
      strength: 40,
      duration: 0,
      mode: 'write',
      writePolicy: 'commit',
      currentPeriod: true,
    });
    expect(vm.spentMana).toBeCloseTo(expected.mana.value);
    expect(vm.spentTicks).toBe(1 + expected.ticks.value);
    expect(world.controlRecordSnapshot()).toEqual([]);
  });
});

describe('实体句柄与控制失败边界', () => {
  it('commit 只接受时间 0，且位置与寿命不回弹', () => {
    const { world, caster } = setup();
    const projectile = world.spawnProjectile({
      faction: caster.faction,
      ownerId: caster.id,
      x: 100,
      y: 100,
      dx: 1,
      dy: 0,
      speed: 100,
      damage: 10,
    })!;
    expect(world.applyEntityControl(projectile.id, 'position', { x: 200, y: 220 }, 1)).toBe(false);
    expect(world.applyEntityControl(projectile.id, 'lifetime', 4, 1)).toBe(false);
    expect(world.applyEntityControl(projectile.id, 'position', { x: 200, y: 220 }, 0)).toBe(true);
    expect(world.applyEntityControl(projectile.id, 'lifetime', 4, 0)).toBe(true);
    world.advanceControlTime(5);
    expect(world.positionOf(projectile.id)).toEqual({ x: 200, y: 220 });
    expect(projectile.life).toBe(4);
    expect(world.controlRecordSnapshot()).toEqual([]);
  });

  it('有限与无限 overlay 按稳定序号合并，同源替换，到期露出仍有效的下层', () => {
    const { world, caster } = setup();
    const projectile = world.spawnProjectile({
      faction: caster.faction,
      ownerId: caster.id,
      x: 100,
      y: 100,
      dx: 1,
      dy: 0,
      speed: 100,
      damage: 10,
    })!;
    expect(
      world.applyEntityControl(projectile.id, 'speed', 2, 0, { controllerId: caster.id }),
    ).toBe(true);
    expect(world.applyEntityControl(projectile.id, 'speed', 3, 1, { controllerId: 0 })).toBe(true);
    expect(projectile.speed).toBe(600);
    expect(
      world.applyEntityControl(projectile.id, 'speed', 4, 0, { controllerId: caster.id }),
    ).toBe(true);
    expect(projectile.speed).toBe(1200);
    expect(world.controlRecordSnapshot()).toHaveLength(2);
    expect(world.controlRecordSnapshot().map((r) => r.sequence)).toEqual([2, 3]);
    world.advanceControlTime(1);
    expect(projectile.speed).toBe(400);
    expect(world.controlRecordSnapshot()).toHaveLength(1);
    expect(
      world.applyEntityControl(projectile.id, 'rotation', { x: 0, y: 1 }, 0, {
        controllerId: caster.id,
      }),
    ).toBe(true);
    expect(
      world.applyEntityControl(projectile.id, 'rotation', { x: -1, y: 0 }, 0, { controllerId: 0 }),
    ).toBe(true);
    expect({ x: projectile.dx, y: projectile.dy }).toEqual({ x: -1, y: 0 });
    world.projectiles = [];
    world.pruneControlRecords();
    expect(world.controlRecordSnapshot()).toEqual([]);
  });

  it('write 层不随施法结束撤销，权限失效只清理对应层', () => {
    const { world, caster } = setup();
    const projectile = world.spawnProjectile({
      faction: caster.faction,
      ownerId: caster.id,
      x: 100,
      y: 100,
      dx: 1,
      dy: 0,
      speed: 100,
      damage: 10,
    })!;
    let allowed = true;
    const session = world.createControlSession(
      caster.id,
      () => true,
      () => allowed,
    )!;
    expect(world.applyEntityControl(projectile.id, 'speed', 2, 0, { session })).toBe(true);
    session.end();
    expect(projectile.speed).toBe(200);
    expect(world.controlRecordSnapshot()).toHaveLength(1);
    expect(
      world.applyEntityControl(projectile.id, 'speed', 0, 0, { controllerId: caster.id }),
    ).toBe(false);
    expect(projectile.speed).toBe(200);
    allowed = false;
    world.pruneControlRecords();
    expect(projectile.speed).toBe(100);
    expect(world.controlRecordSnapshot()).toEqual([]);
  });

  it('maintain 首周期与更新收费，余额不足、取消、权限及目标失效都释放租约', () => {
    const { world, caster } = setup();
    let balance = 3;
    let permitted = true;
    const charged: string[] = [];
    const session = world.createControlSession(
      caster.id,
      (_record, phase) => {
        if (balance < 1) return false;
        balance--;
        charged.push(phase);
        return true;
      },
      () => permitted,
    )!;
    expect(world.applyEntityControl(caster.id, 'speed', 2, 0, { session })).toBe(true);
    expect(world.applyEntityControl(caster.id, 'speed', 3, 0, { session })).toBe(true);
    expect(caster.attr.speed).toBe(caster.base.speed * 3);
    expect(world.controlRecordSnapshot()).toHaveLength(1);
    world.advanceControlTime(0.25);
    expect(charged).toEqual(['start', 'start', 'period']);
    world.advanceControlTime(0.25);
    expect(world.controlRecordSnapshot()).toEqual([]);
    expect(caster.attr.speed).toBe(caster.base.speed);
    balance = 1;
    expect(world.applyEntityControl(caster.id, 'armor', 4, 0, { session })).toBe(true);
    permitted = false;
    world.pruneControlRecords();
    expect(caster.attr.armor).toBe(caster.base.armor);
    permitted = true;
    balance = 1;
    expect(world.applyEntityControl(caster.id, 'armor', 4, 0, { session })).toBe(true);
    session.end();
    session.end();
    expect(world.controlRecordSnapshot()).toEqual([]);
    expect(caster.attr.armor).toBe(caster.base.armor);
    const interrupted = world.createControlSession(caster.id, () => true)!;
    expect(world.applyEntityControl(caster.id, 'speed', 2, 0, { session: interrupted })).toBe(true);
    caster.alive = false;
    world.pruneControlRecords();
    expect(world.controlRecordSnapshot()).toEqual([]);
  });

  it('施法实例取消与完成释放维持层，领域拒绝保留旧层', () => {
    const { world, caster } = setup();
    const program = compileProgram(parseSpellbook('spell 测试 { return 1 }'), '测试');
    const session = world.createControlSession(caster.id, () => true)!;
    expect(world.applyEntityControl(caster.id, 'speed', 2, 0, { session })).toBe(true);
    expect(world.applyEntityControl(caster.id, 'speed', 0, 0, { session })).toBe(false);
    expect(caster.attr.speed).toBe(caster.base.speed * 2);
    const vm = new VM(program, world, caster, { controlSession: session });
    vm.start('测试');
    vm.cancel();
    expect(session.active).toBe(false);
    expect(caster.attr.speed).toBe(caster.base.speed);
    const completed = world.createControlSession(caster.id, () => true)!;
    expect(world.applyEntityControl(caster.id, 'speed', 3, 0, { session: completed })).toBe(true);
    expect(new VM(program, world, caster, { controlSession: completed }).run('测试').ok).toBe(true);
    expect(completed.active).toBe(false);
    expect(caster.attr.speed).toBe(caster.base.speed);
  });

  it('有限维持到期边界先清理，不额外续费', () => {
    const { world, caster } = setup();
    const phases: string[] = [];
    const session = world.createControlSession(caster.id, (_record, phase) => {
      phases.push(phase);
      return true;
    })!;
    expect(world.applyEntityControl(caster.id, 'armor', 3, 0.25, { session })).toBe(true);
    world.advanceControlTime(0.25);
    expect(phases).toEqual(['start']);
    expect(caster.attr.armor).toBe(caster.base.armor);
    expect(world.controlRecordSnapshot()).toEqual([]);
  });

  it('稳定属性描述符统一校验并规范化首批效果域', () => {
    expect(CONTROL_PROPERTY_KEYS).toEqual([
      'position',
      'rotation',
      'speed',
      'damage',
      'lifetime',
      'perception',
      'armor',
    ]);
    expect(getControlPropertyDescriptor('missing')).toBeNull();
    expect(getControlPropertyDescriptor('position')!.normalize({ x: 1, y: 2 })).toEqual({
      x: 1,
      y: 2,
    });
    expect(getControlPropertyDescriptor('position')!.normalize({ x: Infinity, y: 2 })).toBeNull();
    expect(getControlPropertyDescriptor('rotation')!.normalize({ x: 0, y: 2 })).toEqual({
      x: 0,
      y: 1,
    });
    expect(getControlPropertyDescriptor('rotation')!.normalize({ x: 0, y: 0 })).toBeNull();
    expect(getControlPropertyDescriptor('rotation')!.normalize({ x: 1e-100, y: 0 })).toEqual({
      x: 1,
      y: 0,
    });
    const hugeDirection = getControlPropertyDescriptor('rotation')!.normalize({
      x: Number.MAX_VALUE,
      y: Number.MAX_VALUE,
    });
    expect(hugeDirection).not.toBeNull();
    if (hugeDirection && typeof hugeDirection === 'object') {
      expect(hugeDirection.x).toBeCloseTo(Math.SQRT1_2);
      expect(hugeDirection.y).toBeCloseTo(Math.SQRT1_2);
    }
    for (const key of ['speed', 'damage', 'lifetime', 'perception'] as const) {
      expect(getControlPropertyDescriptor(key)!.normalize(0)).toBeNull();
      expect(getControlPropertyDescriptor(key)!.normalize(2)).toBe(2);
    }
    expect(getControlPropertyDescriptor('armor')!.normalize(-2)).toBe(-2);
  });

  it('Actor 与 Projectile 通过 binding 查询并复用同一 speed/damage 入口', () => {
    const { world, caster } = setup();
    const projectile = world.spawnProjectile({
      faction: caster.faction,
      ownerId: caster.id,
      x: caster.x,
      y: caster.y,
      dx: 1,
      dy: 0,
      speed: 100,
      damage: 10,
    })!;

    expect(world.controlPropertyBinding(caster, 'speed')).toMatchObject({
      propertyKey: 'speed',
      mode: 'maintain',
      writePolicy: null,
    });
    expect(world.controlPropertyBinding(projectile, 'speed')).toMatchObject({
      propertyKey: 'speed',
      mode: 'write',
      writePolicy: 'overlay',
    });
    for (const key of ['position', 'rotation', 'speed', 'damage'] as const) {
      expect(world.controlPropertyBinding(caster, key)?.propertyKey).toBe(key);
      expect(world.controlPropertyBinding(projectile, key)?.propertyKey).toBe(key);
    }
    expect(world.controlPropertyBinding(projectile, 'lifetime')?.writePolicy).toBe('commit');
    expect(world.controlPropertyBinding(caster, 'perception')?.mode).toBe('maintain');
    expect(world.controlPropertyBinding(caster, 'armor')?.mode).toBe('maintain');
    expect(world.controlPropertyBinding(caster, 'lifetime')).toBeNull();
    expect(world.controlPropertyBinding(projectile, 'perception')).toBeNull();
    expect(world.controlPropertyBinding(projectile, 'armor')).toBeNull();
    const session = world.createControlSession(caster.id, () => true)!;
    expect(world.applyEntityControl(caster.id, 'speed', 2, 0, { session })).toBe(true);
    expect(world.applyEntityControl(projectile.id, 'speed', 2, 0)).toBe(true);
    expect(caster.attr.speed).toBe(caster.base.speed * 2);
    expect(projectile.speed).toBe(200);

    expect(world.applyEntityControl(caster.id, 'damage', 3, 0, { session })).toBe(true);
    expect(world.applyEntityControl(projectile.id, 'damage', 3, 0)).toBe(true);
    expect(caster.attr.power).toBe(caster.base.power * 3);
    expect(projectile.damage).toBe(30);
  });

  it('缺 descriptor、缺 binding、非法效果与不支持时间均拒绝且不改状态', () => {
    const { world, caster } = setup();
    const projectile = world.spawnProjectile({
      faction: caster.faction,
      ownerId: caster.id,
      x: 100,
      y: 100,
      dx: 1,
      dy: 0,
      speed: 100,
      damage: 10,
    })!;
    const before = structuredClone(projectile);

    expect(world.controlPropertyBinding(projectile, 'perception')).toBeNull();
    expect(world.applyEntityControl(projectile.id, 'perception', 2, 1)).toBe(false);
    expect(world.applyEntityControl(projectile.id, 'missing', 2, 0)).toBe(false);
    expect(world.applyEntityControl(projectile.id, 'speed', 0, 0)).toBe(false);
    expect(world.applyEntityControl(projectile.id, 'position', { x: 200, y: 200 }, 1)).toBe(false);
    expect(world.applyEntityControl(projectile.id, 'speed', 2, -1)).toBe(false);
    expect(world.events.join(' ')).toContain('缺少 perception 属性 binding');
    expect(world.events.join(' ')).toContain('缺少属性能力：missing');
    expect(world.events.join(' ')).toContain('非法效果参数');
    expect(world.events.join(' ')).toContain('非法时间');
    expect(projectile).toEqual(before);
    expect(
      world.applyEntityControl(
        projectile.id,
        'position',
        { x: Number.MAX_VALUE, y: Number.MAX_VALUE },
        0,
      ),
    ).toBe(true);
    expect(world.positionOf(projectile.id)).toEqual({
      x: world.bounds.w - projectile.radius,
      y: world.bounds.h - projectile.radius,
    });
  });

  it('移除、重置和死亡后的旧对象引用不能重新取得 binding 或修改状态', () => {
    const { world, caster } = setup();
    const projectile = world.spawnProjectile({
      faction: caster.faction,
      ownerId: caster.id,
      x: 100,
      y: 100,
      dx: 1,
      dy: 0,
      speed: 100,
      damage: 10,
    })!;
    const before = structuredClone(projectile);
    world.projectiles = [];
    expect(world.controlPropertyBinding(projectile, 'speed')).toBeNull();
    expect(world.applyEntityControl(projectile.id, 'speed', 2, 0)).toBe(false);
    expect(projectile).toEqual(before);

    caster.alive = false;
    const dead = structuredClone(caster);
    expect(world.controlPropertyBinding(caster, 'position')).toBeNull();
    expect(world.applyEntityControl(caster.id, 'position', { x: 200, y: 200 }, 0)).toBe(false);
    expect(caster).toEqual(dead);

    world.reset();
    expect(world.controlPropertyBinding(caster, 'speed')).toBeNull();
  });

  it('会使属性溢出的控制请求返回 false 且不留下修正', () => {
    const { world, caster } = setup();
    caster.base.speed = Number.MAX_VALUE;
    caster.base.armor = Number.MAX_VALUE;
    world.recompute(caster);
    const before = structuredClone(caster);
    const session = world.createControlSession(caster.id, () => true)!;
    expect(world.applyEntityControl(caster.id, 'speed', 2, 0, { session })).toBe(false);
    expect(world.applyEntityControl(caster.id, 'armor', Number.MAX_VALUE, 0, { session })).toBe(
      false,
    );
    expect(caster).toEqual(before);
  });

  it('跨种类、移除及重置后不复用旧句柄', () => {
    const { world, caster, call } = setup();
    const id = call('创建弹道', 5) as number;
    const foe = world.spawnActor({ faction: 'foe', x: 0, y: 0 });
    expect(new Set([caster.id, id, foe.id]).size).toBe(3);
    world.projectiles = [];
    expect(call('实体存在', id)).toBe(false);
    expect(call('探查', id)).toEqual({ x: 0, y: 0 });
    expect(call('设置弹道速度', id, 200)).toBe(false);
    world.reset();
    const fresh = world.spawnActor({ faction: 'player', x: 0, y: 0 });
    expect(fresh.id).toBeGreaterThan(foe.id);
    expect(world.entityById(caster.id)).toBeNull();
  });

  it('其他所有者、空句柄、缺少能力和非法请求不会部分修改', () => {
    const { world, caster, ctx, call } = setup();
    const id = call('创建弹道', 5) as number;
    const projectile = world.entityById(id)!;
    const before = structuredClone(projectile);
    const other = world.spawnActor({ faction: 'player', x: 0, y: 0 });
    for (const name of ['设置弹道方向', '设置弹道速度', '设置弹道威力', '激活弹道']) {
      const arg = name === '设置弹道方向' ? { x: 0, y: 1 } : 50;
      expect(getMeta(name)!.impl({ ...ctx, caster: other }, [id, arg])).toBe(false);
      expect(call(name, null, arg)).toBe(false);
      expect(call(name, caster.id, arg)).toBe(false);
    }
    for (const value of [-1, 0, Infinity, NaN]) {
      expect(call('设置弹道速度', id, value)).toBe(false);
    }
    for (const value of [-1, 0, Infinity, NaN]) {
      expect(call('设置弹道威力', id, value)).toBe(false);
    }
    for (const direction of [
      { x: 0, y: 0 },
      { x: Infinity, y: 1 },
      { x: NaN, y: 0 },
    ]) {
      expect(call('设置弹道方向', id, direction)).toBe(false);
    }
    expect(call('激活弹道', id)).toBe(false);
    expect(projectile).toEqual(before);
    for (const value of [-1, 0, Infinity, NaN]) expect(call('创建弹道', value)).toBeNull();
    expect(world.projectiles).toHaveLength(1);
  });

  it('激活只执行一次，飞行中仍可转向且不重置位置', () => {
    const { world, call } = setup();
    const id = call('创建弹道', 5) as number;
    call('设置弹道速度', id, 600);
    call('设置弹道威力', id, 100);
    expect(call('激活弹道', id)).toBe(true);
    const position = world.positionOf(id);
    expect(call('设置弹道方向', id, { x: 0, y: 2 })).toBe(true);
    expect(call('激活弹道', id)).toBe(false);
    expect(world.positionOf(id)).toEqual(position);
    expect(world.fx).toHaveLength(1);
  });

  it('旧生命、伤害与属性控制按统一实体能力成功或确定性失败', () => {
    const { world, call } = setup();
    const foe = world.spawnActor({ faction: 'foe', x: 140, y: 100 });
    const projectileId = call('创建弹道', 5) as number;
    const projectile = world.entityById(projectileId)!;
    const projectileBefore = structuredClone(projectile);

    expect(call('生命', foe.id)).toBe(foe.hp);
    expect(call('生命', projectileId)).toBe(0);
    expect(call('生命', 999999)).toBe(0);

    const hp = foe.hp;
    expect(call('伤害', foe.id, 12)).toBe(true);
    expect(foe.hp).toBeLessThan(hp);
    expect(call('伤害', projectileId, 12)).toBe(false);
    expect(call('伤害', foe.id, 0)).toBe(false);

    for (const [name, value] of [
      ['迟滞', 0.5],
      ['虚弱', 0.5],
      ['蔽识', 0.5],
      ['破防', 2],
    ] as const) {
      const modCount = foe.mods.length;
      expect(call(name, foe.id, value, 3)).toBe(true);
      expect(foe.mods).toHaveLength(modCount + 1);
      expect(call(name, projectileId, value, 3)).toBe(false);
      expect(call(name, 999999, value, 3)).toBe(false);
    }
    expect(foe.attr.speed).toBeLessThan(foe.base.speed);
    expect(foe.attr.power).toBeLessThan(foe.base.power);
    expect(foe.attr.perception).toBeLessThan(foe.base.perception);
    expect(foe.attr.armor).toBeLessThan(foe.base.armor);
    expect(projectile).toEqual(projectileBefore);
  });
});

describe('动态定价契约', () => {
  it('距离与请求效果改变实扣，动态请求不再被旧上限截断', () => {
    const { world, caster, ctx, call } = setup();
    const id = call('创建弹道', 5) as number;
    const target = world.entityById(id)!;
    const probe = getMeta('探查')!;
    const near = probe.cost!(ctx, [knownCostArg(id)]).mana.value;
    target.x += 200;
    expect(probe.cost!(ctx, [knownCostArg(id)]).mana.value).toBeGreaterThan(near);
    target.x += 10000;
    expect(probe.cost!(ctx, [knownCostArg(id)]).mana.value).toBeGreaterThan(near);
    for (const [name, high] of [
      ['创建弹道', 5],
      ['设置弹道速度', 600],
      ['设置弹道威力', 100],
    ] as const) {
      const meta = getMeta(name)!;
      const args = (value: number) => (name === '创建弹道' ? [value] : [id, value]);
      const low = meta.cost!(ctx, args(1).map(knownCostArg)).mana.value;
      const highCost = meta.cost!(ctx, args(high).map(knownCostArg)).mana.value;
      expect(low).toBeLessThan(highCost);
      expect(highCost).toBeGreaterThan(meta.mana);
      expect(Number.isFinite(meta.cost!(ctx, args(NaN).map(knownCostArg)).mana.value)).toBe(true);
    }
    const book = parseSpellbook(
      'spell 铸剑 { var p: entity = 创建弹道(5) 设置弹道速度(p, 600) 设置弹道威力(p, 100) 激活弹道(p) }',
    );
    caster.base.manaCostMul = 2;
    world.recompute(caster);
    const result = new VM(compileProgram(book), world, caster).run('铸剑');
    expect(result.ok).toBe(true);
    const budget = analyzeBook(book)['铸剑'];
    expect(result.mana).toBe(budget.manaWorst * 2);
    expect(result.ticks).toBe(budget.tickWorst);
    expect(result.ticks).toBeGreaterThan(7);
  });

  it('同一个设置位置元法术可以控制 Actor 与 Projectile，关系同时影响法力与耗时', () => {
    const { world, caster, ctx, call } = setup();
    const ownProjectileId = call('创建弹道', 5) as number;
    const ally = world.spawnActor({ faction: 'player', x: 300, y: 260 });
    const foe = world.spawnActor({ faction: 'foe', x: 300, y: 260 });
    const hostileProjectile = world.spawnProjectile({
      faction: 'foe',
      ownerId: foe.id,
      x: 300,
      y: 260,
      dx: 1,
      dy: 0,
      speed: 100,
      damage: 10,
    })!;
    const meta = getMeta('设置位置')!;
    const point = knownCostArg({ x: 500, y: 260 });
    const foeCost = meta.cost!(ctx, [knownCostArg(foe.id), point]);
    const projectileCost = meta.cost!(ctx, [knownCostArg(hostileProjectile.id), point]);
    expect(foeCost.mana.value).toBe(projectileCost.mana.value);
    expect(foeCost.ticks.value).toBe(projectileCost.ticks.value);

    const moveBy = (id: number, x: number, y: number) =>
      meta.cost!(ctx, [knownCostArg(id), knownCostArg({ x: x + 100, y })]);
    const ownCost = moveBy(ownProjectileId, caster.x, caster.y);
    const allyCost = moveBy(ally.id, ally.x, ally.y);
    const hostileCost = moveBy(foe.id, foe.x, foe.y);
    expect(ownCost.mana.value).toBeLessThan(allyCost.mana.value);
    expect(allyCost.mana.value).toBeLessThan(hostileCost.mana.value);
    expect(ownCost.ticks.value).toBeLessThan(allyCost.ticks.value);
    expect(allyCost.ticks.value).toBeLessThan(hostileCost.ticks.value);

    expect(call('设置位置', foe.id, { x: 500, y: 260 })).toBe(true);
    expect(call('设置位置', hostileProjectile.id, { x: 500, y: 260 })).toBe(true);
    expect(world.positionOf(foe.id)).toEqual({ x: 500, y: 260 });
    expect(world.positionOf(hostileProjectile.id)).toEqual({ x: 500, y: 260 });
    expect(caster.x).toBe(100);
  });

  it('效果数值直接决定法力与时间，10000 不能伪装成 100 的同价请求', () => {
    const meta = getMeta('伤害')!;
    const low = meta.cost!(null, [knownCostArg(1), knownCostArg(100)]);
    const high = meta.cost!(null, [knownCostArg(1), knownCostArg(10000)]);
    expect(high.mana.value).toBeGreaterThan(low.mana.value);
    expect(high.ticks.value).toBeGreaterThan(low.ticks.value);
  });

  it('分支写入不同请求值时分析器保留动态预算，不采用最后分析分支的伪定值', () => {
    const book = parseSpellbook(`
      spell 分支(flag: bool) {
        var target: entity
        var amount: num = 1
        if flag { amount = 10000 } else { amount = 1 }
        伤害(target, amount)
      }
    `);
    const budget = analyzeBook(book)['分支'];
    expect(budget.errors).toEqual([]);
    expect(budget.manaBudget.dynamic).toBe(true);
    expect(budget.tickBudget.dynamic).toBe(true);
    expect(budget.manaBudget.value).toBe(getMeta('伤害')!.mana);
  });

  it.each([NaN, Infinity, -1, 'throw'])('拒绝非法价格 %s，扣费和效果均未发生', (price) => {
    const { world, caster } = setup();
    const original = getMeta('创建弹道')!;
    const impl = vi.fn(original.impl);
    try {
      defMeta({
        ...original,
        impl,
        cost: () => {
          if (typeof price === 'string') throw new Error('pricing');
          return { mana: fixedCost(price), ticks: fixedCost(2) };
        },
      });
      const book = parseSpellbook('spell 测试 { 创建弹道(1) }');
      const analyzed = analyzeBook(book)['测试'];
      expect(analyzed.errors.join()).toMatch(/静态定价失败|非法静态消耗/);
      expect(analyzed.manaBudget.dynamic).toBe(true);
      const result = new VM(compileProgram(book), world, caster).run('测试');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/动态/);
      expect(result.mana).toBe(0);
      expect(impl).not.toHaveBeenCalled();
      expect(world.projectiles).toHaveLength(0);
    } finally {
      defMeta(original);
    }
  });

  it('法力不足时创建不产生实体', () => {
    const { world, caster } = setup();
    caster.mana = 1;
    const book = parseSpellbook('spell 测试 { 创建弹道(5) }');
    expect(new VM(compileProgram(book), world, caster).run('测试').ok).toBe(false);
    expect(world.projectiles).toHaveLength(0);
  });
});

describe('配置期弹道的战斗生命周期', () => {
  it('旧发射与新创建共用上限，失败不生成特效，所有者名额独立', () => {
    const { world, ctx, call } = setup();
    for (let i = 0; i < 15; i++) call('创建弹道', 5);
    call('发射', { x: 100, y: 100 }, { x: 1, y: 0 }, 22);
    expect(world.projectiles).toHaveLength(16);
    expect(world.projectiles[15].active).toBe(true);
    expect(world.fx).toHaveLength(1);
    expect(call('创建弹道', 5)).toBeNull();
    call('发射', { x: 100, y: 100 }, { x: 1, y: 0 }, 22);
    expect(world.projectiles).toHaveLength(16);
    expect(world.fx).toHaveLength(1);
    const other = world.spawnActor({ faction: 'foe', x: 0, y: 0 });
    expect(getMeta('创建弹道')!.impl({ ...ctx, caster: other }, [5])).not.toBeNull();
  });

  it('未激活不移动或碰撞，仍过期并归还名额', () => {
    const battle = new Battle(parseSpellbook('spell 空术 {}'));
    for (const actor of battle.world.actors) {
      actor.bindings = {};
      actor.base.speed = 0;
      battle.world.recompute(actor);
    }
    const foe = battle.world.actors.find((a) => a.faction === 'foe')!;
    const spawn = () =>
      battle.world.spawnProjectile({
        ownerId: battle.player.id,
        faction: 'player',
        x: foe.x,
        y: foe.y,
        dx: 1,
        dy: 0,
        speed: 400,
        damage: 50,
        life: 0.1,
        active: false,
      });
    for (let i = 0; i < 16; i++) expect(spawn()).not.toBeNull();
    expect(spawn()).toBeNull();
    const projectile = battle.world.projectiles[0];
    const initialX = projectile.x;
    const initialY = projectile.y;
    const hp = foe.hp;
    battle.update(0.05);
    expect(projectile.x).toBe(initialX);
    expect(projectile.y).toBe(initialY);
    expect(foe.hp).toBe(hp);
    expect(projectile.life).toBeCloseTo(0.05);
    battle.update(0.06);
    expect(battle.world.entityById(projectile.id)).toBeNull();
    expect(spawn()).not.toBeNull();
  });
});
