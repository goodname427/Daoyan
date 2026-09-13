import { Particles } from '../game/fx';
import { PALETTES, Animator, buildActorSheet, FRAME_H } from '../game/sprites';
import type { ActorSheet, AnimState } from '../game/sprites';
import { sfx } from '../game/audio';
import type { Battle } from '../game/battle';
import type { Actor } from '../core/index';

const VIEW_W = 900;
const VIEW_H = 560;

const PROJ_COLOR: Record<string, string> = {
  player: '#ffe9b0',
  foe: '#ff9a7a',
};

function paletteKey(a: Actor): string {
  if (a.faction === 'player') return 'player';
  return a.behavior === 'shooter' ? 'shooter' : 'chaser';
}

/**
 * 战斗渲染器：精灵图 + 动画状态机 + 粒子 + 音效。
 *
 * 核心层只产出 FxEvent（「发生了什么、在哪」），表现层在这里消费 ——
 * 核心不反向依赖渲染，因此可以随时换表现（精灵图、3D、……）。
 */
export class Renderer {
  private sheets: Record<string, ActorSheet> = {};
  private anims = new Map<number, Animator>();
  private lastPos = new Map<number, { x: number; y: number }>();
  private particles = new Particles();

  private sheetFor(a: Actor): ActorSheet {
    const key = paletteKey(a);
    if (!this.sheets[key]) this.sheets[key] = buildActorSheet(PALETTES[key]);
    return this.sheets[key];
  }

  private animatorFor(a: Actor): Animator {
    let an = this.anims.get(a.id);
    if (!an) {
      an = new Animator(this.sheetFor(a));
      this.anims.set(a.id, an);
    }
    return an;
  }

  private stateFor(a: Actor, battle: Battle, moved: boolean): AnimState {
    if (!a.alive) return 'death';
    if (a.hitFlash > 0) return 'hurt';
    if (battle.casts.has(a.id)) return 'cast';
    if (moved) return 'run';
    return 'idle';
  }

  render(canvas: HTMLCanvasElement, battle: Battle, dt: number): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const world = battle.world;

    // 消费表现事件 → 音效 + 粒子
    for (const ev of world.consumeFx()) {
      switch (ev.kind) {
        case 'cast':
          sfx.play('cast');
          this.particles.burst(ev.x, ev.y - 14, '#e8c37a', 6, 60, 2);
          break;
        case 'shoot':
          sfx.play('shoot');
          this.particles.burst(ev.x, ev.y, '#ffe9b0', 5, 70, 2);
          break;
        case 'hit':
          sfx.play('hit');
          this.particles.burst(ev.x, ev.y, '#ffd28a', 10, 130, 3);
          break;
        case 'death':
          sfx.play('death');
          this.particles.burst(ev.x, ev.y, '#ff9a6a', 18, 160, 3);
          break;
        case 'backfire':
          sfx.play('backfire');
          this.particles.burst(ev.x, ev.y, '#ff5c5c', 16, 140, 3);
          break;
        case 'wave':
          sfx.play('wave');
          break;
      }
    }
    this.particles.update(dt);

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

    // 场地网格
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

    // 玩家准星
    const p = battle.player;
    if (p.alive) {
      ctx.strokeStyle = 'rgba(232,195,122,0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 18);
      ctx.lineTo(p.x + p.aim.x * 70, p.y - 18 + p.aim.y * 70);
      ctx.stroke();
    }

    // 单位（含死亡动画期内的尸体）
    for (const a of world.actors) {
      if (!a.alive && a.deathTimer <= 0) continue;

      const last = this.lastPos.get(a.id);
      const moved = !!last && Math.hypot(a.x - last.x, a.y - last.y) > 1.5;
      this.lastPos.set(a.id, { x: a.x, y: a.y });

      const an = this.animatorFor(a);
      an.facing = a.aim.x < 0 ? -1 : 1;
      an.set(this.stateFor(a, battle, moved));
      an.update(dt);

      // 阴影
      ctx.beginPath();
      ctx.ellipse(a.x, a.y + 2, a.radius * 0.9, a.radius * 0.35, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fill();

      const scale = (a.radius / 12) * 1.05;
      an.draw(ctx, a.x, a.y, scale, a.hitFlash > 0);

      if (!a.alive) continue;

      // 生命条
      const bw = 34;
      const bx = a.x - bw / 2;
      const by = a.y - FRAME_H * scale - 2;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(bx, by, bw, 4);
      ctx.fillStyle = a.faction === 'player' ? '#7bd88f' : '#ff7a5c';
      ctx.fillRect(bx, by, bw * Math.max(0, a.hp / a.attr.hpMax), 4);

      ctx.fillStyle = '#8b97ab';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(a.name, a.x, by - 4);

      // 施法指示环
      const activeCasts = battle.activeCasts(a.id);
      const cast = activeCasts[0];
      if (cast) {
        const cost = battle.costs[cast.spell];
        const total = cost ? Math.max(1, cost.tickBudget.value) : 1;
        const maxProgress = cost?.tickBudget.dynamic ? 0.9 : 1;
        const prog = Math.min(maxProgress, (cast.vm.spentTicks / total) * maxProgress);
        const cy = a.y - 16;
        ctx.beginPath();
        ctx.arc(a.x, cy, a.radius + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog);
        ctx.strokeStyle = '#e8c37a';
        ctx.lineWidth = 3;
        ctx.stroke();
        if (cast.meta.kind === 'duration') {
          const dp = Math.min(1, cast.elapsed / Math.max(0.1, cast.meta.duration));
          ctx.beginPath();
          ctx.arc(a.x, cy, a.radius + 12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * dp);
          ctx.strokeStyle = '#6aa9ff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.fillStyle = '#e8c37a';
        ctx.font = '11px ui-monospace, monospace';
        const label =
          activeCasts.length > 1 ? `${cast.spell} +${activeCasts.length - 1}` : cast.spell;
        ctx.fillText(label, a.x, by - 14);
      }
    }

    // 弹道
    for (const pr of world.projectiles) {
      if (!pr.active) continue;
      const col = PROJ_COLOR[pr.faction] ?? '#ffe9b0';
      ctx.beginPath();
      ctx.moveTo(pr.x, pr.y);
      ctx.lineTo(pr.x - pr.dx * 18, pr.y - pr.dy * 18);
      ctx.strokeStyle = col;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, pr.radius, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    }

    // 粒子
    this.particles.draw(ctx);

    ctx.restore();
  }

  reset(): void {
    this.anims.clear();
    this.lastPos.clear();
    this.particles.clear();
  }
}
