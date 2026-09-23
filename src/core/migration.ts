import type { Expr, SpellBook, Stmt } from './ast';
import { analyzeBook } from './analyzer';
import { parseSpellbook, serializeBook } from './dsl';
import { T } from './types';

export interface MigrationDiagnostic {
  spell: string;
  line: number;
  message: string;
}

export type MigrationResult =
  | { ok: true; source: string; book: SpellBook; diagnostics: [] }
  | { ok: false; source: string; book: SpellBook | null; diagnostics: MigrationDiagnostic[] };

const selfControls: Record<string, string> = {
  疾行: '调整速度',
  增威: '强化伤害',
  洞察: '调整感知',
  护体: '调整护体',
};
const targetControls: Record<string, string> = {
  迟滞: '调整速度',
  虚弱: '强化伤害',
  蔽识: '调整感知',
  破防: '调整护体',
};
const oldChain = new Set(['设置弹道方向', '设置弹道速度', '设置弹道威力', '激活弹道']);

/** 只改写 AST；任一调用无法证明可迁移时，整本书保留原文与最后可运行 AST。 */
export function migrateSpellSource(
  source: string,
  lastRunnable: SpellBook | null = null,
): MigrationResult {
  let parsed: SpellBook;
  try {
    parsed = parseSpellbook(source);
  } catch (error) {
    const message = String(error);
    return {
      ok: false,
      source,
      book: lastRunnable,
      diagnostics: [{ spell: '', line: Number(/第 (\d+) 行/.exec(message)?.[1] ?? 0), message }],
    };
  }
  const diagnostics: MigrationDiagnostic[] = [];
  const lit = (value: number): Expr => ({ k: 'lit', v: value, t: T.num });
  const normalizeExpr = (expr: Expr, spell: string, statement = false): Expr => {
    if (expr.k === 'index')
      return { ...expr, arr: normalizeExpr(expr.arr, spell), i: normalizeExpr(expr.i, spell) };
    if (expr.k !== 'call') return expr;
    const args = expr.args.map((arg) => normalizeExpr(arg, spell));
    const fail = (message: string): Expr => {
      diagnostics.push({ spell, line: expr.line ?? 0, message });
      return expr;
    };
    if (expr.name === '发射') return fail('旧发射仅能作为独立语句迁移');
    if (expr.name === '创建弹道' && args.length === 1)
      return fail('旧一参创建无法单独迁移；句柄状态、激活位置与资源必须同时证明等价');
    if (oldChain.has(expr.name)) return fail('旧弹道控制链无法证明句柄、求值顺序及资源等价');
    if (['明心', '节流', '聚气'].includes(expr.name))
      return fail('该旧自身属性尚无统一控制属性，需保留原文');
    if (expr.name === '设置位置' && args.length === 2) return { ...expr, args: [...args, lit(0)] };
    if (selfControls[expr.name] && args.length === 2) {
      if (!statement) return fail('旧自身属性调用的返回值无法保序转换');
      return {
        ...expr,
        name: selfControls[expr.name],
        args: [{ k: 'call', name: '自身实体', args: [], line: expr.line }, ...args],
      };
    }
    if (targetControls[expr.name] && args.length === 3) {
      const effect =
        expr.name === '破防'
          ? ({ k: 'call', name: '负', args: [args[1]], line: expr.line } as Expr)
          : args[1];
      return { ...expr, name: targetControls[expr.name], args: [args[0], effect, args[2]] };
    }
    return { ...expr, args };
  };
  const normalizeBlock = (stmts: Stmt[], spell: string): Stmt[] =>
    stmts.map((stmt) => {
      switch (stmt.k) {
        case 'decl':
          return { ...stmt, init: stmt.init && normalizeExpr(stmt.init, spell) };
        case 'assign':
          return {
            ...stmt,
            target:
              stmt.target.k === 'index'
                ? {
                    ...stmt.target,
                    arr: normalizeExpr(stmt.target.arr, spell),
                    i: normalizeExpr(stmt.target.i, spell),
                  }
                : stmt.target,
            e: normalizeExpr(stmt.e, spell),
          };
        case 'expr': {
          if (stmt.e.k === 'call' && stmt.e.name === '发射' && stmt.e.args.length === 3) {
            return {
              k: 'expr',
              e: {
                ...stmt.e,
                name: '创建弹道',
                args: [
                  normalizeExpr(stmt.e.args[0], spell),
                  normalizeExpr(stmt.e.args[1], spell),
                  lit(380),
                  normalizeExpr(stmt.e.args[2], spell),
                  lit(2.4),
                ],
              },
            };
          }
          return { ...stmt, e: normalizeExpr(stmt.e, spell, true) };
        }
        case 'if':
          return {
            ...stmt,
            cond: normalizeExpr(stmt.cond, spell),
            then: normalizeBlock(stmt.then, spell),
            els: stmt.els && normalizeBlock(stmt.els, spell),
          };
        case 'for':
          return {
            ...stmt,
            list: normalizeExpr(stmt.list, spell),
            body: normalizeBlock(stmt.body, spell),
          };
        case 'repeat':
          return { ...stmt, body: normalizeBlock(stmt.body, spell) };
        case 'return':
          return { ...stmt, e: stmt.e && normalizeExpr(stmt.e, spell) };
        default:
          return stmt;
      }
    });
  const migrated: SpellBook = Object.fromEntries(
    Object.entries(parsed).map(([name, spell]) => [
      name,
      { ...spell, body: normalizeBlock(spell.body, name) },
    ]),
  );
  if (diagnostics.length) return { ok: false, source, book: lastRunnable, diagnostics };
  for (const [name, cost] of Object.entries(analyzeBook(migrated))) {
    for (const message of cost.errors) diagnostics.push({ spell: name, line: 0, message });
  }
  if (diagnostics.length) return { ok: false, source, book: lastRunnable, diagnostics };
  return { ok: true, source: serializeBook(migrated), book: migrated, diagnostics: [] };
}
