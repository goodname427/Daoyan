import type { Expr, Spell, SpellBook, Stmt } from './ast';
import { DYN_CAP, T, shenshiOf } from './types';
import type { Type, Value } from './types';
import { getMeta, metaIndex } from './meta';
import { DEFAULT_SCAN_CAP } from './analyzer';

export const Op = {
  PUSHK: 0,
  LDSLOT: 1,
  STSLOT: 2,
  TRUNC: 3, // 按容量截断列表（列表变量定容语义）
  DECL: 4, // 声明变量：a=槽位 b=神识大小
  FREE: 5, // 释放变量：a=槽位
  POP: 6,
  PEEK: 7, // 复制栈顶下第 a 个元素
  INCTOP: 8,
  DECTOP: 9,
  IDX: 10,
  SETIDX: 11,
  CALLMETA: 12, // a=元函数索引 b=参数个数
  CALLUSER: 13, // a=函数索引 b=参数个数
  JMP: 14,
  JMPIFNOT: 15,
  SWAP: 16, // 交换栈顶两个元素
  RET: 17, // a=1 时带回返回值
} as const;

export type Op = (typeof Op)[keyof typeof Op];

export interface Inst {
  op: Op;
  a?: number;
  b?: number;
  /** DECL 的调试名称；同一槽位被后续作用域复用时不能覆盖它。 */
  name?: string;
  /** 参数值已由调用帧写入，声明时不得按普通复用槽位清空。 */
  preserveValue?: boolean;
}

export interface CompiledFn {
  name: string;
  slotCount: number;
  /** 调试器显示用的槽位名；不参与运行语义或资源分析。 */
  slotNames: string[];
  hasRet: boolean;
  code: Inst[];
  consts: Value[];
}

export interface Program {
  fns: CompiledFn[];
  index: Map<string, number>;
  entry: number;
}

interface ScopeVar {
  name: string;
  t: Type;
  slot: number;
  /** 是否需要计费（循环变量是临时寄存器，不占神识） */
  charged: boolean;
}

function defaultValue(t: Type): Value {
  switch (t.k) {
    case 'num':
      return 0;
    case 'bool':
      return false;
    case 'vec2':
      return { x: 0, y: 0 };
    case 'entity':
      return null;
    case 'list':
      return [];
    default:
      return null;
  }
}

class FnCompiler {
  code: Inst[] = [];
  consts: Value[] = [];
  private scopes: ScopeVar[][] = [];
  private nextSlot = 0;
  private maxSlot = 0;
  private slotNames: string[] = [];
  private breaks: number[][] = [];

  constructor(private fnIndex: Map<string, number>) {}

  private emit(op: Op, a = 0, b = 0): number {
    this.code.push({ op, a, b });
    return this.code.length - 1;
  }

  private patch(at: number, a: number): void {
    this.code[at].a = a;
  }

  private konst(v: Value): number {
    const i = this.consts.indexOf(v);
    if (i >= 0) return i;
    this.consts.push(v);
    return this.consts.length - 1;
  }

  private pushScope(): void {
    this.scopes.push([]);
  }

  private popScope(): void {
    const s = this.scopes.pop();
    if (!s) return;
    for (let i = s.length - 1; i >= 0; i--) {
      // FREE also ends the debug lifetime.  Emit it for uncharged loop
      // temporaries as well, so a reused slot cannot remain observable.
      this.emit(Op.FREE, s[i].slot);
      this.nextSlot--;
    }
  }

  private allocSlot(): number {
    const s = this.nextSlot++;
    if (s + 1 > this.maxSlot) this.maxSlot = s + 1;
    return s;
  }

