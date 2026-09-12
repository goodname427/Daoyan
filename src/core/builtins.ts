import { T } from './types';
import { asBool, asEntity, asList, asNum, asVec, defMeta } from './meta';
import type { Value } from './types';

/**
 * 基础元函数库（基础术式）。
 *
 * 这张表就是整个游戏的 meta 平衡核心，早期请当作可调数据表看待。
 */

const N = T.num;
const B = T.bool;
const V = T.vec2;
const E = T.entity;

// ============================ 运算（神识内，不耗法力） ============================
// 注意：这些也要收「耗时」，否则玩家可以用超长纯计算循环免费获得时间预算。

const arith: Array<[string, string, (a: number, b: number) => number]> = [
  ['加', '加法', (a, b) => a + b],
  ['减', '减法', (a, b) => a - b],
  ['乘', '乘法', (a, b) => a * b],
  ['除', '除法（除数为 0 得 0）', (a, b) => (b === 0 ? 0 : a / b)],
  ['取余', '取余（除数为 0 得 0）', (a, b) => (b === 0 ? 0 : a % b)],
  ['最小', '较小值', (a, b) => Math.min(a, b)],
  ['最大', '较大值', (a, b) => Math.max(a, b)],
];
for (const [name, desc, f] of arith) {
  defMeta({
    name,
    group: '运算',
    params: [
      { name: '甲', t: N },
      { name: '乙', t: N },
    ],
    ret: N,
    mana: 0,
    ticks: 1,
    desc,
    impl: (_c, a) => f(asNum(a[0]), asNum(a[1])),
  });
}

const cmp: Array<[string, string, (a: number, b: number) => boolean]> = [
  ['小于', '严格小于', (a, b) => a < b],
  ['大于', '严格大于', (a, b) => a > b],
  ['小于等于', '小于等于', (a, b) => a <= b],
  ['大于等于', '大于等于', (a, b) => a >= b],
];
for (const [name, desc, f] of cmp) {
  defMeta({
    name,
    group: '运算',
    params: [
      { name: '甲', t: N },
      { name: '乙', t: N },
    ],
    ret: B,
    mana: 0,
    ticks: 1,
    desc,
    impl: (_c, a) => f(asNum(a[0]), asNum(a[1])),
  });
}

defMeta({
  name: '等于',
  group: '运算',
  params: [
    { name: '甲', t: T.any },
    { name: '乙', t: T.any },
  ],
  ret: B,
  mana: 0,
  ticks: 1,
  desc: '相等比较（数值、布尔、实体句柄皆可）',
  impl: (_c, a) => a[0] === a[1],
});

defMeta({
  name: '不等',
  group: '运算',
  params: [
    { name: '甲', t: T.any },
    { name: '乙', t: T.any },
  ],
  ret: B,
  mana: 0,
  ticks: 1,
  desc: '不等比较',
  impl: (_c, a) => a[0] !== a[1],
});

for (const [name, desc, f] of [
  ['与', '逻辑与', (a: boolean, b: boolean) => a && b],
  ['或', '逻辑或', (a: boolean, b: boolean) => a || b],
] as Array<[string, string, (a: boolean, b: boolean) => boolean]>) {
  defMeta({
    name,
    group: '运算',
    params: [
      { name: '甲', t: B },
      { name: '乙', t: B },
    ],
    ret: B,
    mana: 0,
    ticks: 1,
    desc,
    impl: (_c, a) => f(asBool(a[0]), asBool(a[1])),
  });
}

defMeta({
  name: '非',
  group: '运算',
  params: [{ name: '甲', t: B }],
  ret: B,
  mana: 0,
  ticks: 1,
  desc: '逻辑非',
  impl: (_c, a) => !asBool(a[0]),
});

defMeta({
  name: '负',
  group: '运算',
  params: [{ name: '甲', t: N }],
  ret: N,
  mana: 0,
  ticks: 1,
  desc: '取负',
  impl: (_c, a) => -asNum(a[0]),
});

defMeta({
  name: '绝对值',
  group: '运算',
  params: [{ name: '甲', t: N }],
  ret: N,
  mana: 0,
  ticks: 1,
  desc: '绝对值',
  impl: (_c, a) => Math.abs(asNum(a[0])),
});

