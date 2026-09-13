import { useMemo, useRef, useState } from 'react';

import {
  VM,
  World,
  allMetas,
  analyzeBook,
  compileProgram,
  emptySpell,
  parseSpellbook,
  serializeBook,
  typeName,
  type VMSnapshot,
} from '../core/index';
import type { CastResult, MetaDef, SpellBook } from '../core/index';
import { Battlefield } from './Battlefield';
import type { BattleEntity } from './Battlefield';
import { MetaTable } from './MetaTable';
import { NodeEditor } from './NodeEditor';
import { NodeGraph } from './NodeGraph';
import { CostCard, Slider, Stat } from './Panels';
import { SpellEditor } from './SpellEditor';

interface Outcome {
  result: CastResult;
  entities: BattleEntity[];
  /** 法术瞄向了谁 */
  aim: string;
}

interface StepSession {
  snapshot: VMSnapshot;
  timeline: VMSnapshot[];
}

interface LabViewProps {
  source: string;
  onSourceChange: (source: string) => void;
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

export function LabView({ source, onSourceChange }: LabViewProps) {
  const [editorMode, setEditorMode] = useState<'code' | 'blueprint'>('code');
  const [selected, setSelected] = useState('spell:基础剑气');
  const [enemyCount, setEnemyCount] = useState(6);
  const [shenshiMax, setShenshiMax] = useState(64);
  const [manaMax, setManaMax] = useState(300);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [runError, setRunError] = useState('');
  const stepVm = useRef<VM | null>(null);
  const [stepSession, setStepSession] = useState<StepSession | null>(null);

  const parsed = useMemo(() => {
    try {
      const book: SpellBook = parseSpellbook(source);
      return { book, costs: analyzeBook(book), error: '' };
    } catch (e) {
      return { book: null, costs: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [source]);

  const names = parsed.book ? Object.keys(parsed.book) : [];
  const metas = useMemo(
    () => [...allMetas()].sort((a, b) => a.group.localeCompare(b.group, 'zh-CN')),
    [],
  );
  const requestedSpell = selected.startsWith('spell:') ? selected.slice(6) : '';
  const requestedMeta = selected.startsWith('meta:') ? selected.slice(5) : '';
  const active = names.includes(requestedSpell) ? requestedSpell : '';
  const activeMeta = metas.find((meta) => meta.name === requestedMeta) ?? null;
  const activeKey = active
    ? `spell:${active}`
    : activeMeta
      ? `meta:${activeMeta.name}`
      : names[0]
        ? `spell:${names[0]}`
        : metas[0]
          ? `meta:${metas[0].name}`
          : '';
  const activeSpell = active || (activeKey.startsWith('spell:') ? activeKey.slice(6) : '');
  const shownMeta =
    activeMeta ??
    (activeKey.startsWith('meta:')
      ? (metas.find((meta) => meta.name === activeKey.slice(5)) ?? null)
      : null);

  const ghost = useMemo<BattleEntity[]>(
    () => layout(enemyCount).map((p, i) => ({ id: i + 1, x: p.x, y: p.y, hp: 100, alive: true })),
    [enemyCount],
  );

  const run = (): void => {
    setRunError('');
    setStepSession(null);
    stepVm.current = null;
    if (!parsed.book || !activeSpell) return;
    try {
      const program = compileProgram(parsed.book, activeSpell);
      const world = new World();
      for (const p of layout(enemyCount)) {
        world.spawnActor({ faction: 'foe', x: p.x, y: p.y, attrs: { hpMax: 100 } });
      }
      const caster = world.spawnActor({
        name: '推演者',
        faction: 'player',
        x: 0,
        y: 0,
        attrs: { manaMax, shenshiMax },
      });
      const result = new VM(program, world, caster).run(activeSpell);
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

  const resetStep = (): void => {
    setRunError('');
    setOutcome(null);
    if (!parsed.book || !activeSpell) return;
    try {
      const program = compileProgram(parsed.book, activeSpell);
      const world = new World();
      for (const p of layout(enemyCount)) {
        world.spawnActor({ faction: 'foe', x: p.x, y: p.y, attrs: { hpMax: 100 } });
      }
      const caster = world.spawnActor({
        name: '推演者',
        faction: 'player',
        x: 0,
        y: 0,
        attrs: { manaMax, shenshiMax },
      });
      const vm = new VM(program, world, caster);
      vm.start(activeSpell);
      stepVm.current = vm;
      const snapshot = vm.snapshot();
      setStepSession({ snapshot, timeline: [snapshot] });
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    }
  };

  const step = (): void => {
    const vm = stepVm.current;
    if (!vm || !vm.isRunning) return;
    const snapshot = vm.step();
    setStepSession((current) =>
      current
        ? { snapshot, timeline: [...current.timeline, snapshot] }
        : { snapshot, timeline: [snapshot] },
    );
  };

  const hitId = useMemo(() => {
    if (!outcome) return null;
    const m = /#(\d+)/.exec(outcome.aim);
    return m ? Number(m[1]) : null;
  }, [outcome]);

  const addSpell = (): void => {
    if (!parsed.book) return;
    let suffix = 1;
    let name = '新法术';
    while (parsed.book[name]) {
      suffix += 1;
      name = `新法术${suffix}`;
    }
    onSourceChange(serializeBook({ ...parsed.book, [name]: emptySpell(name) }));
    setSelected(`spell:${name}`);
    setEditorMode('code');
    setOutcome(null);
    setStepSession(null);
    stepVm.current = null;
  };

  const deleteSpell = (): void => {
    if (!parsed.book || !activeSpell) return;
    const next = { ...parsed.book };
    delete next[activeSpell];
    const nextNames = Object.keys(next);
    onSourceChange(serializeBook(next));
    setSelected(nextNames[0] ? `spell:${nextNames[0]}` : metas[0] ? `meta:${metas[0].name}` : '');
    setOutcome(null);
    setStepSession(null);
    stepVm.current = null;
  };

  return (
    <div className={`app lab-app mode-${editorMode}`}>
      <header className="topbar">
        <div className="brand">
          道衍<span>推演台</span>
        </div>
        <div className="hint">
          改写法术 → 看静态消耗 → 推演实测 → 比较不同写法在法力 / 神识 / 耗时上的取舍
        </div>
      </header>

      <div className="lab-modebar">
        <span className="mode-label">法术编辑</span>
        <div className="mode-switch" role="tablist" aria-label="法术编辑方式">
          <button
            type="button"
            role="tab"
            aria-selected={editorMode === 'code'}
            data-testid="lab-code-mode"
            className={editorMode === 'code' ? 'mode active' : 'mode'}
            onClick={() => setEditorMode('code')}
          >
            DSL 代码
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={editorMode === 'blueprint'}
            data-testid="lab-blueprint-mode"
            className={editorMode === 'blueprint' ? 'mode active' : 'mode'}
            onClick={() => setEditorMode('blueprint')}
          >
            蓝图
          </button>
        </div>
        <span className="mode-help">
          {shownMeta
            ? '查看元法术签名、输入含义和资源定价'
            : editorMode === 'code'
              ? '直接编写 DSL，修改后自动检查'
              : '拖节点和连线，编译结果回写当前法术'}
        </span>
      </div>

      <main className="grid">
        <section className="panel spellbook-panel">
          <div className="spellbook-heading">
            <h2>法术书</h2>
            <div className="spell-actions">
              <button
                type="button"
                title="新建自定义法术"
                aria-label="新建自定义法术"
                onClick={addSpell}
              >
                +
              </button>
              <button
                type="button"
                title="删除当前自定义法术"
                aria-label="删除当前自定义法术"
                disabled={!activeSpell}
                onClick={deleteSpell}
              >
                ×
              </button>
            </div>
          </div>
          <div className="spell-catalog">
            <section className="catalog-group">
              <h3>
                自定义法术 <span>{names.length}</span>
              </h3>
              {names.length === 0 ? (
                <p className="muted small">暂无自定义法术</p>
              ) : (
                <ul className="spell-list">
                  {names.map((n) => {
                    const c = parsed.costs?.[n];
                    return (
                      <li key={n}>
                        <button
                          className={n === activeSpell ? 'spell active' : 'spell'}
                          onClick={() => {
                            setSelected(`spell:${n}`);
                            setOutcome(null);
                            setStepSession(null);
                            stepVm.current = null;
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
            </section>
            <section className="catalog-group meta-catalog">
              <h3>
                元法术 <span>{metas.length}</span>
              </h3>
              <ul className="spell-list">
                {metas.map((meta) => (
                  <li key={meta.name}>
                    <button
                      className={
                        shownMeta?.name === meta.name
                          ? 'spell meta-spell active'
                          : 'spell meta-spell'
                      }
                      title={meta.desc}
                      onClick={() => {
                        setSelected(`meta:${meta.name}`);
                        setOutcome(null);
                        setStepSession(null);
                        stepVm.current = null;
                      }}
                    >
                      <span>{meta.name}</span>
                      <small>
                        {meta.group} · 法{meta.mana} · {meta.ticks}t
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <select
            className="spell-picker"
            aria-label="选择法术"
            value={activeKey}
            onChange={(e) => {
              setSelected(e.target.value);
              setOutcome(null);
              setStepSession(null);
              stepVm.current = null;
            }}
          >
            <optgroup label="自定义法术">
              {names.map((name) => (
                <option key={name} value={`spell:${name}`}>
                  {name}
                </option>
              ))}
            </optgroup>
            <optgroup label="元法术">
              {metas.map((meta) => (
                <option key={meta.name} value={`meta:${meta.name}`}>
                  {meta.name}
                </option>
              ))}
            </optgroup>
          </select>
          {activeSpell && parsed.costs?.[activeSpell] && (
            <CostCard cost={parsed.costs[activeSpell]} />
          )}
        </section>

        <section className="panel editor-panel">
          <h2>{shownMeta ? '元法术详情' : editorMode === 'code' ? '法术源码' : '法术蓝图'}</h2>
          {shownMeta ? (
            <MetaInspector meta={shownMeta} />
          ) : editorMode === 'code' ? (
            <SpellEditor
              source={source}
              spellName={activeSpell}
              onSourceChange={(next) => {
                onSourceChange(next);
                setOutcome(null);
                setStepSession(null);
                stepVm.current = null;
              }}
              onSpellNameChange={(name) => setSelected(`spell:${name}`)}
            />
          ) : (
            <div className="blueprint-callout">
              <NodeEditor
                source={source}
                spell={parsed.book && activeSpell ? parsed.book[activeSpell] : null}
                onSourceChange={(next: string) => {
                  onSourceChange(next);
                  setOutcome(null);
                  setStepSession(null);
                  stepVm.current = null;
                }}
                onSpellNameChange={(name) => setSelected(`spell:${name}`)}
              />
            </div>
          )}
          {!shownMeta &&
            (parsed.error ? (
              <pre className="errors">{parsed.error}</pre>
            ) : (
              <p className="ok">解析通过 · {names.length} 个法术</p>
            ))}
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
          <button className="run" onClick={run} disabled={!activeSpell}>
            推演一次
          </button>
          <div className="step-controls" aria-label="单步推演控制">
            <button type="button" className="mini" onClick={resetStep} disabled={!activeSpell}>
              重置单步
            </button>
            <button
              type="button"
              className="mini"
              onClick={step}
              disabled={!stepSession || stepSession.snapshot.status !== 'running'}
            >
              执行下一步
            </button>
          </div>
          {stepSession && <StepInspector session={stepSession} />}
          {shownMeta && (
            <p className="muted small meta-run-hint">
              元法术是自定义法术的基础组件，不能单独推演。
            </p>
          )}
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

      {editorMode === 'code' && (
        <NodeGraph spell={parsed.book && activeSpell ? parsed.book[activeSpell] : null} />
      )}
    </div>
  );
}

function StepInspector({ session }: { session: StepSession }) {
  const { snapshot, timeline } = session;
  return (
    <section className="step-inspector" aria-label="单步推演观察">
      <h3>单步观察</h3>
      <p className="muted small">
        {snapshot.instruction
          ? `${snapshot.instruction.fn} · #${snapshot.instruction.pc} ${snapshot.instruction.op}`
          : '已就绪：点击“执行下一步”开始'}
        {' · '}
        {snapshot.status === 'running'
          ? '施法中'
          : snapshot.status === 'done'
            ? '已完成'
            : '已失败'}
      </p>
      <div className="stat-row">
        <Stat label="法力" value={String(snapshot.mana)} />
        <Stat label="神识" value={`${snapshot.shenshi}/${snapshot.shenshiPeak}`} />
        <Stat label="耗时" value={`${snapshot.ticks}t`} />
      </div>
      <dl className="step-variables">
        {snapshot.variables.length === 0 ? (
          <div>
            <dt>变量</dt>
            <dd>{snapshot.status === 'running' ? '暂无活跃变量' : '当前调用帧已结束'}</dd>
          </div>
        ) : (
          snapshot.variables.map((variable, index) => (
            <div key={`${variable.name}-${index}`}>
              <dt>{variable.name}</dt>
              <dd>{formatValue(variable.value)}</dd>
            </div>
          ))
        )}
      </dl>
      <ol className="resource-timeline" aria-label="资源消耗时间线">
        {timeline.map((point, index) => (
          <li key={index}>
            {index}: 法{point.mana} · 神{point.shenshi} · {point.ticks}t
          </li>
        ))}
      </ol>
    </section>
  );
}

function formatValue(value: unknown): string {
  if (value === null) return '未赋值';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function MetaInspector({ meta }: { meta: MetaDef }) {
  return (
    <div className="meta-inspector">
      <header>
        <div>
          <span className="meta-kind">{meta.group}</span>
          <h3>{meta.name}</h3>
        </div>
        <code>
          {meta.name}({meta.params.map((param) => `${param.name}: ${typeName(param.t)}`).join(', ')}
          ){meta.ret.k === 'void' ? '' : ` → ${typeName(meta.ret)}`}
        </code>
      </header>
      <p>{meta.desc}</p>
      <div className="meta-costs">
        <Stat label="法力" value={String(meta.mana)} />
        <Stat label="耗时" value={`${meta.ticks}t`} />
        <Stat label="返回" value={typeName(meta.ret)} />
      </div>
      <section>
        <h4>输入</h4>
        {meta.params.length === 0 ? (
          <p className="muted small">无需输入，节点可以直接参与值连接或控制流。</p>
        ) : (
          <dl className="meta-inputs">
            {meta.params.map((param, index) => (
              <div key={`${param.name}-${index}`}>
                <dt>
                  {index + 1}. {param.name}
                </dt>
                <dd>{inputDescription(param.name, typeName(param.t))}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      <p className="meta-source-note">
        元法术由系统与扩展模块提供；自定义法术可以在 DSL 或蓝图中调用它。
      </p>
    </div>
  );
}

function inputDescription(name: string, type: string): string {
  return `“${name}”输入，类型为 ${type}。在蓝图中连接同类型的值输出端口。`;
}
