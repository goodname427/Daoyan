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

describe('法球分池行为与守恒命中', () => {
  it('五参创建逐项付款，VM 报告含世界扣款并建立单次命中来源', () => {
    const { world, caster } = setup();
    const book = parseSpellbook(`spell 供能 -> entity {
      return 创建弹道(自身位置(), 向量(1, 0), 380, 2, 2.4)
    }`);
    const before = caster.mana;
    const result = new VM(compileProgram(book), world, caster).run('供能');
    expect(result.ok).toBe(true);
    expect(result.mana).toBeCloseTo(before - caster.mana);
    expect(
      world.resourceLedger.balance(result.returnValue as number).damage,
    ).toBeGreaterThanOrEqual(2);
    expect(world.resourceLedger.snapshot()).toMatchObject({
      conserved: true,
      totals: { motionWork: 1_000_000, controlLoss: 1_000_000 },
    });
  });

  it('冲量后滑行不续费；周期推进耗尽后只衰减惯性', () => {
    const { world, caster } = setup();
    const p = world.spawnProjectile({
      faction: 'player',
      ownerId: caster.id,
      x: 120,
      y: 100,
      dx: 1,
      dy: 0,
      speed: 200,
      damage: 10,
    })!;
    p.velocity = { x: 0, y: 0 };
    expect(world.injectEntityEnergy(p.id, caster.id, 'motion', 0.1)).not.toBeNull();
    expect(world.configureProjectileBehavior(caster.id, p.id, 'thrust', { x: 50, y: 0 })).toBe(
      true,
    );
    const beforeMana = caster.mana;
    world.advanceProjectileMotion(p, 0.25);
    const afterFirst = p.velocity.x;
    expect(afterFirst).toBeGreaterThan(0);
    expect(world.resourceLedger.balance(p.id).motion).toBeLessThan(0.08);
    world.advanceProjectileMotion(p, 0.25);
    expect(p.velocity.x).toBeLessThan(afterFirst);
    expect(p.velocity.x).toBeGreaterThan(0);
    expect(caster.mana).toBe(beforeMana);
    expect(world.resourceLedger.snapshot().conserved).toBe(true);
    expect(world.configureProjectileBehavior(caster.id, p.id, 'glide')).toBe(true);
    const balance = world.resourceLedger.balance(p.id).motion;
    world.advanceProjectileMotion(p, 0.5);
    expect(world.resourceLedger.balance(p.id).motion).toBe(balance);
  });

  it('追踪逐周期先付扫描，再从运动池转向；缺扫描或权限不生成新推力', () => {
    const { world, caster } = setup();
    const foe = world.spawnActor({ faction: 'foe', x: 170, y: 150 });
    world.grantSenseField(caster.id, foe.id, 'position', {
      shenshiUpperBound: foe.attr.shenshiMax,
      resistanceUpperBound: 0,
    });
    const p = world.spawnProjectile({
      faction: 'player',
      ownerId: caster.id,
      x: 120,
      y: 100,
      dx: 1,
      dy: 0,
      speed: 200,
      damage: 0,
    })!;
    p.velocity = { x: 0, y: 0 };
    world.injectEntityEnergy(p.id, caster.id, 'motion', 2);
    world.injectEntityEnergy(p.id, caster.id, 'scan', 1.25);
    expect(
      world.configureProjectileBehavior(caster.id, p.id, 'track', { x: 30, y: 0 }, foe.id),
    ).toBe(true);
    const mana = caster.mana;
    world.advanceProjectileMotion(p, 0.25);
    expect(p.velocity.y).toBeGreaterThan(0);
    expect(world.resourceLedger.balance(p.id).scan).toBe(0);
    const velocity = { ...p.velocity };
    world.advanceProjectileMotion(p, 0.25);
    expect(p.velocity.x).toBeLessThan(velocity.x);
    expect(p.velocity.y).toBeLessThan(velocity.y);
    expect(caster.mana).toBe(mana);
    expect(world.resourceLedger.snapshot().conserved).toBe(true);
  });

  it('追踪权限撤销后不再扣扫描或生成新转向', () => {
    const { world, caster } = setup();
    const foe = world.spawnActor({ faction: 'foe', x: 170, y: 150 });
    world.grantSenseField(caster.id, foe.id, 'position', {
      shenshiUpperBound: foe.attr.shenshiMax,
      resistanceUpperBound: 0,
    });
    const p = world.spawnProjectile({
      faction: 'player',
      ownerId: caster.id,
      x: 120,
      y: 100,
      dx: 1,
      dy: 0,
      speed: 200,
      damage: 0,
    })!;
    p.velocity = { x: 0, y: 0 };
    world.injectEntityEnergy(p.id, caster.id, 'motion', 2);
    world.injectEntityEnergy(p.id, caster.id, 'scan', 2.5);
    world.configureProjectileBehavior(caster.id, p.id, 'track', { x: 30, y: 0 }, foe.id);
    world.advanceProjectileMotion(p, 0.25);
    const scan = world.resourceLedger.balance(p.id).scan;
    const velocity = { ...p.velocity };
    world.revokeSenseField(caster.id, foe.id, 'position');
    world.advanceProjectileMotion(p, 0.25);
    expect(world.resourceLedger.balance(p.id).scan).toBe(scan);
    expect(p.velocity.x).toBeLessThan(velocity.x);
    expect(p.velocity.y).toBeLessThan(velocity.y);
  });

  it('命中只释放可用伤害池，护体不返还能量且穿透逐次扣款', () => {
    const { world, caster } = setup();
    const first = world.spawnActor({ faction: 'foe', x: 160, y: 100 });
    const second = world.spawnActor({ faction: 'foe', x: 180, y: 100 });
    first.attr.armor = 0;
    second.attr.armor = 1;
    const p = world.spawnProjectile({
      faction: 'player',
      ownerId: caster.id,
      x: 120,
      y: 100,
      dx: 1,
      dy: 0,
      speed: 100,
      damage: 10,
      pierce: 1,
    })!;
    const unfundedTarget = world.spawnActor({ faction: 'foe', x: 140, y: 100 });
    const unfundedHp = unfundedTarget.hp;
    expect(world.hitProjectile(p, unfundedTarget.id)).toBe(false);
    expect(unfundedTarget.hp).toBe(unfundedHp);
    expect(p.velocity.x).toBe(100);
    world.injectEntityEnergy(p.id, caster.id, 'damage', 1);
    // 零伤害接触也只登记一次碰撞；后来注能不能重放同一目标的接触。
    expect(world.hitProjectile(p, unfundedTarget.id)).toBe(false);
    expect(world.resourceLedger.balance(p.id).damage).toBeCloseTo(0.8);
    const hp = first.hp;
    expect(world.hitProjectile(p, first.id)).toBe(true);
    expect(first.hp).toBeCloseTo(hp - 0.8);
    expect(world.hitProjectile(p, first.id)).toBe(false);
    world.injectEntityEnergy(p.id, caster.id, 'damage', 0.5);
    const shieldedHp = second.hp;
    expect(world.hitProjectile(p, second.id)).toBe(true);
    expect(second.hp).toBe(shieldedHp);
    expect(world.resourceLedger.balance(p.id).damage).toBe(0);
    const third = world.spawnActor({ faction: 'foe', x: 200, y: 100 });
    third.attr.armor = -100;
    world.injectEntityEnergy(p.id, caster.id, 'damage', 0.5);
    const thirdHp = third.hp;
    expect(world.hitProjectile(p, third.id)).toBe(true);
    expect(thirdHp - third.hp).toBeCloseTo(0.4);
    expect(world.resourceLedger.snapshot().conserved).toBe(true);
  });
});

