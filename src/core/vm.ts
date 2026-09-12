import { Op } from './compiler';
import type { CompiledFn, Program } from './compiler';

export const DEFAULT_OPTIONS = {
  maxTicks: 600,
  fuel: 200_000,
  maxDepth: 32,
  trace: false,
} satisfies CastOptions;
import type { Value } from './types';
import { asNum } from './meta';
import { allMetas } from './meta';
import type { Ctx } from './meta';
import type { Caster, World } from './world';

export interface CastOptions {
  /** 施法耗时上限（tick），超出即走火入魔 */
  maxTicks: number;
  /** 指令步数上限，防止病态法术卡死主线程 */
  fuel: number;
  /** 最大调用深度 */
  maxDepth: 32;
  /** 单步追踪（推演模式与调试用） */
  trace?: boolean;
}

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

const OP_NAMES: Record<number, string> = {};
for (const [k, v] of Object.entries(Op)) OP_NAMES[v as number] = k;

interface Frame {
  fn: CompiledFn;
  slots: Value[];
  pc: number;
  /** 本帧开始时的栈高度，返回时截断到此处 */
  base: number;
  /** 槽位 → 神识占用（尚未释放的变量） */
  live: Map<number, number>;
}

/**
 * 受限虚拟机。
 *
 * 与通用 VM 的区别：每一步都计价。
 *   - 神识：DECL 时占用、FREE / 返回时归还，超过上限即失败
 *   - 法力：只有元函数（与外界交互）收费
 *   - 耗时：元函数与下标运算计费，纯控制流免费
 *   - fuel：指令步数硬上限
 */
export class VM {
  private metas = allMetas();
  private ctx: Ctx;

  constructor(
    private program: Program,
    world: World,
    private caster: Caster,
  ) {
    this.ctx = { world, caster, log: [] };
  }

