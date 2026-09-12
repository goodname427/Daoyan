import type { Type, Value } from './types';
import type { Actor, World } from './world';

/** 元函数执行上下文：只有元函数能接触「外界」 */
export interface Ctx {
  world: World;
  caster: Actor;
  log: string[];
}

export interface MetaParam {
  name: string;
  t: Type;
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
  /** 法力消耗：与外界交互的成本 */
  mana: number;
  /** 耗时（tick） */
  ticks: number;
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
