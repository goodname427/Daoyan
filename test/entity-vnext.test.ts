import { describe, expect, it, vi } from 'vitest';
import {
  World,
  VM,
  analyzeBook,
  compileProgram,
  parseSpellbook,
  getMeta,
  defMeta,
  fixedCost,
  knownCostArg,
  type Ctx,
  type Value,
} from '../src/core/index';
import { Battle } from '../src/game/battle';

function setup() {
  const world = new World();
  const caster = world.spawnActor({ faction: 'player', x: 100, y: 100, attrs: { manaMax: 9999 } });
  const ctx: Ctx = { world, caster, keys: null, log: [], endRequested: false };
  const call = (name: string, ...args: Value[]) => getMeta(name)!.impl(ctx, args);
  return { world, caster, ctx, call };
}

describe('实体句柄与控制失败边界', () => {
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
    const hp = foe.hp;
    battle.update(0.05);
    expect(projectile.x).toBe(foe.x);
    expect(foe.hp).toBe(hp);
    expect(projectile.life).toBeCloseTo(0.05);
    battle.update(0.06);
    expect(battle.world.entityById(projectile.id)).toBeNull();
    expect(spawn()).not.toBeNull();
  });
});
