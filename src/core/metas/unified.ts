import { T } from '../types';
import { asEntity, asNum, defMeta, getMeta, type CostArg, type Ctx } from '../meta';
import { controlPrice, effectCost, isPositiveFinite } from '../pricing';
import type { ControlPropertyKey } from '../attributes';
import { getControlPropertyDescriptor } from '../attributes';
import type { ControlRecord } from '../world';

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
    legacyParams: legacyCreate ? [legacyCreate.params] : [],
    cost: (ctx, args) =>
      args.length === 1 && legacyCreate?.cost
        ? legacyCreate.cost(ctx, args)
        : effectCost(args, 10, 2, [
            { index: 2, manaPer: 0.01, tickUnit: 300, measure: (value) => Math.abs(value - 380) },
            { index: 3, manaPer: 0.15, tickUnit: 80 },
            { index: 4, manaPer: 2, tickUnit: 2, measure: (value) => Math.abs(value - 2.4) },
          ]),
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
      });
      if (projectile)
        c.world.fx.push({ kind: 'shoot', x: origin.x + dx * 16, y: origin.y + dy * 16 });
      return projectile?.id ?? null;
    },
  });
  for (const [name, key, kind] of controls) {
    defMeta({
      name,
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
