import { Op } from './compiler';
import type { CompiledFn, Program } from './compiler';
import type { Value } from './types';
import { asNum, knownCostArg } from './meta';
import { allMetas } from './meta';
import type { Ctx } from './meta';
import type { Actor, World } from './world';
import type { KeyState } from './input';

/** 一个 tick 代表多少毫秒的施法时间 */
export const TICK_MS = 10;

export interface CastOptions {
  /** 施法耗时上限（tick），超出即走火入魔 */
  maxTicks: number;
  /** 指令步数上限，防止病态法术卡死主线程 */
  fuel: number;
  /** 最大调用深度 */
  maxDepth: 32;
  /** 单步追踪（推演模式与调试用） */
  trace?: boolean;
  /** 战斗层可注入的共享资源账户；推演台不注入时使用本次 VM 的独立预算 */
  resources?: CastResourceHooks;
}

export interface CastResourceHooks {
  trySpendMana(amount: number): boolean;
  tryReserveShenshi(amount: number): boolean;
  releaseShenshi(amount: number): void;
}

export const DEFAULT_OPTIONS = {
  maxTicks: 600,
  fuel: 200_000,
  maxDepth: 32,
  trace: false,
} satisfies CastOptions;

export interface CastResult {
  ok: boolean;
  /** 实际法力消耗 */
  mana: number;
  /** 实际神识峰值 */
  shenshiPeak: number;
  /** 实际耗时（tick） */
  ticks: number;
  /** 执行指令数 */
  steps: number;
  /** 失败原因（走火入魔） */
  error: string | null;
  log: string[];
  returnValue: Value;
}

/** 单步推演完成后的只读观察点。 */
export interface VMSnapshot {
  status: CastStatus;
  /** 刚刚执行的函数与指令；启动后、执行前为 null。 */
  instruction: { fn: string; pc: number; op: string } | null;
  mana: number;
  shenshi: number;
  shenshiPeak: number;
  ticks: number;
  steps: number;
  variables: Array<{ name: string; value: Value }>;
}

interface Frame {
  fn: CompiledFn;
  slots: Value[];
  pc: number;
  /** 本帧开始时的栈高度，返回时截断到此处 */
  base: number;
  /** 槽位 → 尚未释放变量的资源占用与声明时名称。 */
  live: Map<number, { size: number; name: string }>;
}

const OP_NAMES: Record<number, string> = {};
for (const [k, v] of Object.entries(Op)) OP_NAMES[v as number] = k;

export type CastStatus = 'idle' | 'running' | 'done' | 'failed';

/**
 * 受限虚拟机。
 *
 * 与通用 VM 的区别：
 *   1. 每一步都计价（神识 / 法力 / 耗时 / fuel）
 *   2. **可中断**：`advance(tickBudget)` 分帧推进，使「施法耗时」成为真实时间，
 *      也让「受伤打断施法」成为可能 —— 这是「躲位」玩法成立的前提
 */
export class VM {
  private metas = allMetas();
  private ctx: Ctx;
  private opts: CastOptions;

  private stack: Value[] = [];
  private frames: Frame[] = [];
  private shenshiCur = 0;
  private shenshiPeak = 0;
  private manaSpent = 0;
  private manaBudget = 0;
  private ticksUsed = 0;
  private steps = 0;
  private status: CastStatus = 'idle';
  private error: string | null = null;
  private returnValue: Value = null;
  private entryName = '';
  private lastInstruction: VMSnapshot['instruction'] = null;

