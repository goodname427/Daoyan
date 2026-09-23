import { T, type QueryValue, type Value } from '../types';
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
import { effectCost, SENSE_ATTEMPT_PRICE, sensePrice } from '../pricing';
import type { EntityAuditField } from '../world';

const unavailable: QueryValue = Object.freeze({ ok: false, reason: 'unavailable' });
const isQuery = (value: Value): value is QueryValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && 'ok' in value;

function queryCost(ctx: Ctx | null, args: readonly CostArg[], field: EntityAuditField) {
  if (!ctx || !args[0]?.known) return { mana: dynamicCost(1), ticks: dynamicCost(1) };
  const quote = ctx.world.senseQuote(ctx.caster, asEntity(args[0].value), field);
  return quote ? sensePrice(quote) : SENSE_ATTEMPT_PRICE;
}

function query(ctx: Ctx, id: number, field: EntityAuditField): QueryValue {
  if (!ctx.world.senseQuote(ctx.caster, id, field)) return unavailable;
  const result = ctx.world.readEntityAuditField(id, field);
  return result.ok
    ? {
        ok: true,
        value: result.value as number | { x: number; y: number } | Value[],
        observedAt: result.observedAt,
        targetId: result.targetId,
        field: result.field,
      }
    : unavailable;
}

