import { T } from '../types';
import { asBool, asNum, defMeta } from '../meta';

/** 元法术文件约定：默认导出 register()，由加载器自动调用 */
export default function register(): void {
  const N = T.num;
  const B = T.bool;

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
      group: '运算符',
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
      group: '运算符',
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
    group: '运算符',
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
    group: '运算符',
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
      group: '运算符',
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

  const unary: Array<[string, string, (a: number) => number]> = [
    ['负', '取负', (a) => -a],
    ['绝对值', '绝对值', (a) => Math.abs(a)],
    ['取整', '向下取整', (a) => Math.floor(a)],
  ];
  for (const [name, desc, f] of unary) {
    defMeta({
      name,
      group: '运算符',
      params: [{ name: '甲', t: N }],
      ret: N,
      mana: 0,
      ticks: 1,
      desc,
      impl: (_c, a) => f(asNum(a[0])),
    });
  }

  defMeta({
    name: '非',
    group: '运算符',
    params: [{ name: '甲', t: B }],
    ret: B,
    mana: 0,
    ticks: 1,
    desc: '逻辑非',
    impl: (_c, a) => !asBool(a[0]),
  });

  defMeta({
    name: '随机',
    group: '运算符',
    params: [{ name: '上限', t: N }],
    ret: N,
    mana: 0,
    ticks: 1,
    desc: '产生 [0, 上限) 内的随机数',
    impl: (_c, a) => Math.random() * asNum(a[0]),
  });
}
