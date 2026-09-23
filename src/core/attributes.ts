import type { Vec2 } from './types';

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

/** 首批可被统一实体控制入口引用的稳定逻辑属性键。 */
export const CONTROL_PROPERTY_KEYS = [
  'position',
  'rotation',
  'speed',
  'damage',
  'lifetime',
  'perception',
  'armor',
] as const;

export type ControlPropertyKey = (typeof CONTROL_PROPERTY_KEYS)[number];
export type ControlPropertyEffect = number | Vec2;
export type ControlEffectKind = 'num' | 'vec2';
export type ControlMerge = 'replace' | 'multiply' | 'add';
export type ControlMode = 'write' | 'maintain';
export type ControlWritePolicy = 'commit' | 'overlay';

export interface ControlPropertyDescriptor {
  readonly propertyKey: ControlPropertyKey;
  readonly effectKind: ControlEffectKind;
  readonly merge: ControlMerge;
  /** 校验并规范化效果；失败返回 null，不能把非法值传给 binding。 */
  normalize(effect: unknown): ControlPropertyEffect | null;
}

export interface ControlPropertyBinding {
  readonly propertyKey: ControlPropertyKey;
  readonly mode: ControlMode;
  readonly writePolicy: ControlWritePolicy | null;
  /** 目标死亡或生命周期结束后，原 binding 不再提供能力。 */
  isAvailable(): boolean;
  /** 当前 binding 是否接受该时间；0 明确表示无限。 */
  supportsDuration(duration: number): boolean;
  /** 抗性必须是非负有限数；后续定价工作项消费该值。 */
  resistance(): number;
  /** 按剔除同源旧层后的前后有效值测量实际变化。 */
  effectStrength(
    effect: ControlPropertyEffect,
    before: ControlPropertyEffect,
    after: ControlPropertyEffect,
  ): number;
  /** 所有前置校验完成后才调用；失败不得留下部分状态。 */
  apply(effect: ControlPropertyEffect, duration: number): boolean;
  /** 覆写适配器读取未受控制层影响的当前基础值。 */
  readBase?(): ControlPropertyEffect;
  /** 覆写适配器发布已合并的有效值。 */
  writeEffective?(value: ControlPropertyEffect): void;
}

export type ControlPropertyBindings = Partial<Record<ControlPropertyKey, ControlPropertyBinding>>;

function finiteVec2(effect: unknown): Vec2 | null {
  if (typeof effect !== 'object' || effect === null) return null;
  const value = effect as Partial<Vec2>;
  return Number.isFinite(value.x) && Number.isFinite(value.y) ? { x: value.x!, y: value.y! } : null;
}

function direction(effect: unknown): Vec2 | null {
  const value = finiteVec2(effect);
  if (!value) return null;
  const scale = Math.max(Math.abs(value.x), Math.abs(value.y));
  if (scale === 0) return null;
  const x = value.x / scale;
  const y = value.y / scale;
  const length = Math.hypot(x, y);
  return { x: x / length, y: y / length };
}

function positiveFinite(effect: unknown): number | null {
  return typeof effect === 'number' && Number.isFinite(effect) && effect > 0 ? effect : null;
}

function finiteNumber(effect: unknown): number | null {
  return typeof effect === 'number' && Number.isFinite(effect) ? effect : null;
}

const CONTROL_PROPERTY_DESCRIPTORS: Readonly<
  Record<ControlPropertyKey, ControlPropertyDescriptor>
> = Object.freeze({
  position: Object.freeze({
    propertyKey: 'position',
    effectKind: 'vec2',
    merge: 'replace',
    normalize: finiteVec2,
  }),
  rotation: Object.freeze({
    propertyKey: 'rotation',
    effectKind: 'vec2',
    merge: 'replace',
    normalize: direction,
  }),
  speed: Object.freeze({
    propertyKey: 'speed',
    effectKind: 'num',
    merge: 'multiply',
    normalize: positiveFinite,
  }),
  damage: Object.freeze({
    propertyKey: 'damage',
    effectKind: 'num',
    merge: 'multiply',
    normalize: positiveFinite,
  }),
  lifetime: Object.freeze({
    propertyKey: 'lifetime',
    effectKind: 'num',
    merge: 'replace',
    normalize: positiveFinite,
  }),
  perception: Object.freeze({
    propertyKey: 'perception',
    effectKind: 'num',
    merge: 'multiply',
    normalize: positiveFinite,
  }),
  armor: Object.freeze({
    propertyKey: 'armor',
    effectKind: 'num',
    merge: 'add',
    normalize: finiteNumber,
  }),
});

/** 未知键返回 null；调用方据此做确定性能力拒绝，不补默认属性。 */
export function getControlPropertyDescriptor(
  propertyKey: string,
): ControlPropertyDescriptor | null {
  return Object.prototype.hasOwnProperty.call(CONTROL_PROPERTY_DESCRIPTORS, propertyKey)
    ? CONTROL_PROPERTY_DESCRIPTORS[propertyKey as ControlPropertyKey]
    : null;
}

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
