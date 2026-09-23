import { describe, expect, it } from 'vitest';
import { World, type Actor, type WorldEvent } from '../src/core/world';

function scene() {
  const world = new World();
  const reader = world.spawnActor({ faction: 'player', x: 0, y: 0, attrs: { manaMax: 100000 } });
  const target = world.spawnActor({ faction: 'foe', x: 20, y: 0 });
  const source = world.spawnActor({ faction: 'foe', x: 30, y: 0 });
  const grant = (entity: Actor, field: 'events' | 'position' | 'hp') =>
    world.grantSenseField(reader.id, entity.id, field, {
      shenshiUpperBound: entity.attr.shenshiMax,
      resistanceUpperBound: 0,
    });
  return { world, reader, target, source, grant };
}

describe('审查回归：事件逐订阅者投影', () => {
  it.each(['damage', 'collision', 'disappear'] as const)(
    '%s 不向无权限或越距订阅者暴露事件存在',
    (type) => {
      for (const mode of ['no-grant', 'far', 'hidden', 'occluded', 'allowed']) {
        const { world, reader, target, source, grant } = scene();
        const events: WorldEvent[] = [];
        if (mode !== 'no-grant') grant(target, 'events');
        if (mode === 'far') target.x = 100000;
        if (mode === 'hidden') world.setSenseVisibility(target.id, false);
        if (mode === 'occluded') world.setSenseVisibility(target.id, true, true);
        world.subscribeEvent(reader.id, 'observe', type, (event) => events.push(event));
        if (type === 'collision')
          world.commitActorContacts([{ sourceId: source.id, targetId: target.id, x: 20, y: 0 }]);
        else world.damage(target.id, type === 'disappear' ? 999 : 1, false, source.id);
        world.dispatchWorldEvents();
        expect(events).toHaveLength(mode === 'allowed' ? 1 : 0);
        if (mode === 'allowed') {
          expect(events[0].summary).toEqual({});
          expect(events[0].sourceId).toBe(type === 'disappear' ? target.id : null);
        }
      }
    },
  );

  it('自身受击保留必要摘要，隐藏来源变为不透明句柄且不能用于筛选', () => {
    const { world, reader, source } = scene();
    world.setSenseVisibility(source.id, false);
    const events: WorldEvent[] = [];
    let filtered = 0;
    world.subscribeEvent(reader.id, 'self', 'damage', (event) => events.push(event));
    world.subscribeEvent(reader.id, 'probe', 'damage', () => filtered++, { sourceId: source.id });
    world.damage(reader.id, 3, false, source.id);
    world.dispatchWorldEvents();
    expect(filtered).toBe(0);
    expect(events[0]).toMatchObject({
      sourceId: null,
      targetId: reader.id,
      summary: { amount: 3, x: 0, y: 0 },
    });
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(Object.isFrozen(events[0].summary)).toBe(true);
  });

  it.each(['grant', 'range', 'hidden', 'occluded'] as const)('派发前 %s 失效会取消响应', (mode) => {
    const { world, reader, target, grant } = scene();
    grant(target, 'events');
    let calls = 0;
    world.subscribeEvent(reader.id, 'observer', 'damage', () => calls++);
    world.damage(target.id, 1);
    if (mode === 'grant') world.revokeSenseField(reader.id, target.id, 'events');
    if (mode === 'range') reader.x = 100000;
    if (mode === 'hidden') world.setSenseVisibility(target.id, false);
    if (mode === 'occluded') world.setSenseVisibility(target.id, true, true);
    world.dispatchWorldEvents();
    expect(calls).toBe(0);
  });

  it('提交后新增权限不补字段，撤销权限只删字段；每位读者得到独立摘要', () => {
    const { world, reader, target, source, grant } = scene();
    grant(target, 'events');
    grant(target, 'hp');
    const events: WorldEvent[] = [];
    const own: WorldEvent[] = [];
    world.subscribeEvent(reader.id, 'observer', 'damage', (event) => events.push(event));
    world.subscribeEvent(target.id, 'self', 'damage', (event) => own.push(event));
    world.damage(target.id, 2, false, source.id);
    grant(target, 'position');
    grant(source, 'events');
    world.revokeSenseField(reader.id, target.id, 'hp');
    world.dispatchWorldEvents();
    expect(events[0]).toMatchObject({ sourceId: null, summary: {} });
    expect(own[0].summary).toEqual({ amount: 2, x: 20, y: 0 });
    grant(target, 'hp');
    world.damage(target.id, 2, false, source.id);
    target.x = 40;
    world.dispatchWorldEvents();
    expect(events[1]).toMatchObject({ sourceId: source.id, summary: { amount: 2, x: 20, y: 0 } });
  });

  it('提交时无事件权限，派发前授权仍不追收', () => {
    const { world, reader, target, grant } = scene();
    let calls = 0;
    world.subscribeEvent(reader.id, 'observer', 'damage', () => calls++);
    world.damage(target.id, 1);
    grant(target, 'events');
    world.dispatchWorldEvents();
    expect(calls).toBe(0);
  });

  it('造成伤害不自动授予对隐藏目标的事件观察权', () => {
    const { world, reader, target } = scene();
    world.setSenseVisibility(target.id, false);
    let calls = 0;
    world.subscribeEvent(reader.id, 'probe', 'damage', () => calls++);
    world.damage(target.id, 1, false, reader.id);
    world.dispatchWorldEvents();
    expect(calls).toBe(0);
  });

  it('来源在提交时获准但派发前撤权，筛选不能继续匹配真实来源', () => {
    const { world, reader, target, source, grant } = scene();
    grant(target, 'events');
    grant(source, 'events');
    let filtered = 0;
    const events: WorldEvent[] = [];
    world.subscribeEvent(reader.id, 'observer', 'damage', (event) => events.push(event));
    world.subscribeEvent(reader.id, 'filtered', 'damage', () => filtered++, {
      sourceId: source.id,
    });
    world.damage(target.id, 1, false, source.id);
    world.revokeSenseField(reader.id, source.id, 'events');
    world.dispatchWorldEvents();
    expect(filtered).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0].sourceId).toBeNull();
  });

  it('已移除法球的消失摘要仍复核距离和授权', () => {
    const { world, reader } = scene();
    const p = projectile(world, reader);
    world.grantSenseField(reader.id, p.id, 'events', {
      shenshiUpperBound: 0,
      resistanceUpperBound: 0,
    });
    let calls = 0;
    world.subscribeEvent(reader.id, 'observer', 'disappear', () => calls++);
    world.removeProjectile(p.id);
    world.revokeSenseField(reader.id, p.id, 'events');
    world.dispatchWorldEvents();
    expect(calls).toBe(0);
  });
});