export default function register(): void {
  const N = T.num,
    V = T.vec2,
    E = T.entity;
  defMeta({
    name: '自身实体',
    group: '状态探查',
    params: [],
    ret: E,
    mana: 0,
    ticks: 0,
    desc: '当前施法者的统一实体句柄。',
    impl: (c) => c.caster.id,
  });
  defMeta({
    name: '自身位置',
    group: '状态探查',
    params: [],
    ret: V,
    mana: 1,
    ticks: 1,
    attemptMana: 1,
    cost: () => SENSE_ATTEMPT_PRICE,
    desc: '付费内视自身坐标。',
    impl: (c) => (query(c, c.caster.id, 'position').ok ? { x: c.caster.x, y: c.caster.y } : null),
  });
  defMeta({
    name: '自身生命',
    group: '状态探查',
    params: [],
    ret: N,
    mana: 1,
    ticks: 1,
    attemptMana: 1,
    cost: () => SENSE_ATTEMPT_PRICE,
    desc: '付费内视当前生命。',
    impl: (c) => (query(c, c.caster.id, 'hp').ok ? c.caster.hp : null),
  });
  defMeta({
    name: '自身法力率',
    group: '状态探查',
    params: [],
    ret: N,
    mana: 1,
    ticks: 1,
    attemptMana: 1,
    cost: () => SENSE_ATTEMPT_PRICE,
    desc: '本笔扣费完成后的自身法力占比。',
    impl: (c) =>
      c.caster.attr.manaMax <= 0
        ? 0
        : (c.availableMana?.() ?? c.caster.mana) / c.caster.attr.manaMax,
  });
  defMeta({
    name: '准星方向',
    group: '状态探查',
    params: [],
    ret: V,
    mana: 1,
    ticks: 1,
    attemptMana: 1,
    cost: () => SENSE_ATTEMPT_PRICE,
    desc: '付费内视当前准星。',
    impl: (c) => ({ x: c.caster.aim.x, y: c.caster.aim.y }),
  });

  for (const [name, field, kind] of [
    ['读取位置', 'position', 'vec2'],
    ['读取朝向', 'facing', 'vec2'],
    ['读取速度', 'velocity', 'vec2'],
    ['读取速度上限', 'speedMax', 'num'],
    ['读取生命', 'hp', 'num'],
    ['读取生命上限', 'hpMax', 'num'],
    ['读取法力', 'mana', 'num'],
    ['读取法力上限', 'manaMax', 'num'],
    ['读取法力回复', 'manaRegen', 'num'],
    ['读取神识上限', 'shenshiMax', 'num'],
    ['读取神识占用', 'shenshiUsed', 'num'],
    ['读取施法速度', 'castSpeed', 'num'],
    ['读取法力消耗', 'manaCostMul', 'num'],
    ['读取护体', 'armor', 'num'],
    ['读取伤害', 'damage', 'num'],
    ['读取感知', 'perception', 'num'],
    ['读取存活时间', 'lifetime', 'num'],
  ] as const) {
    defMeta({
      name,
      group: '状态探查',
      params: [{ name: '目标', t: E }],
      ret: T.query(kind),
      mana: 1,
      ticks: 1,
      attemptMana: 1,
      cost: (c, a) => queryCost(c, a, field),
      desc: `按能力、授权、可见性与距离读取 ${field}。`,
      impl: (c, a) => query(c, asEntity(a[0]), field),
    });
  }
  defMeta({
    name: '查询可用',
    group: '状态探查',
    params: [{ name: '结果', t: T.any }],
    ret: T.bool,
    mana: 0,
    ticks: 1,
    desc: '显式检查查询成功分支。',
    impl: (_c, a) => isQuery(a[0]) && a[0].ok,
  });
  for (const [name, kind, ret] of [
    ['查询数值', 'num', N],
    ['查询向量', 'vec2', V],
    ['查询实体列表', 'entities', T.list('entity', 64)],
    ['查询坐标列表', 'positions', T.list('vec2', 64)],
  ] as const) {
    defMeta({
      name,
      group: '状态探查',
      params: [{ name: '结果', t: T.query(kind) }],
      ret,
      mana: 0,
      ticks: 1,
      desc: '仅在成功分支提取已付费快照。',
      impl: (_c, a) => {
        const result = a[0];
        if (!isQuery(result) || !result.ok) throw new RangeError('不可探查结果不能取值');
        return result.value;
      },
    });
  }
  defMeta({
    name: '查询时刻',
    group: '状态探查',
    params: [{ name: '结果', t: T.any }],
    ret: N,
    mana: 0,
    ticks: 1,
    desc: '已获准快照的模拟时刻。',
    impl: (_c, a) => {
      const result = a[0];
      if (!isQuery(result) || !result.ok) throw new RangeError('不可探查结果不能取时刻');
      return result.observedAt;
    },
  });

  for (const [name, positions] of [
    ['扫描敌人', false],
    ['扫描坐标', true],
  ] as const) {
    defMeta({
      name,
      group: '状态探查',
      params: [
        { name: '中心', t: V },
        { name: '半径', t: N },
      ],
      ret: T.query(positions ? 'positions' : 'entities'),
      mana: 20,
      ticks: positions ? 7 : 4,
      attemptMana: 1,
      cost: (_c, a) => {
        if (
          a[1]?.known &&
          (typeof a[1].value !== 'number' || !Number.isFinite(a[1].value) || a[1].value < 0)
        )
          return SENSE_ATTEMPT_PRICE;
        if (a[0]?.known) {
          const center = asVec(a[0].value);
          if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return SENSE_ATTEMPT_PRICE;
        }
        const price = effectCost(a, 20, positions ? 7 : 4, [
          { index: 1, manaPer: positions ? 0.5 : 0.2, tickUnit: positions ? 80 : 100 },
        ]);
        return { ...price, undiscountedMana: price.mana };
      },
      desc: '先支付公开预算，再返回最多 64 个逐项获准的敌方结果。',
      impl: (c, a) => {
        const radius = asNum(a[1]),
          center = asVec(a[0]);
        if (
          !Number.isFinite(radius) ||
          radius < 0 ||
          !Number.isFinite(center.x) ||
          !Number.isFinite(center.y)
        )
          return unavailable;
        const reach = radius * c.caster.attr.perception;
        if (!Number.isFinite(reach) || reach < 0) return unavailable;
        const value = c.world
          .hostilesOf(c.caster.faction)
          .filter((target) => Math.hypot(target.x - center.x, target.y - center.y) <= reach)
          .flatMap((target) => {
            const result = query(c, target.id, 'position');
            return result.ok ? [positions ? result.value : target.id] : [];
          })
          .slice(0, 64);
        return {
          ok: true,
          value,
          observedAt: c.world.controlTimeNow,
          targetId: c.caster.id,
          field: name,
        };
      },
    });
  }

  // 监控只保存已逐期付款的最近快照；读取缓存不触发新的世界观察。
  for (const [label, field, kind] of [
    ['位置', 'position', 'vec2'],
    ['生命', 'hp', 'num'],
  ] as const) {
    defMeta({
      name: `开启${label}监控`,
      group: '状态探查',
      params: [
        { name: '目标', t: E },
        { name: '周期秒数', t: N },
        { name: '周期次数', t: N },
      ],
      ret: N,
      mana: 1,
      ticks: 1,
      cost: (ctx, args) => {
        const requested = args[2]?.known ? asNum(args[2].value) : 0;
        const minimum = 1 + (Number.isSafeInteger(requested) && requested > 0 ? requested : 0);
        return {
          mana: ctx ? fixedCost(1) : dynamicCost(minimum),
          ticks: ctx ? fixedCost(1) : dynamicCost(minimum),
        };
      },
      desc: `声明单目标${label}监控；返回正数句柄，失败返回 0。每期另按授权探查价格付款并计 tick，静态总预算动态。`,
      impl: (c, a) =>
        c.world.startActiveMonitor({
          ownerId: c.caster.id,
          payerId: c.caster.id,
          targetId: asEntity(a[0]),
          field,
          intervalSeconds: asNum(a[1]),
          periods: asNum(a[2]),
        }) ?? 0,
    });
    defMeta({
      name: `读取${label}监控`,
      group: '状态探查',
      params: [{ name: '监控句柄', t: N }],
      ret: T.query(kind),
      mana: 0,
      ticks: 1,
      desc: '只读取该账户已付费的最近一次快照；未扫描或已停止时不可用。',
      impl: (c, a) => {
        const snapshot = c.world.activeMonitorSnapshot(asNum(a[0]), c.caster.id);
        const latest = snapshot?.field === field ? snapshot.latest : null;
        return latest?.ok
          ? {
              ok: true,
              value: latest.value as number | { x: number; y: number },
              observedAt: latest.observedAt,
              targetId: latest.targetId,
              field: latest.field,
            }
          : unavailable;
      },
    });
  }
  defMeta({
    name: '关闭主动监控',
    group: '状态探查',
    params: [{ name: '监控句柄', t: N }],
    ret: T.bool,
    mana: 0,
    ticks: 1,
    desc: '仅所属账户能关闭监控，停止后不再扫描或扣费。',
    impl: (c, a) => c.world.stopActiveMonitor(asNum(a[0]), c.caster.id),
  });

  // 旧 AST 的零值/列表返回语义不等价；保留名称供迁移器定位，不再读世界。
  for (const [name, params, ret] of [
    ['探查', [{ name: '目标', t: E }], V],
    ['生命', [{ name: '目标', t: E }], N],
    [
      '感知敌人',
      [
        { name: '中心', t: V },
        { name: '半径', t: N },
      ],
      T.list('entity', 64),
    ],
    [
      '快照',
      [
        { name: '中心', t: V },
        { name: '半径', t: N },
      ],
      T.list('vec2', 64),
    ],
  ] as const) {
    defMeta({
      name,
      legacyOnly: true,
      group: '状态探查',
      params: [...params],
      ret,
      mana: 1,
      ticks: 1,
      attemptMana: 1,
      cost: () => SENSE_ATTEMPT_PRICE,
      desc: '旧读取语义不等价，迁移入口给出定位诊断。',
      impl: () => null,
    });
  }
  defMeta({
    name: '长度',
    group: '运算符',
    params: [{ name: '列表', t: T.list('any') }],
    ret: N,
    mana: 0,
    ticks: 1,
    desc: '已在神识中的列表长度。',
    impl: (_c, a) => asList(a[0]).length,
  });
}
