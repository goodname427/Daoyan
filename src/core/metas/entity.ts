import { T } from '../types';
import { asEntity, asNum, asVec, defMeta } from '../meta';

export const MAX_PROJECTILE_LIFE = 5;
export const MAX_PROJECTILE_SPEED = 600;
export const MAX_PROJECTILE_POWER = 100;

const bounded = (value: number, max: number): boolean =>
  Number.isFinite(value) && value > 0 && value <= max;

// 非有限请求也是领域失败，定价阶段保持有限，让 impl 返回空/false。
const pricedRequest = (value: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : 0;

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
    mana: 18,
    manaCost: (_c, args) => 8 + pricedRequest(asNum(args[0]), MAX_PROJECTILE_LIFE) * 2,
    ticks: 2,
    desc: '创建未激活的弹道并返回句柄；寿命范围 (0, 5] 秒，每位施法者最多保有 16 个；失败返回空',
    impl: (c, args) => {
      const life = asNum(args[0]);
      if (!bounded(life, MAX_PROJECTILE_LIFE)) return null;
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
    mana: 8,
    manaCost: (_c, args) => 2 + pricedRequest(asNum(args[1]), MAX_PROJECTILE_SPEED) / 100,
    ticks: 1,
    desc: '设置自己创建的弹道速度；请求越快法力越高，允许范围为 (0, 600]',
    impl: (c, args) => {
      const projectile = c.world.ownedProjectile(c.caster.id, asEntity(args[0]));
      const speed = asNum(args[1]);
      if (!projectile || !bounded(speed, MAX_PROJECTILE_SPEED)) return false;
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
    mana: 27,
    manaCost: (_c, args) => 2 + pricedRequest(asNum(args[1]), MAX_PROJECTILE_POWER) / 4,
    ticks: 1,
    desc: '设置自己创建的弹道基础威力；请求越强法力越高，允许范围为 (0, 100]',
    impl: (c, args) => {
      const projectile = c.world.ownedProjectile(c.caster.id, asEntity(args[0]));
      const power = asNum(args[1]);
      if (!projectile || !bounded(power, MAX_PROJECTILE_POWER)) return false;
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
