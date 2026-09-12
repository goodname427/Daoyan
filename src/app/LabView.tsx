import { useMemo, useState } from 'react';

import LAB_SPELLS from '../demo/spells.dy?raw';
import { VM, World, analyzeBook, compileProgram, parseSpellbook } from '../core/index';
import type { CastResult, SpellBook } from '../core/index';
import { Battlefield } from './Battlefield';
import type { BattleEntity } from './Battlefield';
import { MetaTable } from './MetaTable';
import { CostCard, Slider, Stat } from './Panels';

interface Outcome {
  result: CastResult;
  entities: BattleEntity[];
  /** 法术瞄向了谁 */
  aim: string;
}

/** 布阵：越晚生成越近，便于暴露「容量小 → 看漏目标」的代价 */
function layout(count: number): Array<{ x: number; y: number }> {
  return Array.from({ length: count }, (_, i) => {
    const ang = i * 0.55;
    const r = 110 + (count - 1 - i) * 28;
    return { x: Math.cos(ang) * r, y: Math.sin(ang) * r };
  });
}

/** 从弹道方向推断法术瞄向了谁 */
function aimedAt(world: World): string {
  const pr = world.projectiles[0];
  if (!pr) return '未出手';
  let best: number | null = null;
  let bestT = Infinity;
  for (const a of world.hostilesOf(pr.faction)) {
    const t = (a.x - pr.x) * pr.dx + (a.y - pr.y) * pr.dy;
    if (t < 0 || t > 800) continue;
    const px = pr.x + pr.dx * t;
    const py = pr.y + pr.dy * t;
    if (Math.hypot(a.x - px, a.y - py) <= pr.radius + a.radius && t < bestT) {
      bestT = t;
      best = a.id;
    }
  }
  return best === null ? '未命中' : `#${best}`;
}

export function LabView() {
  const [source, setSource] = useState(LAB_SPELLS);
  const [selected, setSelected] = useState('御剑术·朴');
  const [enemyCount, setEnemyCount] = useState(6);
  const [shenshiMax, setShenshiMax] = useState(64);
  const [manaMax, setManaMax] = useState(300);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [runError, setRunError] = useState('');

  const parsed = useMemo(() => {
    try {
      const book: SpellBook = parseSpellbook(source);
      return { book, costs: analyzeBook(book), error: '' };
    } catch (e) {
      return { book: null, costs: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [source]);

  const names = parsed.book ? Object.keys(parsed.book) : [];
  const active = names.includes(selected) ? selected : (names[0] ?? '');

  const ghost = useMemo<BattleEntity[]>(
    () => layout(enemyCount).map((p, i) => ({ id: i + 1, x: p.x, y: p.y, hp: 100, alive: true })),
    [enemyCount],
  );

  const run = (): void => {
    setRunError('');
    if (!parsed.book || !active) return;
    try {
      const program = compileProgram(parsed.book, active);
      const world = new World();
      for (const p of layout(enemyCount)) {
        world.spawnActor({ faction: 'foe', x: p.x, y: p.y, hpMax: 100 });
      }
      const caster = world.spawnActor({
        name: '推演者',
        faction: 'player',
        x: 0,
        y: 0,
        manaMax,
        shenshiMax,
      });
      const result = new VM(program, world, caster).run(active);
      setOutcome({
        result,
        aim: aimedAt(world),
        entities: world.actors.map((a) => ({
          id: a.id,
          x: a.x,
          y: a.y,
          hp: a.hp,
          alive: a.alive,
        })),
      });
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    }
  };

  const hitId = useMemo(() => {
    if (!outcome) return null;
    const m = /#(\d+)/.exec(outcome.aim);
    return m ? Number(m[1]) : null;
  }, [outcome]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          道衍<span>推演台</span>
        </div>
        <div className="hint">
          改写法术 → 看静态消耗 → 推演实测 → 比较不同写法在法力 / 神识 / 耗时上的取舍
        </div>
      </header>

      <main className="grid">
        <section className="panel">
          <h2>法术书</h2>
          {names.length === 0 ? (
            <p className="muted">暂无可用法术</p>
          ) : (
            <ul className="spell-list">
              {names.map((n) => {
                const c = parsed.costs?.[n];
                return (
                  <li key={n}>
                    <button
                      className={n === active ? 'spell active' : 'spell'}
                      onClick={() => {
                        setSelected(n);
                        setOutcome(null);
                      }}
                    >
                      <span>{n}</span>
                      {c && (
                        <small>
                          法{c.manaWorst} · 神{c.shenshiPeak} · {c.tickWorst}t
                        </small>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {active && parsed.costs?.[active] && <CostCard cost={parsed.costs[active]} />}
        </section>

        <section className="panel">
          <h2>法术源码</h2>
          <textarea
            className="editor"
            value={source}
            spellCheck={false}
            onChange={(e) => setSource(e.target.value)}
          />
          {parsed.error ? (
            <pre className="errors">{parsed.error}</pre>
          ) : (
            <p className="ok">解析通过 · {names.length} 个法术</p>
          )}
        </section>

        <section className="panel">
          <h2>推演</h2>
          <Slider label="敌人数" value={enemyCount} min={0} max={12} onChange={setEnemyCount} />
          <Slider label="神识上限" value={shenshiMax} min={16} max={80} onChange={setShenshiMax} />
          <Slider
            label="法力上限"
            value={manaMax}
            min={40}
            max={400}
            step={20}
            onChange={setManaMax}
          />
          <button className="run" onClick={run} disabled={!active}>
            推演一次
          </button>
          {runError && <pre className="errors">{runError}</pre>}

          {outcome && (
            <div className="result">
              <div className="stat-row">
                <Stat label="法力" value={String(outcome.result.mana)} />
                <Stat label="神识" value={String(outcome.result.shenshiPeak)} />
                <Stat label="耗时" value={`${outcome.result.ticks}t`} />
              </div>
              <div className={outcome.result.ok ? 'verdict ok' : 'verdict bad'}>
                {outcome.result.ok
                  ? `施法成功 · 瞄向 ${outcome.aim}`
                  : `走火入魔：${outcome.result.error}`}
              </div>
              <p className="muted small">
                静态上界按「列表容量」算，实测按真实敌人数算 —— 两者的差距正是可优化的空间
              </p>
            </div>
          )}
        </section>
      </main>

      <section className="panel wide">
        <h2>战场</h2>
        <Battlefield entities={outcome?.entities ?? ghost} hitId={hitId} />
      </section>

      <section className="panel wide">
        <h2>基础术式定价表</h2>
        <MetaTable />
      </section>
    </div>
  );
}