defMeta({
  name: '取整',
  group: '运算',
  params: [{ name: '甲', t: N }],
  ret: N,
  mana: 0,
  ticks: 1,
  desc: '向下取整',
  impl: (_c, a) => Math.floor(asNum(a[0])),
});

defMeta({
  name: '随机',
  group: '运算',
  params: [{ name: '上限', t: N }],
  ret: N,
  mana: 0,
  ticks: 1,
  desc: '产生 [0, 上限) 内的随机数',
  impl: (_c, a) => Math.random() * asNum(a[0]),
});

// ============================ 向量（神识内运算） ============================

defMeta({
  name: '向量',
  group: '向量',
  params: [
    { name: '横', t: N },
    { name: '纵', t: N },
  ],
  ret: V,
  mana: 0,
  ticks: 1,
  desc: '构造二维向量',
  impl: (_c, a) => ({ x: asNum(a[0]), y: asNum(a[1]) }),
});

defMeta({
  name: '取横',
  group: '向量',
  params: [{ name: '向量', t: V }],
  ret: N,
  mana: 0,
  ticks: 1,
  desc: '取横坐标',
  impl: (_c, a) => asVec(a[0]).x,
});

defMeta({
  name: '取纵',
  group: '向量',
  params: [{ name: '向量', t: V }],
  ret: N,
  mana: 0,
  ticks: 1,
  desc: '取纵坐标',
  impl: (_c, a) => asVec(a[0]).y,
});

defMeta({
  name: '向量加',
  group: '向量',
  params: [
    { name: '甲', t: V },
    { name: '乙', t: V },
  ],
  ret: V,
  mana: 0,
  ticks: 1,
  desc: '向量相加',
  impl: (_c, a) => {
    const p = asVec(a[0]);
    const q = asVec(a[1]);
    return { x: p.x + q.x, y: p.y + q.y };
  },
});

defMeta({
  name: '数乘',
  group: '向量',
  params: [
    { name: '向量', t: V },
    { name: '倍率', t: N },
  ],
  ret: V,
  mana: 0,
  ticks: 1,
  desc: '向量缩放',
  impl: (_c, a) => {
    const p = asVec(a[0]);
    const k = asNum(a[1]);
    return { x: p.x * k, y: p.y * k };
  },
});

defMeta({
  name: '距离',
  group: '向量',
  params: [
    { name: '甲', t: V },
    { name: '乙', t: V },
  ],
  ret: N,
  mana: 0,
  ticks: 2,
  desc: '两点间距离（纯神识运算，不耗法力）',
  impl: (_c, a) => {
    const p = asVec(a[0]);
    const q = asVec(a[1]);
    return Math.hypot(p.x - q.x, p.y - q.y);
  },
});

defMeta({
  name: '归一',
  group: '向量',
  params: [{ name: '向量', t: V }],
  ret: V,
  mana: 0,
  ticks: 2,
  desc: '化为单位向量',
  impl: (_c, a) => {
    const p = asVec(a[0]);
    const l = Math.hypot(p.x, p.y);
    return l < 1e-9 ? { x: 1, y: 0 } : { x: p.x / l, y: p.y / l };
  },
});

defMeta({
  name: '朝向',
  group: '向量',
  params: [
    { name: '起点', t: V },
    { name: '终点', t: V },
  ],
  ret: V,
  mana: 0,
  ticks: 2,
  desc: '从起点指向终点的单位方向',
  impl: (_c, a) => {
    const p = asVec(a[0]);
    const q = asVec(a[1]);
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const l = Math.hypot(dx, dy);
    return l < 1e-9 ? { x: 1, y: 0 } : { x: dx / l, y: dy / l };
  },
});

// ============================ 感知（对外查询，法力大头） ============================

defMeta({
  name: '自身位置',
  group: '感知',
  params: [],
  ret: V,
  mana: 2,
  ticks: 1,
  desc: '内视自身坐标。因为是「内视」而非「外探」，极其廉价——但仍值得缓存',
  impl: (c) => ({ x: c.caster.x, y: c.caster.y }),
});

