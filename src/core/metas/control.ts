import { T } from '../types';
import {
  asEntity,
  asNum,
  asVec,
  defMeta,
  dynamicCost,
  fixedCost,
  type CostArg,
  type Ctx,
} from '../meta';
import { effectCost, impulseEnergy, isPositiveFinite, teleportPrice } from '../pricing';

function positionCost(
  ctx: Ctx | null,
  args: readonly CostArg[],
  targetIndex: number,
  pointIndex: number,
) {
  const pointArg = args[pointIndex];
  if (!ctx || !pointArg?.known) {
    return { mana: dynamicCost(20), ticks: dynamicCost(4) };
  }
  const point = asVec(pointArg.value);
  const target =
    targetIndex < 0 ? ctx.caster : ctx.world.entityById(asEntity(args[targetIndex]?.value ?? null));
  if (!target || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { mana: fixedCost(1), ticks: fixedCost(1) };
  }
  if (!ctx.world.canTeleportEntity(target.id, point, ctx.controlSession?.canControl))
    return { mana: fixedCost(1), ticks: fixedCost(1) };
  const distance = Math.hypot(point.x - target.x, point.y - target.y);
  const relation = ctx.world.controlCostMultiplier(ctx.caster, target);
  const resistance = ctx.world.controlPropertyBinding(target, 'position')?.resistance() ?? 0;
  return teleportPrice(distance, relation, resistance);
}

