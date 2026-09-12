import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import COMBAT_SPELLS from '../game/spells.dy?raw';
import { Battle } from '../game/battle';
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

const COLOR = {
  player: '#e8c37a',
  chaser: '#d2593f',
  shooter: '#a05fd6',
  projPlayer: '#ffe9b0',
  projFoe: '#ff9a7a',
};

function actorColor(a: Actor): string {
  if (a.faction === 'player') return COLOR.player;
  return a.behavior === 'shooter' ? COLOR.shooter : COLOR.chaser;
}

function draw(canvas: HTMLCanvasElement | null, battle: Battle): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const world = battle.world;
  const cam = {
    x: Math.max(0, Math.min(world.bounds.w - VIEW_W, battle.player.x - VIEW_W / 2)),
    y: Math.max(0, Math.min(world.bounds.h - VIEW_H, battle.player.y - VIEW_H / 2)),
  };
  canvas.dataset.camX = String(cam.x);
  canvas.dataset.camY = String(cam.y);

  ctx.clearRect(0, 0, VIEW_W, VIEW_H);
  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  ctx.save();
  ctx.translate(-cam.x, -cam.y);

  // 场地
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= world.bounds.w; x += 100) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, world.bounds.h);
    ctx.stroke();
  }
  for (let y = 0; y <= world.bounds.h; y += 100) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(world.bounds.w, y);
    ctx.stroke();
  }
  ctx.strokeStyle = '#2a3340';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, world.bounds.w, world.bounds.h);

  // 玩家准星指示
  const p = battle.player;
  if (p.alive) {
    ctx.strokeStyle = 'rgba(232,195,122,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + p.aim.x * 90, p.y + p.aim.y * 90);
    ctx.stroke();
  }

  // 单位
  for (const a of world.actors) {
    if (!a.alive) continue;
    const color = actorColor(a);
    ctx.beginPath();
    ctx.arc(a.x, a.y, a.radius, 0, Math.PI * 2);
    ctx.fillStyle = a.hitFlash > 0 ? '#ffffff' : color;
    ctx.fill();
    if (a.behavior === 'shooter') {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // 生命条
    const bw = 34;
    const bx = a.x - bw / 2;
    const by = a.y - a.radius - 10;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(bx, by, bw, 4);
    ctx.fillStyle = a.faction === 'player' ? '#7bd88f' : '#ff7a5c';
    ctx.fillRect(bx, by, bw * Math.max(0, a.hp / a.attr.hpMax), 4);

    // 施法指示：内圈是当前这次执行的进度，持续类外圈显示已持续时间
    const cast = battle.casts.get(a.id);
    if (cast) {
      const cost = battle.costs[cast.spell];
      const total = cost ? Math.max(1, cost.tickWorst) : 1;
      const prog = Math.min(1, cast.vm.spentTicks / total);
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.radius + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog);
      ctx.strokeStyle = '#e8c37a';
      ctx.lineWidth = 3;
      ctx.stroke();

      if (cast.meta.kind === 'duration') {
        const dp = Math.min(1, cast.elapsed / Math.max(0.1, cast.meta.duration));
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.radius + 11, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * dp);
        ctx.strokeStyle = '#6aa9ff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.fillStyle = '#e8c37a';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(cast.spell, a.x, a.y + a.radius + 20);
    }

    ctx.fillStyle = '#8b97ab';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(a.name, a.x, by - 4);
  }

  // 弹道
  for (const pr of world.projectiles) {
    ctx.beginPath();
    ctx.arc(pr.x, pr.y, pr.radius, 0, Math.PI * 2);
    ctx.fillStyle = pr.faction === 'player' ? COLOR.projPlayer : COLOR.projFoe;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(pr.x, pr.y);
    ctx.lineTo(pr.x - pr.dx * 16, pr.y - pr.dy * 16);
    ctx.strokeStyle = pr.faction === 'player' ? 'rgba(255,233,176,0.4)' : 'rgba(255,154,122,0.4)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  ctx.restore();
}

function Arena({ battle }: { battle: Battle }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);
  const lastRef = useRef(0);
  const hudRef = useRef(0);

  useEffect(() => {
    let raf = 0;
    const loop = (now: number) => {
      const last = lastRef.current || now;
      const dt = Math.min(0.05, (now - last) / 1000);
      lastRef.current = now;
      battle.update(dt);
      draw(canvasRef.current, battle);
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
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
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
          <div>
            第 <b>{battle.waveIndex + 1}</b> 波 · 剩余妖兽 <b>{battle.foesLeft()}</b>
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