  constructor(
    private program: Program,
    world: World,
    private caster: Actor,
    options?: Partial<CastOptions>,
  ) {
    this.ctx = { world, caster, log: [], keys: null, endRequested: false };
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 接入按键状态（duration / 键位法术用）。引用共享，战斗层原地修改即可 */
  setKeyState(keys: KeyState[] | null): void {
    this.ctx.keys = keys;
  }

  get endRequested(): boolean {
    return this.ctx.endRequested;
  }

  // ---------------- 生命周期 ----------------

  start(entryName?: string): void {
    this.releaseAllShenshi();
    const prog = this.program;
    let entryIdx = prog.entry;
    if (entryName !== undefined) {
      const i = prog.index.get(entryName);
      if (i === undefined) {
        this.status = 'failed';
        this.error = `未定义的法术: ${entryName}`;
        return;
      }
      entryIdx = i;
      this.entryName = entryName;
    } else {
      this.entryName = prog.fns[prog.entry]?.name ?? '';
    }

    this.stack = [];
    this.frames = [];
    this.shenshiCur = 0;
    this.shenshiPeak = 0;
    this.manaSpent = 0;
    this.manaBudget = this.caster.mana;
    this.ticksUsed = 0;
    this.steps = 0;
    this.error = null;
    this.returnValue = null;
    this.lastInstruction = null;
    this.ctx.log.length = 0;
    this.status = 'running';
    this.pushFrame(entryIdx, 0);
  }

  /** 一次性执行到底（推演台、测试、无头沙盒用） */
  run(entryName?: string): CastResult {
    this.start(entryName);
    while (this.status === 'running') this.execOne();
    return this.result();
  }

  /** 执行恰好一条指令，并返回可供推演台展示的观察点。 */
  step(): VMSnapshot {
    this.execOne();
    return this.snapshot();
  }

  /** 获取当前观察点，不会推进 VM。 */
  snapshot(): VMSnapshot {
    const frame = this.frames[this.frames.length - 1];
    return {
      status: this.status,
      instruction: this.lastInstruction,
      mana: this.manaSpent,
      shenshi: this.shenshiCur,
      shenshiPeak: this.shenshiPeak,
      ticks: this.ticksUsed,
      steps: this.steps,
      variables: frame
        ? frame.slots.flatMap((value, slot) =>
            frame.live.has(slot)
              ? [{ name: frame.live.get(slot)?.name ?? `槽位 ${slot}`, value }]
              : [],
          )
        : [],
    };
  }

  /**
   * 推进最多 tickBudget 个 tick，返回实际推进的 tick 数。
   * 每帧调用一次，即可把「耗时」映射成真实的施法时间。
   */
  advance(tickBudget: number, stepCap = 20_000): number {
    if (this.status !== 'running') return 0;
    const startTicks = this.ticksUsed;
    const startSteps = this.steps;
    while (this.status === 'running') {
      this.execOne();
      if (this.ticksUsed - startTicks >= tickBudget) break;
      if (this.steps - startSteps >= stepCap) break;
    }
    return this.ticksUsed - startTicks;
  }

  result(): CastResult {
    return {
      ok: this.status === 'done',
      mana: this.manaSpent,
      shenshiPeak: this.shenshiPeak,
      ticks: this.ticksUsed,
      steps: this.steps,
      error: this.error,
      log: [...this.ctx.log],
      returnValue: this.returnValue,
    };
  }

  // ---------------- 只读状态 ----------------

  get isRunning(): boolean {
    return this.status === 'running';
  }
  get isDone(): boolean {
    return this.status === 'done' || this.status === 'failed';
  }
  get spellName(): string {
    return this.entryName;
  }
  /** 已消耗法力（战斗层每帧按增量扣减，被打断时已消耗部分不退） */
  get spentMana(): number {
    return this.manaSpent;
  }
  get spentTicks(): number {
    return this.ticksUsed;
  }
  get peakShenshi(): number {
    return this.shenshiPeak;
  }
  get failure(): string | null {
    return this.error;
  }

  /** 战斗打断或重置时显式结束，并归还仍由本 VM 占用的共享神识。 */
  cancel(): void {
    if (this.status !== 'running') return;
    this.releaseAllShenshi();
    this.frames = [];
    this.status = 'done';
  }

  // ---------------- 内部 ----------------

  private fail(reason: string): void {
    this.status = 'failed';
    this.error = reason;
    this.releaseAllShenshi();
    this.frames = [];
  }

  private releaseAllShenshi(): void {
    for (const frame of this.frames) {
      for (const variable of frame.live.values()) this.releaseShenshi(variable.size);
      frame.live.clear();
    }
  }

  private releaseShenshi(amount: number): void {
    this.shenshiCur = Math.max(0, this.shenshiCur - amount);
    this.opts.resources?.releaseShenshi(amount);
  }

  private pushFrame(idx: number, argc: number): string | null {
    if (this.frames.length >= this.opts.maxDepth) return '轮回过深：神识无法承载更深层的调用';
    const fn = this.program.fns[idx];
    const args: Value[] = new Array(argc);
    for (let i = argc - 1; i >= 0; i--) args[i] = this.stack.pop() ?? null;
    const slots: Value[] = new Array(fn.slotCount).fill(null);
    for (let i = 0; i < argc; i++) slots[i] = args[i];
    this.frames.push({ fn, slots, pc: 0, base: this.stack.length, live: new Map() });
    this.ticksUsed += 1; // 调用本身的开销
    return null;
  }

  private execOne(): void {
    if (this.frames.length === 0) {
      this.status = 'done';
      return;
    }
    const f = this.frames[this.frames.length - 1];
    const code = f.fn.code;
    if (f.pc >= code.length) {
      // 隐式返回
      for (const variable of f.live.values()) this.releaseShenshi(variable.size);
      f.live.clear();
      this.stack.length = f.base;
      this.frames.pop();
      if (this.frames.length === 0) this.status = 'done';
      else this.stack.push(null);
      return;
    }

    const inst = code[f.pc++];
    this.steps++;
    this.lastInstruction = {
      fn: f.fn.name,
      pc: f.pc - 1,
      op: OP_NAMES[inst.op] ?? String(inst.op),
    };
    if (this.opts.trace) {
      console.log(
        `${String(f.pc - 1).padStart(3)} ${(OP_NAMES[inst.op] ?? inst.op).padEnd(9)}` +
          ` a=${inst.a ?? ''} b=${inst.b ?? ''} | 栈深 ${this.stack.length}` +
          ` 神识 ${this.shenshiCur} 法力 ${this.manaSpent} 耗时 ${this.ticksUsed}`,
      );
    }
    if (this.steps > this.opts.fuel) {
      this.fail(`神识溃散：指令数超过上限 ${this.opts.fuel}`);
      return;
    }

    const stack = this.stack;
    const opts = this.opts;

    switch (inst.op) {
      case Op.PUSHK:
        stack.push(f.fn.consts[inst.a ?? 0]);
        break;

      case Op.LDSLOT:
        stack.push(f.slots[inst.a ?? 0] ?? null);
        break;

      case Op.STSLOT: {
        const v = stack.pop() ?? null;
        f.slots[inst.a ?? 0] = v;
        break;
      }

      case Op.TRUNC: {
        const v = stack.pop();
        stack.push(Array.isArray(v) ? v.slice(0, inst.a ?? 0) : (v ?? null));
        break;
      }

      case Op.DECL: {
        const slot = inst.a ?? 0;
        const size = inst.b ?? 0;
        const cap = this.caster.attr.shenshiMax;
        const next = this.shenshiCur + size;
        const reserved = this.opts.resources
          ? this.opts.resources.tryReserveShenshi(size)
          : next <= cap;
        if (!reserved) {
          this.fail(`神识不足：本次还需 ${size}，上限 ${cap}`);
          return;
        }
        this.shenshiCur = next;
        if (this.shenshiCur > this.shenshiPeak) this.shenshiPeak = this.shenshiCur;
        if (!inst.preserveValue) f.slots[slot] = null;
        f.live.set(slot, { size, name: inst.name ?? f.fn.slotNames[slot] ?? `槽位 ${slot}` });
        break;
      }

      case Op.FREE: {
        const slot = inst.a ?? 0;
        const variable = f.live.get(slot);
        if (variable !== undefined) {
          f.live.delete(slot);
          this.releaseShenshi(variable.size);
        }
        break;
      }

      case Op.POP:
        stack.pop();
        break;

      case Op.SWAP: {
        const a = stack.pop() ?? null;
        const b = stack.pop() ?? null;
        stack.push(a);
        stack.push(b);
        break;
      }

      case Op.PEEK: {
        const d = inst.a ?? 0;
        stack.push(stack[stack.length - 1 - d] ?? null);
        break;
      }

      case Op.INCTOP: {
        const i = stack.length - 1;
        stack[i] = asNum(stack[i]) + 1;
        break;
      }

      case Op.DECTOP: {
        const i = stack.length - 1;
        stack[i] = asNum(stack[i]) - 1;
        break;
      }

      case Op.IDX: {
        const idx = asNum(stack.pop() ?? null);
        const arr = stack.pop();
        this.ticksUsed += 1;
        if (this.ticksUsed > opts.maxTicks) {
          this.fail(`施法超时：超过 ${opts.maxTicks} tick`);
          return;
        }
        stack.push(Array.isArray(arr) ? (arr[idx] ?? null) : null);
        break;
      }

      case Op.SETIDX: {
        const v = stack.pop() ?? null;
        const idx = asNum(stack.pop() ?? null);
        const arr = stack.pop();
        this.ticksUsed += 1;
        if (this.ticksUsed > opts.maxTicks) {
          this.fail(`施法超时：超过 ${opts.maxTicks} tick`);
          return;
        }
        if (Array.isArray(arr)) arr[idx] = v;
        break;
      }

      case Op.CALLMETA: {
        const m = this.metas[inst.a ?? 0];
        const argc = inst.b ?? 0;
        const args: Value[] = new Array(argc);
        for (let i = argc - 1; i >= 0; i--) args[i] = stack.pop() ?? null;
        let baseCost = m.mana;
        let tickCost = m.ticks;
        if (m.cost) {
          try {
            const dynamic = m.cost(this.ctx, args.map(knownCostArg));
            if (dynamic.mana.dynamic || dynamic.ticks.dynamic) {
              this.fail(`元函数「${m.name}」运行时定价仍包含未知项`);
              return;
            }
            baseCost = dynamic.mana.value;
            tickCost = dynamic.ticks.value;
          } catch (error) {
            this.fail(`元函数「${m.name}」动态定价失败：${String(error)}`);
            return;
          }
          if (
            !Number.isFinite(baseCost) ||
            baseCost < 0 ||
            !Number.isFinite(tickCost) ||
            tickCost < 0 ||
            !Number.isInteger(tickCost)
          ) {
            this.fail(`元函数「${m.name}」返回非法动态消耗：法力 ${baseCost}，耗时 ${tickCost}`);
            return;
          }
        } else if (m.manaCost) {
          try {
            baseCost = m.manaCost(this.ctx, args);
          } catch (error) {
            this.fail(`元函数「${m.name}」动态定价失败：${String(error)}`);
            return;
          }
          if (!Number.isFinite(baseCost) || baseCost < 0 || baseCost > m.mana) {
            this.fail(`元函数「${m.name}」动态法力 ${baseCost} 超出静态上界 ${m.mana}`);
            return;
          }
        }
        // 法力受「法力消耗」属性影响；动态基础价也不得越过注册时声明的上界。
        const cost = baseCost * this.caster.attr.manaCostMul;
        const paid = this.opts.resources
          ? this.opts.resources.trySpendMana(cost)
          : this.manaSpent + cost <= this.manaBudget;
        if (!paid) {
          this.fail(`法力不足：本次还需 ${Math.round(cost)}，仅有 ${Math.round(this.caster.mana)}`);
          return;
        }
        this.manaSpent += cost;
        this.ticksUsed += tickCost;
        if (this.ticksUsed > opts.maxTicks) {
          this.fail(`施法超时：超过 ${opts.maxTicks} tick`);
          return;
        }
        stack.push(m.impl(this.ctx, args));
        // 「结束施法」元函数会让当前施法立即结束
        if (this.ctx.endRequested) {
          this.status = 'done';
          return;
        }
        break;
      }

      case Op.CALLUSER: {
        const err = this.pushFrame(inst.a ?? 0, inst.b ?? 0);
        if (err) {
          this.fail(err);
          return;
        }
        if (this.ticksUsed > opts.maxTicks) {
          this.fail(`施法超时：超过 ${opts.maxTicks} tick`);
          return;
        }
        break;
      }

      case Op.JMP:
        f.pc = inst.a ?? 0;
        break;

      case Op.JMPIFNOT: {
        const c = stack.pop();
        // 用户条件经分析器保证为 bool；编译器内部的 repeat 计数器则是正数。
        const truthy = c === true || (typeof c === 'number' && c > 0);
        if (!truthy) f.pc = inst.a ?? 0;
        break;
      }

      case Op.RET: {
        const hasVal = (inst.a ?? 0) === 1;
        const val = hasVal ? (stack.pop() ?? null) : null;
        for (const variable of f.live.values()) this.releaseShenshi(variable.size);
        f.live.clear();
        stack.length = f.base;
        this.frames.pop();
        if (this.frames.length === 0) {
          this.returnValue = val;
          this.status = 'done';
          return;
        }
        stack.push(val);
        break;
      }
    }
  }
}

/**
 * 一次性施展并结算（推演台 / 测试用）。
 * 成功扣法力；失败（走火入魔）法力枯竭。
 */
export function castSpell(
  program: Program,
  entry: string,
  world: World,
  caster: Actor,
  opts?: Partial<CastOptions>,
): CastResult {
  const vm = new VM(program, world, caster, opts);
  const r = vm.run(entry);
  if (r.ok) {
    caster.mana = Math.max(0, caster.mana - r.mana);
    world.events.push(
      `施展「${entry}」：法力 -${r.mana}，神识峰值 ${r.shenshiPeak}，耗时 ${r.ticks} tick`,
    );
  } else {
    caster.mana = 0;
    world.events.push(`走火入魔：「${entry}」失败 —— ${r.error}`);
  }
  return r;
}
