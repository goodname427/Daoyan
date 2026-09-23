import { dynamicCost, fixedCost, type CostAmount, type CostArg, type MetaCost } from './meta';
import type { ControlMode, ControlPropertyKey, ControlWritePolicy } from './attributes';
import type { Actor, ControlRecord, World } from './world';
import type { SenseQuote } from './world';
import type { Vec2 } from './types';

export interface EffectTerm {
  index: number;
  manaPer: number;
  /** 每达到一个单位增加 1 tick；省略时该参数只影响法力。 */
  tickUnit?: number;
  measure?: (value: number) => number;
}

function measured(arg: CostArg | undefined, measure?: (value: number) => number): CostAmount {
  if (!arg?.known) return dynamicCost();
  if (typeof arg.value !== 'number' || !Number.isFinite(arg.value)) return fixedCost(0);
  const value = measure ? measure(arg.value) : Math.max(0, arg.value);
  return Number.isFinite(value) && value > 0 ? fixedCost(value) : fixedCost(0);
}

/**
 * 请求效果的共享线性定价器。它没有最大效果值：更大的有限请求始终继续增加
 * 法力，并可通过 tickUnit 同时增加施法时间。
 */
export function effectCost(
  args: readonly CostArg[],
  baseMana: number,
  baseTicks: number,
  terms: readonly EffectTerm[],
): MetaCost {
  let mana = baseMana;
  let ticks = baseTicks;
  let manaDynamic = false;
  let tickDynamic = false;
  for (const term of terms) {
    const amount = measured(args[term.index], term.measure);
    mana += amount.value * term.manaPer;
    manaDynamic ||= amount.dynamic;
    if (term.tickUnit) {
      ticks += Math.ceil(amount.value / term.tickUnit);
      tickDynamic ||= amount.dynamic;
    }
  }
  return {
    mana: { value: mana, dynamic: manaDynamic },
    ticks: { value: ticks, dynamic: tickDynamic },
  };
}

export const multiplierMagnitude = (value: number): number =>
  value > 0 ? Math.abs(Math.log2(value)) : 0;

export function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export const SENSE_ATTEMPT_PRICE: MetaCost = {
  mana: fixedCost(1),
  ticks: fixedCost(1),
  undiscountedMana: fixedCost(1),
};

/** 探查成功价已包含尝试价；所有输入均是授权给读者的公开报价。 */
export function sensePrice(quote: SenseQuote): MetaCost {
  if (quote.privateSelf) return SENSE_ATTEMPT_PRICE;
  const {
    distance: d,
    relation: a,
    targetShenshi: rt,
    readerShenshi: sa,
    resistance: r,
    level: l,
  } = quote;
  if (
    ![d, rt, sa, r].every(Number.isFinite) ||
    d < 0 ||
    rt < 0 ||
    sa <= 0 ||
    r < 0 ||
    ![1, 2, 8].includes(a) ||
    ![0, 1, 2].includes(l)
  )
    throw new RangeError('非法探查价格参数');
  const gate = a === 8 ? 4 : 0;
  const mana = Math.ceil(gate + a * (1 + d / 120 + 2 * l + Math.max(0, rt - sa) / 8 + r));
  const ticks = Math.ceil(gate + a * (1 + d / 240 + l + Math.max(0, rt - sa) / 16 + r / 2));
  if (!Number.isSafeInteger(mana) || !Number.isSafeInteger(ticks))
    throw new RangeError('探查价格溢出');
  return { mana: fixedCost(mana), ticks: fixedCost(ticks), undiscountedMana: fixedCost(mana) };
}

export const CONTROL_PERIOD_SECONDS = 0.25 as const;

/** 同一法力价格函数用于静态上界（倍率取安全域最大值）和实扣。未声明可折扣的费用全额支付。 */
export function payableMana(base: number, fixed: number | null, multiplier: number): number {
  if (
    !Number.isFinite(base) ||
    base < 0 ||
    !Number.isFinite(fixed ?? 0) ||
    (fixed !== null && (fixed < 1 || fixed > base))
  )
    throw new RangeError('非法法力价格');
  if (fixed === null) return base;
  if (!Number.isFinite(multiplier) || multiplier < 0.25 || multiplier > 4)
    throw new RangeError('非法法力费用倍率');
  const amount = fixed + (base - fixed) * multiplier;
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError('法力价格溢出');
  return amount;
}

/** 弹道参考速率 380；做功与操控损耗都须在冲量发布前付款。 */
export function impulseEnergy(velocity: Vec2, delta: Vec2): number {
  const nextX = velocity.x + delta.x;
  const nextY = velocity.y + delta.y;
  const work = Math.max(
    0,
    (nextX * nextX + nextY * nextY - velocity.x * velocity.x - velocity.y * velocity.y) /
      (380 * 380),
  );
  const control = (delta.x * delta.x + delta.y * delta.y) / (380 * 380);
  const energy = work + control;
  if (!Number.isFinite(energy)) throw new RangeError('冲量价格溢出');
  return energy;
}

