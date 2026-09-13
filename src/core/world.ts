import type { Vec2 } from './types';
import { baseAttributes, computeAttributes, tickModifiers } from './attributes';
import type { AttrKey, Attributes, Modifier } from './attributes';

/**
 * 战斗世界。
 *
 * 与阶段一的区别：
 *   - 统一用 Actor 表示「施法者」，玩家与妖兽是同一种东西，只是阵营不同
 *   - 攻击以「弹道」形式存在（有飞行时间），这样「躲位」才有意义
 */

export type Faction = 'player' | 'foe';

export type Behavior = 'chaser' | 'shooter' | null;

/** 表现层事件：核心层只负责记录「发生了什么、发生在哪」，怎么表现由视图决定 */
export interface FxEvent {
  kind: string;
  x: number;
  y: number;
}

export interface Projectile {
  kind: 'projectile';
  id: number;
  faction: Faction;
  ownerId: number;
  x: number;
  y: number;
  /** 单位方向 */
  dx: number;
  dy: number;
  speed: number;
  damage: number;
  radius: number;
  /** 剩余存活秒数 */
  life: number;
  /** 剩余穿透次数 */
  pierce: number;
  hit: Set<number>;
  /** 创建后可先配置；只有激活的弹道才移动和碰撞 */
  active: boolean;
}

export interface Actor {
  kind: 'actor';
  id: number;
  name: string;
  faction: Faction;

  x: number;
  y: number;
  /** 准星方向（单位向量），玩家由鼠标驱动 */
  aim: Vec2;

  /** 当前生命（上限见 attr.hpMax） */
  hp: number;
  /** 当前法力（上限见 attr.manaMax） */
  mana: number;

  /** 基础属性（不受临时增益影响） */
  base: Attributes;
  /** 临时增益 / 减益 */
  mods: Modifier[];
  /** 结算后的有效属性，战斗层每帧刷新 */
  attr: Attributes;

  radius: number;
  alive: boolean;

  /** 按键 → 法术名。'mouse' 为左键，'1'~'5' 为数字键，'attack' 为妖兽的攻击法术 */
  bindings: Record<string, string>;

  behavior: Behavior;
  attackRange: number;
  attackCooldown: number;
  attackTimer: number;
  /** 游走方向（用于 shooter 走位） */
  strafe: number;
  strafeTimer: number;

  /** 施法时的移动速度倍率 */
  castSlow: number;
  /** 受击硬直剩余秒数 */
  stun: number;
  /** 受击闪白剩余秒数（仅表现） */
  hitFlash: number;
  /** 死亡后仍保留的秒数（用于播放死亡动画） */
  deathTimer: number;
}

/** DSL `entity` 句柄可以指向的统一世界对象。 */
export type Entity = Actor | Projectile;

export type EntityCapability =
  'identity' | 'transform' | 'vitality' | 'caster' | 'movement' | 'projectile' | 'modifiers';

/** 单个施法者在场上可同时保有的弹道上限（含尚未激活的弹道）。 */
export const MAX_OWNED_PROJECTILES = 16;

export interface ActorInit {
  name?: string;
  faction: Faction;
  x: number;
  y: number;
  /** 基础属性覆盖项，未给出的走 baseAttributes() 默认值 */
  attrs?: Partial<Attributes>;
  radius?: number;
  bindings?: Record<string, string>;
  behavior?: Behavior;
  attackRange?: number;
  attackCooldown?: number;
  castSlow?: number;
}

export class World {
  actors: Actor[] = [];
  projectiles: Projectile[] = [];
  events: string[] = [];
  /** 表现层事件队列，视图每帧消费 */
  fx: FxEvent[] = [];
  bounds = { w: 1600, h: 1200 };
  /** 伤害回调，战斗层用它实现「受击打断施法」 */
  onDamage: ((target: Actor, amount: number) => void) | null = null;

  /** Actor 与 Projectile 共用同一 ID 空间，句柄在一次 World 生命周期内不复用。 */
  private nextEntityId = 1;
  private nextModifierId = 1;

  reset(): void {
    this.actors = [];
    this.projectiles = [];
    this.events = [];
    this.fx = [];
    // 保留计数器，避免重置前持有的句柄误指向新场景对象。
    this.nextModifierId = 1;
  }

  /** 每帧推进：法力回复、增益计时、属性重算 */
  tickActor(a: Actor, dt: number): void {
    if (!a.alive) return;
    a.mana = Math.min(a.attr.manaMax, a.mana + a.attr.manaRegen * dt);
    if (a.stun > 0) a.stun = Math.max(0, a.stun - dt);
    if (a.hitFlash > 0) a.hitFlash = Math.max(0, a.hitFlash - dt);
    if (a.mods.length > 0 && tickModifiers(a.mods, dt)) this.recompute(a);
  }

  spawnActor(init: ActorInit): Actor {
    const base = baseAttributes(init.attrs);
    const a: Actor = {
      kind: 'actor',
      id: this.nextEntityId++,
      name: init.name ?? (init.faction === 'player' ? '修士' : '妖兽'),
      faction: init.faction,
      x: init.x,
      y: init.y,
      aim: { x: 1, y: 0 },
      hp: base.hpMax,
      mana: base.manaMax,
      base,
      mods: [],
      attr: base,
      radius: init.radius ?? 12,
      alive: true,
      bindings: init.bindings ?? {},
      behavior: init.behavior ?? null,
      attackRange: init.attackRange ?? 240,
      attackCooldown: init.attackCooldown ?? 1.6,
      attackTimer: 0,
      strafe: 0,
      strafeTimer: 0,
      castSlow: init.castSlow ?? 0.45,
      stun: 0,
      hitFlash: 0,
      deathTimer: 0,
    };
    this.actors.push(a);
    return a;
  }

