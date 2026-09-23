import { publicMetas, typeName, unknownCostArg } from '../core/index';
import type { MetaDef } from '../core/index';
import { controlHelp } from './controlHelp';

export const LEGACY_META_ALIASES: Readonly<Record<string, string>> = {
  迟滞: '调整速度',
  破防: '调整护体',
  发射: '创建弹道',
  感知敌人: '扫描敌人',
  快照: '扫描坐标',
  探查: '读取位置',
  生命: '读取生命',
  疾行: '调整速度',
  护体: '调整护体',
};

export function metaSection(meta: MetaDef): string {
  if (meta.name.startsWith('读取') || meta.group === '状态探查') return '探查';
  if (meta.name.includes('法球') || meta.name.includes('能量') || meta.group === '实体创建')
    return '实体与供能';
  if (meta.group.includes('事件') || meta.group.includes('会话') || meta.group === '施法控制')
    return '事件与会话';
  return '效果与控制';
}

export function matchesMeta(meta: MetaDef, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return true;
  const aliases = Object.entries(LEGACY_META_ALIASES)
    .filter(([, current]) => current === meta.name)
    .map(([old]) => old);
  return [meta.name, meta.group, metaSection(meta), meta.desc, ...aliases]
    .join(' ')
    .toLocaleLowerCase()
    .includes(q);
}

export function metaPermission(meta: MetaDef): string {
  if (controlHelp(meta.name)) return '目标属性 binding、控制关系与抗性；按当前施法会话维持';
  if (meta.name.startsWith('读取') || meta.name.startsWith('扫描'))
    return '读取能力、可见性、距离与授权；拒绝不泄露私有值';
  if (meta.name.includes('法球') || meta.name.includes('能量'))
    return '仅可操作自身拥有的法球；余额从施法者账户付款';
  if (meta.group === '实体创建') return '创建数量、起点与施法者余额须合法';
  return '依签名、实体能力和施法上下文判定';
}

export function metaRejection(meta: MetaDef): string {
  if (controlHelp(meta.name)) return controlHelp(meta.name)!.failure;
  if (meta.name.startsWith('读取') || meta.name.startsWith('扫描'))
    return '目标为空、不可见、越距或缺少授权时返回 unavailable；仍收取公开尝试价。';
  if (meta.name.includes('法球') || meta.name.includes('能量'))
    return '句柄失效、非本人法球、参数无效或储能/法力不足时拒绝；耗尽后停止主动行为。';
  return '参数、目标能力或法力不足时拒绝；具体结果可在推演中核对。';
}

export function metaBudget(meta: MetaDef): string {
  let periodic = '';
  try {
    const quoted = meta.cost?.(
      null,
      meta.params.map(() => unknownCostArg()),
    );
    if (quoted?.periodic) {
      const p = quoted.periodic;
      periodic = `；每 ${p.intervalSeconds} 秒法${p.mana.value}${p.mana.dynamic ? '+动态' : ''} / ${p.ticks.value}${p.ticks.dynamic ? '+动态' : ''}t`;
    }
  } catch {
    // 外部元法术可能只接受运行态上下文，目录仍显示声明的基础价。
  }
  if (meta.name === '设置法球推进')
    periodic = '；每 0.25 秒从 motion 池按实际速度变化扣能（动态），耗尽后滑行';
  if (meta.name === '设置法球追踪')
    periodic = '；每 0.25 秒先从 scan 池扣 1 E，再从 motion 池按实际转向扣能（动态）';
  if (meta.name === '设置法球滑行') periodic = '；周期价 0，保留惯性';
  if (!periodic && controlHelp(meta.name)) periodic = `；${controlHelp(meta.name)!.period}`;
  return `起手 法${meta.mana}${meta.cost || meta.manaCost ? '+动态' : ''} / ${meta.ticks}${meta.cost ? '+动态' : ''}t${periodic}`;
}

export function MetaTable() {
  const metas = publicMetas();
  const groups = [...new Set(metas.map(metaSection))];

  return (
    <div className="meta-table">
      {groups.map((group) => (
        <div key={group} className="meta-group">
          <h3>{group}</h3>
          <table>
            <thead>
              <tr>
                <th>术式与能力</th>
                <th>权限 / 拒绝</th>
                <th>预算</th>
              </tr>
            </thead>
            <tbody>
              {metas
                .filter((meta) => metaSection(meta) === group)
                .map((meta) => (
                  <tr key={meta.name}>
                    <td className="mdesc">
                      <strong className="mname">{meta.name}</strong> (
                      {meta.params.map((p) => typeName(p.t)).join(', ')} → {typeName(meta.ret)})
                      <br />
                      {meta.desc}
                    </td>
                    <td className="mdesc">
                      {metaPermission(meta)}
                      <br />
                      拒绝：{metaRejection(meta)}
                    </td>
                    <td className="mdesc">{metaBudget(meta)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