function projectile(world: World, owner: Actor) {
  return world.spawnProjectile({
    faction: owner.faction,
    ownerId: owner.id,
    x: 10,
    y: 0,
    dx: 1,
    dy: 0,
    speed: 300,
    damage: 0,
  })!;
}

describe('审查回归：控制者死亡撤销主动行为', () => {
  it('周期入口也拒绝已失效控制者，不依赖死亡清理被调用', () => {
    const { world, reader } = scene();
    const p = projectile(world, reader);
    p.velocity = { x: 10, y: 0 };
    world.injectEntityEnergy(p.id, reader.id, 'motion', 10);
    world.configureProjectileBehavior(reader.id, p.id, 'thrust', { x: 20, y: 0 });
    reader.alive = false;
    const pools = world.resourceLedger.balance(p.id);
    world.advanceProjectileMotion(p, 0.25);
    expect(p.velocity.x).toBeCloseTo(10 * Math.exp(-0.125));
    expect(world.resourceLedger.balance(p.id)).toEqual(pools);
    expect(p.behavior).toBe('glide');
  });
  it.each(['thrust', 'track'] as const)('%s 在死亡后保留惯性但不再消耗运动/扫描池', (behavior) => {
    const { world, reader, target, grant } = scene();
    grant(target, 'position');
    const p = projectile(world, reader);
    p.velocity = { x: 10, y: 0 };
    world.injectEntityEnergy(p.id, reader.id, 'motion', 10);
    world.injectEntityEnergy(p.id, reader.id, 'scan', 10);
    world.configureProjectileBehavior(reader.id, p.id, behavior, { x: 20, y: 0 }, target.id);
    world.advanceProjectileMotion(p, 0.1);
    world.damage(reader.id, 9999);
    const pools = world.resourceLedger.balance(p.id);
    const velocity = p.velocity.x;
    const x = p.x;
    expect(p.behavior).toBe('glide');
    expect(
      world.configureProjectileBehavior(reader.id, p.id, behavior, { x: 20, y: 0 }, target.id),
    ).toBe(false);
    world.advanceProjectileMotion(p, 1);
    expect(p.x).toBeGreaterThan(x);
    expect(p.velocity.x).toBeCloseTo(velocity * Math.exp(-0.5));
    expect(world.resourceLedger.balance(p.id)).toEqual(pools);
    expect(world.resourceLedger.snapshot().conserved).toBe(true);
  });
});

