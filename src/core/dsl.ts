import type { Expr, Param, Spell, SpellBook, Stmt } from './ast';
import type { SpellMeta } from './spellMeta';
import { DYN_CAP, T } from './types';
import type { Type } from './types';

/**
 * 极简 DSL 解析器。
 *
 * 定位：这只是「产出 AST 的前端之一」。未来可视化节点图产出的是同一份 AST，
 * 因此这里的任何投入都不会浪费，也不会污染核心。
 *
 * 关键字用英文（面向开发者），标识符与元函数名用中文（面向玩家）。
 */

type TokKind = 'name' | 'num' | 'punct';

interface Tok {
  kind: TokKind;
  text: string;
  num: number;
  line: number;
}

/** 标识符：英文字母、下划线、中日韩统一表意文字、以及间隔号「·」 */
const NAME_RE = /[A-Za-z_一-鿿·][A-Za-z0-9_一-鿿·]*/u;

class ParseError extends Error {}

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      toks.push({ kind: 'num', text, num: Number(text), line });
      i = j;
      continue;
    }
    const m = NAME_RE.exec(src.slice(i));
    if (m && m.index === 0) {
      toks.push({ kind: 'name', text: m[0], num: 0, line });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (
      two === '==' ||
      two === '!=' ||
      two === '<=' ||
      two === '>=' ||
      two === '&&' ||
      two === '||' ||
      two === '->'
    ) {
      toks.push({ kind: 'punct', text: two, num: 0, line });
      i += 2;
      continue;
    }
    if ('+-*/%<>=!()[]{},:;@'.includes(c)) {
      toks.push({ kind: 'punct', text: c, num: 0, line });
      i++;
      continue;
    }
    throw new ParseError(`第 ${line} 行：无法识别的字符 "${c}"`);
  }
  return toks;
}

const BIN_OPS: Record<string, string> = {
  '+': '加',
  '-': '减',
  '*': '乘',
  '/': '除',
  '%': '取余',
  '<': '小于',
  '>': '大于',
  '<=': '小于等于',
  '>=': '大于等于',
  '==': '等于',
  '!=': '不等',
  '&&': '与',
  '||': '或',
};

class Parser {
  private pos = 0;

  constructor(private toks: Tok[]) {}

  private peek(): Tok | null {
    return this.toks[this.pos] ?? null;
  }

  private at(text: string): boolean {
    const t = this.peek();
    return !!t && t.text === text && (t.kind === 'punct' || t.kind === 'name');
  }

  private next(): Tok {
    const t = this.peek();
    if (!t) throw new ParseError('意外的文件结尾');
    this.pos++;
    return t;
  }

