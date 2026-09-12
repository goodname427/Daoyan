import { T } from '../types';
import { asEntity, asNum, defMeta } from '../meta';
import type { AttrKey } from '../attributes';

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
      group: '属性',
      params: [
        { name: '倍率', t: N },
        { name: '持续秒数', t: N },
      ],
      ret: T.void,
      mana: 20,
      ticks: 2,
      desc,
      impl: (c, a) => {
        c.world.addModifier(
          c.caster,
          key,
          'mul',
          asNum(a[0]),
          asNum(a[1]),
          `${c.caster.name}·${name}`,
        );
        c.log.push(`${name}：${key} ×${asNum(a[0])}，持续 ${asNum(a[1])} 秒`);
        return null;
      },
    });
  }

  defMeta({
    name: '护体',
    group: '属性',
    params: [
      { name: '减伤', t: N },
      { name: '持续秒数', t: N },
    ],
    ret: T.void,
    mana: 18,
    ticks: 2,
    desc: '为自身附加固定减伤（加法）',
    impl: (c, a) => {
      c.world.addModifier(c.caster, 'armor', 'add', asNum(a[0]), asNum(a[1]), '护体');
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
      group: '属性',
      params: [
        { name: '目标', t: E },
        { name: '倍率', t: N },
        { name: '持续秒数', t: N },
      ],
      ret: T.void,
      mana: 22,
      ticks: 2,
      desc,
      impl: (c, a) => {
        const t = c.world.byId(asEntity(a[0]));
        if (!t) return null;
        c.world.addModifier(t, key, 'mul', asNum(a[1]), asNum(a[2]), name);
        c.log.push(`对 #${t.id} 施加${name}：${key} ×${asNum(a[1])}`);
        return null;
      },
    });
  }

  defMeta({
    name: '破防',
    group: '属性',
    params: [
      { name: '目标', t: E },
      { name: '数值', t: N },
      { name: '持续秒数', t: N },
    ],
    ret: T.void,
    mana: 20,
    ticks: 2,
    desc: '削损目标护体（加法，传正数即降低减伤）',
    impl: (c, a) => {
      const t = c.world.byId(asEntity(a[0]));
      if (!t) return null;
      c.world.addModifier(t, 'armor', 'add', -asNum(a[1]), asNum(a[2]), '破防');
      c.log.push(`对 #${t.id} 破防：护体 -${asNum(a[1])}`);
      return null;
    },
  });
}