describe('审查回归：账本活跃容量回收', () => {
  it('超过 4096 次串行预留/结算后仍可继续，旧预留无法重放', () => {
    const { world, reader } = scene();
    const ledger = world.resourceLedger;
    world.injectEntityEnergy(reader.id, reader.id, 'motion', 10000);
    let first = 0;
    for (let i = 0; i < 4100; i++) {
      const id = ledger.reserve(reader.id, 'motion', 1)!;
      expect(id).not.toBeNull();
      if (i === 0) first = id;
      expect(ledger.settle(id, { motionWork: 1 })).toBe(true);
    }
    expect(ledger.settle(first, { motionWork: 1 })).toBe(false);
    expect(ledger.snapshot()).toMatchObject({ reservations: 0, conserved: true });
    expect(ledger.balance(reader.id).motion).toBe(3900);
  });

  it('耗尽来源被回收，同一实体可持续注入/做功且累计账守恒', () => {
    const { world, reader } = scene();
    const ledger = world.resourceLedger;
    for (let i = 0; i < 4100; i++) {
      expect(world.injectEntityEnergy(reader.id, reader.id, 'motion', 1.25)).not.toBeNull();
      expect(ledger.consume(reader.id, 'motion', 1, 'motionWork')).toBe(true);
    }
    expect(ledger.snapshot()).toMatchObject({ sources: 0, reservations: 0, conserved: true });
    expect(ledger.sourceSnapshot(reader.id).length).toBeLessThanOrEqual(128);
    expect(ledger.manaAccountSnapshot(reader.id)?.conserved).toBe(true);
  });

  it('超过 4096 次创建/移除和退款后，旧终结凭证仍幂等且不能重新注能', () => {
    const { world, reader } = scene();
    const ledger = world.resourceLedger;
    let first = 0;
    let oldReservation = 0;
    for (let i = 0; i < 4100; i++) {
      const p = projectile(world, reader);
      if (i === 0) first = p.id;
      expect(world.injectEntityEnergy(p.id, reader.id, 'motion', 1.25)).not.toBeNull();
      const reserved = ledger.reserve(p.id, 'motion', 0.5)!;
      if (i === 0) oldReservation = reserved;
      expect(world.removeProjectile(p.id)).toBe(true);
      world.dispatchWorldEvents();
    }
    const mana = reader.mana;
    expect(world.refundEntityEnergy(first)).toBe(1);
    expect(reader.mana).toBe(mana);
    expect(ledger.settle(oldReservation, { motionWork: 0.5 })).toBe(false);
    expect(ledger.reserve(first, 'motion', 0.1)).toBeNull();
    expect(world.injectEntityEnergy(first, reader.id, 'motion', 1)).toBeNull();
    expect(ledger.snapshot()).toMatchObject({ sources: 0, reservations: 0, conserved: true });
    expect(ledger.manaAccountSnapshot(reader.id)?.conserved).toBe(true);
  });

  it('容量限制仍约束同时存续的来源和预留，释放后立即恢复容量', () => {
    const { world, reader } = scene();
    const ledger = world.resourceLedger;
    for (let i = 0; i < 4096; i++)
      expect(world.injectEntityEnergy(reader.id, reader.id, 'motion', 1.25)).not.toBeNull();
    expect(ledger.canInjectBatch(reader.id, reader.id, [{ pool: 'motion', mana: 1.25 }])).toBe(
      false,
    );
    expect(world.injectEntityEnergy(reader.id, reader.id, 'motion', 1.25)).toBeNull();
    const reservations = Array.from({ length: 4096 }, () =>
      ledger.reserve(reader.id, 'motion', 0.5)!,
    );
    expect(reservations.every((id) => id !== null)).toBe(true);
    expect(ledger.reserve(reader.id, 'motion', 0.5)).toBeNull();
    expect(ledger.settle(reservations[0], {})).toBe(true);
    expect(ledger.reserve(reader.id, 'motion', 0.5)).not.toBeNull();
    world.refundEntityEnergy(reader.id);
    expect(ledger.snapshot()).toMatchObject({ sources: 0, reservations: 0, conserved: true });
    expect(world.injectEntityEnergy(reader.id, reader.id, 'motion', 1.25)).toBeNull();
    const p = projectile(world, reader);
    expect(world.injectEntityEnergy(p.id, reader.id, 'motion', 1.25)).not.toBeNull();
  });
});