  byId(id: number): Actor | null {
    return this.actors.find((a) => a.id === id) ?? null;
  }

  /** 统一句柄解析；调用方再按能力而不是按 ID 范围判断可执行操作。 */
  entityById(id: number): Entity | null {
    return (
      this.actors.find((a) => a.id === id) ?? this.projectiles.find((p) => p.id === id) ?? null
    );
  }

  hasCapability(entity: Entity, capability: EntityCapability): boolean {
    if (capability === 'identity' || capability === 'transform' || capability === 'movement')
      return true;
    if (entity.kind === 'projectile') return capability === 'projectile';
    return capability === 'vitality' || capability === 'caster' || capability === 'modifiers';
  }

  positionOf(id: number): Vec2 | null {
    const entity = this.entityById(id);
    return entity ? { x: entity.x, y: entity.y } : null;
  }

  ownedProjectile(ownerId: number, id: number): Projectile | null {
    const entity = this.entityById(id);
    return entity?.kind === 'projectile' && entity.ownerId === ownerId ? entity : null;
  }

  aliveActors(): Actor[] {
    return this.actors.filter((a) => a.alive);
  }

  /** 与给定阵营敌对的存活单位 */
  hostilesOf(faction: Faction): Actor[] {
    return this.actors.filter((a) => a.alive && a.faction !== faction);
  }

  inRadius(c: Vec2, r: number, cap: number, faction: Faction): Actor[] {
    const out: Actor[] = [];
    for (const a of this.actors) {
      if (!a.alive || a.faction === faction) continue;
      const dx = a.x - c.x;
      const dy = a.y - c.y;
      if (dx * dx + dy * dy <= r * r) {
        out.push(a);
        if (out.length >= cap) break;
      }
    }
    return out;
  }

  /** 结算有效属性 */
  recompute(a: Actor): void {
    a.attr = computeAttributes(a.base, a.mods);
    if (a.hp > a.attr.hpMax) a.hp = a.attr.hpMax;
    if (a.mana > a.attr.manaMax) a.mana = a.attr.manaMax;
  }

  addModifier(
    a: Actor,
    key: AttrKey,
    op: 'add' | 'mul',
    value: number,
    duration: number,
    source = '',
  ): void {
    a.mods.push({
      id: this.nextModifierId++,
      key,
      op,
      value,
      duration,
      source,
    });
    this.recompute(a);
  }

  damage(id: number, amount: number): boolean {
    const a = this.byId(id);
    if (!a || !a.alive) return false;
    const real = Math.max(1, amount - a.attr.armor);
    a.hp -= real;
    a.hitFlash = 0.15;
    this.fx.push({ kind: 'hit', x: a.x, y: a.y });
    if (a.hp <= 0) {
      a.hp = 0;
      a.alive = false;
      a.deathTimer = 0.9;
      this.events.push(`${a.name}#${a.id} 被击倒`);
      this.fx.push({ kind: 'death', x: a.x, y: a.y });
    } else {
      this.events.push(`${a.name}#${a.id} 受到 ${Math.round(real)} 伤害，剩余 ${Math.round(a.hp)}`);
    }
    this.onDamage?.(a, real);
    return true;
  }

  consumeFx(): FxEvent[] {
    const out = this.fx;
    this.fx = [];
    return out;
  }

  /** 位移并限制在场地内 */
  moveActor(a: Actor, dx: number, dy: number): void {
    a.x = Math.min(this.bounds.w - a.radius, Math.max(a.radius, a.x + dx));
    a.y = Math.min(this.bounds.h - a.radius, Math.max(a.radius, a.y + dy));
  }

  placeActor(a: Actor, x: number, y: number): void {
    a.x = Math.min(this.bounds.w - a.radius, Math.max(a.radius, x));
    a.y = Math.min(this.bounds.h - a.radius, Math.max(a.radius, y));
  }

  spawnProjectile(p: {
    faction: Faction;
    ownerId: number;
    x: number;
    y: number;
    dx: number;
    dy: number;
    speed: number;
    damage: number;
    radius?: number;
    life?: number;
    pierce?: number;
    active?: boolean;
  }): Projectile | null {
    const ownedCount = this.projectiles.filter(
      (projectile) => projectile.ownerId === p.ownerId,
    ).length;
    if (ownedCount >= MAX_OWNED_PROJECTILES) return null;
    const proj: Projectile = {
      kind: 'projectile',
      id: this.nextEntityId++,
      faction: p.faction,
      ownerId: p.ownerId,
      x: p.x,
      y: p.y,
      dx: p.dx,
      dy: p.dy,
      speed: p.speed,
      damage: p.damage,
      radius: p.radius ?? 7,
      life: p.life ?? 2.4,
      pierce: p.pierce ?? 0,
      hit: new Set<number>(),
      active: p.active ?? true,
    };
    this.projectiles.push(proj);
    return proj;
  }

  /** 简易射线：沿方向命中最近的敌对单位（元函数「近战斩击」等用） */
  raycast(origin: Vec2, dir: Vec2, maxDist: number, width: number, faction: Faction): Actor | null {
    const len = Math.hypot(dir.x, dir.y);
    if (len < 1e-6) return null;
    const dx = dir.x / len;
    const dy = dir.y / len;
    let best: Actor | null = null;
    let bestT = Infinity;
    for (const a of this.actors) {
      if (!a.alive || a.faction === faction) continue;
      const t = (a.x - origin.x) * dx + (a.y - origin.y) * dy;
      if (t < 0 || t > maxDist) continue;
      const px = origin.x + dx * t;
      const py = origin.y + dy * t;
      const d = Math.hypot(a.x - px, a.y - py);
      if (d <= width + a.radius && t < bestT) {
        bestT = t;
        best = a;
      }
    }
    return best;
  }
}