describe('有源运动与传送', () => {
  it('基础功率按周期预付、起停保留惯性且调低上限不截断速度', () => {
    const { world, caster } = setup();
    const initial = caster.base.speed;
    world.advanceActorMotion(caster, { x: 1, y: 0 }, 1, 0.15);
    expect(caster.velocity.x).toBeGreaterThan(initial * 0.94);
    expect(caster.movePower).toBeCloseTo(3.6);
    caster.attr.speed = initial / 2;
    const before = caster.velocity.x;
    expect(before).toBeGreaterThan(caster.attr.speed);
    world.advanceActorMotion(caster, { x: 0, y: 0 }, 1, 0.15);
    expect(caster.velocity.x).toBeCloseTo(before * Math.exp(-3));
    expect(caster.x).toBeLessThan(100 + initial * 0.15 + before / 20);
    expect(caster.movePower).toBeLessThanOrEqual(4);
  });

  it('无功率的更新不能免费推进，分步与整步的周期账一致', () => {
    const first = setup();
    const second = setup();
    first.world.advanceActorMotion(first.caster, { x: 1, y: 0 }, 1, 1);
    for (let i = 0; i < 10; i++)
      second.world.advanceActorMotion(second.caster, { x: 1, y: 0 }, 1, 0.1);
    expect(first.caster.x).toBeCloseTo(second.caster.x, 5);
    expect(first.caster.movePower).toBeCloseTo(second.caster.movePower, 5);
    first.caster.movePower = 0;
    const speed = first.caster.velocity.x;
    first.world.advanceActorMotion(first.caster, { x: 0, y: 1 }, 1, 0.1);
    expect(first.caster.velocity.x).toBeLessThan(speed);
    expect(first.caster.velocity.y).toBe(0);
  });

  it('传送拒绝越界、占用和失权，成功保留实际速度', () => {
    const { world, caster, ctx, call } = setup();
    world.spawnActor({ faction: 'foe', x: 200, y: 100 });
    world.advanceActorMotion(caster, { x: 1, y: 0 }, 1, 0.1);
    const velocity = { ...caster.velocity };
    const origin = world.positionOf(caster.id);
    expect(call('传送', caster.id, { x: 0, y: 100 })).toBe(false);
    expect(call('传送', caster.id, { x: 200, y: 100 })).toBe(false);
    const failedBook = parseSpellbook(
      'spell 误传 -> bool { return 传送(自身实体(), 向量(200, 100)) }',
    );
    const failed = new VM(compileProgram(failedBook), world, caster).run('误传');
    expect(failed.ok).toBe(true);
    expect(failed.returnValue).toBe(false);
    expect(failed.mana).toBe(1);
    caster.teleportAllowed = false;
    expect(call('传送', caster.id, { x: 300, y: 100 })).toBe(false);
    caster.teleportAllowed = true;
    ctx.controlSession = world.createControlSession(
      caster.id,
      () => true,
      () => false,
    )!;
    expect(call('传送', caster.id, { x: 300, y: 100 })).toBe(false);
    expect(world.positionOf(caster.id)).toEqual(origin);
    ctx.controlSession.end();
    ctx.controlSession = undefined;
    expect(call('传送', caster.id, { x: 300, y: 100 })).toBe(true);
    expect(caster.velocity).toEqual(velocity);
    const price = getMeta('传送')!.cost!(ctx, [
      knownCostArg(caster.id),
      knownCostArg({ x: 400, y: 100 }),
    ]);
    expect(price.mana.value).toBe(30);
  });

  it('弹道朝向与上限变化不改惯性，冲量有非零价格', () => {
    const { world, caster, ctx } = setup();
    const projectile = world.spawnProjectile({
      faction: 'player',
      ownerId: caster.id,
      x: 200,
      y: 100,
      dx: 1,
      dy: 0,
      speed: 100,
      damage: 1,
    })!;
    expect(world.applyEntityControl(projectile.id, 'rotation', { x: 0, y: 1 }, 0)).toBe(true);
    expect(world.applyEntityControl(projectile.id, 'speed', 2, 0)).toBe(true);
    expect(projectile.velocity).toEqual({ x: 100, y: 0 });
    const price = getMeta('施加冲量')!.cost!(ctx, [
      knownCostArg(projectile.id),
      knownCostArg({ x: 0, y: 100 }),
    ]);
    expect(price.mana.value).toBeGreaterThan(2);
    expect(world.applyImpulse(projectile.id, { x: 0, y: 100 })).toBe(true);
    expect(projectile.velocity).toEqual({ x: 100, y: 100 });
  });

  it('冲量整项不受法力折扣，余额不足不发布速度', () => {
    const { world, caster } = setup();
    caster.base.manaCostMul = 0.5;
    world.recompute(caster);
    const book = parseSpellbook('spell 推进 -> bool { return 施加冲量(自身实体(), 向量(100, 0)) }');
    const program = compileProgram(book);
    const energyMana = (2 * (100 / 380) ** 2) / 0.8;
    caster.mana = 1;
    const failed = new VM(program, world, caster).run('推进');
    expect(failed.ok).toBe(false);
    expect(caster.velocity).toEqual({ x: 0, y: 0 });
    caster.mana = 10;
    const result = new VM(program, world, caster).run('推进');
    expect(result.ok).toBe(true);
    expect(result.returnValue).toBe(true);
    expect(result.mana).toBeCloseTo(2 + energyMana);
    expect(caster.velocity.x).toBe(100);
  });
});

