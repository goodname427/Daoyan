/**
 * 精灵图系统。
 *
 * 没有美术资源的阶段，精灵图由离屏 Canvas **程序化生成** ——
 * 生成流程和真实素材完全一致（一张大图 + 帧索引 + 动画行），
 * 后续替换成真美术时只需要换掉 buildActorSheet 的实现。
 *
 * 动画状态机：idle / run / cast / hurt / death
 */

export type AnimState = 'idle' | 'run' | 'cast' | 'hurt' | 'death';

export interface Palette {
  robe: string;
  trim: string;
  skin: string;
  aura: string;
}

export const PALETTES: Record<string, Palette> = {
  player: { robe: '#3d5a80', trim: '#e8c37a', skin: '#f0c8a0', aura: '#e8c37a' },
  chaser: { robe: '#7a2e2a', trim: '#ffb37a', skin: '#d9a184', aura: '#ff7a5c' },
  shooter: { robe: '#4a2e6e', trim: '#c39bff', skin: '#d9c1a8', aura: '#c39bff' },
};

export const FRAME_W = 36;
export const FRAME_H = 44;

interface AnimSpec {
  frames: number;
  fps: number;
  loop: boolean;
}

const ANIMS: Record<AnimState, AnimSpec> = {
  idle: { frames: 4, fps: 4, loop: true },
  run: { frames: 6, fps: 10, loop: true },
  cast: { frames: 4, fps: 9, loop: true },
  hurt: { frames: 2, fps: 12, loop: false },
  death: { frames: 6, fps: 9, loop: false },
};

const STATES = Object.keys(ANIMS) as AnimState[];

export interface ActorSheet {
  canvas: HTMLCanvasElement;
  rows: Record<AnimState, number>;
}

interface FrameStyle {
  bob: number;
  lean: number;
  armRaise: number;
  glow: number;
  flash: boolean;
  squash: number;
  alpha: number;
  step: number;
}

function withAlpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function styleFor(state: AnimState, i: number): FrameStyle {
  const n = ANIMS[state].frames;
  const t = n <= 1 ? 0 : i / (n - 1);
  switch (state) {
    case 'idle':
      return {
        bob: Math.sin((i / n) * Math.PI * 2) * 1.4,
        lean: 0,
        armRaise: 0.1,
        glow: 0,
        flash: false,
        squash: 1,
        alpha: 1,
        step: 0,
      };
    case 'run':
      return {
        bob: (i % 2) * 2.2,
        lean: 0.14,
        armRaise: 0.2,
        glow: 0,
        flash: false,
        squash: 1,
        alpha: 1,
        step: Math.sin((i / n) * Math.PI * 2),
      };
    case 'cast':
      return {
        bob: -1,
        lean: -0.04,
        armRaise: t,
        glow: t,
        flash: false,
        squash: 1,
        alpha: 1,
        step: 0,
      };
    case 'hurt':
      return {
        bob: 0,
        lean: 0,
        armRaise: 0,
        glow: 0,
        flash: i === 0,
        squash: 0.92,
        alpha: 1,
        step: 0,
      };
    case 'death':
      return {
        bob: t * 3,
        lean: t * 1.1,
        armRaise: 0,
        glow: 0,
        flash: false,
        squash: 1 - t * 0.7,
        alpha: 1 - t * 0.85,
        step: 0,
      };
  }
}