/** 独立传送价格；动态预算由调用方标记。 */
export function teleportPrice(distance: number, relation: number, resistance: number): MetaCost {
  if (
    ![distance, relation, resistance].every(Number.isFinite) ||
    distance < 0 ||
    resistance < 0 ||
    ![1, 2, 8].includes(relation)
  )
    throw new RangeError('非法传送价格参数');
  const gate = relation === 8 ? 4 : 0;
  const mana = gate + relation * (20 + distance / 10) * (1 + resistance);
  const ticks = Math.ceil(gate + relation * (4 + distance / 50) * (1 + resistance));
  if (!Number.isFinite(mana) || !Number.isSafeInteger(ticks)) throw new RangeError('传送价格溢出');
  return { mana: fixedCost(mana), ticks: fixedCost(ticks) };
}

/** null 表示分析阶段尚不能确定；运行阶段必须全部解析。 */
export interface ControlPriceInput {
  propertyKey?: ControlPropertyKey;
  relation: number | null;
  resistance: number | null;
  strength: number | null;
  duration: number | null;
  mode: ControlMode | null;
  writePolicy: ControlWritePolicy | null;
  /** 仅实扣当前周期时为 true；静态预算必须保留未来状态变化。 */
  currentPeriod?: boolean;
}

/** 关系、抗性与实际变化共享的双资源定价，分析和实扣都调用这里。 */
export function controlPrice(input: ControlPriceInput): MetaCost {
  const { relation: a, resistance: r, strength: s, duration, mode, writePolicy } = input;
  if (a !== null && ![1, 2, 8].includes(a)) throw new RangeError('非法控制关系倍率');
  if (r !== null && !isNonNegativeFinite(r)) throw new RangeError('非法控制抗性');
  if (s !== null && !isNonNegativeFinite(s)) throw new RangeError('非法控制效果强度');
  if (duration !== null && !(duration === 0 || isPositiveFinite(duration)))
    throw new RangeError('非法控制时间');
  const gate = a === 8 ? 4 : 0;
  const factor = (a ?? 1) * (1 + (r ?? 0));
  const overlayTime =
    mode === 'write' && writePolicy === 'overlay' && duration !== null ? duration : 0;
  const startDynamic =
    a === null ||
    r === null ||
    s === null ||
    mode === null ||
    (mode === 'write' && writePolicy === null) ||
    (mode === 'write' && writePolicy === 'overlay' && duration === null);
  const amount = (base: number, effect: number, time: number, periodic = false): CostAmount => {
    const raw = (periodic ? 0 : gate) + factor * (base + effect * (s ?? 0) + time);
    if (!Number.isFinite(raw) || raw < 0) throw new RangeError('控制价格溢出');
    return {
      value: raw,
      dynamic: startDynamic || (periodic && !input.currentPeriod),
    };
  };
  const ticks = (cost: CostAmount): CostAmount => {
    const value = Math.ceil(cost.value);
    if (!Number.isSafeInteger(value)) throw new RangeError('控制 tick 价格溢出');
    return { value, dynamic: cost.dynamic };
  };
  const mana = amount(2, 1, overlayTime);
  const startTicks = ticks(amount(1, 0.1, overlayTime / 4));
  const result: MetaCost = { mana, ticks: startTicks };
  if (mode === 'maintain' || mode === null) {
    const periodMana = amount(1, 1, CONTROL_PERIOD_SECONDS, true);
    if (input.propertyKey === 'manaRegen') {
      // Each layer pays for its own maximum extra regeneration before that period runs.
      // Absolute marginal changes make opposing or concurrent layers no cheaper in total.
      periodMana.value = Math.max(periodMana.value, (s ?? 0) + 1);
    }
    const periodTicks = ticks(amount(1, 0.1, CONTROL_PERIOD_SECONDS, true));
    const max =
      duration === null || duration === 0 ? null : Math.ceil(duration / CONTROL_PERIOD_SECONDS);
    if (max !== null && !Number.isSafeInteger(max)) throw new RangeError('控制周期数溢出');
    result.periodic = {
      intervalSeconds: CONTROL_PERIOD_SECONDS,
      mana: periodMana,
      ticks: periodTicks,
      count:
        mode === null || duration === null
          ? { kind: 'dynamic' }
          : duration === 0
            ? { kind: 'unbounded' }
            : { kind: 'finite', max: max! },
    };
  }
  return result;
}

/** 世界只提供当前 binding 与实际效果测量，公式仍只有一份。 */
export function controlRecordPrice(world: World, caster: Actor, record: ControlRecord): MetaCost {
  const target = world.entityById(record.targetId);
  const binding = target && world.controlPropertyBinding(target, record.propertyKey);
  if (!target || !binding) throw new RangeError('控制目标能力失效');
  return controlPrice({
    propertyKey: record.propertyKey,
    relation: world.entityCostMultiplier(caster, target),
    resistance: binding.resistance(),
    strength: world.controlEffectStrength(record),
    duration: record.expiresAt === null ? 0 : Math.max(0, record.expiresAt - world.controlTimeNow),
    mode: record.mode,
    writePolicy: record.writePolicy,
    currentPeriod: true,
  });
}