describe('共享账户与实体分池账本', () => {
  it('逐笔记录注能、预留、做功和命中；10 M 换 8 E、消费 3 E 后最多退 5 M', () => {
    const { world, caster } = setup();
    caster.mana = 20;
    const projectile = world.spawnProjectile({
      faction: 'player',
      ownerId: caster.id,
      x: 120,
      y: 100,
      dx: 1,
      dy: 0,
      speed: 0,
      damage: 0,
    })!;
    const source = world.injectEntityEnergy(projectile.id, caster.id, 'damage', 10, 7, 9);
    expect(source).not.toBeNull();
    expect(caster.mana).toBe(10);
    expect(world.resourceLedger.balance(projectile.id).damage).toBe(8);
    const held = world.resourceLedger.reserve(projectile.id, 'damage', 3);
    expect(held).not.toBeNull();
    expect(world.resourceLedger.reserve(projectile.id, 'damage', 6)).toBeNull();
    expect(world.resourceLedger.settle(held!, { damage: 3 })).toBe(true);
    expect(world.resourceLedger.settle(held!, { damage: 3 })).toBe(false);
    expect(world.resourceLedger.sourceSnapshot(projectile.id)[0]).toMatchObject({
      id: source,
      payerId: caster.id,
      sessionId: 7,
      effectId: 9,
      paidMana: 10,
      mintedEnergy: 8,
      balance: 5,
    });
    expect(world.refundEntityEnergy(projectile.id)).toBe(5);
    expect(world.refundEntityEnergy(projectile.id)).toBe(5);
    expect(caster.mana).toBe(15);
    expect(world.resourceLedger.snapshot()).toMatchObject({
      conserved: true,
      totals: {
        injectionMana: 10_000_000,
        mintedEnergy: 8_000_000,
        conversionLoss: 2_000_000,
        damage: 3_000_000,
        refundedEnergy: 5_000_000,
      },
    });
    expect(world.resourceLedger.manaAccountSnapshot(caster.id)?.conserved).toBe(true);
  });

  it('运动、伤害、扫描隔离；来源 FIFO 且满额退款转为终止损耗', () => {
    const { world, caster } = setup();
    caster.mana = 30;
    const projectile = world.spawnProjectile({
      faction: 'player',
      ownerId: caster.id,
      x: 120,
      y: 100,
      dx: 1,
      dy: 0,
      speed: 0,
      damage: 0,
    })!;
    const first = world.injectEntityEnergy(projectile.id, caster.id, 'motion', 5)!;
    const second = world.injectEntityEnergy(projectile.id, caster.id, 'motion', 5)!;
    expect(world.injectEntityEnergy(projectile.id, caster.id, 'scan', 2)).not.toBeNull();
    expect(world.resourceLedger.consume(projectile.id, 'damage', 1, 'damage')).toBe(false);
    expect(world.resourceLedger.consume(projectile.id, 'scan', 1, 'scan')).toBe(true);
    const held = world.resourceLedger.reserve(projectile.id, 'motion', 5)!;
    expect(world.resourceLedger.settle(held, { motionWork: 3, controlLoss: 1 })).toBe(true);
    expect(
      world.resourceLedger.sourceSnapshot(projectile.id).find((s) => s.id === first)?.balance,
    ).toBe(0);
    expect(
      world.resourceLedger.sourceSnapshot(projectile.id).find((s) => s.id === second)?.balance,
    ).toBe(4);
    caster.mana = caster.attr.manaMax;
    expect(world.refundEntityEnergy(projectile.id)).toBe(0);
    expect(world.resourceLedger.snapshot()).toMatchObject({
      conserved: true,
      totals: {
        motionWork: 3_000_000,
        controlLoss: 1_000_000,
        scan: 1_000_000,
        terminationLoss: 4_600_000,
      },
    });
  });

  it('VM 用同一付款账本先预检 tick，再扣法力；失败不发布本笔效果', () => {
    const { world, caster } = setup();
    caster.mana = 10;
    const book = parseSpellbook('spell 测试 -> bool { return 实体存在(自身实体()) }');
    const program = compileProgram(book);
    const tooSlow = new VM(program, world, caster, { maxTicks: 1 }).run('测试');
    expect(tooSlow.ok).toBe(false);
    expect(tooSlow.mana).toBe(0);
    expect(caster.mana).toBe(10);
    const first = new VM(program, world, caster).run('测试');
    const second = new VM(program, world, caster).run('测试');
    expect(first.ok && second.ok).toBe(true);
    expect(caster.mana).toBe(8);
    expect(world.resourceLedger.snapshot().totals.payerMana).toBe(2_000_000);
  });

  it('无 Battle 钩子时并发 VM 仍共享神识容量，释放后才能再保留', () => {
    const { world, caster } = setup();
    caster.attr.shenshiMax = 1;
    const first = {};
    const second = {};
    expect(world.tryReserveVmShenshi(caster.id, first, 1)).toBe(true);
    expect(world.tryReserveVmShenshi(caster.id, second, 1)).toBe(false);
    expect(world.reportVmShenshiUsage(caster.id, first, 0)).toBe(true);
    expect(world.tryReserveVmShenshi(caster.id, second, 1)).toBe(true);
    expect(world.readEntityAuditField(caster.id, 'shenshiUsed')).toMatchObject({
      ok: true,
      value: 1,
    });
  });

  it('法力世界回复与上限裁剪和能量单位分别对账', () => {
    const world = new World();
    const caster = world.spawnActor({
      faction: 'player',
      x: 100,
      y: 100,
      attrs: { manaMax: 10, manaRegen: 2 },
    });
    caster.mana = 5;
    world.tickActor(caster, 0.5);
    expect(caster.mana).toBe(6);
    caster.base.manaMax = 4;
    world.recompute(caster);
    expect(caster.mana).toBe(4);
    expect(world.resourceLedger.manaAccountSnapshot(caster.id)).toMatchObject({
      unit: 'micro',
      regen: 1_000_000,
      clampLoss: 2_000_000,
      conserved: true,
    });
  });

  it('普通直接效果只折扣显式可折扣部分，静态预算覆盖实扣', () => {
    const { world, caster } = setup();
    caster.base.manaCostMul = 0.5;
    world.recompute(caster);
    caster.mana = 100;
    const book = parseSpellbook('spell 攻击 -> bool { return 伤害(自身实体(), 10) }');
    const budget = analyzeBook(book).攻击;
    const result = new VM(compileProgram(book), world, caster).run('攻击');
    expect(result.ok).toBe(true);
    expect(result.mana).toBe(3.5); // 固定 I/O 1 + 可折扣部分 5 × 0.5
    expect(budget.manaWorst).toBeGreaterThanOrEqual(result.mana);
    expect(world.resourceLedger.manaAccountSnapshot(caster.id)?.conserved).toBe(true);
  });
});

