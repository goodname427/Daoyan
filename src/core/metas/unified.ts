import { T } from '../types';
import { asEntity, asNum, defMeta, getMeta, type CostArg, type Ctx } from '../meta';
import { controlPrice, effectCost, isPositiveFinite, teleportPrice } from '../pricing';
import { RESOURCE_SCALE } from '../ledger';
import type { ControlPropertyKey } from '../attributes';
import { getControlPropertyDescriptor } from '../attributes';
import type { ControlRecord } from '../world';

const projectileFundingMana = (energy: number): number =>
  Math.ceil((energy / 0.8) * RESOURCE_SCALE + 2) / RESOURCE_SCALE;
const initialMotionSpend = (speed: number): number =>
  (2 * Math.ceil((speed / 380) ** 2 * RESOURCE_SCALE)) / RESOURCE_SCALE;

function finiteVec(value: unknown): value is { x: number; y: number } {
  if (typeof value !== 'object' || value === null) return false;
  const point = value as { x?: unknown; y?: unknown };
  return (
    typeof point.x === 'number' &&
    typeof point.y === 'number' &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y)
  );
}

const controls: Array<[string, ControlPropertyKey, typeof T.num | typeof T.vec2]> = [
  ['设置位置', 'position', T.vec2],
  ['设置朝向', 'rotation', T.vec2],
  ['调整速度', 'speed', T.num],
  ['强化伤害', 'damage', T.num],
  ['设置存活时间', 'lifetime', T.num],
  ['调整感知', 'perception', T.num],
  ['调整护体', 'armor', T.num],
  ['调整生命上限', 'hpMax', T.num],
  ['调整法力上限', 'manaMax', T.num],
  ['调整法力回复', 'manaRegen', T.num],
  ['调整神识上限', 'shenshiMax', T.num],
  ['调整施法速度', 'castSpeed', T.num],
  ['调整法力消耗', 'manaCostMul', T.num],
];

function price(ctx: Ctx | null, args: readonly CostArg[], key: ControlPropertyKey) {
  const duration = args[2]?.known && typeof args[2].value === 'number' ? args[2].value : null;
  const rejected = () =>
    controlPrice({
      relation: 1,
      resistance: 0,
      strength: 0,
      duration: 0,
      mode: 'write',
      writePolicy: 'commit',
    });
  if (!ctx || !args[0]?.known || !args[1]?.known) {
    return controlPrice({
      propertyKey: key,
      relation: null,
      resistance: null,
      strength: null,
      duration,
      mode: null,
      writePolicy: null,
    });
  }
  if (duration === null || !Number.isFinite(duration) || duration < 0) return rejected();
  const effect = getControlPropertyDescriptor(key)?.normalize(args[1].value);
  if (effect === null || effect === undefined) return rejected();
  const targetId = asEntity(args[0].value);
  const target = ctx.world.entityById(targetId);
  const binding = target && ctx.world.controlPropertyBinding(target, key);
  if (!target || !binding) {
    return rejected();
  }
  const record: ControlRecord = {
    targetId,
    propertyKey: key,
    effect,
    mode: binding.mode,
    writePolicy: binding.writePolicy,
    expiresAt: duration ? ctx.world.controlTimeNow + duration : null,
    controllerId: ctx.caster.id,
    controllerSessionId: ctx.controlSession?.id ?? null,
    sequence: -1,
    paidPeriods: 0,
    nextPaymentAt: null,
  };
  let strength: number;
  try {
    strength = ctx.world.controlEffectStrength(record);
  } catch {
    return rejected();
  }
  return controlPrice({
    propertyKey: key,
    relation: ctx.world.entityCostMultiplier(ctx.caster, target),
    resistance: binding.resistance(),
    strength,
    duration,
    mode: binding.mode,
    writePolicy: binding.writePolicy,
  });
}