/** 操控类：改变世界，收高额法力。伤害统一受「术法威力」属性影响 */
export default function register(): void {
  const N = T.num;
  const V = T.vec2;
  const E = T.entity;

  defMeta({
    name: '发射',
    legacyOnly: true,
    group: '实体创建',
    params: [
      { name: '起点', t: V },
      { name: '方向', t: V },
      { name: '威力', t: N },
    ],
    ret: T.void,
    mana: 10,
    ticks: 2,
    cost: (_ctx, args) => effectCost(args, 10, 2, [{ index: 2, manaPer: 0.15, tickUnit: 80 }]),
    desc: '射出一道飞剑（有飞行时间，可被躲开）；请求威力越高，法力和耗时越高',
    impl: (c, a) => {
      const o = asVec(a[0]);
      const d = asVec(a[1]);
      const power = asNum(a[2]) * c.caster.attr.power;
      const l = Math.hypot(d.x, d.y);
      if (
        !Number.isFinite(o.x) ||
        !Number.isFinite(o.y) ||
        !Number.isFinite(l) ||
        l < 1e-9 ||
        !isPositiveFinite(power)
      )
        return null;
      const dx = d.x / l;
      const dy = d.y / l;
      const projectile = c.world.spawnProjectile({
        faction: c.caster.faction,
        ownerId: c.caster.id,
        x: o.x + dx * (c.caster.radius + 6),
        y: o.y + dy * (c.caster.radius + 6),
        dx,
        dy,
        speed: 380,
        damage: power,
        radius: 7,
        life: 2.4,
      });
      if (projectile) c.world.fx.push({ kind: 'shoot', x: o.x + dx * 16, y: o.y + dy * 16 });
      return null;
    },
  });

  defMeta({
    name: '近战斩击',
    discountableFixedMana: 1,
    group: '实体控制',
    params: [
      { name: '方向', t: V },
      { name: '距离', t: N },
      { name: '伤害', t: N },
    ],
    ret: T.void,
    mana: 6,
    ticks: 2,
    cost: (_ctx, args) =>
      effectCost(args, 6, 2, [
        { index: 1, manaPer: 0.04, tickUnit: 150 },
        { index: 2, manaPer: 0.12, tickUnit: 100 },
      ]),
    desc: '朝方向挥出近战斩击；请求距离与伤害越高，法力和耗时越高',
    impl: (c, a) => {
      const d = asVec(a[0]);
      const dist = asNum(a[1]);
      const dmg = asNum(a[2]) * c.caster.attr.power;
      if (!isPositiveFinite(dist) || !isPositiveFinite(dmg)) return null;
      const o = { x: c.caster.x, y: c.caster.y };
      const hit = c.world.raycast(o, d, dist, 18, c.caster.faction);
      if (hit) {
        c.world.damage(hit.id, dmg, false, c.caster.id);
        c.log.push(`斩击命中 #${hit.id}，造成 ${Math.round(dmg)} 点伤害`);
      } else {
        c.log.push('斩击落空');
      }
      return null;
    },
  });

  defMeta({
    name: '伤害',
    discountableFixedMana: 1,
    group: '实体控制',
    params: [
      { name: '目标', t: E },
      { name: '数值', t: N },
    ],
    ret: T.bool,
    mana: 5,
    ticks: 1,
    cost: (_ctx, args) => effectCost(args, 5, 1, [{ index: 1, manaPer: 0.1, tickUnit: 200 }]),
    desc: '伤害具备生命能力的实体并返回是否成功；数值越高，法力和耗时持续增加，不设人为上限',
    impl: (c, a) => {
      const id = asEntity(a[0]);
      const dmg = asNum(a[1]) * c.caster.attr.power;
      if (!isPositiveFinite(dmg) || !c.world.damage(id, dmg, false, c.caster.id)) return false;
      c.log.push(`对 #${id} 造成 ${Math.round(dmg)} 点伤害`);
      return true;
    },
  });

  defMeta({
    name: '移动',
    legacyOnly: true,
    group: '实体控制',
    params: [
      { name: '方向', t: V },
      { name: '距离', t: N },
    ],
    ret: T.void,
    mana: 3,
    ticks: 1,
    cost: (ctx, args) => {
      const price = effectCost(args, 3, 1, [{ index: 1, manaPer: 0.05, tickUnit: 100 }]);
      if (!ctx || !args[0]?.known || !args[1]?.known) {
        price.mana.dynamic = true;
        price.ticks.dynamic = true;
        return price;
      }
      const direction = asVec(args[0].value);
      const distance = asNum(args[1].value);
      const length = Math.hypot(direction.x, direction.y);
      if (!Number.isFinite(length) || length < 1e-9 || !isPositiveFinite(distance)) return price;
      const energy = impulseEnergy(ctx.caster.velocity, {
        x: (direction.x / length) * distance,
        y: (direction.y / length) * distance,
      });
      price.mana.value += energy / 0.8;
      price.ticks.value += Math.ceil(energy);
      price.undiscountedMana = fixedCost(energy / 0.8);
      return price;
    },
    desc: '旧入口按请求量支付冲量并受主动速度上限约束；新法术请使用施加冲量',
    impl: (c, a) => {
      const d = asVec(a[0]);
      const dist = asNum(a[1]);
      const l = Math.hypot(d.x, d.y);
      if (!Number.isFinite(l) || l < 1e-9 || !isPositiveFinite(dist)) return null;
      c.world.applyImpulse(c.caster.id, { x: (d.x / l) * dist, y: (d.y / l) * dist });
      return null;
    },
  });

  defMeta({
    name: '瞬移',
    legacyOnly: true,
    group: '实体控制',
    params: [{ name: '目标点', t: V }],
    ret: T.void,
    mana: 5,
    ticks: 2,
    cost: (ctx, args) => positionCost(ctx, args, -1, 0),
    desc: '直接挪移自身到指定坐标；实际位移越远，法力和耗时越高',
    impl: (c, a) => {
      const p = asVec(a[0]);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
      if (!c.world.teleportEntity(c.caster.id, p, c.controlSession?.canControl)) return null;
      c.log.push(`瞬移至 (${Math.round(p.x)}, ${Math.round(p.y)})`);
      return null;
    },
  });

  defMeta({
    name: '设置位置',
    legacyOnly: true,
    group: '实体控制',
    params: [
      { name: '目标', t: E },
      { name: '目标点', t: V },
    ],
    ret: T.bool,
    mana: 5,
    ticks: 2,
    cost: (ctx, args) => positionCost(ctx, args, 0, 1),
    desc: '控制任意具备位置能力的实体；敌对 Actor、敌对弹道、友方和自有实体使用不同价格倍率',
    impl: (c, args) => {
      const target = c.world.entityById(asEntity(args[0]));
      const point = asVec(args[1]);
      if (!target || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
      if (!c.world.teleportEntity(target.id, point, c.controlSession?.canControl)) return false;
      c.log.push(`设置 #${target.id} 位置为 (${Math.round(target.x)}, ${Math.round(target.y)})`);
      return true;
    },
  });
}
