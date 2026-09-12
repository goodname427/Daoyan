import type { Vec2 } from './types';

export interface Entity {
  id: number;
  x: number;
  y: number;
  hp: number;
  hostile: boolean;
  alive: boolean;
}

/** 施法者：法力与神识的持有者 */
export interface Caster {
  x: number;
  y: number;
  mana: number;
  manaMax: number;
  shenshi: number;
  shenshiMax: number;
}

export function makeCaster(x = 0, y = 0, manaMax = 300, shenshiMax = 64): Caster {
  return { x, y, mana: manaMax, manaMax, shenshi: shenshiMax, shenshiMax };
}

export class World {
  entities: Entity[] = [];
  events: string[] = [];
  private nextId = 1;

  spawn(x: number, y: number, hp = 100, hostile = true): Entity {
    const e: Entity = { id: this.nextId++, x, y, hp, hostile, alive: true };
    this.entities.push(e);
    return e;
  }

  reset(): void {
    this.entities = [];
    this.events = [];
    this.nextId = 1;
  }

  alive(): Entity[] {
    return this.entities.filter((e) => e.alive && e.hostile);
  }

  byId(id: number): Entity | null {
    return this.entities.find((e) => e.id === id && e.alive) ?? null;
  }

  /** 半径扫描，结果按容量截断 */
  inRadius(c: Vec2, r: number, cap: number): Entity[] {
    const out: Entity[] = [];
    for (const e of this.entities) {
      if (!e.alive || !e.hostile) continue;
      const dx = e.x - c.x;
      const dy = e.y - c.y;
      if (dx * dx + dy * dy <= r * r) {
        out.push(e);
        if (out.length >= cap) break;
      }
    }
    return out;
  }

  damage(id: number, amount: number): boolean {
    const e = this.byId(id);
    if (!e) return false;
    e.hp -= amount;
    if (e.hp <= 0) {
      e.alive = false;
      this.events.push(`实体#${id} 被击杀`);
    } else {
      this.events.push(`实体#${id} 受到 ${amount} 伤害，剩余 ${e.hp}`);
    }
    return true;
  }

  /** 简易射线检测：命中沿射线最近的敌人 */
  raycast(origin: Vec2, dir: Vec2, maxDist: number, width: number): Entity | null {
    const len = Math.hypot(dir.x, dir.y);
    if (len < 1e-6) return null;
    const dx = dir.x / len;
    const dy = dir.y / len;
    let best: Entity | null = null;
    let bestT = Infinity;
    for (const e of this.entities) {
      if (!e.alive || !e.hostile) continue;
      const t = (e.x - origin.x) * dx + (e.y - origin.y) * dy;
      if (t < 0 || t > maxDist) continue;
      const px = origin.x + dx * t;
      const py = origin.y + dy * t;
      const d = Math.hypot(e.x - px, e.y - py);
      if (d <= width && t < bestT) {
        bestT = t;
        best = e;
      }
    }
    return best;
  }
}