export default function register(): void {
  const legacyCreate = getMeta('创建弹道');
  const legacyPosition = getMeta('设置位置');
  defMeta({
    name: '传送',
    group: '实体控制',
    params: [
      { name: '目标', t: T.entity },
      { name: '落点', t: T.vec2 },
    ],
    ret: T.bool,
    mana: 20,
    ticks: 4,
    cost: (ctx, args) => {
      if (!ctx || !args[0]?.known || !args[1]?.known)
        return { mana: { value: 20, dynamic: true }, ticks: { value: 4, dynamic: true } };
      const target = ctx.world.entityById(asEntity(args[0].value));
      const point = args[1].value;
      if (!target || !finiteVec(point))
        return { mana: { value: 1, dynamic: false }, ticks: { value: 1, dynamic: false } };
      if (!ctx.world.canTeleportEntity(target.id, point, ctx.controlSession?.canControl))
        return { mana: { value: 1, dynamic: false }, ticks: { value: 1, dynamic: false } };
      return teleportPrice(
        Math.hypot(point.x - target.x, point.y - target.y),
        ctx.world.entityCostMultiplier(ctx.caster, target),
        ctx.world.controlPropertyBinding(target, 'position')?.resistance() ?? 0,
      );
    },
    desc: '独立高价传送，检查能力、权限、边界和落点；保留当前速度。',
    impl: (ctx, args) => {
      const targetId = asEntity(args[0]);
      const point = args[1];
      if (!finiteVec(point)) return false;
      return ctx.world.teleportEntity(targetId, point, ctx.controlSession?.canControl);
    },
  });
  defMeta({
    name: '创建弹道',
    group: '实体创建',
    params: [
      { name: '起点', t: T.vec2 },
      { name: '方向', t: T.vec2 },
      { name: '速度', t: T.num },
      { name: '基础伤害', t: T.num },
      { name: '存活时间', t: T.num },
    ],
    ret: T.entity,
    mana: 10,
    ticks: 2,
    worldCharged: (args) => args.length === 5,
    worldChargedTicks: true,
    legacyParams: legacyCreate ? [legacyCreate.params] : [],
    cost: (ctx, args) => {
      if (args.length === 1 && legacyCreate?.cost) return legacyCreate.cost(ctx, args);
      const base = effectCost(args, 10, 2, [
        { index: 2, manaPer: 0.01, tickUnit: 300, measure: (value) => Math.abs(value - 380) },
        { index: 3, manaPer: 0.15, tickUnit: 80 },
        { index: 4, manaPer: 2, tickUnit: 2, measure: (value) => Math.abs(value - 2.4) },
      ]);
      const speed = args[2];
      const baseDamage = args[3];
      if (
        !speed?.known ||
        typeof speed.value !== 'number' ||
        !baseDamage?.known ||
        typeof baseDamage.value !== 'number' ||
        !ctx
      ) {
        base.mana.dynamic = true;
        base.ticks.dynamic = true;
      } else if (Number.isFinite(speed.value) && Number.isFinite(baseDamage.value)) {
        const energy = initialMotionSpend(speed.value);
        const damage = baseDamage.value * ctx.caster.attr.power;
        if (!Number.isFinite(energy)) throw new RangeError('初始冲量价格溢出');
        if (!Number.isFinite(damage)) throw new RangeError('伤害储能价格溢出');
        const injected =
          projectileFundingMana(Math.max(0, energy)) + projectileFundingMana(Math.max(0, damage));
        base.mana.value += injected;
        base.ticks.value += Math.ceil(energy);
        base.undiscountedMana = { value: injected, dynamic: false };
      }
      return base;
    },
    desc: '在指定起点按方向创建已激活弹道，返回统一实体句柄。',
    impl: (c, args) => {
      if (args.length === 1 && legacyCreate) return legacyCreate.impl(c, args);
      if (args.length !== 5 || !finiteVec(args[0])) return null;
      const origin = args[0];
      const direction = getControlPropertyDescriptor('rotation')!.normalize(args[1]);
      if (!finiteVec(direction)) return null;
      const speed = asNum(args[2]);
      const baseDamage = asNum(args[3]);
      const life = asNum(args[4]);
      const damage = baseDamage * c.caster.attr.power;
      if (
        !isPositiveFinite(speed) ||
        !isPositiveFinite(baseDamage) ||
        !isPositiveFinite(damage) ||
        !isPositiveFinite(life)
      )
        return null;
      const dx = direction.x;
      const dy = direction.y;
      const x = origin.x + dx * (c.caster.radius + 6);
      const y = origin.y + dy * (c.caster.radius + 6);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const basePrice = effectCost(
        args.map((value) => ({ known: true, value })),
        10,
        2,
        [
          { index: 2, manaPer: 0.01, tickUnit: 300, measure: (value) => Math.abs(value - 380) },
          { index: 3, manaPer: 0.15, tickUnit: 80 },
          { index: 4, manaPer: 2, tickUnit: 2, measure: (value) => Math.abs(value - 2.4) },
        ],
      ).mana.value;
      const motionEnergy = initialMotionSpend(speed);
      const motionMana = projectileFundingMana(motionEnergy);
      const damageMana = projectileFundingMana(damage);
      if (
        ![basePrice, motionMana, damageMana].every(Number.isFinite) ||
        (c.availableMana?.() ?? c.caster.mana) < basePrice + motionMana + damageMana
      )
        return null;
      const projectile = c.world.spawnProjectile({
        faction: c.caster.faction,
        ownerId: c.caster.id,
        x,
        y,
        dx,
        dy,
        speed,
        damage,
        life,
        radius: 7,
        active: false,
      });
      if (!projectile) return null;
      if (
        !c.world.resourceLedger.canInjectBatch(projectile.id, c.caster.id, [
          { pool: 'motion', mana: motionMana },
          { pool: 'damage', mana: damageMana },
        ])
      ) {
        c.world.projectiles = c.world.projectiles.filter((item) => item !== projectile);
        return null;
      }
      const paid = c.world.resourceLedger.payMana(c.caster.id, basePrice, 'projectile-create');
      const motion =
        paid !== null &&
        c.world.injectEntityEnergy(projectile.id, c.caster.id, 'motion', motionMana);
      const damageSource =
        motion && c.world.injectEntityEnergy(projectile.id, c.caster.id, 'damage', damageMana);
      const initialMotion =
        damageSource && c.world.resourceLedger.reserve(projectile.id, 'motion', motionEnergy);
      if (
        !initialMotion ||
        !c.world.resourceLedger.settle(initialMotion, {
          motionWork: motionEnergy / 2,
          controlLoss: motionEnergy / 2,
        })
      ) {
        c.world.refundEntityEnergy(projectile.id);
        c.world.projectiles = c.world.projectiles.filter((item) => item !== projectile);
        return null;
      }
      projectile.active = true;
      projectile.velocity = { x: dx * speed, y: dy * speed };
      projectile.motionSource = 'projectile';
      c.world.fx.push({ kind: 'shoot', x: origin.x + dx * 16, y: origin.y + dy * 16 });
      return projectile.id;
    },
  });
  for (const [name, key, kind] of controls) {
    defMeta({
      name,
      legacyOnly: key === 'position',
      group: '实体控制',
      params: [
        { name: '目标', t: T.entity },
        { name: '效果', t: kind },
        { name: '时间', t: T.num },
      ],
      ret: T.bool,
      mana: 2,
      ticks: 1,
      legacyParams: key === 'position' && legacyPosition ? [legacyPosition.params] : [],
      worldCharged: (args) => args.length === 3,
      cost: (ctx, args) =>
        key === 'position' && args.length === 2 && legacyPosition?.cost
          ? legacyPosition.cost(ctx, args)
          : price(ctx, args, key),
      desc: `通过目标的 ${key} 属性能力施加效果；时间 0 表示无限。`,
      impl: (ctx, args) => {
        // 未规范化的旧 AST 仍由 VM 按旧价格结算，不能再进入会话扣费。
        if (key === 'position' && args.length === 2 && legacyPosition)
          return legacyPosition.impl(ctx, args);
        return args.length === 3 && typeof args[2] === 'number'
          ? ctx.world.applyEntityControl(asEntity(args[0]), key, args[1], asNum(args[2]), {
              session: ctx.controlSession,
              controllerId: ctx.caster.id,
            })
          : false;
      },
    });
  }
}