  run(entryName?: string, options?: Partial<CastOptions>): CastResult {
    const opts: CastOptions = { ...DEFAULT_OPTIONS, ...options };
    const prog = this.program;
    let entryIdx = prog.entry;
    if (entryName !== undefined) {
      const i = prog.index.get(entryName);
      if (i === undefined) {
        return {
          ok: false,
          mana: 0,
          shenshiPeak: 0,
          ticks: 0,
          steps: 0,
          error: `未定义的法术: ${entryName}`,
          log: [],
          returnValue: null,
        };
      }
      entryIdx = i;
    }

    const stack: Value[] = [];
    const frames: Frame[] = [];
    const log = this.ctx.log;
    log.length = 0;

    let shenshiCur = 0;
    let shenshiPeak = 0;
    let mana = 0;
    let ticks = 0;
    let steps = 0;
    let returnValue: Value = null;

    const caster = this.caster;

    const fail = (reason: string): CastResult => ({
      ok: false,
      mana,
      shenshiPeak,
      ticks,
      steps,
      error: reason,
      log: [...log],
      returnValue: null,
    });

    const pushFrame = (idx: number, argc: number): string | null => {
      if (frames.length >= opts.maxDepth) return '轮回过深：神识无法承载更深层的调用';
      const fn = prog.fns[idx];
      const args: Value[] = new Array(argc);
      for (let i = argc - 1; i >= 0; i--) args[i] = stack.pop() ?? null;
      const slots: Value[] = new Array(fn.slotCount).fill(null);
      for (let i = 0; i < argc; i++) slots[i] = args[i];
      frames.push({ fn, slots, pc: 0, base: stack.length, live: new Map() });
      ticks += 1; // 调用本身的开销
      return null;
    };

    pushFrame(entryIdx, 0);

    for (;;) {
      if (frames.length === 0) break;
      const f = frames[frames.length - 1];
      const code = f.fn.code;
      if (f.pc >= code.length) {
        // 隐式返回
        for (const size of f.live.values()) shenshiCur -= size;
        f.live.clear();
        stack.length = f.base;
        frames.pop();
        if (frames.length === 0) break;
        stack.push(null);
        continue;
      }

      const inst = code[f.pc++];
      steps++;
      if (opts.trace) {
        console.log(
          `${String(f.pc - 1).padStart(3)} ${(OP_NAMES[inst.op] ?? inst.op).padEnd(9)}` +
            ` a=${inst.a ?? ''} b=${inst.b ?? ''} | 栈深 ${stack.length}` +
            ` 神识 ${shenshiCur} 法力 ${mana} 耗时 ${ticks}`,
        );
      }
      if (steps > opts.fuel) return fail(`神识溃散：指令数超过上限 ${opts.fuel}`);

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
          shenshiCur += size;
          if (shenshiCur > caster.shenshiMax) {
            return fail(`神识不足：需要 ${shenshiCur}，上限 ${caster.shenshiMax}`);
          }
          if (shenshiCur > shenshiPeak) shenshiPeak = shenshiCur;
          f.live.set(slot, size);
          break;
        }

        case Op.FREE: {
          const slot = inst.a ?? 0;
          const size = f.live.get(slot);
          if (size !== undefined) {
            f.live.delete(slot);
            shenshiCur -= size;
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
          ticks += 1;
          if (ticks > opts.maxTicks) return fail(`施法超时：超过 ${opts.maxTicks} tick`);
          stack.push(Array.isArray(arr) ? (arr[idx] ?? null) : null);
          break;
        }

        case Op.SETIDX: {
          const v = stack.pop() ?? null;
          const idx = asNum(stack.pop() ?? null);
          const arr = stack.pop();
          ticks += 1;
          if (ticks > opts.maxTicks) return fail(`施法超时：超过 ${opts.maxTicks} tick`);
          if (Array.isArray(arr)) arr[idx] = v;
          break;
        }

        case Op.CALLMETA: {
          const m = this.metas[inst.a ?? 0];
          const argc = inst.b ?? 0;
          const args: Value[] = new Array(argc);
          for (let i = argc - 1; i >= 0; i--) args[i] = stack.pop() ?? null;
          mana += m.mana;
          if (mana > caster.mana) {
            return fail(`法力不足：需要 ${mana}，仅有 ${caster.mana}`);
          }
          ticks += m.ticks;
          if (ticks > opts.maxTicks) return fail(`施法超时：超过 ${opts.maxTicks} tick`);
          stack.push(m.impl(this.ctx, args));
          break;
        }

        case Op.CALLUSER: {
          const err = pushFrame(inst.a ?? 0, inst.b ?? 0);
          if (err) return fail(err);
          if (ticks > opts.maxTicks) return fail(`施法超时：超过 ${opts.maxTicks} tick`);
          break;
        }

        case Op.JMP:
          f.pc = inst.a ?? 0;
          break;

        case Op.JMPIFNOT: {
          const c = stack.pop();
          if (c !== true) f.pc = inst.a ?? 0;
          break;
        }

        case Op.RET: {
          const hasVal = (inst.a ?? 0) === 1;
          const val = hasVal ? (stack.pop() ?? null) : null;
          for (const size of f.live.values()) shenshiCur -= size;
          f.live.clear();
          stack.length = f.base;
          frames.pop();
          if (frames.length === 0) {
            returnValue = val;
            break;
          }
          stack.push(val);
          break;
        }
      }
    }

    return {
      ok: true,
      mana,
      shenshiPeak,
      ticks,
      steps,
      error: null,
      log: [...log],
      returnValue,
    };
  }
}

/**
 * 施展一次法术：计量并真正结算资源。
 * 成功则扣除法力；失败（走火入魔）则法力枯竭并留下反噬记录。
 */
export function castSpell(
  program: Program,
  entry: string,
  world: World,
  caster: Caster,
  opts?: Partial<CastOptions>,
): CastResult {
  const vm = new VM(program, world, caster);
  const r = vm.run(entry, opts);
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
