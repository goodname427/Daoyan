import { T } from '../types';
import { asNum, defMeta } from '../meta';

/**
 * 按键输入类元法术。
 *
 * 配合 SpellMeta.keys 使用：法术声明虚拟按键后，用这些元函数读取按键状态。
 * 按下/松开是**粘性边沿**——发生一次后保持 true，直到被读取才清除，
 * 这样 duration 法术的周期轮询不会漏掉松开瞬间。
 *
 * 注意：只有「持有该按键」的施法者（玩家通过 pressSlot 触发的施法）能读到真值；
 * 妖兽的施法没有按键，一律读 false/0。
 */
export default function register(): void {
  const N = T.num;
  const B = T.bool;

  defMeta({
    name: '按键按住',
    group: '按键状态',
    params: [{ name: '索引', t: N }],
    ret: B,
    mana: 0,
    ticks: 1,
    desc: '指定虚拟按键当前是否按住',
    impl: (c, a) => {
      const idx = asNum(a[0]) | 0;
      return c.keys?.[idx]?.held ?? false;
    },
  });

  defMeta({
    name: '按键按下',
    group: '按键状态',
    params: [{ name: '索引', t: N }],
    ret: B,
    mana: 0,
    ticks: 1,
    desc: '该按键是否在本周期内被按下（粘性，读取后清除）',
    impl: (c, a) => {
      const idx = asNum(a[0]) | 0;
      const k = c.keys?.[idx];
      if (!k) return false;
      const v = k.pressEdge;
      k.pressEdge = false;
      return v;
    },
  });

  defMeta({
    name: '按键松开',
    group: '按键状态',
    params: [{ name: '索引', t: N }],
    ret: B,
    mana: 0,
    ticks: 1,
    desc: '该按键是否在本周期内被松开（粘性，读取后清除）。蓄力释放型法术靠它判断出手时机',
    impl: (c, a) => {
      const idx = asNum(a[0]) | 0;
      const k = c.keys?.[idx];
      if (!k) return false;
      const v = k.releaseEdge;
      k.releaseEdge = false;
      return v;
    },
  });

  defMeta({
    name: '按键蓄力',
    group: '按键状态',
    params: [{ name: '索引', t: N }],
    ret: N,
    mana: 0,
    ticks: 1,
    desc: '该按键已按住的秒数（松开后归零）。用于按蓄力时长决定威力',
    impl: (c, a) => {
      const idx = asNum(a[0]) | 0;
      return c.keys?.[idx]?.heldTime ?? 0;
    },
  });

  defMeta({
    name: '结束施法',
    group: '施法控制',
    params: [],
    ret: T.void,
    mana: 0,
    ticks: 0,
    desc: '立即结束本次施法。释放型法术在出手/取消后必须调用，否则会拖到 duration 上限',
    impl: (c) => {
      c.endRequested = true;
      return null;
    },
  });
}
