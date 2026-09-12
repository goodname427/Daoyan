import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import COMBAT_SPELLS from '../game/spells.dy?raw';
import { Battle } from '../game/battle';
import { sfx } from '../game/audio';
import { Renderer } from './renderer';
import { ATTR_LABELS, describeMeta, parseSpellbook, SPELL_KIND_LABELS } from '../core/index';
import type { Actor, AttrKey } from '../core/index';

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

interface BattleInputLike {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

function Arena({ battle }: { battle: Battle }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer>(new Renderer());
  const [, force] = useReducer((x: number) => x + 1, 0);
  const lastRef = useRef(0);
  const hudRef = useRef(0);

  useEffect(() => {
    rendererRef.current.reset();
    let raf = 0;
    const loop = (now: number) => {
      const last = lastRef.current || now;
      const dt = Math.min(0.05, (now - last) / 1000);
      lastRef.current = now;
      battle.update(dt);
      const canvas = canvasRef.current;
      if (canvas) rendererRef.current.render(canvas, battle, dt);
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
      const dir = MOVEMENT_KEYS[e.code];
      if (dir) {
        battle.input[dir] = true;
        e.preventDefault();
        return;
      }
      const m = /^Digit([1-5])$/.exec(e.code);
      if (m) battle.castPlayer(m[1]);
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      const dir = MOVEMENT_KEYS[e.code];
      if (dir) battle.input[dir] = false;
    };
    const onBlur = (): void => {
      battle.input.up = false;
      battle.input.down = false;
      battle.input.left = false;
      battle.input.right = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    // 任意按键 / 点击解除浏览器音频自动播放限制
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
  const casting = battle.casts.get(player.id);
  const castCost = casting ? battle.costs[casting.spell] : null;

  return (
    <div className="arena-wrap">
      <div className="arena-stage">
        <canvas
          ref={canvasRef}
          width={VIEW_W}
          height={VIEW_H}
          className="arena"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const camX = Number(e.currentTarget.dataset.camX ?? 0);
            const camY = Number(e.currentTarget.dataset.camY ?? 0);
            const sx = ((e.clientX - rect.left) / rect.width) * VIEW_W + camX;
            const sy = ((e.clientY - rect.top) / rect.height) * VIEW_H + camY;
            battle.aimAt(sx, sy);
          }}
          onMouseDown={() => battle.castPlayer('mouse')}
        />
        {battle.state !== 'fighting' && (
          <div className="overlay">
            <div className="overlay-title">
              {battle.state === 'victory' ? '尽数伏诛' : '道消身陨'}
            </div>
            <p>
              共施法 {battle.stats.casts} 次 · 打断 {battle.stats.interrupts} 次 · 走火入魔{' '}
              {battle.stats.backfires} 次 · 击杀 {battle.stats.kills}
            </p>
            <button className="run" onClick={() => battle.restart()}>
              再来一局
            </button>
          </div>
        )}
      </div>

      <div className="hud">
        <div className="bars">
          <Bar label="生命" v={player.hp} max={player.attr.hpMax} color="#7bd88f" />
          <Bar label="法力" v={player.mana} max={player.attr.manaMax} color="#6aa9ff" />
          <div className="bar-row">
            <span className="bar-label">神识</span>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{
                  width: `${Math.min(100, ((casting?.vm.peakShenshi ?? 0) / Math.max(1, player.attr.shenshiMax)) * 100)}%`,
                  background: '#c39bff',
                }}
              />
            </div>
            <span className="bar-num">
              {Math.round(casting?.vm.peakShenshi ?? 0)}/{player.attr.shenshiMax}
            </span>
          </div>
        </div>

        <AttributePanel player={player} />

        <div className="meta-info">
          <div className="row-between">
            <span>
              第 <b>{battle.waveIndex + 1}</b> 波 · 剩余妖兽 <b>{battle.foesLeft()}</b>
            </span>
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
          <div className="muted small">
            施法 {battle.stats.casts} · 打断 {battle.stats.interrupts} · 反噬{' '}
            {battle.stats.backfires}
          </div>
          {casting && (
            <div className="casting-note">
              施法中：<b>{casting.spell}</b> · {describeMeta(casting.meta)}
              <div>
                {casting.vm.spentTicks}/{castCost?.tickWorst ?? '?'} tick（第 {casting.fired} 次）
              </div>
              <div className="muted small">施法时移动变慢，受击会打断</div>
            </div>
          )}
        </div>

        <div className="bindings">
          {SLOTS.map((s) => {
            const spell = player.bindings[s.key] ?? '';
            const cd = spell ? battle.cooldownLeft(player.id, spell) : 0;
            return (
              <label key={s.key} className="binding">
                <span>{s.label}</span>
                <select value={spell} onChange={(e) => battle.setBinding(s.key, e.target.value)}>
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

function Bar({ label, v, max, color }: { label: string; v: number; max: number; color: string }) {
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <div className="bar-track">
        <div
          className="bar-fill"
          style={{ width: `${Math.max(0, Math.min(100, (v / max) * 100))}%`, background: color }}
        />
      </div>
      <span className="bar-num">
        {Math.round(v)}/{max}
      </span>
    </div>
  );
}

export function CombatView() {
  const [source, setSource] = useState(COMBAT_SPELLS);

  const { battle, error } = useMemo(() => {
    try {
      return { battle: new Battle(parseSpellbook(source)), error: '' };
    } catch (e) {
      return { battle: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [source]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          道衍<span>演武场</span>
        </div>
        <div className="hint">
          WASD / 方向键移动 · 左键与 1~5 施放绑定法术 · 施法时移速下降，受击会打断 —— 边走位边打
        </div>
      </header>

      {error ? (
        <pre className="errors">{error}</pre>
      ) : (
        battle && <Arena battle={battle} key={source} />
      )}

      <section className="panel wide">
        <h2>法术书（改完立刻生效）</h2>
        <textarea
          className="editor"
          value={source}
          spellCheck={false}
          onChange={(e) => setSource(e.target.value)}
        />
      </section>
    </div>
  );
}
