import { T } from '../types';
import { asNum, asVec, defMeta } from '../meta';

/** 向量运算：全部是神识内运算，不耗法力，只收耗时 */
export default function register(): void {
  const N = T.num;
  const V = T.vec2;

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

  defMeta({
    name: '旋转',
    group: '向量',
    params: [
      { name: '向量', t: V },
      { name: '弧度', t: N },
    ],
    ret: V,
    mana: 0,
    ticks: 1,
    desc: '把向量旋转指定弧度（做扇形散射很便宜）',
    impl: (_c, a) => {
      const p = asVec(a[0]);
      const r = asNum(a[1]);
      const c = Math.cos(r);
      const s = Math.sin(r);
      return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
    },
  });
}
