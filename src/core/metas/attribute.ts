import { T } from '../types';
import { asEntity, asNum, defMeta, fixedCost, type CostArg, type Ctx } from '../meta';
import type { AttrKey } from '../attributes';
import { effectCost, isPositiveFinite, multiplierMagnitude } from '../pricing';

function targetEffectCost(
  ctx: Ctx | null,
  args: readonly CostArg[],
  targetIndex: number,
  baseMana: number,
  baseTicks: number,
  terms: Parameters<typeof effectCost>[3],
) {
  const targetArg = args[targetIndex];
  if (!ctx || !targetArg?.known) {
    const knownInput = effectCost(args, baseMana, baseTicks, terms);
    return {
      mana: { ...knownInput.mana, dynamic: true },
      ticks: { ...knownInput.ticks, dynamic: true },
    };
  }
  const target = ctx.world.entityById(asEntity(targetArg.value));
  if (!target) return effectCost(args, baseMana, baseTicks, terms);
  const relation = ctx.world.entityCostMultiplier(ctx.caster, target);
  const inputCost = effectCost(
    args,
    baseMana * relation,
    baseTicks,
    terms.map((term) => ({ ...term, manaPer: term.manaPer * relation })),
  );
  return {
    mana: inputCost.mana,
    ticks: fixedCost(baseTicks + (inputCost.ticks.value - baseTicks) * relation),
  };
}

/**
 * 属性类元法术（增益 / 减益）。
 *
 * 之所以用「护体 / 疾行 / 明心」这种具名法术，而不是「加持(属性号, …)」，
 * 是因为具名法术在节点图里就是一个节点，玩家不需要记编号。
 */
export default function register(): void {
  const N = T.num;
  const E = T.entity;

  /** 自身增益（乘法） */
  const selfMul: Array<[string, AttrKey, string]> = [
    ['疾行', 'speed', '提升自身移动速度（倍率）'],
    ['明心', 'castSpeed', '提升自身施法速度（倍率）—— 同样的 tick 数，读条更短'],
    ['增威', 'power', '提升自身术法威力（倍率）'],
    ['节流', 'manaCostMul', '降低自身法力消耗（倍率，0.8 即打八折）'],
    ['聚气', 'manaRegen', '提升自身法力回复（倍率）'],
    ['洞察', 'perception', '提升自身感知半径（倍率）'],
  ];
  for (const [name, key, desc] of selfMul) {
    defMeta({
      name,
      group: '实体控制',
      params: [
        { name: '倍率', t: N },
        { name: '持续秒数', t: N },
      ],
      ret: T.void,
      mana: 8,
      ticks: 2,
      cost: (_ctx, args) =>
        effectCost(args, 8, 2, [
          { index: 0, manaPer: 4, tickUnit: 1, measure: multiplierMagnitude },
          { index: 1, manaPer: 1, tickUnit: 2 },
        ]),
      desc,
      impl: (c, a) => {
        const multiplier = asNum(a[0]);
        const duration = asNum(a[1]);
        if (!isPositiveFinite(multiplier) || !isPositiveFinite(duration)) return null;
        c.world.addModifier(c.caster, key, 'mul', multiplier, duration, `${c.caster.name}·${name}`);
        c.log.push(`${name}：${key} ×${asNum(a[0])}，持续 ${asNum(a[1])} 秒`);
        return null;
      },
    });
  }

  defMeta({
    name: '护体',
    group: '实体控制',
    params: [
      { name: '减伤', t: N },
      { name: '持续秒数', t: N },
    ],
    ret: T.void,
    mana: 8,
    ticks: 2,
    cost: (_ctx, args) =>
      effectCost(args, 8, 2, [
        { index: 0, manaPer: 0.5, tickUnit: 1 },
        { index: 1, manaPer: 1, tickUnit: 2 },
      ]),
    desc: '为自身附加固定减伤（加法）',
    impl: (c, a) => {
      const amount = asNum(a[0]);
      const duration = asNum(a[1]);
      if (!isPositiveFinite(amount) || !isPositiveFinite(duration)) return null;
      c.world.addModifier(c.caster, 'armor', 'add', amount, duration, '护体');
      c.log.push(`护体：减伤 +${asNum(a[0])}，持续 ${asNum(a[1])} 秒`);
      return null;
    },
  });

  /** 对敌减益（乘法） */
  const foeMul: Array<[string, AttrKey, string]> = [
    ['迟滞', 'speed', '降低目标移动速度（倍率）'],
    ['虚弱', 'power', '降低目标术法威力（倍率）'],
    ['蔽识', 'perception', '降低目标感知半径（倍率）—— 让它「看不清」你'],
  ];
  for (const [name, key, desc] of foeMul) {
    defMeta({
      name,
      group: '实体控制',
      params: [
        { name: '目标', t: E },
        { name: '倍率', t: N },
        { name: '持续秒数', t: N },
      ],
      ret: T.void,
      mana: 8,
      ticks: 2,
      cost: (ctx, args) =>
        targetEffectCost(ctx, args, 0, 8, 2, [
          { index: 1, manaPer: 4, tickUnit: 1, measure: multiplierMagnitude },
          { index: 2, manaPer: 1, tickUnit: 2 },
        ]),
      desc,
      impl: (c, a) => {
        const target = c.world.entityById(asEntity(a[0]));
        const multiplier = asNum(a[1]);
        const duration = asNum(a[2]);
        if (
          target?.kind !== 'actor' ||
          !isPositiveFinite(multiplier) ||
          !isPositiveFinite(duration)
        ) {
          return null;
        }
        c.world.addModifier(target, key, 'mul', multiplier, duration, name);
        c.log.push(`对 #${target.id} 施加${name}：${key} ×${multiplier}`);
        return null;
      },
    });
  }

  defMeta({
    name: '破防',
    group: '实体控制',
    params: [
      { name: '目标', t: E },
      { name: '数值', t: N },
      { name: '持续秒数', t: N },
    ],
    ret: T.void,
    mana: 8,
    ticks: 2,
    cost: (ctx, args) =>
      targetEffectCost(ctx, args, 0, 8, 2, [
        { index: 1, manaPer: 0.5, tickUnit: 1 },
        { index: 2, manaPer: 1, tickUnit: 2 },
      ]),
    desc: '削损目标护体（加法，传正数即降低减伤）',
    impl: (c, a) => {
      const target = c.world.entityById(asEntity(a[0]));
      const amount = asNum(a[1]);
      const duration = asNum(a[2]);
      if (target?.kind !== 'actor' || !isPositiveFinite(amount) || !isPositiveFinite(duration)) {
        return null;
      }
      c.world.addModifier(target, 'armor', 'add', -amount, duration, '破防');
      c.log.push(`对 #${target.id} 破防：护体 -${amount}`);
      return null;
    },
  });
}
