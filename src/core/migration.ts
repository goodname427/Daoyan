import type { Expr, SpellBook, Stmt } from './ast';
import { analyzeBook } from './analyzer';
import { parseSpellbook, serializeBook } from './dsl';

export interface MigrationDiagnostic {
  spell: string;
  line: number;
  message: string;
}

export type MigrationResult =
  | { ok: true; source: string; book: SpellBook; diagnostics: [] }
  | { ok: false; source: string; book: SpellBook | null; diagnostics: MigrationDiagnostic[] };

const selfControls = new Set(['疾行', '增威', '洞察', '护体']);
const targetControls = new Set(['迟滞', '虚弱', '蔽识', '破防']);
const oldChain = new Set(['设置弹道方向', '设置弹道速度', '设置弹道威力', '激活弹道']);
const oldReads = new Set(['探查', '生命', '自身法力率', '感知敌人', '快照']);
const changedLegacyCalls = new Set(['自身位置', '准星方向', '移动', '瞬移']);
const changedLegacyControls = new Set(['调整速度', '强化伤害', '设置朝向', '设置位置']);

function oldLaunchCostDetail(args: Expr[]): string {
  const power = args[2];
  if (
    power?.k !== 'lit' ||
    typeof power.v !== 'number' ||
    !Number.isFinite(power.v) ||
    power.v <= 0
  ) {
    return '旧价为 10 + 0.15×威力；新版还需初始运动 2 E 与按实际威力预付的 damage 池';
  }
  const oldMana = 10 + 0.15 * power.v;
  const fundingMana = 2 / 0.8 + 2 / 1_000_000 + power.v / 0.8 + 2 / 1_000_000;
  return `威力倍率为 1 时旧创建价 ${oldMana} 法力，新版仅运动及单次伤害注能至少 ${fundingMana.toFixed(6)} 法力，缺少已付款储能`;
}

/** 只改写 AST；任一调用无法证明可迁移时，整本书保留原文与最后可运行 AST。 */
export function migrateSpellSource(
  source: string,
  lastRunnable: SpellBook | null = null,
  legacySemantics = false,
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
  const normalizeExpr = (expr: Expr, spell: string): Expr => {
    if (expr.k === 'index')
      return { ...expr, arr: normalizeExpr(expr.arr, spell), i: normalizeExpr(expr.i, spell) };
    if (expr.k !== 'call') return expr;
    const fail = (message: string): Expr => {
      diagnostics.push({ spell, line: expr.line ?? 0, message });
      return expr;
    };
    if (expr.name === '发射')
      return fail(
        `旧发射的固定伤害与初始冲量：${oldLaunchCostDetail(expr.args)}；新五参创建增加不可折扣注能及 tick，无法证明资源等价`,
      );
    if (legacySemantics && expr.name === '创建弹道' && expr.args.length === 5)
      return fail(
        '旧五参创建的固定伤害与速度缺少储能来源；新创建的付款、tick 与失败分支无法证明等价',
      );
    if (expr.name === '创建弹道' && expr.args.length === 1)
      return fail('旧一参创建无法单独迁移；句柄状态、激活位置与资源必须同时证明等价');
    if (oldChain.has(expr.name)) return fail('旧弹道控制链无法证明句柄、求值顺序及资源等价');
    if (oldReads.has(expr.name))
      return fail(`旧读取「${expr.name}」的权限、结果分支或付费时刻无法证明等价，须显式迁移`);
    if (legacySemantics && changedLegacyCalls.has(expr.name))
      return fail(`旧调用「${expr.name}」的资源价格或位置效果已变，无法证明等价`);
    if (['明心', '节流', '聚气'].includes(expr.name))
      return fail('该旧自身属性尚无统一控制属性，需保留原文');
    if (expr.name === '设置位置' && expr.args.length === 2)
      return fail('旧两参位置与新版控制的权限、提交及资源价格不同，无法证明等价');
    if (legacySemantics && changedLegacyControls.has(expr.name))
      return fail(`旧控制「${expr.name}」的速度、伤害、位置或资源合同无法证明等价`);
    if (selfControls.has(expr.name) && expr.args.length === 2) {
      return fail('旧自身属性倍率与新版维护控制的付款、期限及返回值无法证明等价');
    }
    if (targetControls.has(expr.name) && expr.args.length === 3) {
      return fail('旧目标属性控制与新版抗性、价格及生命周期无法证明等价');
    }
    if (legacySemantics && expr.name.startsWith('按键'))
      return fail('旧按键状态需要会话、边沿及蓄力时序证明，普通存档不能重建');
    return { ...expr, args: expr.args.map((arg) => normalizeExpr(arg, spell)) };
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
          return { ...stmt, e: normalizeExpr(stmt.e, spell) };
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
  if (legacySemantics) {
    const lines = source.split(/\r?\n/);
    for (const [name, spell] of Object.entries(parsed)) {
      if (!spell.meta?.keys?.length) continue;
      const index = lines.findIndex(
        (line) => line.includes(`spell ${name}`) && /@keys?=/.test(line),
      );
      diagnostics.push({
        spell: name,
        line: index + 1,
        message: '旧按键法术的输入边沿与会话时序无法从存档证明等价',
      });
    }
  }
  if (diagnostics.length) return { ok: false, source, book: lastRunnable, diagnostics };
  for (const [name, cost] of Object.entries(analyzeBook(migrated))) {
    for (const message of cost.errors) diagnostics.push({ spell: name, line: 0, message });
  }
  if (diagnostics.length) return { ok: false, source, book: lastRunnable, diagnostics };
  return { ok: true, source: serializeBook(migrated), book: migrated, diagnostics: [] };
}