function drawFigure(c: CanvasRenderingContext2D, pal: Palette, s: FrameStyle, shake: number): void {
  c.save();
  c.translate(FRAME_W / 2 + shake, FRAME_H - 4);
  c.rotate(s.lean);
  c.scale(1, Math.max(0.15, s.squash));
  c.globalAlpha = s.alpha;

  const bob = s.bob;

  // 施法光环
  if (s.glow > 0.02) {
    c.beginPath();
    c.arc(0, -20, 8 + s.glow * 9, 0, Math.PI * 2);
    c.fillStyle = withAlpha(pal.aura, s.glow * 0.45);
    c.fill();
  }

  // 袍子
  c.beginPath();
  c.moveTo(-10, -1 + bob);
  c.lineTo(-5, -23 + bob);
  c.lineTo(5, -23 + bob);
  c.lineTo(10, -1 + bob);
  c.closePath();
  c.fillStyle = s.flash ? '#ffffff' : pal.robe;
  c.fill();

  // 领口
  c.fillStyle = s.flash ? '#ffffff' : pal.trim;
  c.fillRect(-5, -23 + bob, 10, 3);

  // 双臂（施法时抬起）
  const ay = s.armRaise * 13;
  c.strokeStyle = s.flash ? '#ffffff' : pal.skin;
  c.lineWidth = 2;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(-6, -19 + bob);
  c.lineTo(-10 - s.armRaise * 4, -18 + bob - ay);
  c.moveTo(6, -19 + bob);
  c.lineTo(10 + s.armRaise * 4, -18 + bob - ay);
  c.stroke();

  // 头
  c.beginPath();
  c.arc(0, -28 + bob, 5.5, 0, Math.PI * 2);
  c.fillStyle = s.flash ? '#ffffff' : pal.skin;
  c.fill();

  // 发髻 / 妖角
  c.beginPath();
  c.arc(0, -33 + bob, 2.6, 0, Math.PI * 2);
  c.fillStyle = s.flash ? '#ffffff' : pal.trim;
  c.fill();

  // 双足（跑动时交替）
  c.fillStyle = s.flash ? '#ffffff' : pal.trim;
  c.fillRect(-7 + s.step * 4, -1, 5, 3);
  c.fillRect(2 - s.step * 4, -1, 5, 3);

  c.restore();
}

/** 生成一张角色的精灵图（每行一个动画状态） */
export function buildActorSheet(pal: Palette): ActorSheet {
  const canvas = document.createElement('canvas');
  canvas.width = FRAME_W * Math.max(...STATES.map((s) => ANIMS[s].frames));
  canvas.height = FRAME_H * STATES.length;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 上下文');

  const rows: Record<AnimState, number> = {} as Record<AnimState, number>;
  STATES.forEach((state, row) => {
    rows[state] = row;
    for (let i = 0; i < ANIMS[state].frames; i++) {
      ctx.save();
      ctx.translate(i * FRAME_W, row * FRAME_H);
      const shake = state === 'hurt' ? (i === 0 ? -2 : 2) : 0;
      drawFigure(ctx, pal, styleFor(state, i), shake);
      ctx.restore();
    }
  });

  return { canvas, rows };
}

/**
 * 动画状态机。
 * 由战斗事件驱动状态切换（移动 / 施法 / 受击 / 死亡），帧推进自行完成。
 */
export class Animator {
  state: AnimState = 'idle';
  private frame = 0;
  private timer = 0;
  /** 朝向：1 右 / -1 左 */
  facing = 1;

  constructor(private sheet: ActorSheet) {}

  set(state: AnimState): void {
    if (this.state === state) return;
    this.state = state;
    this.frame = 0;
    this.timer = 0;
  }

  update(dt: number): void {
    const spec = ANIMS[this.state];
    this.timer += dt;
    const step = 1 / spec.fps;
    while (this.timer >= step) {
      this.timer -= step;
      if (this.frame + 1 < spec.frames) this.frame++;
      else if (spec.loop) this.frame = 0;
      // 非循环动画停在最后一帧
    }
  }

  get finished(): boolean {
    return !ANIMS[this.state].loop && this.frame >= ANIMS[this.state].frames - 1;
  }

  draw(ctx: CanvasRenderingContext2D, x: number, y: number, scale = 1, flash = false): void {
    const row = this.sheet.rows[this.state];
    const cols = ANIMS[this.state].frames;
    const sx = (this.frame % cols) * FRAME_W;
    const sy = row * FRAME_H;
    const w = FRAME_W * scale;
    const h = FRAME_H * scale;

    ctx.save();
    ctx.translate(x, y);
    if (this.facing < 0) ctx.scale(-1, 1);
    ctx.drawImage(this.sheet.canvas, sx, sy, FRAME_W, FRAME_H, -w / 2, -h + 5, w, h);
    if (flash) {
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillRect(-w / 2, -h + 5, w, h);
    }
    ctx.restore();
  }
}
