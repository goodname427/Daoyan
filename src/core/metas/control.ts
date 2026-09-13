import { T } from '../types';
import { asEntity, asNum, asVec, defMeta } from '../meta';

/** 操控类：改变世界，收高额法力。伤害统一受「术法威力」属性影响 */
export default function register(): void {
  const N = T.num;
  const V = T.vec2;
  const E = T.entity;

  defMeta({
    name: '发射',
    group: '实体创建',
    params: [
      { name: '起点', t: V },
      { name: '方向', t: V },
      { name: '威力', t: N },
    ],
    ret: T.void,
    mana: 25,
    ticks: 3,
    desc: '射出一道飞剑（有飞行时间，可被躲开）。威力受「术法威力」属性加成',
    impl: (c, a) => {
      const o = asVec(a[0]);
      const d = asVec(a[1]);
      const power = asNum(a[2]) * c.caster.attr.power;
      const l = Math.hypot(d.x, d.y);
      const dx = l < 1e-9 ? 1 : d.x / l;
      const dy = l < 1e-9 ? 0 : d.y / l;
      const projectile = c.world.spawnProjectile({
        faction: c.caster.faction,
        ownerId: c.caster.id,
        x: o.x + dx * (c.caster.radius + 6),
        y: o.y + dy * (c.caster.radius + 6),
        dx,
        dy,
        speed: 380,
        damage: power,
        radius: 7,
        life: 2.4,
      });
      if (projectile) c.world.fx.push({ kind: 'shoot', x: o.x + dx * 16, y: o.y + dy * 16 });
      return null;
    },
  });

  defMeta({
    name: '近战斩击',
    group: '实体控制',
    params: [
      { name: '方向', t: V },
      { name: '距离', t: N },
      { name: '伤害', t: N },
    ],
    ret: T.void,
    mana: 18,
    ticks: 3,
    desc: '朝方向挥出一道近战斩击，命中射线上最近的敌人（无法被躲开的贴身打法）',
    impl: (c, a) => {
      const d = asVec(a[0]);
      const dist = asNum(a[1]);
      const dmg = asNum(a[2]) * c.caster.attr.power;
      const o = { x: c.caster.x, y: c.caster.y };
      const hit = c.world.raycast(o, d, dist, 18, c.caster.faction);
      if (hit) {
        c.world.damage(hit.id, dmg);
        c.log.push(`斩击命中 #${hit.id}，造成 ${Math.round(dmg)} 点伤害`);
      } else {
        c.log.push('斩击落空');
      }
      return null;
    },
  });

  defMeta({
    name: '伤害',
    group: '实体控制',
    params: [
      { name: '目标', t: E },
      { name: '数值', t: N },
    ],
    ret: T.void,
    mana: 15,
    ticks: 2,
    desc: '直接对指定单位造成伤害（需要持有句柄，不会被躲开）。受「术法威力」属性加成',
    impl: (c, a) => {
      const id = asEntity(a[0]);
      const dmg = asNum(a[1]) * c.caster.attr.power;
      if (c.world.damage(id, dmg)) c.log.push(`对 #${id} 造成 ${Math.round(dmg)} 点伤害`);
      return null;
    },
  });

  defMeta({
    name: '移动',
    group: '实体控制',
    params: [
      { name: '方向', t: V },
      { name: '距离', t: N },
    ],
    ret: T.void,
    mana: 12,
    ticks: 2,
    desc: '沿方向瞬时位移（身法、冲刺）。想变快就要付出法力',
    impl: (c, a) => {
      const d = asVec(a[0]);
      const dist = asNum(a[1]);
      const l = Math.hypot(d.x, d.y);
      if (l < 1e-9) return null;
      c.world.moveActor(c.caster, (d.x / l) * dist, (d.y / l) * dist);
      return null;
    },
  });

  defMeta({
    name: '瞬移',
    group: '实体控制',
    params: [{ name: '目标点', t: V }],
    ret: T.void,
    mana: 40,
    ticks: 2,
    desc: '直接挪移到指定坐标',
    impl: (c, a) => {
      const p = asVec(a[0]);
      c.world.placeActor(c.caster, p.x, p.y);
      c.log.push(`瞬移至 (${Math.round(p.x)}, ${Math.round(p.y)})`);
      return null;
    },
  });
}
