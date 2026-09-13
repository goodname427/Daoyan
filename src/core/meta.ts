import type { Type, Value } from './types';
import type { Actor, World } from './world';
import type { KeyState } from './input';

/** 元函数执行上下文：只有元函数能接触「外界」 */
export interface Ctx {
  world: World;
  caster: Actor;
  log: string[];
  /** 当前施法的按键状态（duration/键位法术用），无键法术为 null */
  keys: KeyState[] | null;
  /** 法术调用「结束施法」后置真，VM 检测后立即结束 */
  endRequested: boolean;
}

export interface MetaParam {
  name: string;
  t: Type;
}

/** 分析器传入的静态实参；未知值不会被伪装成 0。 */
export interface CostArg {
  known: boolean;
  value: Value;
}

/** `dynamic` 表示 value 只是已知的固定部分，其余由运行时输入或实体状态决定。 */
export interface CostAmount {
  value: number;
  dynamic: boolean;
}

export interface MetaCost {
  mana: CostAmount;
  ticks: CostAmount;
}

export const knownCostArg = (value: Value): CostArg => ({ known: true, value });
export const unknownCostArg = (): CostArg => ({ known: false, value: null });
export const fixedCost = (value: number): CostAmount => ({ value, dynamic: false });
export const dynamicCost = (base = 0): CostAmount => ({ value: base, dynamic: true });

export function costNumber(arg: CostArg): number | null {
  return arg.known && typeof arg.value === 'number' && Number.isFinite(arg.value)
    ? arg.value
    : null;
}

/**
 * 元函数（基础术式）。
 *
 * 定价原则：
 *   - 神识内运算（加减、比较、距离、长度）→ 法力 0，只收耗时
 *   - 读取外界（感知、探查、快照）        → 法力高，这是主要优化空间
 *   - 改变外界（发射、伤害、移动）        → 法力高
 */
export interface MetaDef {
  name: string;
  group: string;
  params: MetaParam[];
  ret: Type;
  /** 不含请求效果的基础法力成本；动态定价可在此基础上继续累加。 */
  mana: number;
  /** 旧版仅计算法力的运行时价格，保留给外部元法术兼容。 */
  manaCost?: (ctx: Ctx, args: Value[]) => number;
  /** 耗时（tick） */
  ticks: number;
  /**
   * 同时计算法力与耗时的新定价契约。运行时的参数全部 known；静态分析时
   * 未知输入用 dynamic 表达，避免为了得到伪上界而限制玩家请求的效果。
   * 与旧 `manaCost` 同时存在时以本字段为准。
   */
  cost?: (ctx: Ctx | null, args: readonly CostArg[]) => MetaCost;
  desc: string;
  impl: (ctx: Ctx, args: Value[]) => Value;
}

/**
 * 注册表挂在 globalThis 上，保证 HMR / 重复 import 时全局唯一。
 * defMeta 幂等：同名元函数会被覆盖，而不是报错 —— 这样增删改元法术文件时
 * 热更新不会炸掉整个页面。
 */
interface MetaRegistry {
  list: MetaDef[];
  index: Map<string, number>;
}

const REGISTRY_KEY = '__DAOYAN_META_REGISTRY__';
const holder = globalThis as unknown as Record<string, MetaRegistry | undefined>;
if (!holder[REGISTRY_KEY]) {
  holder[REGISTRY_KEY] = { list: [], index: new Map() };
}
const registry: MetaDef[] = holder[REGISTRY_KEY]!.list;
const index: Map<string, number> = holder[REGISTRY_KEY]!.index;

export function defMeta(m: MetaDef): MetaDef {
  const existing = index.get(m.name);
  if (existing !== undefined) {
    registry[existing] = m;
    return m;
  }
  index.set(m.name, registry.length);
  registry.push(m);
  return m;
}

/** 用配置覆盖定价（调平衡不用改代码） */
export function applyMetaOverrides(overrides: Record<string, Partial<MetaDef>>): void {
  for (const [name, patch] of Object.entries(overrides)) {
    const i = index.get(name);
    if (i === undefined) continue;
    registry[i] = { ...registry[i], ...patch, name };
  }
}

/** 清空注册表（测试用） */
export function clearMetas(): void {
  registry.length = 0;
  index.clear();
}

export function allMetas(): readonly MetaDef[] {
  return registry;
}

export function getMeta(name: string): MetaDef | null {
  const i = index.get(name);
  return i === undefined ? null : registry[i];
}

export function metaIndex(name: string): number {
  const i = index.get(name);
  if (i === undefined) throw new Error(`未知元函数: ${name}`);
  return i;
}

export function isMeta(name: string): boolean {
  return index.has(name);
}

// ---- 取值辅助 ----

export function asNum(v: Value): number {
  return typeof v === 'number' ? v : 0;
}
export function asBool(v: Value): boolean {
  return v === true;
}
export function asVec(v: Value): { x: number; y: number } {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'x' in v) {
    return v as { x: number; y: number };
  }
  return { x: 0, y: 0 };
}
export function asList(v: Value): Value[] {
  return Array.isArray(v) ? v : [];
}
export function asEntity(v: Value): number {
  return typeof v === 'number' ? v : -1;
}