  private declare(name: string, t: Type, charged = true, preserveValue = false): number {
    const slot = this.allocSlot();
    this.slotNames[slot] = name;
    const scope = this.scopes[this.scopes.length - 1];
    if (scope) scope.push({ name, t, slot, charged });
    // DECL establishes the slot lifetime in addition to reserving shenshi.
    // Uncharged loop variables use a zero-sized declaration for that purpose.
    const decl = this.emit(Op.DECL, slot, charged ? shenshiOf(t) : 0);
    this.code[decl].name = name;
    this.code[decl].preserveValue = preserveValue;
    return slot;
  }

  private lookup(name: string): ScopeVar | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      for (let j = this.scopes[i].length - 1; j >= 0; j--) {
        if (this.scopes[i][j].name === name) return this.scopes[i][j];
      }
    }
    return null;
  }

  /** 存入变量：定容列表会先按容量截断 */
  private store(slot: number, t: Type): void {
    if (t.k === 'list' && t.cap !== DYN_CAP) this.emit(Op.TRUNC, t.cap);
    this.emit(Op.STSLOT, slot);
  }

  // ---------------- 表达式 ----------------

  private expr(e: Expr): void {
    switch (e.k) {
      case 'lit':
        this.emit(Op.PUSHK, this.konst(e.v));
        break;

      case 'var': {
        const v = this.lookup(e.name);
        if (!v) throw new Error(`编译错误：未定义的变量 ${e.name}（应先通过静态分析）`);
        this.emit(Op.LDSLOT, v.slot);
        break;
      }

      case 'index': {
        this.expr(e.arr);
        this.expr(e.i);
        this.emit(Op.IDX);
        break;
      }

      case 'call': {
        for (const a of e.args) this.expr(a);
        const meta = getMeta(e.name);
        if (meta) {
          this.emit(Op.CALLMETA, metaIndex(e.name), e.args.length);
        } else {
          const idx = this.fnIndex.get(e.name);
          if (idx === undefined) throw new Error(`编译错误：未知的被调用者 ${e.name}`);
          this.emit(Op.CALLUSER, idx, e.args.length);
        }
        break;
      }
    }
  }

  // ---------------- 语句 ----------------

  private stmts(list: Stmt[]): void {
    for (const s of list) this.stmt(s);
  }

  private stmt(s: Stmt): void {
    switch (s.k) {
      case 'decl': {
        const t = s.t ?? T.num;
        const slot = this.declare(s.name, t);
        if (s.init) {
          this.expr(s.init);
        } else {
          this.emit(Op.PUSHK, this.konst(defaultValue(t)));
        }
        this.store(slot, t);
        break;
      }

      case 'assign': {
        const target = s.target;
        if (target.k === 'var') {
          const v = this.lookup(target.name);
          if (!v) throw new Error(`编译错误：未定义的变量 ${target.name}`);
          this.expr(s.e);
          this.store(v.slot, v.t);
        } else {
          this.expr(target.arr);
          this.expr(target.i);
          this.expr(s.e);
          this.emit(Op.SETIDX);
        }
        break;
      }

      case 'expr':
        this.expr(s.e);
        this.emit(Op.POP);
        break;

      case 'if': {
        this.expr(s.cond);
        const jmpElse = this.emit(Op.JMPIFNOT);
        this.pushScope();
        this.stmts(s.then);
        this.popScope();
        if (s.els) {
          const jmpEnd = this.emit(Op.JMP);
          this.patch(jmpElse, this.code.length);
          this.pushScope();
          this.stmts(s.els);
          this.popScope();
          this.patch(jmpEnd, this.code.length);
        } else {
          this.patch(jmpElse, this.code.length);
        }
        break;
      }

      case 'for': {
        // 列表只求值一次：循环内一律用 PEEK 复用，避免重复触发昂贵的感知元函数
        this.expr(s.list); // [L]
        this.emit(Op.PUSHK, this.konst(0)); // [L, i]
        const L_start = this.code.length;
        this.emit(Op.PEEK, 1); // [L, i, L]
        this.emit(Op.CALLMETA, metaIndex('长度'), 1); // [L, i, len]
        this.emit(Op.PEEK, 1); // [L, i, len, i]
        this.emit(Op.PEEK, 1); // [L, i, len, i, len]
        this.emit(Op.CALLMETA, metaIndex('小于'), 2); // [L, i, len, i<len]
        // 比较用的 len 是副本，会残留在栈上，交换后弹出
        this.emit(Op.SWAP); // [L, i, i<len, len]
        this.emit(Op.POP); //  [L, i, i<len]
        const jmpBreak = this.emit(Op.JMPIFNOT); // [L, i]

        this.pushScope();
        this.emit(Op.PEEK, 1); // [L, i, L]
        this.emit(Op.PEEK, 1); // [L, i, L, i]
        this.emit(Op.IDX); //     [L, i, elem]
        const elemSlot = this.declare(s.name, T.any, false);
        this.emit(Op.STSLOT, elemSlot); // [L, i]

        this.breaks.push([]);
        this.stmts(s.body);
        const brks = this.breaks.pop() ?? [];
        this.popScope();

        this.emit(Op.INCTOP);
        this.emit(Op.JMP, L_start);
        const L_break = this.code.length;
        this.emit(Op.POP); // i
        this.emit(Op.POP); // 列表
        for (const b of brks) this.patch(b, L_break);
        this.patch(jmpBreak, L_break);
        break;
      }

      case 'repeat': {
        this.emit(Op.PUSHK, this.konst(s.count));
        const L_start = this.code.length;
        this.emit(Op.PEEK, 0);
        const jmpBreak = this.emit(Op.JMPIFNOT);
        this.pushScope();
        this.breaks.push([]);
        this.stmts(s.body);
        const brks = this.breaks.pop() ?? [];
        this.popScope();
        this.emit(Op.DECTOP);
        this.emit(Op.JMP, L_start);
        const L_break = this.code.length;
        this.emit(Op.POP);
        for (const b of brks) this.patch(b, L_break);
        this.patch(jmpBreak, L_break);
        break;
      }

      case 'break': {
        const at = this.emit(Op.JMP);
        const top = this.breaks[this.breaks.length - 1];
        if (top) top.push(at);
        else throw new Error('编译错误：break 必须出现在循环内');
        break;
      }

      case 'free': {
        const v = this.lookup(s.name);
        if (v) this.emit(Op.FREE, v.slot);
        break;
      }

      case 'return': {
        if (s.e) this.expr(s.e);
        else this.emit(Op.PUSHK, this.konst(null));
        this.emit(Op.RET, 1);
        break;
      }
    }
  }

  compile(spell: Spell): CompiledFn {
    this.pushScope();
    for (const p of spell.params) {
      const slot = this.declare(p.name, p.t, true, true);
      // 参数由调用方写入槽位
      void slot;
    }
    this.stmts(spell.body);
    this.popScope();
    this.emit(Op.PUSHK, this.konst(null));
    this.emit(Op.RET, 1);
    return {
      name: spell.name,
      slotCount: this.maxSlot,
      slotNames: this.slotNames,
      hasRet: true,
      code: this.code,
      consts: this.consts,
    };
  }
}

export function compileSpell(spell: Spell, fnIndex: Map<string, number>): CompiledFn {
  return new FnCompiler(fnIndex).compile(spell);
}

/** 编译整本法术书。entry 省略时取书中第一个法术作为入口。 */
export function compileProgram(book: SpellBook, entry?: string): Program {
  const index = new Map<string, number>();
  const names = Object.keys(book);
  for (const n of names) {
    if (getMeta(n)) throw new Error(`法术名「${n}」与基础元函数重名，请改名`);
  }
  names.forEach((n, i) => index.set(n, i));
  const fns = names.map((n) => compileSpell(book[n], index));
  const name = entry ?? names[0];
  const e = name === undefined ? undefined : index.get(name);
  if (e === undefined) throw new Error(`入口法术不存在: ${String(name)}`);
  return { fns, index, entry: e };
}

export { DEFAULT_SCAN_CAP };
