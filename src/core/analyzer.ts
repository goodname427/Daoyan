import type { Expr, Spell, SpellBook, Stmt } from './ast';
import { DYN_CAP, T, assignable, elemTypeOf, shenshiOf, typeName } from './types';
import type { Type } from './types';
import { getMeta } from './meta';

/**
 * 静态分析器。
 *
 * 因为语言是 DAG（无递归、循环次数必须是常量），所有消耗都能在编译期
 * 精确算出上界，玩家因此可以在「创建法术」时就看到代价，从而产生优化动机。
 *
 * 关键语义：
 *   - for / repeat 的最坏消耗 = 容量（或常量次数） × 循环体
 *     而实际消耗取决于真实长度 / break 提前退出
 *     这个「上界 vs 实测」的差距本身就是玩法：把列表容量调小能降低上界，
 *     但真实敌人过多时会漏掉目标。
 */

/** 动态容量列表在分析时采用的保守上界 */
export const DEFAULT_SCAN_CAP = 8;

/**
 * for 循环每轮的固定开销（tick）：长度() + 小于() + 下标取值。
 * 必须计入，否则「静态上界」会低于实测值，玩家将不再信任消耗面板。
 */
const FOR_OVERHEAD_TICKS = 3;

export interface SpellCost {
  name: string;
  /** 最坏法力消耗 */
  manaWorst: number;
  /** 最坏耗时（tick） */
  tickWorst: number;
  /** 神识峰值（含参数） */
  shenshiPeak: number;
  /** 参数本身常驻占用的神识 */
  shenshiParams: number;
  errors: string[];
}

interface BlockCost {
  mana: number;
  ticks: number;
  peak: number;
}

interface ExprCost {
  t: Type;
  mana: number;
  ticks: number;
  /** 求值过程中额外需要的神识（被调用函数的局部变量） */
  peak: number;
}

type Env = Array<Map<string, Type>>;

const ZERO: BlockCost = { mana: 0, ticks: 0, peak: 0 };

export class Analyzer {
  private errors: string[] = [];
  private memo = new Map<string, SpellCost>();
  private visiting = new Set<string>();

  constructor(private book: SpellBook) {}

  /** 分析单个法术（含其调用的其它法术） */
  analyze(name: string): SpellCost {
    const cached = this.memo.get(name);
    if (cached) return cached;

    const spell = this.book[name];
    if (!spell) {
      const c: SpellCost = {
        name,
        manaWorst: 0,
        tickWorst: 0,
        shenshiPeak: 0,
        shenshiParams: 0,
        errors: [`未定义的法术: ${name}`],
      };
      this.memo.set(name, c);
      return c;
    }

    if (this.visiting.has(name)) {
      this.errors.push(
        `【轮回】法术「${name}」存在递归调用。当前境界禁止递归——请在「轮回术」解锁后再试。`,
      );
      const c: SpellCost = {
        name,
        manaWorst: 0,
        tickWorst: 0,
        shenshiPeak: 0,
        shenshiParams: 0,
        errors: [],
      };
      this.memo.set(name, c);
      return c;
    }
    this.visiting.add(name);

    const before = this.errors.length;
    const scope = new Map<string, Type>();
    let cur = 0;
    for (const p of spell.params) {
      scope.set(p.name, p.t);
      cur += shenshiOf(p.t);
    }
    const paramsShenshi = cur;

    const body = this.block(spell.body, [scope], cur);
    const result: SpellCost = {
      name,
      manaWorst: body.mana,
      // +1 为「调用本函数」本身的开销，与虚拟机保持一致，保证静态上界 >= 实测
      tickWorst: body.ticks + 1,
      shenshiPeak: Math.max(body.peak, cur),
      shenshiParams: paramsShenshi,
      errors: this.errors.slice(before),
    };

    this.visiting.delete(name);
    this.memo.set(name, result);
    return result;
  }

  // ---------------- 语句 ----------------

