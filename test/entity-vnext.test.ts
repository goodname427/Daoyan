import { describe, expect, it, vi } from 'vitest';
import {
  World,
  VM,
  analyzeBook,
  compileProgram,
  parseSpellbook,
  getMeta,
  defMeta,
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
    for (const value of [-1, 0, 601, Infinity, NaN]) {
      expect(call('设置弹道速度', id, value)).toBe(false);
    }
    for (const value of [-1, 0, 101, Infinity, NaN]) {
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
    for (const value of [-1, 0, 6, Infinity, NaN]) expect(call('创建弹道', value)).toBeNull();
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
});

describe('动态定价契约', () => {
  it('距离、请求效果改变实扣，倍率后的实扣不超过同倍率静态上界', () => {
    const { world, caster, ctx, call } = setup();
    const id = call('创建弹道', 5) as number;
    const target = world.entityById(id)!;
    const probe = getMeta('探查')!;
    const near = probe.manaCost!(ctx, [id]);
    target.x += 200;
    expect(probe.manaCost!(ctx, [id])).toBeGreaterThan(near);
    target.x += 10000;
    expect(probe.manaCost!(ctx, [id])).toBe(probe.mana);
    for (const [name, max] of [
      ['创建弹道', 5],
      ['设置弹道速度', 600],
      ['设置弹道威力', 100],
    ] as const) {
      const meta = getMeta(name)!;
      const args = (value: number) => (name === '创建弹道' ? [value] : [id, value]);
      expect(meta.manaCost!(ctx, args(1))).toBeLessThan(meta.manaCost!(ctx, args(max)));
      expect(meta.manaCost!(ctx, args(max))).toBe(meta.mana);
      expect(Number.isFinite(meta.manaCost!(ctx, args(NaN)))).toBe(true);
    }
    const book = parseSpellbook(
      'spell 铸剑 { var p: entity = 创建弹道(5) 设置弹道速度(p, 600) 设置弹道威力(p, 100) 激活弹道(p) }',
    );
    caster.base.manaCostMul = 2;
    world.recompute(caster);
    const result = new VM(compileProgram(book), world, caster).run('铸剑');
    expect(result.ok).toBe(true);
    expect(result.mana).toBe(analyzeBook(book)['铸剑'].manaWorst * 2);
  });

  it.each([NaN, Infinity, -1, 19, 'throw'])('拒绝非法价格 %s，扣费和效果均未发生', (price) => {
    const { world, caster } = setup();
    const original = getMeta('创建弹道')!;
    const impl = vi.fn(original.impl);
    try {
      defMeta({
        ...original,
        impl,
        manaCost: () => {
          if (typeof price === 'string') throw new Error('pricing');
          return price;
        },
      });
      const book = parseSpellbook('spell 测试 { 创建弹道(1) }');
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
