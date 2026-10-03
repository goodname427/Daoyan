import { asNum, defMeta } from '../meta';
import { T } from '../types';

export default function register(): void {
  for (const kind of ['J1', 'D1'] as const) {
    defMeta({
      name: `首批${kind}原读`,
      group: '有限世界',
      internalOnly: true,
      params: [
        { name: '会话', t: T.num },
        { name: '读索引', t: T.num },
      ],
      ret: T.bool,
      mana: 1,
      ticks: 10,
      worldCharged: true,
      desc: `${kind} 固定读索引由 World 采真值、版本和逐字段授权。`,
      impl: (ctx, args) =>
        !!ctx.chargeWorldWork &&
        ctx.world.vmFiniteDriveRead(
          kind,
          asNum(args[0]),
          asNum(args[1]),
          ctx.programHash,
          ctx.chargeWorldWork,
        ),
    });
    defMeta({
      name: `首批${kind}阶段`,
      group: '有限世界',
      internalOnly: true,
      params: [
        { name: '会话', t: T.num },
        { name: '阶段', t: T.num },
      ],
      ret: T.bool,
      mana: kind === 'J1' ? 12 : 8,
      ticks: 20,
      worldCharged: true,
      desc:
        kind === 'J1'
          ? 'J1 的有源取得、装载与杆推；阶段 0 为 H1，1 为装载，2 为作用，3 为取得，4 为夹持，5 为封印。'
          : 'D1 的有源取得、装载与起步；阶段 1 为装载，2 为作用，3 为取得，4 为夹持，5 为封印。',
      impl: (ctx, args) => {
        const phase = ['H1', 'load', 'action', 'acquire', 'clamp', 'seal'][asNum(args[1])] as
          'H1' | 'load' | 'action' | 'acquire' | 'clamp' | 'seal' | undefined;
        return (
          !!ctx.chargeWorldWork &&
          !!phase &&
          ctx.world.vmFiniteDriveStage(
            kind,
            asNum(args[0]),
            phase,
            ctx.programHash,
            ctx.chargeWorldWork,
          )
        );
      },
    });
  }
  defMeta({
    name: '首批B4审计',
    group: '有限世界',
    internalOnly: true,
    params: [
      { name: '会话', t: T.num },
      { name: '读索引', t: T.num },
    ],
    ret: T.bool,
    /** Max of the fixed nineteen positive prices; World settles each actual ID. */
    mana: 2,
    ticks: 22,
    worldCharged: true,
    desc: '按固定投影及逐字段授权读取同版 B4 端点，并由真实付款方结算。',
    impl: (ctx, args) => {
      if (!ctx.chargeWorldWork) return false;
      return ctx.world.vmB4Read(
        asNum(args[0]),
        asNum(args[1]),
        ctx.programHash,
        ctx.chargeWorldWork,
      );
    },
  });
  defMeta({
    name: '首批B4装载',
    group: '有限世界',
    internalOnly: true,
    params: [{ name: '会话', t: T.num }],
    ret: T.bool,
    mana: 5,
    ticks: 10,
    worldCharged: true,
    desc: '逐源与普通 k0 供料按已证转移，并结一次装载收据。',
    impl: (ctx, args) =>
      !!ctx.chargeWorldWork &&
      ctx.world.vmB4Load(asNum(args[0]), ctx.programHash, ctx.chargeWorldWork),
  });
  defMeta({
    name: '首批B4封印',
    group: '有限世界',
    internalOnly: true,
    params: [{ name: '会话', t: T.num }],
    ret: T.bool,
    mana: 0,
    ticks: 1,
    worldCharged: true,
    desc: '在 R2 新鲜原读后封印本次包。',
    impl: (ctx, args) => ctx.world.vmB4Seal(asNum(args[0]), ctx.programHash),
  });
  defMeta({
    name: '首批B4锁款',
    group: '有限世界',
    internalOnly: true,
    params: [{ name: '会话', t: T.num }],
    ret: T.bool,
    mana: 0,
    ticks: 1,
    worldCharged: true,
    desc: '作用前锁本人 10 M 与三项独立 POST 共 5 M。',
    impl: (ctx, args) => {
      const sessionId = asNum(args[0]);
      if (!ctx.world.vmB4Lock(sessionId, ctx.programHash)) return false;
      ctx.registerWorldCleanup?.(() => ctx.world.releaseB4Lock(sessionId, ctx.programHash));
      return true;
    },
  });
  defMeta({
    name: '首批B4修壳',
    group: '有限世界',
    internalOnly: true,
    params: [{ name: '会话', t: T.num }],
    ret: T.bool,
    mana: 10,
    ticks: 20,
    worldCharged: true,
    desc: '消费独立切片和 2q 供料，只修普通惰性 k0 壳。',
    impl: (ctx, args) =>
      !!ctx.chargeWorldWork &&
      ctx.world.vmB4Action(asNum(args[0]), ctx.programHash, ctx.chargeWorldWork),
  });
}
