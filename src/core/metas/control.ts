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
import { effectCost, isPositiveFinite } from '../pricing';

function positionCost(
  ctx: Ctx | null,
  args: readonly CostArg[],
  targetIndex: number,
  pointIndex: number,
) {
  const pointArg = args[pointIndex];
  if (!ctx || !pointArg?.known) {
    return { mana: dynamicCost(5), ticks: dynamicCost(2) };
  }
  const point = asVec(pointArg.value);
  const target =
    targetIndex < 0 ? ctx.caster : ctx.world.entityById(asEntity(args[targetIndex]?.value ?? null));
  if (!target || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { mana: fixedCost(5), ticks: fixedCost(2) };
  }
  const distance = Math.hypot(point.x - target.x, point.y - target.y);
  const relation = ctx.world.controlCostMultiplier(ctx.caster, target);
  return {
    mana: fixedCost(5 + (distance / 20) * relation),
    ticks: fixedCost(2 + Math.ceil((distance / 100) * relation)),
  };
}

/** 操控类：改变世界，收高额法力。伤害统一受「术法威力」属性影响 */
export default function register(): void {
  const N = T.num;
  const V = T.vec2;
  const E = T.entity;

  defMeta({
    name: '发射',
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
        c.world.damage(hit.id, dmg);
        c.log.push(`斩击命中 #${hit.id}，造成 ${Math.round(dmg)} 点伤害`);
      } else {
        c.log.push('斩击落空');
      }
      return null;
    },
  });

  defMeta({
    name: '伤害',
    group: '实体控制',
    params: [
      { name: '目标', t: E },
      { name: '数值', t: N },
    ],
    ret: T.void,
    mana: 5,
    ticks: 1,
    cost: (_ctx, args) => effectCost(args, 5, 1, [{ index: 1, manaPer: 0.1, tickUnit: 200 }]),
    desc: '直接对指定单位造成请求伤害；数值越高，法力和耗时持续增加，不设人为上限',
    impl: (c, a) => {
      const id = asEntity(a[0]);
      const dmg = asNum(a[1]) * c.caster.attr.power;
      if (!isPositiveFinite(dmg)) return null;
      if (c.world.damage(id, dmg)) c.log.push(`对 #${id} 造成 ${Math.round(dmg)} 点伤害`);
      return null;
    },
  });

  defMeta({
    name: '移动',
    group: '实体控制',
    params: [
      { name: '方向', t: V },
      { name: '距离', t: N },
    ],
    ret: T.void,
    mana: 3,
    ticks: 1,
    cost: (_ctx, args) => effectCost(args, 3, 1, [{ index: 1, manaPer: 0.05, tickUnit: 100 }]),
    desc: '沿方向瞬时位移；请求距离越远，法力和耗时越高，不设人为上限',
    impl: (c, a) => {
      const d = asVec(a[0]);
      const dist = asNum(a[1]);
      const l = Math.hypot(d.x, d.y);
      if (!Number.isFinite(l) || l < 1e-9 || !isPositiveFinite(dist)) return null;
      c.world.moveActor(c.caster, (d.x / l) * dist, (d.y / l) * dist);
      return null;
    },
  });

  defMeta({
    name: '瞬移',
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
      c.world.placeActor(c.caster, p.x, p.y);
      c.log.push(`瞬移至 (${Math.round(p.x)}, ${Math.round(p.y)})`);
      return null;
    },
  });

  defMeta({
    name: '设置位置',
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
      c.world.placeEntity(target, point.x, point.y);
      c.log.push(`设置 #${target.id} 位置为 (${Math.round(target.x)}, ${Math.round(target.y)})`);
      return true;
    },
  });
}
