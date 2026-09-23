import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  ATTR_LABELS,
  describeMeta,
  migrateSpellSource,
  SENSE_ATTEMPT_PRICE,
  SPELL_KIND_LABELS,
  sensePrice,
} from '../core/index';
import type {
  AttrKey,
  Attributes,
  EntityAuditField,
  EntityAuditResult,
  SpellBook,
  WorldEventType,
} from '../core/index';
import { sfx } from '../game/audio';
import { Battle } from '../game/battle';
import { ARENA_ATTR_CONSTRAINTS } from './arenaConfig';
import { Renderer } from './renderer';

const VIEW_W = 900;
const VIEW_H = 560;

const SLOTS: Array<{ key: string; label: string }> = [
  { key: 'mouse', label: '左键' },
  { key: '1', label: '1' },
  { key: '2', label: '2' },
  { key: '3', label: '3' },
  { key: '4', label: '4' },
  { key: '5', label: '5' },
];

const MOVEMENT_KEYS: Record<string, keyof BattleInputLike> = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};

const ATTR_CONTROLS = ARENA_ATTR_CONSTRAINTS;

interface BattleInputLike {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

interface ParsedBook {
  book: SpellBook | null;
  error: string;
}

interface CombatViewProps {
  source: string;
  attrs: Attributes;
  bindings: Record<string, string>;
  onAttrsChange: (attrs: Attributes) => void;
  onBindingsChange: (bindings: Record<string, string>) => void;
}

interface ArenaProps {
  battle: Battle;
  attrs: Attributes;
  bindings: Record<string, string>;
  onAttrChange: (key: AttrKey, value: number) => void;
  onBindingChange: (slot: string, spell: string) => void;
}

function Arena({ battle, attrs, bindings, onAttrChange, onBindingChange }: ArenaProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer>(new Renderer());
  const [, force] = useReducer((x: number) => x + 1, 0);
  const lastRef = useRef(0);
  const hudRef = useRef(0);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [selfSnapshot, setSelfSnapshot] = useState<PanelSnapshot | null>(null);
  const [targetSnapshot, setTargetSnapshot] = useState<PanelSnapshot | null>(null);
  const [senseFeedback, setSenseFeedback] = useState('');
  const [worldEpoch, setWorldEpoch] = useState(0);
  const clearObservation = (): void => {
    setTargetId(null);
    setSelfSnapshot(null);
    setTargetSnapshot(null);
    setSenseFeedback('');
  };

  const observe = (id: number, fields: readonly EntityAuditField[]): PanelSnapshot | null => {
    const values: Partial<Record<EntityAuditField, EntityAuditResult>> = {};
    let paid = 0;
    let insufficient = false;
    for (const field of fields) {
      const quote = battle.world.senseQuote(battle.player, id, field);
      const cost = quote ? sensePrice(quote) : SENSE_ATTEMPT_PRICE;
      const amount = cost.mana.value;
      if (battle.world.resourceLedger.payMana(battle.player.id, amount, 'panel-sense') === null) {
        insufficient = true;
        break;
      }
      paid += amount;
      if (!quote) continue;
      const result = battle.world.readEntityAuditField(id, field);
      if (result.ok) values[field] = result;
    }
    if (Object.keys(values).length === 0) {
      setSenseFeedback(
        insufficient
          ? `法力不足，未更新快照；已支付 ${paid} 法力尝试价`
          : `不可探查：目标不存在、越距或没有字段权限；已支付 ${paid} 法力尝试价`,
      );
      return null;
    }
    setSenseFeedback(
      `已按公开报价支付 ${paid} 法力；${insufficient ? '余额不足，其余字段未知' : '快照不会自动刷新'}`,
    );
    return { targetId: id, values, observedAt: battle.world.controlTimeNow };
  };

  useEffect(() => {
    rendererRef.current.reset();
    lastRef.current = 0;
    let raf = 0;
    const loop = (now: number) => {
      const last = lastRef.current || now;
      const dt = Math.min(0.05, (now - last) / 1000);
      lastRef.current = now;
      battle.update(dt);
      const canvas = canvasRef.current;
      if (canvas) rendererRef.current.render(canvas, battle, battle.paused ? 0 : dt);
      if (now - hudRef.current > 80) {
        hudRef.current = now;
        force();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [battle]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code === 'KeyP') {
        battle.setPaused(!battle.paused);
        force();
        return;
      }
      const dir = MOVEMENT_KEYS[e.code];
      if (dir) {
        if (battle.started && !battle.paused) battle.input[dir] = true;
        e.preventDefault();
        return;
      }
      const m = /^Digit([1-5])$/.exec(e.code);
      if (m && !e.repeat) battle.pressSlot(m[1]);
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      const dir = MOVEMENT_KEYS[e.code];
      if (dir) {
        battle.input[dir] = false;
        return;
      }
      const m = /^Digit([1-5])$/.exec(e.code);
      if (m) battle.releaseSlot(m[1]);
    };
    const onBlur = (): void => {
      battle.input.up = false;
      battle.input.down = false;
      battle.input.left = false;
      battle.input.right = false;
      for (const s of SLOTS) battle.releaseSlot(s.key);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    const unlock = (): void => sfx.unlock();
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('pointerdown', unlock);
    };
  }, [battle]);

  const player = battle.player;
  const activeCasts = battle.activeCasts(player.id);
  const maintained = battle.world
    .controlRecordSnapshot()
    .filter((record) => record.mode === 'maintain');
  const shenshiAudit = battle.world.readEntityAuditField(player.id, 'shenshiUsed');
  const shenshiInUse =
    shenshiAudit.ok && typeof shenshiAudit.value === 'number'
      ? shenshiAudit.value
      : battle.shenshiInUse(player.id);
  const showOverlay = !battle.started || battle.paused || battle.state !== 'fighting';

  return (
    <div className="arena-wrap">
      <div className="arena-stage">
        <canvas
          ref={canvasRef}
          width={VIEW_W}
          height={VIEW_H}
          className="arena"
          onMouseMove={(e) => {
            const el = e.currentTarget;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const camX = Number(el.dataset.camX ?? 0);
            const camY = Number(el.dataset.camY ?? 0);
            const sx = ((e.clientX - rect.left) / rect.width) * VIEW_W + camX;
            const sy = ((e.clientY - rect.top) / rect.height) * VIEW_H + camY;
            battle.aimAt(sx, sy);
          }}
          onMouseDown={() => battle.pressSlot('mouse')}
          onMouseUp={() => battle.releaseSlot('mouse')}
          onMouseLeave={() => battle.releaseSlot('mouse')}
        />
        {showOverlay && (
          <div className="overlay">
            <div className="overlay-title">{overlayTitle(battle)}</div>
            <p>{overlayText(battle)}</p>
            <div className="overlay-actions">
              {!battle.started ? (
                <button
                  className="run"
                  onClick={() => {
                    battle.start();
                    force();
                  }}
                >
                  开始演武
                </button>
              ) : battle.paused ? (
                <button
                  className="run"
                  onClick={() => {
                    battle.setPaused(false);
                    force();
                  }}
                >
                  继续
                </button>
              ) : (
                <button
                  className="run"
                  onClick={() => {
                    battle.restart();
                    clearObservation();
                    setWorldEpoch((value) => value + 1);
                    force();
                  }}
                >
                  再来一局
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="hud">
        <div className="battle-controls">
          {!battle.started ? (
            <button
              className="run"
              onClick={() => {
                battle.start();
                force();
              }}
            >
              开始演武
            </button>
          ) : (
            <>
              <button
                className="mini"
                onClick={() => {
                  battle.setPaused(!battle.paused);
                  force();
                }}
              >
                {battle.paused ? '继续' : '暂停'}
              </button>
              <button
                className="mini"
                onClick={() => {
                  battle.restart();
                  clearObservation();
                  setWorldEpoch((value) => value + 1);
                  force();
                }}
              >
                重开
              </button>
            </>
          )}
          <button
            className="mini"
            onClick={() => {
              sfx.enabled = !sfx.enabled;
              force();
            }}
          >
            {sfx.enabled ? '♪ 音效' : '× 静音'}
          </button>
        </div>

        <div className="bars">
          <Bar label="生命" v={player.hp} max={player.attr.hpMax} color="#7bd88f" />
          <Bar label="法力" v={player.mana} max={player.attr.manaMax} color="#6aa9ff" />
          <div className="bar-row">
            <span className="bar-label">神识</span>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{
                  width: `${Math.min(100, (shenshiInUse / Math.max(1, player.attr.shenshiMax)) * 100)}%`,
                  background: '#c39bff',
                }}
              />
            </div>
            <span className="bar-num">
              {Math.round(shenshiInUse)}/{player.attr.shenshiMax}
            </span>
          </div>
        </div>

        <AttributePanel
          battle={battle}
          selfSnapshot={selfSnapshot}
          targetSnapshot={targetSnapshot}
          targetId={targetId}
          onTargetChange={(id) => {
            setTargetId(id);
            setTargetSnapshot(null);
            setSenseFeedback('');
          }}
          onObserveSelf={() => {
            const next = observe(player.id, SELF_FIELDS);
            if (next) setSelfSnapshot(next);
          }}
          onObserveTarget={() => {
            if (targetId !== null) {
              const next = observe(targetId, TARGET_FIELDS);
              if (next) setTargetSnapshot(next);
            }
          }}
          feedback={senseFeedback}
        />
        <AttributeEditor attrs={attrs} onChange={onAttrChange} />
        <BindingPanel battle={battle} bindings={bindings} onChange={onBindingChange} />
        <PhaseThreeControls
          key={worldEpoch}
          battle={battle}
          targetId={targetId}
          onWorldChange={force}
        />

        <div className="phase-three-summary" aria-label="账户与会话摘要">
          <h3>账户与会话</h3>
          {(() => {
            const account = battle.world.resourceLedger.manaAccountSnapshot(player.id);
            const pools = battle.world.projectiles
              .filter((projectile) => projectile.ownerId === player.id)
              .map((projectile) => battle.world.resourceLedger.balance(projectile.id))
              .reduce(
                (sum, balance) => ({
                  motion: sum.motion + balance.motion,
                  damage: sum.damage + balance.damage,
                  scan: sum.scan + balance.scan,
                }),
                { motion: 0, damage: 0, scan: 0 },
              );
            return account ? (
              <>
                <p className="muted small">
                  本人法力 {player.mana.toFixed(1)} · 累计付款{' '}
                  {(account.paid / 1_000_000).toFixed(1)} · 退款{' '}
                  {(account.refunded / 1_000_000).toFixed(1)} · 账目
                  {account.conserved ? '守恒' : '待核对'}
                </p>
                <p className="muted small">
                  本人法球未用储能：运动 {pools.motion.toFixed(1)} · 命中 {pools.damage.toFixed(1)}{' '}
                  · 探查 {pools.scan.toFixed(1)}
                </p>
              </>
            ) : null;
          })()}
          {battle.chargeSessions.size === 0 && battle.finishedCharges.length === 0 ? (
            <p className="muted small">暂无蓄力会话</p>
          ) : (
            <ul className="phase-three-list">
              {[
                ...battle.chargeSessions.values(),
                ...battle.finishedCharges.slice(-4).reverse(),
              ].map((session, index) => (
                <li key={`${session.slot}-${session.spell}-${index}`}>
                  {session.spell} · {session.mode === 'prepare' ? '蓄时瞬发' : '持球注能'} ·
                  {session.terminal ? CHARGE_END_LABELS[session.terminal] : '进行中'} ·{' '}
                  {session.elapsed.toFixed(2)} 秒 · 已付工作
                  {session.workTicks.toFixed(0)} tick
                </li>
              ))}
            </ul>
          )}
          {battle.eventResponses.length > 0 && (
            <ul className="phase-three-list" aria-label="获准事件响应">
              {battle.eventResponses.slice(0, 6).map((response, index) => (
                <li key={`${response.eventId}-${response.spell}-${index}`}>
                  #{response.eventId} {EVENT_LABELS[response.type]} → {response.spell} ·
                  {response.state === 'running'
                    ? '执行中'
                    : response.state === 'success'
                      ? '成功'
                      : `失败：${response.error}`}{' '}
                  · 法力 {response.mana.toFixed(1)} / {response.ticks} tick
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="meta-info">
          <div className="row-between">
            <span>
              第 <b>{battle.waveIndex + 1}</b> 波 · 剩余妖兽 <b>{battle.foesLeft()}</b>
            </span>
            <b>{battle.started ? (battle.paused ? '暂停' : '演武中') : '整备'}</b>
          </div>
          <div className="muted small">
            施法 {battle.stats.casts} · 打断 {battle.stats.interrupts} · 反噬{' '}
            {battle.stats.backfires}
          </div>
          {activeCasts.length > 0 && (
            <div className="casting-note" data-testid="active-casts">
              <div className="row-between">
                <b>并行施法 {activeCasts.length}</b>
                <span className="muted small">受击会打断可打断法术</span>
              </div>
              <div className="active-cast-list">
                {activeCasts.map((cast) => {
                  const cost = battle.costs[cast.spell];
                  const tickBase = Math.max(1, cost?.tickBudget.value ?? 1);
                  const tickProgress = cost?.tickBudget.dynamic
                    ? Math.min(90, (cast.vm.spentTicks / tickBase) * 90)
                    : Math.min(100, (cast.vm.spentTicks / tickBase) * 100);
                  const tickBudget = cost?.tickBudget.dynamic
                    ? `${cost.tickBudget.value}+动态`
                    : (cost?.tickWorst ?? '?');
                  return (
                    <div
                      className="active-cast"
                      key={cast.triggerSlot}
                      data-slot={cast.triggerSlot}
                    >
                      <div className="row-between">
                        <span>
                          <b>{cast.triggerSlot === 'mouse' ? '左键' : cast.triggerSlot}</b> ·{' '}
                          {cast.spell}
                        </span>
                        <span>{describeMeta(cast.meta)}</span>
                      </div>
                      <div className="cast-progress" aria-hidden="true">
                        <span
                          style={{
                            width: `${tickProgress}%`,
                          }}
                        />
                      </div>
                      <div className="muted small">
                        已用 {cast.vm.spentTicks} tick · 预算 {tickBudget} tick · 第 {cast.fired} 次
                      </div>
                      {maintained
                        .filter((record) => record.controllerSessionId === cast.controlSession.id)
                        .map((record) => (
                          <div className="muted small" key={record.sequence}>
                            维持实例：{record.propertyKey} · 目标 #{record.targetId} ·{' '}
                            {record.expiresAt === null
                              ? '无限'
                              : `剩余 ${Math.max(0, record.expiresAt - battle.world.controlTimeNow).toFixed(2)} 秒`}
                            {' · '}已付 {record.paidPeriods} 周期（每 0.25 秒）
                            {' · '}控制累计法力 {cast.controlCharge.mana.toFixed(1)} / tick{' '}
                            {cast.controlCharge.ticks}
                            {' · '}下周期成本随关系、抗性和效果动态计算
                          </div>
                        ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <ul className="log">
          {battle.log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const SELF_FIELDS = [
  'speedMax',
  'velocity',
  'castSpeed',
  'manaCostMul',
  'perception',
  'armor',
  'events',
] as const;
const TARGET_FIELDS = ['position', 'speedMax', 'hp', 'events'] as const;
const EVENT_LABELS: Record<WorldEventType, string> = {
  damage: '受击',
  collision: '碰撞',
  'mana-exhausted': '法力耗尽',
  disappear: '实体消失',
};
const CHARGE_END_LABELS = {
  released: '已释放',
  'early-release': '提前松开取消',
  interrupted: '受击打断',
  cancelled: '已取消',
  death: '死亡终止',
  exhausted: '法力耗尽',
  'target-lost': '目标失效',
  expired: '持有到期',
} as const;
interface PanelSnapshot {
  targetId: number;
  observedAt: number;
  values: Partial<Record<EntityAuditField, EntityAuditResult>>;
}

function overlayTitle(battle: Battle): string {
  if (!battle.started) return '整备中';
  if (battle.paused) return '暂停';
  return battle.state === 'victory' ? '尽数伏诛' : '道消身陨';
}

function overlayText(battle: Battle): string {
  if (!battle.started) return '设定基础属性与法术绑定后开始演武';
  if (battle.paused) return '战场已冻结，可以调整属性或法术绑定';
  return `共施法 ${battle.stats.casts} 次 · 打断 ${battle.stats.interrupts} 次 · 走火入魔 ${battle.stats.backfires} 次 · 击杀 ${battle.stats.kills}`;
}

/** 战场观察只呈现付费且获准的读取结果；历史快照不随实时实体变化。 */
function AttributePanel({
  battle,
  selfSnapshot,
  targetSnapshot,
  targetId,
  onTargetChange,
  onObserveSelf,
  onObserveTarget,
  feedback,
}: {
  battle: Battle;
  selfSnapshot: PanelSnapshot | null;
  targetSnapshot: PanelSnapshot | null;
  targetId: number | null;
  onTargetChange: (id: number | null) => void;
  onObserveSelf: () => void;
  onObserveTarget: () => void;
  feedback: string;
}) {
  const foes = battle.world.actors.filter((actor) => actor.faction === 'foe' && actor.alive);
  const now = battle.world.controlTimeNow;
  const rows = (snapshot: PanelSnapshot | null, fields: readonly EntityAuditField[]) =>
    snapshot ? (
      fields.map((field) => {
        const result = snapshot.values[field];
        if (!result?.ok)
          return (
            <div className="attr-row" key={field}>
              <span>{field}</span>
              <b>未知</b>
            </div>
          );
        if (field === 'events') return null;
        const value =
          typeof result.value === 'number' ? result.value.toFixed(2) : JSON.stringify(result.value);
        return (
          <div className="attr-row" key={field}>
            <span>{field}</span>
            <b>{value}</b>
          </div>
        );
      })
    ) : (
      <p className="muted small">尚无获准快照</p>
    );
  const events = selfSnapshot?.values.events;
  const targetEvents = targetSnapshot?.values.events;
  const observedTarget = targetSnapshot && battle.world.entityById(targetSnapshot.targetId);
  const targetGone =
    targetSnapshot !== null &&
    (!observedTarget || (observedTarget.kind === 'actor' && !observedTarget.alive));
  return (
    <div className="attrs" role="region" aria-label="授权属性面板">
      <h3>自己</h3>
      <button type="button" className="mini" onClick={onObserveSelf}>
        读取自身快照
      </button>
      {selfSnapshot && (
        <p className="muted small">
          模拟时刻 {selfSnapshot.observedAt.toFixed(2)} 秒 ·{' '}
          {now > selfSnapshot.observedAt + 1 ? '已过期' : '已获准快照'}
        </p>
      )}
      {rows(selfSnapshot, SELF_FIELDS)}
      <h3>已获准目标</h3>
      <select
        aria-label="探查目标"
        value={targetId ?? ''}
        onChange={(event) => onTargetChange(event.target.value ? Number(event.target.value) : null)}
      >
        <option value="">无目标</option>
        {foes.map((foe) => (
          <option key={foe.id} value={foe.id}>
            目标 #{foe.id}
          </option>
        ))}
      </select>
      <button type="button" className="mini" disabled={targetId === null} onClick={onObserveTarget}>
        读取目标快照
      </button>
      {targetSnapshot && (
        <p className="muted small">
          目标 #{targetSnapshot.targetId} · 模拟时刻 {targetSnapshot.observedAt.toFixed(2)} 秒 ·{' '}
          {targetGone
            ? '目标已消失，历史快照'
            : now > targetSnapshot.observedAt + 1
              ? '已过期'
              : '已获准快照'}
        </p>
      )}
      {targetId === null ? (
        <p className="muted small">无目标</p>
      ) : (
        rows(targetSnapshot, TARGET_FIELDS)
      )}
      <h3>必要事件</h3>
      {events?.ok && Array.isArray(events.value) && events.value.length > 0 ? (
        <ul className="log">
          {events.value
            .slice(-4)
            .map((event: { at: number; type: string; summary: string }, index: number) => (
              <li key={index}>
                {event.at.toFixed(2)} 秒 · {event.summary}
              </li>
            ))}
        </ul>
      ) : (
        <p className="muted small">暂无获准事件摘要</p>
      )}
      {targetEvents?.ok && Array.isArray(targetEvents.value) && targetEvents.value.length > 0 && (
        <ul className="phase-three-list" aria-label="目标获准事件摘要">
          {targetEvents.value
            .slice(-4)
            .map((event: { at: number; summary: string }, index: number) => (
              <li key={index}>
                {event.at.toFixed(2)} 秒 · {event.summary}
              </li>
            ))}
        </ul>
      )}
      {feedback && (
        <p className="muted small" role="status">
          {feedback}
        </p>
      )}
    </div>
  );
}

function AttributeEditor({
  attrs,
  onChange,
}: {
  attrs: Attributes;
  onChange: (key: AttrKey, value: number) => void;
}) {
  return (
    <div className="attr-editor">
      <h3>基础属性</h3>
      <p className="muted small">
        六项可控属性：生命上限、法力上限、法力回复、神识上限、施法速度、法力消耗。上限变化不赠送当前资源；周期效果需持续付款。
      </p>
      {ATTR_CONTROLS.map((c) => (
        <label key={c.key} className="attr-control">
          <span>{ATTR_LABELS[c.key]}</span>
          <input
            type="number"
            min={c.min}
            max={c.max}
            step={c.step}
            value={formatAttrValue(attrs[c.key])}
            onChange={(e) => onChange(c.key, Number(e.target.value))}
          />
        </label>
      ))}
    </div>
  );
}

function PhaseThreeControls({
  battle,
  targetId,
  onWorldChange,
}: {
  battle: Battle;
  targetId: number | null;
  onWorldChange: () => void;
}) {
  const [type, setType] = useState<WorldEventType>('damage');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [field, setField] = useState<'position' | 'hp'>('position');
  const [monitorId, setMonitorId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState('');
  const subscriptions = useRef<number[]>([]);

  useEffect(() => {
    subscriptions.current = [];
    setMonitorId(null);
    setFeedback('');
    return () => {
      for (const id of subscriptions.current) battle.unsubscribeSpellEvent(id);
    };
  }, [battle]);

  const bind = (): void => {
    for (const id of subscriptions.current) battle.unsubscribeSpellEvent(id);
    subscriptions.current = [];
    for (const [index, spell] of [first, second].entries()) {
      if (!spell) continue;
      const id = battle.subscribeSpellEvent(
        battle.player.id,
        `arena:${type}:${index}`,
        type,
        spell,
      );
      if (id !== null) subscriptions.current.push(id);
    }
    setFeedback(
      subscriptions.current.length
        ? `已为${EVENT_LABELS[type]}登记 ${subscriptions.current.length} 个独立响应；各占 1 神识，按订阅顺序竞争本人账户。`
        : '未登记响应：请选择法术，检查法术错误和神识余额。',
    );
    onWorldChange();
  };
  const startMonitor = (): void => {
    if (targetId === null) return;
    if (monitorId !== null) battle.world.stopActiveMonitor(monitorId, battle.player.id);
    const paid = battle.world.resourceLedger.payMana(battle.player.id, 1, 'monitor-start');
    if (paid === null) {
      setFeedback('监控起手失败：本人法力不足。');
      setMonitorId(null);
      onWorldChange();
      return;
    }
    const id = battle.world.startActiveMonitor({
      ownerId: battle.player.id,
      payerId: battle.player.id,
      targetId,
      field,
      intervalSeconds: 0.25,
      periods: 4,
    });
    setMonitorId(id);
    setFeedback(
      id === null
        ? '监控被拒绝：已付 1 法力 / 1 tick 尝试价，目标字段仍须有授权。'
        : '监控已开启：起手 1 法力 / 1 tick；每 0.25 秒先付款与计 tick，再更新快照，最多 4 次。',
    );
    onWorldChange();
  };
  const monitor =
    monitorId === null ? null : battle.world.activeMonitorSnapshot(monitorId, battle.player.id);

  return (
    <section className="phase-three-controls" aria-label="事件与主动监控">
      <h3>被动事件与主动监控</h3>
      <p className="muted small">被动事件只在世界事实发生时派发；持续读取须开启付费监控。</p>
      <div className="phase-three-inputs">
        <label>
          事件
          <select
            aria-label="被动事件类型"
            value={type}
            onChange={(event) => setType(event.target.value as WorldEventType)}
          >
            {Object.entries(EVENT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {[first, second].map((value, index) => (
          <label key={index}>
            响应法术 {index + 1}
            <select
              aria-label={`响应法术 ${index + 1}`}
              value={value}
              onChange={(event) =>
                index === 0 ? setFirst(event.target.value) : setSecond(event.target.value)
              }
            >
              <option value="">—</option>
              {battle.spellNames().map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ))}
        <button type="button" className="mini" onClick={bind}>
          登记事件响应
        </button>
        <label>
          监控字段
          <select
            aria-label="主动监控字段"
            value={field}
            onChange={(event) => setField(event.target.value as 'position' | 'hp')}
          >
            <option value="position">位置</option>
            <option value="hp">生命</option>
          </select>
        </label>
        <button
          type="button"
          className="mini"
          disabled={targetId === null || !battle.started}
          onClick={startMonitor}
        >
          开启目标监控
        </button>
        <button
          type="button"
          className="mini"
          disabled={monitorId === null}
          onClick={() => {
            if (monitorId !== null) battle.world.stopActiveMonitor(monitorId, battle.player.id);
            setMonitorId(null);
            onWorldChange();
            setFeedback('主动监控已关闭，后续零扫描费。');
          }}
        >
          关闭目标监控
        </button>
      </div>
      {monitor && (
        <p className="muted small" aria-label="监控账户摘要">
          目标 #{monitor.targetId} · 已付法力 {monitor.paidMana.toFixed(1)} / {monitor.paidTicks}{' '}
          tick ·{' '}
          {monitor.finishedAt === null ? `剩余 ${monitor.remainingPeriods} 期` : '扫描已结束'} ·
          最近获准快照：
          {monitor.latest?.ok ? JSON.stringify(monitor.latest.value) : '尚未扫描'}
        </p>
      )}
      {monitorId !== null && !monitor && (
        <p className="muted small" aria-label="监控已终止">
          监控已终止或快照已过期：次数、余额、目标或授权发生变化；后续零扫描费。
        </p>
      )}
      {feedback && (
        <p className="muted small" role="status">
          {feedback}
        </p>
      )}
    </section>
  );
}

function BindingPanel({
  battle,
  bindings,
  onChange,
}: {
  battle: Battle;
  bindings: Record<string, string>;
  onChange: (slot: string, spell: string) => void;
}) {
  const spellNames = battle.spellNames();

  return (
    <div className="bindings">
      {SLOTS.map((s) => {
        const spell = bindings[s.key] ?? '';
        const missingFromBook = spell !== '' && !spellNames.includes(spell);
        return (
          <label key={s.key} className="binding">
            <span>{s.label}</span>
            <select value={spell} onChange={(e) => onChange(s.key, e.target.value)}>
              <option value="">—</option>
              {missingFromBook && <option value={spell}>{spell}（当前法术书中不存在）</option>}
              {spellNames.map((n) => (
                <option key={n} value={n}>
                  {n} · {SPELL_KIND_LABELS[battle.metaOf(n).kind]}
                </option>
              ))}
            </select>
            {battle.metaOf(spell).charge && (
              <span className="charge-actions">
                <button
                  type="button"
                  className="mini"
                  disabled={!battle.started || battle.paused}
                  onClick={() => battle.pressSlot(s.key)}
                >
                  按下{s.label}
                </button>
                <button type="button" className="mini" onClick={() => battle.releaseSlot(s.key)}>
                  松开{s.label}
                </button>
                <button type="button" className="mini" onClick={() => battle.cancelCharge(s.key)}>
                  取消{s.label}
                </button>
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}

function Bar({ label, v, max, color }: { label: string; v: number; max: number; color: string }) {
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <div className="bar-track">
        <div
          className="bar-fill"
          style={{
            width: `${Math.max(0, Math.min(100, (v / Math.max(1, max)) * 100))}%`,
            background: color,
          }}
        />
      </div>
      <span className="bar-num">
        {Math.round(v)}/{max}
      </span>
    </div>
  );
}

function SyncedSpellList({ battle }: { battle: Battle }) {
  return (
    <section className="panel wide">
      <h2>可绑定法术（来自推演台）</h2>
      <ul className="synced-spells">
        {battle.spellNames().map((name) => {
          const cost = battle.costs[name];
          const mana = cost?.manaBudget.dynamic
            ? `${cost.manaBudget.value}+动态`
            : (cost?.manaWorst ?? '?');
          const ticks = cost?.tickBudget.dynamic
            ? `${cost.tickBudget.value}+动态`
            : (cost?.tickWorst ?? '?');
          return (
            <li key={name}>
              <span>{name}</span>
              <small>
                {SPELL_KIND_LABELS[battle.metaOf(name).kind]} · 法{mana} · 神
                {cost?.shenshiPeak ?? '?'} · {ticks}t
              </small>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function formatAttrValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function CombatView({
  source,
  attrs,
  bindings,
  onAttrsChange,
  onBindingsChange,
}: CombatViewProps) {
  const [battle, setBattle] = useState<Battle | null>(null);

  const parsed = useMemo<ParsedBook>(() => {
    try {
      const migration = migrateSpellSource(source);
      if (!migration.ok) {
        return {
          book: null,
          error: migration.diagnostics
            .map(
              (diagnostic) =>
                `${diagnostic.spell || '法术书'}${diagnostic.line ? ` 第 ${diagnostic.line} 行` : ''}：${diagnostic.message}`,
            )
            .join('\n'),
        };
      }
      return { book: migration.book, error: '' };
    } catch (e) {
      return { book: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [source]);

  useEffect(() => {
    if (!parsed.book) {
      setBattle(null);
      return;
    }
    setBattle(
      new Battle(parsed.book, {
        playerAttrs: attrs,
        playerBindings: bindings,
        autoStart: false,
      }),
    );
  }, [parsed.book]);

  // 导入可以恢复与当前 source 完全相同的法术书；此时 parsed.book 保持
  // 引用不变，不能只依靠重建 Battle 来应用新的演武配置。
  useEffect(() => {
    if (!battle) return;
    battle.setPlayerBaseAttrs(attrs, true);
    for (const slot of SLOTS) battle.setBinding(slot.key, bindings[slot.key] ?? '');
  }, [battle, attrs, bindings]);

  const updateAttr = (key: AttrKey, value: number): void => {
    onAttrsChange({ ...attrs, [key]: value });
    battle?.setPlayerBaseAttr(key, value, true);
  };

  const updateBinding = (slot: string, spell: string): void => {
    onBindingsChange({ ...bindings, [slot]: spell });
    battle?.setBinding(slot, spell);
  };

  return (
    <div className="app arena-app">
      <header className="topbar">
        <div className="brand">
          道衍<span>演武场</span>
        </div>
        <div className="hint">
          WASD / 方向键移动 · 左键与 1~5 可同时施放不同槽位法术 · 施法时移速下降，受击会打断
        </div>
      </header>

      {parsed.error ? (
        <pre className="errors">{parsed.error}</pre>
      ) : (
        battle && (
          <>
            <Arena
              battle={battle}
              attrs={attrs}
              bindings={bindings}
              onAttrChange={updateAttr}
              onBindingChange={updateBinding}
            />
            <SyncedSpellList battle={battle} />
          </>
        )
      )}
    </div>
  );
}
