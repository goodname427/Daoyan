import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { ATTR_LABELS, describeMeta, parseSpellbook, SPELL_KIND_LABELS } from '../core/index';
import type { Actor, AttrKey, Attributes, SpellBook } from '../core/index';
import { sfx } from '../game/audio';
import { Battle } from '../game/battle';
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

const ATTR_CONTROLS: Array<{ key: AttrKey; min: number; max: number; step: number }> = [
  { key: 'hpMax', min: 20, max: 500, step: 10 },
  { key: 'manaMax', min: 20, max: 800, step: 10 },
  { key: 'manaRegen', min: 0, max: 120, step: 1 },
  { key: 'shenshiMax', min: 8, max: 160, step: 1 },
  { key: 'speed', min: 0, max: 360, step: 5 },
  { key: 'castSpeed', min: 0.1, max: 5, step: 0.05 },
  { key: 'power', min: 0.1, max: 5, step: 0.05 },
  { key: 'manaCostMul', min: 0.1, max: 3, step: 0.05 },
  { key: 'cooldownMul', min: 0.1, max: 3, step: 0.05 },
  { key: 'perception', min: 0.1, max: 3, step: 0.05 },
  { key: 'armor', min: 0, max: 120, step: 1 },
];

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
  const shenshiInUse = battle.shenshiInUse(player.id);
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

        <AttributePanel player={player} />
        <AttributeEditor attrs={attrs} onChange={onAttrChange} />
        <BindingPanel battle={battle} bindings={bindings} onChange={onBindingChange} />

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
                            width: `${Math.min(100, (cast.vm.spentTicks / Math.max(1, cost?.tickWorst ?? 1)) * 100)}%`,
                          }}
                        />
                      </div>
                      <div className="muted small">
                        {cast.vm.spentTicks}/{cost?.tickWorst ?? '?'} tick · 第 {cast.fired} 次
                      </div>
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

const HUD_ATTRS: AttrKey[] = ['speed', 'castSpeed', 'power', 'manaCostMul', 'perception', 'armor'];

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

/** 属性面板：展示有效属性，有增益时高亮 */
function AttributePanel({ player }: { player: Actor }) {
  return (
    <div className="attrs">
      {HUD_ATTRS.map((k) => {
        const cur = player.attr[k];
        const base = player.base[k];
        const buffed = Math.abs(cur - base) > 1e-6;
        return (
          <div key={k} className="attr-row">
            <span>{ATTR_LABELS[k]}</span>
            <b className={buffed ? 'buffed' : ''}>
              {k === 'armor' ? cur.toFixed(0) : cur.toFixed(2)}
            </b>
          </div>
        );
      })}
      {player.mods.length > 0 && (
        <div className="muted small">增益 {player.mods.length} 项生效中</div>
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

function BindingPanel({
  battle,
  bindings,
  onChange,
}: {
  battle: Battle;
  bindings: Record<string, string>;
  onChange: (slot: string, spell: string) => void;
}) {
  return (
    <div className="bindings">
      {SLOTS.map((s) => {
        const spell = bindings[s.key] ?? '';
        const cd = spell ? battle.cooldownLeft(battle.player.id, spell) : 0;
        return (
          <label key={s.key} className="binding">
            <span>{s.label}</span>
            <select value={spell} onChange={(e) => onChange(s.key, e.target.value)}>
              <option value="">—</option>
              {battle.spellNames().map((n) => (
                <option key={n} value={n}>
                  {n} · {SPELL_KIND_LABELS[battle.metaOf(n).kind]}
                </option>
              ))}
            </select>
            {cd > 0 && <em className="cd">{cd.toFixed(1)}s</em>}
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
          return (
            <li key={name}>
              <span>{name}</span>
              <small>
                {SPELL_KIND_LABELS[battle.metaOf(name).kind]} · 法{cost?.manaWorst ?? '?'} · 神
                {cost?.shenshiPeak ?? '?'} · {cost?.tickWorst ?? '?'}t
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
      return { book: parseSpellbook(source), error: '' };
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