  private match(text: string): boolean {
    if (this.at(text)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expect(text: string): Tok {
    if (!this.at(text)) {
      const t = this.peek();
      throw new ParseError(
        `第 ${t?.line ?? 0} 行：期望 "${text}"，实际是 "${t?.text ?? '<结尾>'}"`,
      );
    }
    return this.next();
  }

  private name(): string {
    const t = this.peek();
    if (!t || t.kind !== 'name') {
      throw new ParseError(`第 ${t?.line ?? 0} 行：期望标识符，实际是 "${t?.text ?? '<结尾>'}"`);
    }
    this.pos++;
    return t.text;
  }

  private optSemi(): void {
    this.match(';');
  }

  // ---------------- 类型 ----------------

  private parseType(): Type {
    const n = this.name();
    if (n === 'query') {
      this.expect('<');
      const value = this.name();
      if (!['num', 'vec2', 'entities', 'positions'].includes(value))
        throw new ParseError(`未知查询值类型: ${value}`);
      this.expect('>');
      return T.query(value as 'num' | 'vec2' | 'entities' | 'positions');
    }
    if (n === 'list' || n === '列表') {
      this.expect('<');
      const elem = this.name();
      this.expect(',');
      const capTok = this.next();
      if (capTok.kind !== 'num') throw new ParseError(`第 ${capTok.line} 行：列表容量必须是数字`);
      this.expect('>');
      return T.list(primKindOf(elem), Math.floor(capTok.num));
    }
    return primOf(n);
  }

  // ---------------- 程序 ----------------

  parseProgram(): SpellBook {
    const book: SpellBook = {};
    while (this.peek()) {
      const sp = this.parseSpell();
      if (book[sp.name]) throw new ParseError(`法术重名: ${sp.name}`);
      book[sp.name] = sp;
    }
    return book;
  }

  private parseSpell(): Spell {
    if (!this.match('spell') && !this.match('法术')) {
      const t = this.peek();
      throw new ParseError(`第 ${t?.line ?? 0} 行：期望 spell，实际是 "${t?.text}"`);
    }
    const name = this.name();

    // 生命周期注解：@kind=duration @period=1 @duration=6 @keys=蓄力
    const meta: Partial<Record<keyof SpellMeta, string | number | boolean>> = {};
    while (this.at('@')) {
      this.next();
      const key = this.name();
      this.expect('=');
      const tok = this.next();
      let value: string | number | boolean = tok.text;
      if (tok.kind === 'num') value = tok.num;
      else if (tok.text === 'true' || tok.text === '真') value = true;
      else if (tok.text === 'false' || tok.text === '假') value = false;
      // keys 是字符串数组，需要把 "蓄力,辅助" 拆开
      if (key === 'cooldown') {
        // 兼容旧法术书：接受后丢弃，规范化序列化不再保留法术冷却。
        continue;
      } else if (key === 'keys') {
        (meta as { keys?: string[] }).keys = String(value)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (key === 'key') {
        (meta as { keys?: string[] }).keys = [String(value)];
      } else {
        (meta as Record<string, string | number | boolean>)[key] = value;
      }
    }

    const params: Param[] = [];
    if (this.match('(')) {
      if (!this.at(')')) {
        do {
          const pn = this.name();
          this.expect(':');
          params.push({ name: pn, t: this.parseType() });
        } while (this.match(','));
      }
      this.expect(')');
    }
    let ret: Type | null = null;
    if (this.match('->')) ret = this.parseType();
    const body = this.parseBlock();
    return { name, params, ret, body, tags: [], meta: meta as Partial<SpellMeta> };
  }

  private parseBlock(): Stmt[] {
    this.expect('{');
    const out: Stmt[] = [];
    while (!this.at('}')) {
      if (!this.peek()) throw new ParseError('块未闭合，缺少 }');
      out.push(this.parseStmt());
    }
    this.expect('}');
    return out;
  }

  private parseStmt(): Stmt {
    if (this.at('var') || this.at('变量')) {
      this.next();
      const name = this.name();
      let t: Type | null = null;
      if (this.match(':')) t = this.parseType();
      let init: Expr | null = null;
      if (this.match('=')) init = this.parseExpr();
      this.optSemi();
      return { k: 'decl', name, t, init };
    }

    if (this.at('if') || this.at('若')) {
      this.next();
      const cond = this.parseExpr();
      const then = this.parseBlock();
      let els: Stmt[] | null = null;
      if (this.match('else') || this.match('否则')) {
        if (this.at('if') || this.at('若')) {
          els = [this.parseStmt()];
        } else {
          els = this.parseBlock();
        }
      }
      return { k: 'if', cond, then, els };
    }

    if (this.at('for') || this.at('遍历')) {
      this.next();
      const name = this.name();
      if (!this.match('in') && !this.match('于')) {
        const t = this.peek();
        throw new ParseError(`第 ${t?.line ?? 0} 行：遍历语句应形如 "for x in 列表"`);
      }
      const list = this.parseExpr();
      const body = this.parseBlock();
      return { k: 'for', name, list, body };
    }

    if (this.at('repeat') || this.at('重复')) {
      this.next();
      const t = this.next();
      if (t.kind !== 'num') throw new ParseError(`第 ${t.line} 行：repeat 的次数必须是字面量数字`);
      const body = this.parseBlock();
      return { k: 'repeat', count: Math.floor(t.num), body };
    }

    if (this.at('break') || this.at('中断')) {
      this.next();
      this.optSemi();
      return { k: 'break' };
    }

    if (this.at('free') || this.at('释放')) {
      this.next();
      const name = this.name();
      this.optSemi();
      return { k: 'free', name };
    }

    if (this.at('return') || this.at('返回')) {
      this.next();
      let e: Expr | null = null;
      if (!this.at('}') && !this.at(';')) e = this.parseExpr();
      this.optSemi();
      return { k: 'return', e };
    }

    // 赋值 或 表达式语句
    const e = this.parseExpr();
    if (this.match('=')) {
      const v = this.parseExpr();
      this.optSemi();
      if (e.k === 'var') return { k: 'assign', target: { k: 'var', name: e.name }, e: v };
      if (e.k === 'index') return { k: 'assign', target: { k: 'index', arr: e.arr, i: e.i }, e: v };
      throw new ParseError('赋值号左侧必须是变量或列表元素');
    }
    this.optSemi();
    return { k: 'expr', e };
  }

  // ---------------- 表达式 ----------------

  parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let l = this.parseAnd();
    while (this.at('||')) {
      this.next();
      l = { k: 'call', name: '或', args: [l, this.parseAnd()] };
    }
    return l;
  }

  private parseAnd(): Expr {
    let l = this.parseEq();
    while (this.at('&&')) {
      this.next();
      l = { k: 'call', name: '与', args: [l, this.parseEq()] };
    }
    return l;
  }

  private parseEq(): Expr {
    let l = this.parseRel();
    while (this.at('==') || this.at('!=')) {
      const op = this.next().text;
      l = { k: 'call', name: BIN_OPS[op], args: [l, this.parseRel()] };
    }
    return l;
  }

  private parseRel(): Expr {
    let l = this.parseAdd();
    while (this.at('<') || this.at('>') || this.at('<=') || this.at('>=')) {
      const op = this.next().text;
      l = { k: 'call', name: BIN_OPS[op], args: [l, this.parseAdd()] };
    }
    return l;
  }

  private parseAdd(): Expr {
    let l = this.parseMul();
    while (this.at('+') || this.at('-')) {
      const op = this.next().text;
      l = { k: 'call', name: BIN_OPS[op], args: [l, this.parseMul()] };
    }
    return l;
  }

  private parseMul(): Expr {
    let l = this.parseUnary();
    while (this.at('*') || this.at('/') || this.at('%')) {
      const op = this.next().text;
      l = { k: 'call', name: BIN_OPS[op], args: [l, this.parseUnary()] };
    }
    return l;
  }

  private parseUnary(): Expr {
    if (this.at('-')) {
      this.next();
      return { k: 'call', name: '负', args: [this.parseUnary()] };
    }
    if (this.at('!')) {
      this.next();
      return { k: 'call', name: '非', args: [this.parseUnary()] };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.at('(')) {
        const callLine = this.next().line;
        const args: Expr[] = [];
        if (!this.at(')')) {
          do {
            args.push(this.parseExpr());
          } while (this.match(','));
        }
        this.expect(')');
        if (e.k !== 'var') throw new ParseError('只有具名函数可以被调用');
        e = { k: 'call', name: e.name, args, line: callLine };
      } else if (this.at('[')) {
        this.next();
        const idx = this.parseExpr();
        this.expect(']');
        e = { k: 'index', arr: e, i: idx };
      } else {
        return e;
      }
    }
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (!t) throw new ParseError('意外的结尾');
    if (t.kind === 'num') {
      this.next();
      return { k: 'lit', v: t.num, t: T.num };
    }
    if (this.match('(')) {
      const e = this.parseExpr();
      this.expect(')');
      return e;
    }
    if (t.kind === 'name') {
      if (t.text === 'true' || t.text === '真') {
        this.next();
        return { k: 'lit', v: true, t: T.bool };
      }
      if (t.text === 'false' || t.text === '假') {
        this.next();
        return { k: 'lit', v: false, t: T.bool };
      }
      if (t.text === 'null' || t.text === '空') {
        this.next();
        return { k: 'lit', v: null, t: T.any };
      }
      this.next();
      return { k: 'var', name: t.text };
    }
    throw new ParseError(`第 ${t.line} 行：无法解析的记号 "${t.text}"`);
  }
}

function primKindOf(n: string): 'num' | 'bool' | 'vec2' | 'entity' {
  switch (n) {
    case 'num':
    case '数':
      return 'num';
    case 'bool':
    case '布尔':
      return 'bool';
    case 'vec2':
    case '向量':
      return 'vec2';
    case 'entity':
    case '实体':
      return 'entity';
    default:
      throw new ParseError(`未知类型: ${n}`);
  }
}

function primOf(n: string): Type {
  switch (primKindOf(n)) {
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

export function parseSpellbook(src: string): SpellBook {
  return new Parser(tokenize(src)).parseProgram();
}

// ============================ AST → DSL 序列化 ============================

function serType(t: Type): string {
  if (t.k === 'query') return `query<${t.value}>`;
  if (t.k === 'list') {
    const cap = t.cap < 0 ? '' : `, ${t.cap}`;
    return `list<${t.elem}${cap}>`;
  }
  return t.k;
}

function serExpr(e: Expr): string {
  switch (e.k) {
    case 'lit':
      if (e.v === null) return '空';
      if (typeof e.v === 'boolean') return e.v ? 'true' : 'false';
      return String(e.v);
    case 'var':
      return e.name;
    case 'index':
      return `${serExpr(e.arr)}[${serExpr(e.i)}]`;
    case 'call':
      return `${e.name}(${e.args.map(serExpr).join(', ')})`;
  }
}

function serStmt(s: Stmt, indent: number): string {
  const pad = '  '.repeat(indent);
  switch (s.k) {
    case 'decl': {
      const t = s.t ? `: ${serType(s.t)}` : '';
      const init = s.init ? ` = ${serExpr(s.init)}` : '';
      return `${pad}var ${s.name}${t}${init}`;
    }
    case 'assign':
      if (s.target.k === 'var') return `${pad}${s.target.name} = ${serExpr(s.e)}`;
      return `${pad}${serExpr(s.target.arr)}[${serExpr(s.target.i)}] = ${serExpr(s.e)}`;
    case 'expr':
      return `${pad}${serExpr(s.e)}`;
    case 'if': {
      const thenBody = s.then.map((st) => serStmt(st, indent + 1)).join('\n');
      if (s.els) {
        const elseBody = s.els.map((st) => serStmt(st, indent + 1)).join('\n');
        return `${pad}if ${serExpr(s.cond)} {\n${thenBody}\n${pad}} else {\n${elseBody}\n${pad}}`;
      }
      return `${pad}if ${serExpr(s.cond)} {\n${thenBody}\n${pad}}`;
    }
    case 'for': {
      const body = s.body.map((st) => serStmt(st, indent + 1)).join('\n');
      return `${pad}for ${s.name} in ${serExpr(s.list)} {\n${body}\n${pad}}`;
    }
    case 'repeat': {
      const body = s.body.map((st) => serStmt(st, indent + 1)).join('\n');
      return `${pad}repeat ${s.count} {\n${body}\n${pad}}`;
    }
    case 'break':
      return `${pad}break`;
    case 'free':
      return `${pad}free ${s.name}`;
    case 'return':
      return `${pad}return${s.e ? ' ' + serExpr(s.e) : ''}`;
  }
}

function serAnnotations(spell: Spell): string {
  if (!spell.meta) return '';
  const m = spell.meta;
  const parts: string[] = [];
  if (m.kind) parts.push(`@kind=${m.kind}`);
  if (m.charge) parts.push(`@charge=${m.charge}`);
  if (m.chargeMana !== undefined) parts.push(`@chargeMana=${m.chargeMana}`);
  if (m.period !== undefined) parts.push(`@period=${m.period}`);
  if (m.duration !== undefined) parts.push(`@duration=${m.duration}`);
  if (m.keys && m.keys.length > 0) parts.push(`@keys=${m.keys.join(',')}`);
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

/** 把单个法术序列化回 DSL 文本 */
export function serializeSpell(spell: Spell): string {
  const params = spell.params.length
    ? `(${spell.params.map((p) => `${p.name}: ${serType(p.t)}`).join(', ')})`
    : '';
  const ret = spell.ret ? ` -> ${serType(spell.ret)}` : '';
  const annotations = serAnnotations(spell);
  const body = spell.body.map((st) => serStmt(st, 1)).join('\n');
  // 顺序与解析器一致：spell 名 注解 (参数) -> 返回类型 { 体 }
  return `spell ${spell.name}${annotations}${params}${ret} {\n${body}\n}`;
}

/** 把整本法术书序列化回 DSL 文本 */
export function serializeBook(book: SpellBook): string {
  return Object.values(book).map(serializeSpell).join('\n\n');
}

export { ParseError, DYN_CAP };
