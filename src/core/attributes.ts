/**
 * 属性表与增益系统（GAS 风格）。
 *
 * 主角与妖兽共用同一套属性结构 —— 差别只在数值与绑定了什么法术。
 * 属性既影响元函数的**效果**（伤害、感知半径、位移），也影响**消耗**（法力、耗时）。
 */

export interface Attributes {
  /** 生命上限 */
  hpMax: number;
  /** 法力上限 */
  manaMax: number;
  /** 每秒法力回复 */
  manaRegen: number;
  /** 神识上限（境界） */
  shenshiMax: number;
  /** 移动速度（单位/秒） */
  speed: number;
  /** 施法速度倍率：越大，每 tick 对应的真实时间越短 */
  castSpeed: number;
  /** 术法威力倍率：影响所有伤害 */
  power: number;
  /** 法力消耗倍率：越小越省 */
  manaCostMul: number;
  /** 感知半径倍率 */
  perception: number;
  /** 护体：固定减伤 */
  armor: number;
}

export type AttrKey = keyof Attributes;

export const ATTR_LABELS: Record<AttrKey, string> = {
  hpMax: '生命上限',
  manaMax: '法力上限',
  manaRegen: '法力回复',
  shenshiMax: '神识上限',
  speed: '移动速度',
  castSpeed: '施法速度',
  power: '术法威力',
  manaCostMul: '法力消耗',
  perception: '感知半径',
  armor: '护体减伤',
};

export function baseAttributes(over: Partial<Attributes> = {}): Attributes {
  return {
    hpMax: 100,
    manaMax: 200,
    manaRegen: 20,
    shenshiMax: 48,
    speed: 140,
    castSpeed: 1,
    power: 1,
    manaCostMul: 1,
    perception: 1,
    armor: 0,
    ...over,
  };
}

/** 属性修正：加法或乘法，可限时 */
export interface Modifier {
  id: number;
  key: AttrKey;
  op: 'add' | 'mul';
  value: number;
  /** 剩余秒数，<= 0 表示永久 */
  duration: number;
  source: string;
}

const ATTR_KEYS = Object.keys(ATTR_LABELS) as AttrKey[];

/** 结算有效属性：先加后乘 */
export function computeAttributes(base: Attributes, mods: readonly Modifier[]): Attributes {
  const out = { ...base };
  if (mods.length === 0) return out;
  const add: Partial<Record<AttrKey, number>> = {};
  const mul: Partial<Record<AttrKey, number>> = {};
  for (const m of mods) {
    if (m.op === 'add') add[m.key] = (add[m.key] ?? 0) + m.value;
    else mul[m.key] = (mul[m.key] ?? 1) * m.value;
  }
  for (const k of ATTR_KEYS) {
    out[k] = (out[k] + (add[k] ?? 0)) * (mul[k] ?? 1);
  }
  return out;
}

/** 推进修正的存活时间，返回是否有修正过期 */
export function tickModifiers(mods: Modifier[], dt: number): boolean {
  let changed = false;
  for (let i = mods.length - 1; i >= 0; i--) {
    const m = mods[i];
    if (m.duration <= 0) continue;
    m.duration -= dt;
    if (m.duration <= 0) {
      mods.splice(i, 1);
      changed = true;
    }
  }
  return changed;
}
