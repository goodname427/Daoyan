import { T } from '../types';
import {
  asEntity,
  asList,
  asNum,
  asVec,
  defMeta,
  dynamicCost,
  fixedCost,
  type CostArg,
  type Ctx,
} from '../meta';
import { effectCost } from '../pricing';
import type { Value } from '../types';

/**
 * 感知类：对外查询，法力大头。
 * 这一类的定价直接决定了「批量 I/O vs 逐个 I/O」的权衡是否有意义。
 */
export default function register(): void {
  const N = T.num;
  const V = T.vec2;
  const E = T.entity;

  defMeta({
    name: '自身实体',
    group: '状态探查',
    params: [],
    ret: E,
    mana: 0,
    ticks: 0,
    desc: '返回当前施法者的统一实体句柄。',
    impl: (c) => c.caster.id,
  });

  function distanceCost(
    ctx: Ctx | null,
    args: readonly CostArg[],
    index: number,
    mana: number,
    ticks: number,
  ) {
    const targetArg = args[index];
    if (!ctx || !targetArg?.known) {
      return { mana: dynamicCost(mana), ticks: dynamicCost(ticks) };
    }
    const target = ctx.world.entityById(asEntity(targetArg.value));
    if (!target) return { mana: fixedCost(mana), ticks: fixedCost(ticks) };
    const distance = Math.hypot(target.x - ctx.caster.x, target.y - ctx.caster.y);
    const relation = ctx.world.entityCostMultiplier(ctx.caster, target);
    return {
      mana: fixedCost(mana + (distance / 200) * relation),
      ticks: fixedCost(ticks + Math.ceil((distance / 400) * relation)),
    };
  }

  defMeta({
    name: '自身位置',
    group: '状态探查',
    params: [],
    ret: V,
    mana: 2,
    ticks: 1,
    desc: '内视自身坐标。因为是「内视」而非「外探」，极其廉价——但仍值得缓存',
    impl: (c) => ({ x: c.caster.x, y: c.caster.y }),
  });

  defMeta({
    name: '自身生命',
    group: '状态探查',
    params: [],
    ret: N,
    mana: 1,
    ticks: 1,
    desc: '内视自身当前生命',
    impl: (c) => c.caster.hp,
  });

  defMeta({
    name: '自身法力率',
    group: '状态探查',
    params: [],
    ret: N,
    mana: 0,
    ticks: 1,
    desc: '自身剩余法力占比（0~1）。可用来写法力不足时的退化策略',
    impl: (c) => (c.caster.attr.manaMax <= 0 ? 0 : c.caster.mana / c.caster.attr.manaMax),
  });

  defMeta({
    name: '准星方向',
    group: '状态探查',
    params: [],
    ret: V,
    mana: 0,
    ticks: 1,
    desc: '当前准星方向（玩家由鼠标控制）。让玩家可以写手动瞄准的法术',
    impl: (c) => ({ x: c.caster.aim.x, y: c.caster.aim.y }),
  });

  defMeta({
    name: '感知敌人',
    group: '状态探查',
    params: [
      { name: '中心', t: V },
      { name: '半径', t: N },
    ],
    ret: T.list('entity'),
    mana: 20,
    ticks: 4,
    cost: (_ctx, args) => effectCost(args, 20, 4, [{ index: 1, manaPer: 0.2, tickUnit: 100 }]),
    desc: '一次扫描获得范围内敌方句柄（只含句柄，不含坐标）。半径受「感知」属性影响',
    impl: (c, a) => {
      const r = asNum(a[1]) * c.caster.attr.perception;
      return c.world.inRadius(asVec(a[0]), r, 64, c.caster.faction).map((e) => e.id);
    },
  });

  defMeta({
    name: '探查',
    group: '状态探查',
    params: [{ name: '目标', t: E }],
    ret: V,
    mana: 8,
    cost: (ctx, args) => distanceCost(ctx, args, 0, 8, 2),
    ticks: 2,
    desc: '读取 Actor 或 Projectile 的坐标；距离越远法力和耗时越高，不设人为上限',
    impl: (c, a) => {
      return c.world.positionOf(asEntity(a[0])) ?? { x: 0, y: 0 };
    },
  });

  defMeta({
    name: '快照',
    group: '状态探查',
    params: [
      { name: '中心', t: V },
      { name: '半径', t: N },
    ],
    ret: T.list('vec2'),
    mana: 20,
    ticks: 7,
    cost: (_ctx, args) => effectCost(args, 20, 7, [{ index: 1, manaPer: 0.5, tickUnit: 80 }]),
    desc: '一次 I/O 把范围内所有敌方坐标读入神识。很贵，但之后计算全免费',
    impl: (c, a) => {
      const r = asNum(a[1]) * c.caster.attr.perception;
      return c.world
        .inRadius(asVec(a[0]), r, 64, c.caster.faction)
        .map((e) => ({ x: e.x, y: e.y }) as Value);
    },
  });

  defMeta({
    name: '生命',
    group: '状态探查',
    params: [{ name: '目标', t: E }],
    ret: N,
    mana: 8,
    cost: (ctx, args) => distanceCost(ctx, args, 0, 8, 2),
    ticks: 2,
    desc: '读取具备生命能力的实体当前生命；能力缺失或句柄失效时返回 0',
    impl: (c, a) => {
      const e = c.world.entityWithCapability(asEntity(a[0]), 'vitality');
      return e ? e.hp : 0;
    },
  });

  defMeta({
    name: '长度',
    group: '运算符',
    params: [{ name: '列表', t: T.list('any') }],
    ret: N,
    mana: 0,
    ticks: 1,
    desc: '列表真实长度（数据已在神识中，不耗法力）',
    impl: (_c, a) => asList(a[0]).length,
  });
}
