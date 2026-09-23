import { controlPrice, getControlPropertyDescriptor } from '../core/index';

const CONTROLS: Record<string, { key: string; effect: string; capability: string }> = {
  设置位置: {
    key: 'position',
    effect: '有限坐标向量；按场地边界裁剪',
    capability: 'Transform 的 position 写入；仅接受时间 0',
  },
  设置朝向: {
    key: 'rotation',
    effect: '有限且非零的方向向量，自动归一化',
    capability: 'rotation 写入覆写',
  },
  调整速度: {
    key: 'speed',
    effect: '大于 0 的有限速度倍率',
    capability: 'speed 写入覆写或维持 binding',
  },
  强化伤害: {
    key: 'damage',
    effect: '大于 0 的有限伤害倍率',
    capability: 'damage 写入覆写或维持 binding',
  },
  设置存活时间: {
    key: 'lifetime',
    effect: '大于 0 的有限剩余秒数',
    capability: 'lifetime 一次写入；仅接受时间 0',
  },
  调整感知: {
    key: 'perception',
    effect: '大于 0 的有限感知倍率',
    capability: 'perception 维持 binding',
  },
  调整护体: { key: 'armor', effect: '有限护体增量，可正可负', capability: 'armor 维持 binding' },
};

export function controlHelp(name: string) {
  const item = CONTROLS[name];
  if (!item) return null;
  const descriptor = getControlPropertyDescriptor(item.key);
  const periodic = controlPrice({
    relation: null,
    resistance: null,
    strength: null,
    duration: null,
    mode: null,
    writePolicy: null,
  }).periodic!;
  return {
    ...item,
    merge: descriptor?.merge ?? '',
    period: `维持时每 ${periodic.intervalSeconds} 秒另付法力 ${periodic.mana.value} + 动态、${periodic.ticks.value} + 动态 tick；未知目标不能预报总价`,
    failure:
      '返回 false 时检查：目标是否仍有该属性 binding、关系是否允许控制、效果与时间是否在合法域内。法力余额不足会终止施法并报告所需法力。',
  };
}
