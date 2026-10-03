import { compileProgram } from '../core/index';
import type { Expr, Program, SpellBook, Stmt } from '../core/index';

/** Compile an entry and every same-book spell it can call into one canonical program. */
export function compileFiniteProgram(book: SpellBook, entry: string): Program {
  const reachable = new Set<string>();
  const visitSpell = (name: string): void => {
    if (reachable.has(name)) return;
    if (!Object.hasOwn(book, name)) throw new Error(`入口或依赖法术不存在：${name}`);
    const spell = book[name];
    reachable.add(name);
    visitBlock(spell.body);
  };
  const visitExpr = (expr: Expr): void => {
    switch (expr.k) {
      case 'call':
        if (Object.hasOwn(book, expr.name)) visitSpell(expr.name);
        expr.args.forEach(visitExpr);
        break;
      case 'index':
        visitExpr(expr.arr);
        visitExpr(expr.i);
        break;
    }
  };
  const visitBlock = (block: Stmt[]): void => {
    for (const stmt of block) {
      switch (stmt.k) {
        case 'decl':
          if (stmt.init) visitExpr(stmt.init);
          break;
        case 'assign':
          if (stmt.target.k === 'index') {
            visitExpr(stmt.target.arr);
            visitExpr(stmt.target.i);
          }
          visitExpr(stmt.e);
          break;
        case 'expr':
          visitExpr(stmt.e);
          break;
        case 'if':
          visitExpr(stmt.cond);
          visitBlock(stmt.then);
          if (stmt.els) visitBlock(stmt.els);
          break;
        case 'for':
          visitExpr(stmt.list);
          visitBlock(stmt.body);
          break;
        case 'repeat':
          visitBlock(stmt.body);
          break;
        case 'return':
          if (stmt.e) visitExpr(stmt.e);
          break;
      }
    }
  };

  visitSpell(entry);
  const selected: SpellBook = {};
  for (const name of reachable) selected[name] = book[name];
  return compileProgram(selected, entry);
}
