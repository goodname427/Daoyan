import { dynamicCost, fixedCost, type CostAmount, type CostArg, type MetaCost } from './meta';

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
