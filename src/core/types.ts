/**
 * 类型系统 —— 神识（内存）成本的唯一来源。
 *
 * 设计原则：
 *   神识 = 持有状态的成本（空间）
 *   法力 = 与外界交互的成本（I/O）
 *   耗时 = 执行步数（时间）
 *
 * 每个类型都有确定的神识价格，因此"声明变量"这件事本身就天然构成了
 * 空间复杂度约束。
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** 运行期值：num→number, bool→boolean, vec2→Vec2, entity→number(id), list→数组, 空→null */
export type QueryValue =
  | {
      ok: true;
      value: number | Vec2 | Value[];
      observedAt: number;
      targetId: number;
      field: string;
    }
  | { ok: false; reason: 'unavailable' };
export type Value = number | boolean | Vec2 | QueryValue | Value[] | null;

export type PrimKind = 'num' | 'bool' | 'vec2' | 'entity';

/** 列表元素类型；'any' 表示「任意元素的列表」，用于 长度() 这类泛型元函数 */
export type ListElem = PrimKind | 'any';

/** 列表容量未知（例如元函数返回的动态列表）时用 DYN_CAP */
export const DYN_CAP = -1;

export type Type =
  | { k: 'num' }
  | { k: 'bool' }
  | { k: 'vec2' }
  | { k: 'entity' }
  | { k: 'query'; value: 'num' | 'vec2' | 'entities' | 'positions' }
  | { k: 'any' } // 用于「空」字面量与泛型相等比较
  | { k: 'list'; elem: ListElem; cap: number }
  | { k: 'void' };

export const T = {
  num: { k: 'num' } as Type,
  bool: { k: 'bool' } as Type,
  vec2: { k: 'vec2' } as Type,
  entity: { k: 'entity' } as Type,
  query: (value: 'num' | 'vec2' | 'entities' | 'positions'): Type => ({ k: 'query', value }),
  any: { k: 'any' } as Type,
  void: { k: 'void' } as Type,
  list: (elem: ListElem, cap: number = DYN_CAP): Type => ({ k: 'list', elem, cap }),
};

/** 基础类型的神识价格 */
export const PRIM_SHENSHI: Record<ListElem, number> = {
  num: 1,
  bool: 1,
  entity: 1,
  vec2: 2, // 向量是两个数
  any: 1,
};

export function shenshiOf(t: Type): number {
  switch (t.k) {
    case 'num':
    case 'bool':
    case 'entity':
    case 'any':
      return 1;
    case 'vec2':
      return 2;
    case 'query':
      return t.value === 'positions'
        ? 133
        : t.value === 'entities'
          ? 69
          : t.value === 'vec2'
            ? 6
            : 5;
    case 'list':
      // 列表 = 1 点表头 + 每个槽位的元素价格（容量即预算）
      return 1 + PRIM_SHENSHI[t.elem] * Math.max(t.cap, 0);
    case 'void':
      return 0;
  }
}

export function primType(k: PrimKind): Type {
  switch (k) {
    case 'num':
      return T.num;
    case 'bool':
      return T.bool;
    case 'vec2':
      return T.vec2;
    case 'entity':
      return T.entity;
  }
}

export function elemTypeOf(t: Type): Type | null {
  if (t.k !== 'list') return null;
  return t.elem === 'any' ? T.any : primType(t.elem);
}

export function typeName(t: Type): string {
  if (t.k === 'query') return `query<${t.value}>`;
  if (t.k === 'list') return `list<${t.elem},${t.cap < 0 ? '?' : t.cap}>`;
  return t.k;
}

export function isPrim(t: Type): boolean {
  return t.k === 'num' || t.k === 'bool' || t.k === 'vec2' || t.k === 'entity';
}

/** 赋值兼容性：动态容量列表可赋给同元素的定容列表（按目标容量截断） */
export function assignable(from: Type, to: Type): boolean {
  if (from.k === 'any' || to.k === 'any') return true;
  if (from.k === 'void' || to.k === 'void') return false;
  if (from.k === to.k) {
    if (from.k === 'query' && to.k === 'query') return from.value === to.value;
    if (from.k === 'list' && to.k === 'list') {
      return from.elem === to.elem || to.elem === 'any' || from.elem === 'any';
    }
    return true;
  }
  return false;
}
