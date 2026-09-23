import { publicMetas, typeName } from '../core/index';
import { controlHelp } from './controlHelp';

export function MetaTable() {
  const metas = publicMetas();
  const groups = [...new Set(metas.map((m) => m.group))];

  return (
    <div className="meta-table">
      {groups.map((g) => (
        <div key={g} className="meta-group">
          <h3>{g}</h3>
          <table>
            <thead>
              <tr>
                <th>术式</th>
                <th>签名</th>
                <th>法力</th>
                <th>耗时</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {metas
                .filter((m) => m.group === g)
                .map((m) => (
                  <tr key={m.name}>
                    <td className="mname">{m.name}</td>
                    <td className="msig">
                      {m.params.map((p) => `${typeName(p.t)}`).join(', ')} → {typeName(m.ret)}
                    </td>
                    <td className="num">{m.cost || m.manaCost ? `${m.mana}+动态` : m.mana}</td>
                    <td className="num">{m.cost ? `${m.ticks}+动态` : m.ticks}</td>
                    <td className="mdesc">
                      {m.desc}
                      {controlHelp(m.name) && (
                        <>
                          <br />
                          属性 {controlHelp(m.name)!.key} · {controlHelp(m.name)!.effect} ·{' '}
                          {controlHelp(m.name)!.capability} · 时间 0 = 无限；维持每 0.25
                          秒另付周期法力 / tick
                        </>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
