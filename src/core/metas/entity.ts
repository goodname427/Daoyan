import { T } from '../types';
import { asEntity, asNum, asVec, defMeta } from '../meta';
import { effectCost, isPositiveFinite } from '../pricing';

/** vNext 纵向切片：创建一个统一句柄，再按能力控制并探查它。 */
export default function register(): void {
  const N = T.num;
  const B = T.bool;
  const V = T.vec2;
  const E = T.entity;

  defMeta({
    name: '创建弹道',
    group: '实体创建',
    params: [{ name: '存活秒数', t: N }],
    ret: E,
    mana: 8,
    ticks: 2,
    cost: (_ctx, args) => effectCost(args, 8, 2, [{ index: 0, manaPer: 2, tickUnit: 2 }]),
    desc: '创建未激活的弹道并返回句柄；寿命越长，法力和耗时越高，不设人为上限；每位施法者最多保有 16 个',
    impl: (c, args) => {
      const life = asNum(args[0]);
      if (!isPositiveFinite(life)) return null;
      return (
        c.world.spawnProjectile({
          faction: c.caster.faction,
          ownerId: c.caster.id,
          x: c.caster.x,
          y: c.caster.y,
          dx: c.caster.aim.x,
          dy: c.caster.aim.y,
          speed: 0,
          damage: 0,
          life,
          active: false,
        })?.id ?? null
      );
    },
  });

  defMeta({
    name: '设置弹道方向',
    group: '实体控制',
    params: [
      { name: '目标', t: E },
      { name: '方向', t: V },
    ],
    ret: B,
    mana: 2,
    ticks: 1,
    desc: '设置自己创建的弹道方向；句柄无效、能力缺失或不属于自己时返回 false',
    impl: (c, args) => {
      const projectile = c.world.ownedProjectile(c.caster.id, asEntity(args[0]));
      const direction = asVec(args[1]);
      const length = Math.hypot(direction.x, direction.y);
      if (!projectile || !Number.isFinite(length) || length < 1e-9) return false;
      projectile.dx = direction.x / length;
      projectile.dy = direction.y / length;
      return true;
    },
  });

  defMeta({
    name: '设置弹道速度',
    group: '实体控制',
    params: [
      { name: '目标', t: E },
      { name: '速度', t: N },
    ],
    ret: B,
    mana: 2,
    ticks: 1,
    cost: (_ctx, args) => effectCost(args, 2, 1, [{ index: 1, manaPer: 0.01, tickUnit: 300 }]),
    desc: '设置自己创建的弹道速度；请求越快，法力和耗时越高，不设人为上限',
    impl: (c, args) => {
      const projectile = c.world.ownedProjectile(c.caster.id, asEntity(args[0]));
      const speed = asNum(args[1]);
      if (!projectile || !isPositiveFinite(speed)) return false;
      projectile.speed = speed;
      return true;
    },
  });

  defMeta({
    name: '设置弹道威力',
    group: '实体控制',
    params: [
      { name: '目标', t: E },
      { name: '威力', t: N },
    ],
    ret: B,
    mana: 2,
    ticks: 1,
    cost: (_ctx, args) => effectCost(args, 2, 1, [{ index: 1, manaPer: 0.25, tickUnit: 50 }]),
    desc: '设置自己创建的弹道基础威力；请求越强，法力和耗时越高，不设人为上限',
    impl: (c, args) => {
      const projectile = c.world.ownedProjectile(c.caster.id, asEntity(args[0]));
      const power = asNum(args[1]);
      if (!projectile || !isPositiveFinite(power)) return false;
      projectile.damage = power * c.caster.attr.power;
      return true;
    },
  });

  defMeta({
    name: '激活弹道',
    group: '实体控制',
    params: [{ name: '目标', t: E }],
    ret: B,
    mana: 2,
    ticks: 1,
    desc: '激活自己创建且已配置的弹道；无速度或无威力时返回 false',
    impl: (c, args) => {
      const projectile = c.world.ownedProjectile(c.caster.id, asEntity(args[0]));
      if (!projectile || projectile.active || projectile.speed <= 0 || projectile.damage <= 0) {
        return false;
      }
      projectile.x = c.caster.x + projectile.dx * (c.caster.radius + projectile.radius);
      projectile.y = c.caster.y + projectile.dy * (c.caster.radius + projectile.radius);
      projectile.active = true;
      c.world.fx.push({ kind: 'shoot', x: projectile.x, y: projectile.y });
      return true;
    },
  });

  defMeta({
    name: '实体存在',
    group: '状态探查',
    params: [{ name: '目标', t: E }],
    ret: B,
    mana: 1,
    ticks: 1,
    desc: '句柄当前是否仍指向 Actor 或 Projectile；用于在探查前处理失效实体',
    impl: (c, args) => c.world.entityById(asEntity(args[0])) !== null,
  });
}
