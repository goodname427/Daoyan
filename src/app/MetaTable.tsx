import { allMetas, typeName } from '../core/index';

export function MetaTable() {
  const metas = allMetas();
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
                    <td className="num">{m.manaCost ? `≤${m.mana}` : m.mana}</td>
                    <td className="num">{m.ticks}</td>
                    <td className="mdesc">{m.desc}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
