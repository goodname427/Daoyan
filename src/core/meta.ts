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

const registry: MetaDef[] = [];
const index = new Map<string, number>();

export function defMeta(m: MetaDef): MetaDef {
  if (index.has(m.name)) throw new Error(`元函数重名: ${m.name}`);
  index.set(m.name, registry.length);
  registry.push(m);
  return m;
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
