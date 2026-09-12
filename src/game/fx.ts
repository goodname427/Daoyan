/** 极简粒子系统：命中 / 死亡 / 施法的打击感来源 */

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

export class Particles {
  list: Particle[] = [];

  burst(x: number, y: number, color: string, count = 10, speed = 110, size = 3): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.8);
      const life = 0.3 + Math.random() * 0.35;
      this.list.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life,
        maxLife: life,
        color,
        size: size * (0.6 + Math.random() * 0.8),
      });
    }
    if (this.list.length > 400) this.list.splice(0, this.list.length - 400);
  }

  update(dt: number): void {
    const keep: Particle[] = [];
    for (const p of this.list) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.92;
      p.vy *= 0.92;
      p.life -= dt;
      if (p.life > 0) keep.push(p);
    }
    this.list = keep;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (const p of this.list) {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  clear(): void {
    this.list = [];
  }
}
