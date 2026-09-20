import type { Type } from './types';
import type { SpellMeta } from './spellMeta';

/**
 * 抽象语法树 —— 整个项目的唯一真相（IR）。
 *
 * 重要：AST 完全可 JSON 序列化。
 *   - 节点图编辑器产出它
 *   - DSL 解析产出它
 *   - 「秘籍」分享码就是它的序列化结果
 */

export type LitValue = number | boolean | null;

export type Expr =
  | { k: 'lit'; v: LitValue; t: Type }
  | { k: 'var'; name: string }
  | { k: 'index'; arr: Expr; i: Expr }
  | { k: 'call'; name: string; args: Expr[] };

export type AssignTarget = { k: 'var'; name: string } | { k: 'index'; arr: Expr; i: Expr };

/**
 * 语句说明：
 *  - decl   声明变量（消耗神识），可带初值
 *  - free   手动释放变量（归还神识）
 *  - for    遍历列表；静态最坏消耗按「列表容量」计，实际按真实长度
 *  - repeat 固定次数循环；次数必须是字面量常量，保证可静态分析
 *  - break  提前退出，使实际消耗低于最坏上界
 */
export type Stmt =
  | { k: 'decl'; name: string; t: Type | null; init: Expr | null }
  | { k: 'assign'; target: AssignTarget; e: Expr }
  | { k: 'expr'; e: Expr }
  | { k: 'if'; cond: Expr; then: Stmt[]; els: Stmt[] | null }
  | { k: 'for'; name: string; list: Expr; body: Stmt[] }
  | { k: 'repeat'; count: number; body: Stmt[] }
  | { k: 'break' }
  | { k: 'free'; name: string }
  | { k: 'return'; e: Expr | null };

export interface Param {
  name: string;
  t: Type;
}

export interface Spell {
  name: string;
  params: Param[];
  ret: Type | null;
  body: Stmt[];
  tags: string[];
  /** 描述，展示给玩家 */
  desc?: string;
  /** 生命周期配置（瞬时 / 持续 / 引导、周期、按键…） */
  meta?: Partial<SpellMeta>;
}

export type SpellBook = Record<string, Spell>;

export function emptySpell(name: string): Spell {
  return { name, params: [], ret: null, body: [], tags: [], desc: '' };
}