  private block(stmts: Stmt[], env: Env, base: number): BlockCost {
    let mana = 0;
    let ticks = 0;
    let peak = base;
    let cur = base;

    const scope = new Map<string, Type>();
    const env2 = env.concat([scope]);

    for (const s of stmts) {
      switch (s.k) {
        case 'decl': {
          let t = s.t;
          let initPeak = 0;
          if (s.init) {
            const r = this.expr(s.init, env2);
            mana += r.mana;
            ticks += r.ticks;
            initPeak = r.peak;
            if (!t) {
              t = r.t;
              if (t.k === 'void') {
                this.errors.push(`变量「${s.name}」不能由无返回值的式子初始化`);
                t = T.num;
              }
            } else if (!assignable(r.t, t)) {
              this.errors.push(
                `类型不符：「${s.name}」声明为 ${typeName(t)}，初值却是 ${typeName(r.t)}`,
              );
            }
          }
          if (!t) {
            this.errors.push(`变量「${s.name}」缺少类型标注且无初值`);
            t = T.num;
          }
          if (scope.has(s.name)) {
            this.errors.push(`变量「${s.name}」重复声明`);
          }
          const size = shenshiOf(t);
          // 变量在初值求值「之前」就已占用神识（与编译器 DECL 的时机一致）
          if (s.init) peak = Math.max(peak, cur + size + initPeak);
          cur += size;
          peak = Math.max(peak, cur);
          scope.set(s.name, t);
          break;
        }

        case 'assign': {
          const r = this.expr(s.e, env2);
          mana += r.mana;
          ticks += r.ticks;
          peak = Math.max(peak, cur + r.peak);
          const target = s.target;
          if (target.k === 'var') {
            const vt = this.lookup(env2, target.name);
            if (vt && !assignable(r.t, vt)) {
              this.errors.push(
                `类型不符：不能把 ${typeName(r.t)} 赋给「${target.name}」(${typeName(vt)})`,
              );
            }
          } else {
            const at = this.expr(target.arr, env2);
            mana += at.mana;
            ticks += at.ticks;
            const it = this.expr(target.i, env2);
            mana += it.mana;
            ticks += it.ticks;
            if (at.t.k === 'list') {
              const et = elemTypeOf(at.t) ?? T.any;
              if (!assignable(r.t, et)) {
                this.errors.push(`类型不符：列表元素为 ${typeName(et)}，却写入 ${typeName(r.t)}`);
              }
            } else {
              this.errors.push(`不能对非列表类型 ${typeName(at.t)} 做下标写入`);
            }
            ticks += 1; // SETIDX
          }
          break;
        }

        case 'expr': {
          const r = this.expr(s.e, env2);
          mana += r.mana;
          ticks += r.ticks;
          peak = Math.max(peak, cur + r.peak);
          break;
        }

        case 'if': {
          const c = this.expr(s.cond, env2);
          mana += c.mana;
          ticks += c.ticks;
          peak = Math.max(peak, cur + c.peak);
          if (c.t.k !== 'bool' && c.t.k !== 'any') {
            this.errors.push(`条件必须是 bool，实际是 ${typeName(c.t)}`);
          }
          const thenC = this.block(s.then, env2, cur);
          const elseC = s.els ? this.block(s.els, env2, cur) : { ...ZERO, peak: cur };
          mana += Math.max(thenC.mana, elseC.mana);
          ticks += Math.max(thenC.ticks, elseC.ticks);
          peak = Math.max(peak, thenC.peak, elseC.peak);
          break;
        }

        case 'for': {
          const lt = this.expr(s.list, env2);
          mana += lt.mana;
          ticks += lt.ticks;
          peak = Math.max(peak, cur + lt.peak);
          let cap = DEFAULT_SCAN_CAP;
          let et: Type = T.any;
          if (lt.t.k === 'list') {
            cap = lt.t.cap === DYN_CAP ? DEFAULT_SCAN_CAP : lt.t.cap;
            et = elemTypeOf(lt.t) ?? T.any;
          } else {
            this.errors.push(`只能遍历列表，实际是 ${typeName(lt.t)}`);
          }
          const loopScope = new Map<string, Type>([[s.name, et]]);
          const bodyC = this.block(s.body, env2.concat([loopScope]), cur);
          mana += bodyC.mana * cap;
          ticks += (bodyC.ticks + FOR_OVERHEAD_TICKS) * cap;
          peak = Math.max(peak, bodyC.peak);
          break;
        }

        case 'repeat': {
          const bodyC = this.block(s.body, env2, cur);
          const n = Math.max(0, Math.floor(s.count));
          mana += bodyC.mana * n;
          ticks += bodyC.ticks * n;
          peak = Math.max(peak, bodyC.peak);
          break;
        }

        case 'break':
        case 'free':
          break;

        case 'return': {
          if (s.e) {
            const r = this.expr(s.e, env2);
            mana += r.mana;
            ticks += r.ticks;
            peak = Math.max(peak, cur + r.peak);
          }
          break;
        }
      }
    }

    return { mana, ticks, peak };
  }