defMeta({
  name: '感知敌人',
  group: '感知',
  params: [
    { name: '中心', t: V },
    { name: '半径', t: N },
  ],
  ret: T.list('entity'),
  mana: 40,
  ticks: 4,
  desc: '一次扫描获得范围内敌人句柄列表（只含句柄，不含坐标）',
  impl: (c, a) => c.world.inRadius(asVec(a[0]), asNum(a[1]), 64).map((e) => e.id),
});

defMeta({
  name: '探查',
  group: '感知',
  params: [{ name: '目标', t: E }],
  ret: V,
  mana: 10,
  ticks: 2,
  desc: '读取单个实体的坐标。每调用一次就是一次对外探查，循环里用它会很贵',
  impl: (c, a) => {
    const e = c.world.byId(asEntity(a[0]));
    return e ? { x: e.x, y: e.y } : { x: 0, y: 0 };
  },
});

defMeta({
  name: '快照',
  group: '感知',
  params: [
    { name: '中心', t: V },
    { name: '半径', t: N },
  ],
  ret: T.list('vec2'),
  mana: 70,
  ticks: 7,
  desc: '一次 I/O 把范围内所有敌人坐标读入神识。很贵，但之后计算全免费',
  impl: (c, a) =>
    c.world.inRadius(asVec(a[0]), asNum(a[1]), 64).map((e) => ({ x: e.x, y: e.y }) as Value),
});

defMeta({
  name: '生命',
  group: '感知',
  params: [{ name: '目标', t: E }],
  ret: N,
  mana: 8,
  ticks: 2,
  desc: '读取实体当前生命',
  impl: (c, a) => {
    const e = c.world.byId(asEntity(a[0]));
    return e ? e.hp : 0;
  },
});

defMeta({
  name: '长度',
  group: '感知',
  params: [{ name: '列表', t: T.list('any') }],
  ret: N,
  mana: 0,
  ticks: 1,
  desc: '列表真实长度（数据已在神识中，不耗法力）',
  impl: (_c, a) => asList(a[0]).length,
});

// ============================ 操控（改变世界） ============================

defMeta({
  name: '发射',
  group: '操控',
  params: [
    { name: '起点', t: V },
    { name: '方向', t: V },
    { name: '威力', t: N },
  ],
  ret: T.void,
  mana: 25,
  ticks: 3,
  desc: '沿方向射出一道剑气，命中射线上最近的敌人',
  impl: (c, a) => {
    const o = asVec(a[0]);
    const d = asVec(a[1]);
    const p = asNum(a[2]);
    const hit = c.world.raycast(o, d, 400, 16);
    if (hit) {
      c.world.damage(hit.id, p);
      c.log.push(`剑气命中 #${hit.id}，造成 ${p} 点伤害`);
    } else {
      c.log.push('剑气落空');
    }
    return null;
  },
});

defMeta({
  name: '伤害',
  group: '操控',
  params: [
    { name: '目标', t: E },
    { name: '数值', t: N },
  ],
  ret: T.void,
  mana: 20,
  ticks: 2,
  desc: '直接对指定实体造成伤害（需要持有句柄）',
  impl: (c, a) => {
    const id = asEntity(a[0]);
    const dmg = asNum(a[1]);
    if (c.world.damage(id, dmg)) c.log.push(`对 #${id} 造成 ${dmg} 点伤害`);
    return null;
  },
});

defMeta({
  name: '移动',
  group: '操控',
  params: [
    { name: '方向', t: V },
    { name: '距离', t: N },
  ],
  ret: T.void,
  mana: 12,
  ticks: 2,
  desc: '沿方向移动自身',
  impl: (c, a) => {
    const d = asVec(a[0]);
    const dist = asNum(a[1]);
    const l = Math.hypot(d.x, d.y);
    if (l < 1e-9) return null;
    c.caster.x += (d.x / l) * dist;
    c.caster.y += (d.y / l) * dist;
    return null;
  },
});

defMeta({
  name: '瞬移',
  group: '操控',
  params: [{ name: '目标点', t: V }],
  ret: T.void,
  mana: 40,
  ticks: 2,
  desc: '直接挪移到指定坐标',
  impl: (c, a) => {
    const p = asVec(a[0]);
    c.caster.x = p.x;
    c.caster.y = p.y;
    c.log.push(`瞬移至 (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
    return null;
  },
});
