import { T } from '../types';
import {
  asEntity,
  asNum,
  asVec,
  defMeta,
  dynamicCost,
  fixedCost,
  type CostArg,
  type Ctx,
} from '../meta';
import { effectCost, impulseEnergy, isPositiveFinite } from '../pricing';

function impulseCost(ctx: Ctx | null, args: readonly CostArg[]) {
  const base = { mana: dynamicCost(2), ticks: dynamicCost(1) };
  if (!ctx || !args[0]?.known || !args[1]?.known) return base;
  const target = ctx.world.entityById(asEntity(args[0].value));
  const delta = asVec(args[1].value);
  if (!target || !Number.isFinite(delta.x) || !Number.isFinite(delta.y))
    return { mana: fixedCost(2), ticks: fixedCost(1) };
  const energy = impulseEnergy(target.velocity, delta);
  return {
    mana: fixedCost(2 + energy / 0.8),
    ticks: fixedCost(1 + Math.ceil(energy)),
    undiscountedMana: fixedCost(energy / 0.8),
  };
}

/** vNext 纵向切片：创建一个统一句柄，再按能力控制并探查它。 */
export default function register(): void {
  const N = T.num;
  const B = T.bool;
  const V = T.vec2;
  const E = T.entity;

  for (const [name, pool] of [
    ['注入运动能量', 'motion'],
    ['注入伤害能量', 'damage'],
    ['注入扫描能量', 'scan'],
  ] as const) {
    defMeta({
      name,
      group: '实体控制',
      params: [
        { name: '法球', t: E },
        { name: '法力', t: N },
      ],
      ret: B,
      mana: 0,
      ticks: 1,
      worldCharged: true,
      worldChargedTicks: true,
      cost: (_ctx, args) => {
        const amount = args[1]?.known
          ? fixedCost(
              typeof args[1].value === 'number' && Number.isFinite(args[1].value)
                ? Math.max(0, args[1].value)
                : 0,
            )
          : dynamicCost(0);
        return { mana: amount, ticks: fixedCost(1), undiscountedMana: amount };
      },
      desc: '从施法者账户原子付款，按 1 法力换 0.8 E 注入法球指定储能池。',
      impl: (c, args) => {
        const projectile = c.world.ownedProjectile(c.caster.id, asEntity(args[0]));
        const mana = asNum(args[1]);
        return (
          !!projectile &&
          isPositiveFinite(mana) &&
          c.world.injectEntityEnergy(projectile.id, c.caster.id, pool, mana) !== null
        );
      },
    });
  }

  defMeta({
    name: '设置法球推进',
    group: '实体控制',
    params: [
      { name: '法球', t: E },
      { name: '周期速度变化', t: V },
    ],
    ret: B,
    mana: 2,
    ticks: 1,
    desc: '每 0.25 秒仅用法球 motion 余额主动推进；余额耗尽只保留惯性。',
    impl: (c, args) =>
      c.world.configureProjectileBehavior(c.caster.id, asEntity(args[0]), 'thrust', asVec(args[1])),
  });

  defMeta({
    name: '设置法球追踪',
    group: '实体控制',
    params: [
      { name: '法球', t: E },
      { name: '目标', t: E },
      { name: '周期速度变化', t: N },
    ],
    ret: B,
    mana: 2,
    ticks: 1,
    desc: '每周期从 scan 池购买目标位置，随后仅用 motion 池转向推进。',
    impl: (c, args) => {
      const push = asNum(args[2]);
      if (!Number.isFinite(push) || push <= 0) return false;
      return c.world.configureProjectileBehavior(
        c.caster.id,
        asEntity(args[0]),
        'track',
        { x: push, y: 0 },
        asEntity(args[1]),
      );
    },
  });

  defMeta({
    name: '设置法球滑行',
    group: '实体控制',
    params: [{ name: '法球', t: E }],
    ret: B,
    mana: 1,
    ticks: 1,
    desc: '结束主动推进或追踪，仅按已有冲量和阻力滑行。',
    impl: (c, args) => c.world.configureProjectileBehavior(c.caster.id, asEntity(args[0]), 'glide'),
  });

  defMeta({
    name: '施加冲量',
    group: '实体控制',
    params: [
      { name: '目标', t: E },
      { name: '速度变化', t: V },
    ],
    ret: B,
    mana: 2,
    ticks: 1,
    cost: impulseCost,
    desc: '为自身或自有弹道支付一次冲量；受主动速度上限约束，滑行不续费。',
    impl: (c, args) => {
      const id = asEntity(args[0]);
      const target = c.world.entityById(id);
      const delta = asVec(args[1]);
      if (
        !target ||
        !Number.isFinite(delta.x) ||
        !Number.isFinite(delta.y) ||
        (target.id !== c.caster.id &&
          (target.kind !== 'projectile' || target.ownerId !== c.caster.id))
      )
        return false;
      return c.world.applyImpulse(id, delta);
    },
  });

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
    legacyOnly: true,
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
    legacyOnly: true,
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
    legacyOnly: true,
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
    legacyOnly: true,
    group: '实体控制',
    params: [{ name: '目标', t: E }],
    ret: B,
    mana: 2,
    ticks: 1,
    cost: (ctx, args) => {
      if (!ctx || !args[0]?.known) return { mana: dynamicCost(2), ticks: dynamicCost(1) };
      const projectile = ctx.world.entityById(asEntity(args[0].value));
      if (!projectile || projectile.kind !== 'projectile')
        return { mana: fixedCost(2), ticks: fixedCost(1) };
      const energy = 2 * (projectile.speed / 380) ** 2;
      if (!Number.isFinite(energy)) throw new RangeError('激活冲量价格溢出');
      return {
        mana: fixedCost(2 + energy / 0.8),
        ticks: fixedCost(1 + Math.ceil(energy)),
        undiscountedMana: fixedCost(energy / 0.8),
      };
    },
    desc: '激活自己创建且已配置的弹道；无速度或无威力时返回 false',
    impl: (c, args) => {
      const projectile = c.world.ownedProjectile(c.caster.id, asEntity(args[0]));
      if (!projectile || projectile.active || projectile.speed <= 0 || projectile.damage <= 0) {
        return false;
      }
      projectile.x = c.caster.x + projectile.dx * (c.caster.radius + projectile.radius);
      projectile.y = c.caster.y + projectile.dy * (c.caster.radius + projectile.radius);
      projectile.active = true;
      if (
        !c.world.applyImpulse(projectile.id, {
          x: projectile.dx * projectile.speed,
          y: projectile.dy * projectile.speed,
        })
      ) {
        projectile.active = false;
        return false;
      }
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