  // ---------------- 表达式 ----------------

  private expr(e: Expr, env: Env): ExprCost {
    switch (e.k) {
      case 'lit':
        return { t: e.t, mana: 0, ticks: 0, peak: 0 };

      case 'var': {
        const t = this.lookup(env, e.name);
        if (!t) {
          this.errors.push(`未定义的变量: ${e.name}`);
          return { t: T.any, mana: 0, ticks: 0, peak: 0 };
        }
        return { t, mana: 0, ticks: 0, peak: 0 };
      }

      case 'index': {
        const a = this.expr(e.arr, env);
        const i = this.expr(e.i, env);
        let t: Type = T.any;
        if (a.t.k === 'list') t = elemTypeOf(a.t) ?? T.any;
        else this.errors.push(`不能对 ${typeName(a.t)} 取下标`);
        if (i.t.k !== 'num' && i.t.k !== 'any') {
          this.errors.push(`下标必须是 num，实际是 ${typeName(i.t)}`);
        }
        return {
          t,
          mana: a.mana + i.mana,
          ticks: a.ticks + i.ticks + 1, // IDX
          peak: Math.max(a.peak, i.peak),
        };
      }

      case 'call':
        return this.call(e.name, e.args, env);
    }
  }

  private call(name: string, args: Expr[], env: Env): ExprCost {
    let mana = 0;
    let ticks = 0;
    let peak = 0;
    const argTypes: Type[] = [];
    for (const a of args) {
      const r = this.expr(a, env);
      mana += r.mana;
      ticks += r.ticks;
      peak = Math.max(peak, r.peak);
      argTypes.push(r.t);
    }

    const meta = getMeta(name);
    if (meta) {
      if (args.length !== meta.params.length) {
        this.errors.push(
          `元函数「${name}」需要 ${meta.params.length} 个参数，实际给了 ${args.length} 个`,
        );
      }
      for (let i = 0; i < Math.min(args.length, meta.params.length); i++) {
        if (!assignable(argTypes[i], meta.params[i].t)) {
          this.errors.push(
            `元函数「${name}」第 ${i + 1} 个参数应为 ${typeName(meta.params[i].t)}，实际是 ${typeName(argTypes[i])}`,
          );
        }
      }
      return { t: meta.ret, mana: mana + meta.mana, ticks: ticks + meta.ticks, peak };
    }

    const spell = this.book[name];
    if (spell) {
      if (args.length !== spell.params.length) {
        this.errors.push(
          `法术「${name}」需要 ${spell.params.length} 个参数，实际给了 ${args.length} 个`,
        );
      }
      for (let i = 0; i < Math.min(args.length, spell.params.length); i++) {
        if (!assignable(argTypes[i], spell.params[i].t)) {
          this.errors.push(
            `法术「${name}」第 ${i + 1} 个参数应为 ${typeName(spell.params[i].t)}，实际是 ${typeName(argTypes[i])}`,
          );
        }
      }
      const c = this.analyze(name);
      return {
        t: spell.ret ?? T.void,
        mana: mana + c.manaWorst,
        ticks: ticks + c.tickWorst,
        // 被调用法术的局部变量叠加在当前神识之上
        peak: Math.max(peak, c.shenshiPeak),
      };
    }

    this.errors.push(`未定义的元函数或法术: ${name}`);
    return { t: T.any, mana, ticks, peak };
  }

  private lookup(env: Env, name: string): Type | null {
    for (let i = env.length - 1; i >= 0; i--) {
      const t = env[i].get(name);
      if (t) return t;
    }
    return null;
  }
}

/** 分析单条法术 */
export function analyzeSpell(name: string, book: SpellBook): SpellCost {
  return new Analyzer(book).analyze(name);
}

/** 分析整本法术书 */
export function analyzeBook(book: SpellBook): Record<string, SpellCost> {
  const a = new Analyzer(book);
  const out: Record<string, SpellCost> = {};
  for (const name of Object.keys(book)) out[name] = a.analyze(name);
  return out;
}

export type { Spell };