describe('统一实体审计合同', () => {
  it('Actor 与 Projectile 只暴露已安装的状态 binding，快照不可反写', () => {
    const { world, caster } = setup();
    const projectile = world.spawnProjectile({
      faction: 'player',
      ownerId: caster.id,
      x: 120,
      y: 100,
      dx: 1,
      dy: 0,
      speed: 380,
      damage: 4,
    })!;
    const read = (id: number, field: Parameters<World['readEntityAuditField']>[1]) =>
      world.readEntityAuditField(id, field);
    expect(read(caster.id, 'position')).toMatchObject({ ok: true, value: { x: 100, y: 100 } });
    expect(read(caster.id, 'velocity')).toMatchObject({ ok: true, value: { x: 0, y: 0 } });
    expect(read(caster.id, 'speedMax')).toMatchObject({ ok: true, value: caster.attr.speed });
    expect(read(caster.id, 'movePower')).toMatchObject({ ok: true, value: 4 });
    expect(read(caster.id, 'hp')).toMatchObject({ ok: true, value: caster.hp });
    expect(read(caster.id, 'manaMax')).toMatchObject({ ok: true, value: caster.attr.manaMax });
    expect(read(caster.id, 'shenshiUsed')).toMatchObject({ ok: true, value: 0 });
    expect(read(caster.id, 'resistances')).toMatchObject({
      ok: true,
      value: expect.objectContaining({ speed: 0, armor: 0 }),
    });
    expect(read(projectile.id, 'velocity')).toMatchObject({ ok: true, value: { x: 380, y: 0 } });
    expect(read(projectile.id, 'ownership')).toMatchObject({
      ok: true,
      value: { ownerId: caster.id },
    });
    expect(read(projectile.id, 'hp')).toEqual({ ok: false, reason: 'unavailable' });
    expect(read(projectile.id, 'mana')).toEqual({ ok: false, reason: 'unavailable' });
    expect(read(projectile.id, 'movePower')).toEqual({ ok: false, reason: 'unavailable' });
    expect(read(projectile.id, 'shenshiUsed')).toEqual({ ok: false, reason: 'unavailable' });
    const position = read(caster.id, 'position');
    if (position.ok) (position.value as { x: number }).x = 999;
    expect(caster.x).toBe(100);
    world.advanceActorMotion(caster, { x: 1, y: 0 }, 1, 0.2);
    const moving = caster.velocity.x;
    caster.attr.speed = 70;
    expect(moving).toBeGreaterThan(130);
    expect(read(caster.id, 'velocity')).toMatchObject({ ok: true, value: { x: moving, y: 0 } });
    expect(read(caster.id, 'speedMax')).toMatchObject({ ok: true, value: 70 });
    world.projectiles = [];
    expect(read(projectile.id, 'position')).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('组合能力实体复用字段合同，缺能力拒绝且句柄不复用', () => {
    const world = new World();
    const state = { x: 4, y: 5, speed: 12 };
    const id = world.registerAuditComposite({
      position: { isAvailable: () => true, read: () => ({ x: state.x, y: state.y }) },
      speedMax: { isAvailable: () => true, read: () => state.speed },
      velocity: {
        isAvailable: () => false,
        read: () => {
          throw new Error('unreachable');
        },
      },
    })!;
    expect(world.readEntityAuditField(id, 'position')).toMatchObject({
      ok: true,
      value: { x: 4, y: 5 },
    });
    state.x = 8;
    expect(world.readEntityAuditField(id, 'position')).toMatchObject({
      ok: true,
      value: { x: 8, y: 5 },
    });
    expect(world.readEntityAuditField(id, 'speedMax')).toMatchObject({ ok: true, value: 12 });
    expect(world.readEntityAuditField(id, 'velocity')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(world.readEntityAuditField(id, 'hp')).toEqual({ ok: false, reason: 'unavailable' });
    world.removeAuditComposite(id);
    expect(world.readEntityAuditField(id, 'position')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(world.registerAuditComposite({})).toBeGreaterThan(id);
  });

  it('组合 binding 不可用无界历史或非法数值绕过审计容量', () => {
    const world = new World();
    const id = world.registerAuditComposite({
      events: {
        isAvailable: () => true,
        read: () => Array(17).fill({ at: 0, type: 'test', summary: 'x' }),
      },
      speedMax: { isAvailable: () => true, read: () => Infinity },
    })!;
    expect(world.readEntityAuditField(id, 'events')).toEqual({ ok: false, reason: 'unavailable' });
    expect(world.readEntityAuditField(id, 'speedMax')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('组合句柄与活跃会话均有硬容量', () => {
    const { world, caster } = setup();
    const composites = Array.from({ length: 64 }, () => world.registerAuditComposite({}));
    expect(composites.every((id) => typeof id === 'number')).toBe(true);
    expect(world.registerAuditComposite({})).toBeNull();
    const sessions = Array.from({ length: 64 }, () =>
      world.createControlSession(caster.id, () => true),
    );
    expect(sessions.every(Boolean)).toBe(true);
    expect(world.createControlSession(caster.id, () => true)).toBeNull();
    sessions[0]!.end();
    expect(world.createControlSession(caster.id, () => true)).not.toBeNull();
  });

  it('会话与事件摘要有界，神识占用和上限分别读取', () => {
    const { world, caster } = setup();
    const session = world.createControlSession(caster.id, () => true)!;
    expect(world.readEntityAuditField(caster.id, 'sessions')).toMatchObject({
      ok: true,
      value: [{ id: session.id, role: 'controller' }],
    });
    expect(world.reportEntityShenshiUsage(caster.id, 9)).toBe(true);
    expect(world.readEntityAuditField(caster.id, 'shenshiUsed')).toMatchObject({
      ok: true,
      value: 9,
    });
    expect(world.readEntityAuditField(caster.id, 'shenshiMax')).toMatchObject({
      ok: true,
      value: caster.attr.shenshiMax,
    });
    expect(world.reportEntityShenshiUsage(caster.id, -1)).toBe(false);
    const firstVm = {};
    const secondVm = {};
    expect(world.reportVmShenshiUsage(caster.id, firstVm, 2)).toBe(true);
    expect(world.reportVmShenshiUsage(caster.id, secondVm, 3)).toBe(true);
    expect(world.readEntityAuditField(caster.id, 'shenshiUsed')).toMatchObject({
      ok: true,
      value: 14,
    });
    expect(world.reportVmShenshiUsage(caster.id, firstVm, 0)).toBe(true);
    expect(world.reportVmShenshiUsage(caster.id, secondVm, 0)).toBe(true);
    expect(world.reportEntityShenshiUsage(caster.id, 0)).toBe(true);
    for (let i = 0; i < 40; i++) world.recordEntityAuditEvent(caster.id, 'test', 'x'.repeat(300));
    const events = world.readEntityAuditField(caster.id, 'events');
    expect(events.ok).toBe(true);
    if (events.ok) {
      const history = events.value as { summary: string }[];
      expect(history).toHaveLength(16);
      expect(history.every((event) => event.summary.length === 160)).toBe(true);
      history.length = 0;
    }
    expect(world.readEntityAuditField(caster.id, 'events')).toMatchObject({
      ok: true,
      value: expect.arrayContaining([{ at: 0, type: 'test', summary: 'x'.repeat(160) }]),
    });
    session.end();
    expect(world.readEntityAuditField(caster.id, 'sessions')).toMatchObject({
      ok: true,
      value: [],
    });
    world.damage(caster.id, 1000);
    expect(world.readEntityAuditField(caster.id, 'hp')).toMatchObject({ ok: true, value: 0 });
    expect(world.readEntityAuditField(caster.id, 'events')).toMatchObject({
      ok: true,
      value: expect.arrayContaining([expect.objectContaining({ type: 'damage' })]),
    });
  });
});

describe('公开统一创建与具名属性入口', () => {
  it.each([1, 2])('旧两参位置也收不可折扣传送高价（倍率 %s）', (multiplier) => {
    const { world, caster } = setup();
    caster.base.manaCostMul = multiplier;
    world.recompute(caster);
    const book = parseSpellbook(`spell 旧位置 -> bool {
      return 设置位置(自身实体(), 向量(100, 100))
    }`);
    caster.mana = 20 * multiplier;
    const result = new VM(compileProgram(book), world, caster).run('旧位置');
    expect(result.ok).toBe(true);
    expect(result.returnValue).toBe(true);
    expect(result.mana).toBe(20);
    expect(world.positionOf(caster.id)).toEqual({ x: 100, y: 100 });
    expect(world.controlRecordSnapshot()).toEqual([]);
  });

  it('旧位置入口余额不足不移动或部分扣款', () => {
    const { world, caster } = setup();
    const book = parseSpellbook(`spell 旧位置 -> bool {
      return 设置位置(自身实体(), 向量(200, 100))
    }`);
    const program = compileProgram(book);
    caster.mana = 29;
    const failed = new VM(program, world, caster).run('旧位置');
    expect(failed.ok).toBe(false);
    expect(failed.mana).toBe(0);
    expect(world.positionOf(caster.id)).toEqual({ x: 100, y: 100 });
    caster.mana = 30;
    const result = new VM(program, world, caster).run('旧位置');
    expect(result.ok).toBe(true);
    expect(result.returnValue).toBe(true);
    expect(result.mana).toBe(30);
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
      expect(world.positionOf(id)).not.toEqual({ x: 240, y: 180 });
    }
    expect(world.events.join(' ')).toMatch(/控制失败.*(?:传送|能力)/);
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
      '设置位置',
    ])
      expect(visible.some((meta) => meta.name === name)).toBe(false);
    expect(visible.some((meta) => meta.name === '传送')).toBe(true);
    expect(visible.some((meta) => meta.name === '施加冲量')).toBe(true);
    for (const name of [
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
    expect(call('传送', caster.id, { x: 130, y: 140 })).toBe(true);
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

describe('六项属性控制与资源边界', () => {
  it('六项控制沿用关系和抗性报价，失败不留下控制层', () => {
    const { world, caster, ctx } = setup();
    const ally = world.spawnActor({ faction: 'player', x: 140, y: 100 });
    const foe = world.spawnActor({ faction: 'foe', x: 160, y: 100 });
    const meta = getMeta('调整生命上限')!;
    const quote = (id: number) =>
      meta.cost!(ctx, [knownCostArg(id), knownCostArg(20), knownCostArg(1)]);
    expect(quote(caster.id).mana.value).toBeLessThan(quote(ally.id).mana.value);
    expect(quote(ally.id).mana.value).toBeLessThan(quote(foe.id).mana.value);
    expect(quote(caster.id).ticks.value).toBeLessThan(quote(foe.id).ticks.value);
    const binding = world.controlPropertyBinding(foe, 'hpMax')!;
    const original = quote(foe.id);
    Object.defineProperty(binding, 'resistance', { value: () => 2 });
    expect(quote(foe.id).mana.value).toBeGreaterThan(original.mana.value);
    expect(quote(foe.id).ticks.value).toBeGreaterThan(original.ticks.value);
    const session = world.createControlSession(caster.id, () => false)!;
    expect(world.applyEntityControl(foe.id, 'hpMax', 20, 1, { session })).toBe(false);
    expect(foe.attr.hpMax).toBe(foe.base.hpMax);
    expect(world.controlRecordSnapshot()).toEqual([]);
  });

  it('六项只由 Actor binding 接受，合成越域和无会话失败且不写余额', () => {
    const { world, caster } = setup();
    const projectile = world.spawnProjectile({
      faction: 'player',
      ownerId: caster.id,
      x: 140,
      y: 100,
      dx: 1,
      dy: 0,
      speed: 100,
      damage: 1,
    })!;
    const session = world.createControlSession(caster.id, () => true)!;
    for (const [name, key, effect] of [
      ['调整生命上限', 'hpMax', 20],
      ['调整法力上限', 'manaMax', 20],
      ['调整法力回复', 'manaRegen', 2],
      ['调整神识上限', 'shenshiMax', 2],
      ['调整施法速度', 'castSpeed', 2],
      ['调整法力消耗', 'manaCostMul', 0.5],
    ] as const) {
      expect(getMeta(name)).toBeDefined();
      expect(world.controlPropertyBinding(caster, key)).not.toBeNull();
      expect(world.controlPropertyBinding(projectile, key)).toBeNull();
      expect(world.applyEntityControl(projectile.id, key, effect, 1, { session })).toBe(false);
      expect(world.applyEntityControl(caster.id, key, effect, 1)).toBe(false);
      expect(world.applyEntityControl(caster.id, key, effect, 1, { session })).toBe(true);
    }
    expect(caster.attr.hpMax).toBe(caster.base.hpMax + 20);
    expect(caster.attr.manaMax).toBe(caster.base.manaMax + 20);
    expect(caster.attr.manaRegen).toBe(caster.base.manaRegen + 2);
    expect(caster.attr.shenshiMax).toBe(caster.base.shenshiMax + 2);
    expect(caster.attr.castSpeed).toBe(2);
    expect(caster.attr.manaCostMul).toBe(0.5);
    const before = world.controlRecordSnapshot();
    expect(world.applyEntityControl(caster.id, 'manaRegen', -100, 1, { session })).toBe(false);
    expect(world.applyEntityControl(caster.id, 'shenshiMax', 0.5, 1, { session })).toBe(false);
    expect(world.applyEntityControl(caster.id, 'castSpeed', 9, 1, { session })).toBe(false);
    expect(world.controlRecordSnapshot()).toEqual(before);
    session.end();
    expect(caster.attr.castSpeed).toBe(1);
    expect(caster.attr.manaCostMul).toBe(1);
  });

  it('上限缩小裁剪但恢复不赠生命或法力，超额神识保留既有占用', () => {
    const { world, caster } = setup();
    caster.hp = 90;
    caster.mana = 100;
    expect(world.reportEntityShenshiUsage(caster.id, 40)).toBe(true);
    const session = world.createControlSession(caster.id, () => true)!;
    expect(world.applyEntityControl(caster.id, 'hpMax', -30, 1, { session })).toBe(true);
    expect(
      world.applyEntityControl(caster.id, 'manaMax', -(caster.attr.manaMax - 50), 1, { session }),
    ).toBe(true);
    expect(caster.hp).toBe(70);
    expect(caster.mana).toBe(50);
    expect(world.resourceLedger.manaAccountSnapshot(caster.id)?.conserved).toBe(true);
    expect(world.applyEntityControl(caster.id, 'shenshiMax', -20, 1, { session })).toBe(true);
    expect(world.readEntityAuditField(caster.id, 'shenshiUsed')).toMatchObject({
      ok: true,
      value: 43,
    });
    expect(world.tryReserveEntityShenshi(caster.id, 1)).toBe(false);
    session.end();
    expect(caster.hp).toBe(70);
    expect(caster.mana).toBe(50);
    expect(world.readEntityAuditField(caster.id, 'shenshiUsed')).toMatchObject({
      ok: true,
      value: 40,
    });
  });

  it('自回蓝和并发回复层先付周期费，降耗不折扣自己的控制账', () => {
    const { world, caster } = setup();
    caster.mana = 100;
    const program = compileProgram(parseSpellbook('spell 保持 { return 1 }'), '保持');
    const first = new VM(program, world, caster, { retainControlSessionOnCompletion: true });
    first.start('保持');
    const second = new VM(program, world, caster, { retainControlSessionOnCompletion: true });
    second.start('保持');
    expect(
      world.applyEntityControl(caster.id, 'manaCostMul', 0.5, 0, { session: first.controlSession }),
    ).toBe(true);
    const discountPrice = controlRecordPrice(world, caster, world.controlRecordSnapshot()[0]);
    expect(first.spentMana).toBeCloseTo(
      discountPrice.mana.value + discountPrice.periodic!.mana.value,
    );
    const ordinary = new VM(
      compileProgram(parseSpellbook('spell 普通 { 伤害(自身实体(), 1) }')),
      world,
      caster,
    ).run('普通');
    expect(ordinary.ok).toBe(true);
    expect(ordinary.mana).toBeGreaterThan(1);
    expect(ordinary.mana).toBeLessThan(5.1);
    expect(
      world.applyEntityControl(caster.id, 'manaRegen', 20, 0, { session: first.controlSession }),
    ).toBe(true);
    expect(
      world.applyEntityControl(caster.id, 'manaRegen', 20, 0, { session: second.controlSession }),
    ).toBe(true);
    const regenRecords = world
      .controlRecordSnapshot()
      .filter((record) => record.propertyKey === 'manaRegen');
    expect(regenRecords).toHaveLength(2);
    for (const record of regenRecords)
      expect(controlRecordPrice(world, caster, record).periodic!.mana.value).toBeGreaterThanOrEqual(
        6,
      );
    const before = caster.mana;
    world.tickActor(caster, 0.25);
    expect(caster.mana - before).toBeLessThanOrEqual(caster.base.manaRegen * 0.25 + 10);
    const paid = caster.mana;
    world.advanceControlTime(0.25);
    expect(caster.mana).toBeLessThan(paid - 10);
    expect(world.resourceLedger.manaAccountSnapshot(caster.id)?.conserved).toBe(true);
    first.controlSession!.end();
    second.controlSession!.end();
  });

  it('提速只改变有效属性，不抹除已欠的 VM tick', () => {
    const { world, caster } = setup();
    const program = compileProgram(parseSpellbook('spell 保持 { return 1 }'), '保持');
    const vm = new VM(program, world, caster, { retainControlSessionOnCompletion: true });
    vm.start('保持');
    expect(world.applyEntityControl(caster.id, 'speed', 2, 0, { session: vm.controlSession })).toBe(
      true,
    );
    const debt = vm.pendingTickDebt;
    expect(debt).toBeGreaterThan(0);
    const session = world.createControlSession(caster.id, () => true)!;
    expect(world.applyEntityControl(caster.id, 'castSpeed', 2, 1, { session })).toBe(true);
    expect(caster.attr.castSpeed).toBe(2);
    expect(vm.pendingTickDebt).toBe(debt);
    vm.advance(1);
    expect(vm.pendingTickDebt).toBe(debt - 1);
    session.end();
    vm.controlSession!.end();
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

  it('位置属性写入被拒，独立传送保留提交语义', () => {
    const { world, caster } = setup();
    const program = compileProgram(parseSpellbook('spell 测试 { return 1 }'), '测试');
    const vm = new VM(program, world, caster);
    vm.start('测试');
    const to = { x: 140, y: 100 };
    expect(
      world.applyEntityControl(caster.id, 'position', to, 0, { session: vm.controlSession }),
    ).toBe(false);
    expect(world.teleportEntity(caster.id, to, vm.controlSession!.canControl)).toBe(true);
    expect(vm.spentMana).toBe(0);
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
    expect(world.applyEntityControl(projectile.id, 'position', { x: 200, y: 220 }, 0)).toBe(false);
    expect(world.teleportEntity(projectile.id, { x: 200, y: 220 })).toBe(true);
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
      'hpMax',
      'manaMax',
      'manaRegen',
      'shenshiMax',
      'castSpeed',
      'manaCostMul',
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
    expect(world.teleportEntity(projectile.id, { x: Number.MAX_VALUE, y: Number.MAX_VALUE })).toBe(
      false,
    );
    expect(world.positionOf(projectile.id)).toEqual({ x: before.x, y: before.y });
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
    expect(call('探查', id)).toBeNull();
    expect(call('读取位置', id)).toEqual({ ok: false, reason: 'unavailable' });
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
    const { world, caster, call } = setup();
    const foe = world.spawnActor({ faction: 'foe', x: 140, y: 100 });
    const projectileId = call('创建弹道', 5) as number;
    const projectile = world.entityById(projectileId)!;
    const projectileBefore = structuredClone(projectile);

    expect(call('生命', foe.id)).toBeNull();
    expect(call('生命', projectileId)).toBeNull();
    expect(call('生命', 999999)).toBeNull();
    expect(call('读取生命', foe.id)).toEqual({ ok: false, reason: 'unavailable' });
    world.grantSenseField(caster.id, foe.id, 'hp', {
      shenshiUpperBound: foe.attr.shenshiMax,
      resistanceUpperBound: 0,
    });
    expect(call('读取生命', foe.id)).toMatchObject({ ok: true, value: foe.hp });
    expect(call('读取生命', projectileId)).toEqual({ ok: false, reason: 'unavailable' });
    expect(call('读取生命', 999999)).toEqual({ ok: false, reason: 'unavailable' });

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
    const probe = getMeta('读取位置')!;
    const near = probe.cost!(ctx, [knownCostArg(id)]).mana.value;
    target.x += 200;
    expect(probe.cost!(ctx, [knownCostArg(id)]).mana.value).toBeGreaterThan(near);
    target.x += 10000;
    expect(probe.cost!(ctx, [knownCostArg(id)]).mana.value).toBe(1);
    expect(call('读取位置', id)).toEqual({ ok: false, reason: 'unavailable' });
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
    const activationEnergyMana = (2 * (600 / 380) ** 2) / 0.8;
    expect(budget.manaBudget.dynamic).toBe(true);
    expect(result.mana).toBeCloseTo(budget.manaWorst + activationEnergyMana);
    expect(result.ticks).toBe(budget.tickWorst + Math.ceil(2 * (600 / 380) ** 2));
    expect(result.ticks).toBeGreaterThan(7);
  });

  it('旧位置入口按关系收取传送费用并检查落点', () => {
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
    expect(call('设置位置', hostileProjectile.id, { x: 500, y: 260 })).toBe(false);
    expect(call('设置位置', hostileProjectile.id, { x: 550, y: 260 })).toBe(true);
    expect(world.positionOf(foe.id)).toEqual({ x: 500, y: 260 });
    expect(world.positionOf(hostileProjectile.id)).toEqual({ x: 550, y: 260 });
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
    // 可折扣部分按合法倍率上限 4 估算，其余固定尝试价不可折扣。
    const damage = getMeta('伤害')!;
    const fixed = damage.discountableFixedMana!;
    expect(budget.manaBudget.value).toBe(fixed + (damage.mana - fixed) * 4);
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

describe('逐属性探查授权与公开报价', () => {
  it('字段授权、可见性、距离和能力拒绝都返回同一结果与尝试价', () => {
    const { world, caster, ctx, call } = setup();
    const foe = world.spawnActor({ faction: 'foe', x: 150, y: 100 });
    const meta = getMeta('读取生命')!;
    const price = () => meta.cost!(ctx, [knownCostArg(foe.id)]).mana.value;
    const denied = { ok: false, reason: 'unavailable' };
    expect(call('读取生命', foe.id)).toEqual(denied);
    expect(price()).toBe(1);
    const probe = parseSpellbook('spell 试探 -> bool { return 查询可用(读取生命(空)) }');
    const refused = new VM(compileProgram(probe), world, caster).run('试探');
    expect(refused.ok).toBe(true);
    expect(refused.returnValue).toBe(false);
    expect(refused.mana).toBe(1);
    expect(refused.log).toEqual([]);
    world.grantSenseField(caster.id, foe.id, 'hp', {
      shenshiUpperBound: 64,
      resistanceUpperBound: 2,
    });
    expect(call('读取生命', foe.id)).toMatchObject({ ok: true, value: foe.hp });
    expect(call('读取法力回复', foe.id)).toEqual(denied);
    const priced = price();
    expect(priced).toBeGreaterThan(1);
    foe.hp = 0;
    foe.attr.shenshiMax = 50;
    expect(price()).toBe(priced);
    expect(call('读取生命', foe.id)).toMatchObject({ ok: true, value: 0 });
    world.setSenseVisibility(foe.id, false);
    expect(call('读取生命', foe.id)).toEqual(denied);
    expect(price()).toBe(1);
    world.setSenseVisibility(foe.id, true, true);
    expect(call('读取生命', foe.id)).toEqual(denied);
    world.setSenseVisibility(foe.id, true);
    foe.x = 10000;
    expect(call('读取生命', foe.id)).toEqual(denied);
    expect(price()).toBe(1);
    expect(call('读取生命', 999999)).toEqual(denied);
    expect(call('读取生命', caster.id)).toMatchObject({ ok: true, value: caster.hp });
    expect(getMeta('读取法力')!.cost!(ctx, [knownCostArg(caster.id)]).mana.value).toBe(1);
  });

  it('弹道和组合实体共用能力路径；零值、抗性上界和扫描过滤可区分', () => {
    const { world, caster, ctx, call } = setup();
    const projectile = world.spawnProjectile({
      faction: 'player',
      ownerId: caster.id,
      x: 120,
      y: 100,
      dx: 1,
      dy: 0,
      speed: 10,
      damage: 0,
    })!;
    const composite = world.registerAuditComposite({
      position: { isAvailable: () => true, read: () => ({ x: 120, y: 100 }) },
      hp: { isAvailable: () => true, read: () => 0 },
    })!;
    expect(call('读取位置', projectile.id)).toMatchObject({ ok: true, value: { x: 120, y: 100 } });
    expect(call('读取存活时间', projectile.id)).toEqual({ ok: false, reason: 'unavailable' });
    world.grantSenseField(caster.id, projectile.id, 'lifetime', {
      shenshiUpperBound: 0,
      resistanceUpperBound: 0,
    });
    expect(call('读取存活时间', projectile.id)).toMatchObject({ ok: true, value: projectile.life });
    expect(call('读取位置', composite)).toMatchObject({ ok: true, value: { x: 120, y: 100 } });
    expect(call('读取生命', projectile.id)).toEqual({ ok: false, reason: 'unavailable' });
    world.grantSenseField(caster.id, composite, 'hp', {
      shenshiUpperBound: 48,
      resistanceUpperBound: 0,
      relation: 1,
    });
    const low = getMeta('读取生命')!.cost!(ctx, [knownCostArg(composite)]).mana.value;
    expect(call('读取生命', composite)).toMatchObject({ ok: true, value: 0 });
    world.grantSenseField(caster.id, composite, 'hp', {
      shenshiUpperBound: 48,
      resistanceUpperBound: 3,
      relation: 1,
    });
    expect(getMeta('读取生命')!.cost!(ctx, [knownCostArg(composite)]).mana.value).toBeGreaterThan(
      low,
    );
    const foe = world.spawnActor({ faction: 'foe', x: 130, y: 100 });
    world.grantSenseField(caster.id, foe.id, 'position', {
      shenshiUpperBound: 64,
      resistanceUpperBound: 0,
    });
    const hidden = world.spawnActor({ faction: 'foe', x: 140, y: 100 });
    world.setSenseVisibility(hidden.id, false);
    expect(call('扫描敌人', { x: 100, y: 100 }, 100)).toMatchObject({ ok: true, value: [foe.id] });
    expect(call('感知敌人', { x: 100, y: 100 }, 100)).toBeNull();
    expect(call('快照', { x: 100, y: 100 }, 100)).toBeNull();
    expect(call('探查', foe.id)).toBeNull();
    expect(call('生命', foe.id)).toBeNull();
    world.removeAuditComposite(composite);
    expect(call('读取生命', composite)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('查询类型与付费后法力率走 VM，零余额不能先试探权限', () => {
    const { world, caster } = setup();
    const book = parseSpellbook(
      'spell 读取(t: entity) -> num { var q: query<num> = 读取生命(t) if 查询可用(q) { return 查询数值(q) } return 0 }',
    );
    expect(analyzeBook(book).读取.errors).toEqual([]);
    caster.mana = 100;
    caster.base.manaCostMul = 0.5;
    world.recompute(caster);
    const self = parseSpellbook('spell 内视 -> num { return 自身法力率() }');
    const result = new VM(compileProgram(self), world, caster).run('内视');
    expect(result.ok).toBe(true);
    expect(result.mana).toBe(1);
    expect(result.returnValue).toBeCloseTo(99 / caster.attr.manaMax);
    caster.mana = 0;
    const denied = new VM(compileProgram(book), world, caster).run('读取');
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/探查尝试/);
  });
});

describe('显式付费主动监控', () => {
  it('声明目标、字段、频率、次数和本人账户，逐期先付款才更新快照', () => {
    const { world, caster, ctx } = setup();
    const foe = world.spawnActor({ faction: 'foe', x: 150, y: 100 });
    world.grantSenseField(caster.id, foe.id, 'hp', {
      shenshiUpperBound: foe.attr.shenshiMax,
      resistanceUpperBound: 0,
    });
    const request = {
      ownerId: caster.id,
      payerId: caster.id,
      targetId: foe.id,
      field: 'hp' as const,
      intervalSeconds: 0.25,
      periods: 3,
    };
    expect(world.startActiveMonitor({ ...request, payerId: foe.id })).toBeNull();
    expect(world.startActiveMonitor({ ...request, intervalSeconds: 0.1 })).toBeNull();
    expect(world.startActiveMonitor({ ...request, periods: 0 })).toBeNull();
    expect(world.startActiveMonitor({ ...request, field: 'mana' })).toBeNull();
    expect(world.reportEntityShenshiUsage(caster.id, caster.attr.shenshiMax)).toBe(true);
    expect(world.startActiveMonitor(request)).toBeNull();
    world.reportEntityShenshiUsage(caster.id, 0);
    const beforeShenshi = world.readEntityAuditField(caster.id, 'shenshiUsed');
    const id = world.startActiveMonitor(request)!;
    expect(id).toBeGreaterThan(0);
    expect(world.readEntityAuditField(caster.id, 'shenshiUsed')).toMatchObject({
      ok: true,
      value: beforeShenshi.ok ? (beforeShenshi.value as number) + 1 : -1,
    });
    const startMana = caster.mana;
    world.advanceControlTime(0.24);
    expect(world.activeMonitorSnapshot(id, caster.id)?.latest).toBeNull();
    expect(caster.mana).toBe(startMana);
    const price = getMeta('读取生命')!.cost!(ctx, [knownCostArg(foe.id)]);
    world.advanceControlTime(0.01);
    expect(caster.mana).toBeCloseTo(startMana - price.mana.value);
    expect(world.activeMonitorSnapshot(id, caster.id)).toMatchObject({
      paidMana: price.mana.value,
      paidTicks: price.ticks.value,
      remainingPeriods: 2,
      latest: { ok: true, value: foe.hp, observedAt: 0.25 },
    });
    const originalHp = foe.hp;
    foe.hp = originalHp - 7;
    expect(world.activeMonitorSnapshot(id, caster.id)?.latest).toMatchObject({ value: originalHp });
    expect(world.activeMonitorSnapshot(id, foe.id)).toBeNull();
    world.advanceControlTime(0.25);
    expect(world.activeMonitorSnapshot(id, caster.id)).toMatchObject({
      paidTicks: price.ticks.value * 2,
      latest: { value: foe.hp, observedAt: 0.5 },
    });
    expect(world.stopActiveMonitor(id, foe.id)).toBe(false);
    expect(world.stopActiveMonitor(id, caster.id)).toBe(true);
    expect(world.readEntityAuditField(caster.id, 'shenshiUsed')).toMatchObject({
      ok: true,
      value: beforeShenshi.ok ? beforeShenshi.value : -1,
    });
    const stoppedMana = caster.mana;
    world.advanceControlTime(2);
    expect(caster.mana).toBe(stoppedMana);
    expect(world.activeMonitorSnapshot(id, caster.id)).toBeNull();
  });

  it('撤权、隐藏、死亡、目标失效和付款不足立即停止，之后没有扫描', () => {
    const { world, caster } = setup();
    const foe = world.spawnActor({ faction: 'foe', x: 140, y: 100 });
    const grant = () =>
      world.grantSenseField(caster.id, foe.id, 'hp', {
        shenshiUpperBound: foe.attr.shenshiMax,
        resistanceUpperBound: 0,
      });
    const start = (targetId = foe.id, field: 'hp' | 'position' = 'hp') =>
      world.startActiveMonitor({
        ownerId: caster.id,
        payerId: caster.id,
        targetId,
        field,
        intervalSeconds: 0.25,
        periods: 4,
      })!;
    grant();
    const revoked = start();
    world.revokeSenseField(caster.id, foe.id, 'hp');
    expect(world.activeMonitorSnapshot(revoked, caster.id)).toBeNull();
    grant();
    const hidden = start();
    world.setSenseVisibility(foe.id, false);
    expect(world.activeMonitorSnapshot(hidden, caster.id)).toBeNull();
    world.setSenseVisibility(foe.id, true);
    const removed = world.spawnProjectile({
      faction: 'player',
      ownerId: caster.id,
      x: 120,
      y: 100,
      dx: 1,
      dy: 0,
      speed: 1,
      damage: 0,
    })!;
    const targetGone = start(removed.id, 'position');
    world.removeProjectile(removed.id);
    expect(world.activeMonitorSnapshot(targetGone, caster.id)).toBeNull();
    const insufficient = start();
    caster.mana = 1;
    world.advanceControlTime(0.25);
    expect(world.activeMonitorSnapshot(insufficient, caster.id)).toBeNull();
    expect(caster.mana).toBe(1);
    const noScan = world.resourceLedger.snapshot().totals.payerMana;
    world.advanceControlTime(1);
    expect(world.resourceLedger.snapshot().totals.payerMana).toBe(noScan);
    caster.mana = 100;
    const ownerDead = start();
    world.damage(caster.id, caster.hp + 1000);
    expect(world.activeMonitorSnapshot(ownerDead, caster.id)).toBeNull();
    world.advanceControlTime(1);
    expect(world.resourceLedger.snapshot().totals.payerMana).toBe(noScan);
  });

  it('DSL 仅能读取本账户已付款的缓存，离散事件不会推动扫描', () => {
    const { world, caster } = setup();
    const book = parseSpellbook(`spell 开启 -> num {
      return 开启位置监控(自身实体(), 0.25, 3)
    }`);
    const started = new VM(compileProgram(book), world, caster).run('开启');
    expect(started.ok).toBe(true);
    const id = started.returnValue as number;
    expect(id).toBeGreaterThan(0);
    const read = parseSpellbook(`spell 读取 -> num {
      var q: query<vec2> = 读取位置监控(${id})
      if 查询可用(q) { return 查询时刻(q) }
      return 0
    }`);
    const program = compileProgram(read);
    expect(new VM(program, world, caster).run('读取').returnValue).toBe(0);
    world.dispatchWorldEvents();
    expect(world.activeMonitorSnapshot(id, caster.id)?.paidMana).toBe(0);
    world.advanceControlTime(0.25);
    expect(new VM(program, world, caster).run('读取').returnValue).toBe(0.25);
  });
});
