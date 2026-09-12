import {
  TICK_MS,
  VM,
  World,
  analyzeBook,
  compileProgram,
  normalizeMeta,
  spellMeta,
} from '../core/index';
import type { Actor, KeyState, Program, SpellBook, SpellCost, SpellMeta } from '../core/index';
import { makeKeyState } from '../core/input';

/**
 * 战斗运行时。
 *
 * 关键设计：**玩家和妖兽走同一套施法管线**。
 * 区别只在于谁触发 —— 玩家靠按键，妖兽靠 AI 计时器。
 * 因此妖兽的法术同样受神识 / 法力 / 耗时约束，也会被「受伤打断」。
 */

export interface BattleInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export interface WaveSpec {
  chaser: number;
  shooter: number;
}

export const WAVES: WaveSpec[] = [
  { chaser: 3, shooter: 0 },
  { chaser: 3, shooter: 2 },
  { chaser: 4, shooter: 3 },
  { chaser: 6, shooter: 4 },
];

export type BattleState = 'fighting' | 'victory' | 'defeat';

export interface BattleStats {
  casts: number;
  interrupts: number;
  backfires: number;
  kills: number;
}

/** 一次施放的运行时状态 */
export interface CastInstance {
  spell: string;
  meta: SpellMeta;
  vm: VM;
  /** 已持续秒数 */
  elapsed: number;
  /** 距离下次周期触发还剩多久（duration 用） */
  periodTimer: number;
  /** 已触发次数 */
  fired: number;
  /** 虚拟按键状态（引用共享，每帧原地更新） */
  keys: KeyState[];
  /** 触发本施法的槽位（玩家用，用于把物理键状态映射到 keys[0]） */
  triggerSlot: string | null;
  /** 已主动结束（调用过「结束施法」），优先于 duration 周期重启 */
  ended: boolean;
}

const ARENA_W = 1600;
const ARENA_H = 1200;

const PLAYER_BINDINGS: Record<string, string> = {
  mouse: '基础剑气',
  '1': '疾风步',
  '2': '三连剑',
  '3': '爆炎咒',
  '4': '微剑',
  '5': '蓄力火球',
};

const PLAYER_ATTRS = {
  hpMax: 120,
  manaMax: 300,
  manaRegen: 24,
  shenshiMax: 64,
  speed: 170,
  castSpeed: 1,
  power: 1,
  armor: 0,
};

export class Battle {
  world: World;
  program: Program;
  costs: Record<string, SpellCost>;
  metas: Record<string, SpellMeta>;
  player: Actor;
  /** actorId → 当前施法 */
  casts = new Map<number, CastInstance>();
  /** actorId → 法术名 → 剩余冷却 */
  cooldowns = new Map<number, Map<string, number>>();

  input: BattleInput = { up: false, down: false, left: false, right: false };
  /** 当前按住的槽位集合（玩家用，驱动键位法术的 keys[0]） */
  heldSlots = new Set<string>();
  time = 0;
  waveIndex = 0;
  state: BattleState = 'fighting';
  log: string[] = [];
  stats: BattleStats = { casts: 0, interrupts: 0, backfires: 0, kills: 0 };

  constructor(private book: SpellBook) {
    this.costs = analyzeBook(book);
    this.program = compileProgram(book);
    this.metas = Object.fromEntries(
      Object.entries(book).map(([n, sp]) => [n, normalizeMeta(sp.meta)]),
    );

    this.world = new World();
    this.world.bounds = { w: ARENA_W, h: ARENA_H };
    this.world.onDamage = (target) => this.handleDamage(target);

    this.player = this.spawnPlayer();
    this.startWave(0);
  }

  private spawnPlayer(): Actor {
    return this.world.spawnActor({
      name: '修士',
      faction: 'player',
      x: ARENA_W / 2,
      y: ARENA_H / 2,
      attrs: PLAYER_ATTRS,
      radius: 13,
      castSlow: 0.45,
      bindings: { ...PLAYER_BINDINGS },
    });
  }

  // ---------------- 波次 ----------------

  startWave(index: number): void {
    this.waveIndex = index;
    const spec = WAVES[Math.min(index, WAVES.length - 1)];
    this.world.projectiles = [];

    for (let i = 0; i < spec.chaser; i++) this.spawnFoe('chaser');
    for (let i = 0; i < spec.shooter; i++) this.spawnFoe('shooter');

    this.world.fx.push({ kind: 'wave', x: this.player.x, y: this.player.y });
    this.pushLog(`第 ${index + 1} 波：${spec.chaser} 扑击妖兽 / ${spec.shooter} 符修`);
  }

  private spawnFoe(kind: 'chaser' | 'shooter'): Actor {
    let x = 0;
    let y = 0;
    for (let tries = 0; tries < 40; tries++) {
      x = 80 + Math.random() * (ARENA_W - 160);
      y = 80 + Math.random() * (ARENA_H - 160);
      if (Math.hypot(x - this.player.x, y - this.player.y) > 420) break;
    }

    if (kind === 'chaser') {
      return this.world.spawnActor({
        name: '扑击妖兽',
        faction: 'foe',
        x,
        y,
        attrs: {
          hpMax: 60,
          manaMax: 220,
          manaRegen: 46,
          shenshiMax: 40,
          speed: 108,
          power: 1,
        },
        radius: 12,
        behavior: 'chaser',
        attackRange: 260,
        attackCooldown: 1.9,
        castSlow: 0.35,
        bindings: { attack: '妖兽·扑击' },
      });
    }
    return this.world.spawnActor({
      name: '妖兽符修',
      faction: 'foe',
      x,
      y,
      attrs: {
        hpMax: 45,
        manaMax: 240,
        manaRegen: 52,
        shenshiMax: 40,
        speed: 88,
        power: 1,
      },
      radius: 11,
      behavior: 'shooter',
      attackRange: 460,
      attackCooldown: 2.3,
      castSlow: 0.35,
      bindings: { attack: '妖兽·雷符' },
    });
  }

  // ---------------- 主循环 ----------------

  update(dt: number): void {
    if (this.state !== 'fighting') return;
    this.time += dt;

    for (const a of this.world.actors) {
      if (!a.alive) {
        if (a.deathTimer > 0) a.deathTimer = Math.max(0, a.deathTimer - dt);
        continue;
      }
      this.world.tickActor(a, dt);
      if (a.faction === 'foe') a.attackTimer -= dt;
    }
    for (const [, map] of this.cooldowns) {
      for (const [spell, left] of [...map]) {
        const next = left - dt;
        if (next <= 0) map.delete(spell);
        else map.set(spell, next);
      }
    }

    this.movePlayer(dt);
    for (const a of this.world.actors) {
      if (a.alive && a.faction === 'foe') this.updateFoe(a, dt);
    }
    this.advanceCasts(dt);
    this.updateProjectiles(dt);
    this.separate();
    this.checkEnd();
  }

  private movePlayer(dt: number): void {
    const p = this.player;
    if (!p.alive || p.stun > 0) return;
    const dx = (this.input.right ? 1 : 0) - (this.input.left ? 1 : 0);
    const dy = (this.input.down ? 1 : 0) - (this.input.up ? 1 : 0);
    if (dx === 0 && dy === 0) return;
    const l = Math.hypot(dx, dy);
    const speed = p.attr.speed * this.moveMul(p);
    this.world.moveActor(p, (dx / l) * speed * dt, (dy / l) * speed * dt);
  }

  /** 施法中的移动速度倍率 */
  private moveMul(a: Actor): number {
    const cast = this.casts.get(a.id);
    if (!cast) return 1;
    if (cast.meta.kind === 'channel') return cast.meta.channelSlow;
    return a.castSlow;
  }

  private updateFoe(a: Actor, dt: number): void {
    if (a.stun > 0) return;
    const target = this.nearestHostile(a);
    if (!target) return;
    const dx = target.x - a.x;
    const dy = target.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    a.aim = { x: ux, y: uy };

    const casting = this.casts.has(a.id);
    let mx = 0;
    let my = 0;

    if (a.behavior === 'chaser') {
      if (d > a.attackRange * 0.8) {
        mx = ux;
        my = uy;
      } else {
        mx = -uy * 0.8;
        my = ux * 0.8;
      }
    } else {
      const want = 320;
      if (d > want + 70) {
        mx = ux;
        my = uy;
      } else if (d < want - 70) {
        mx = -ux;
        my = -uy;
      }
      a.strafeTimer -= dt;
      if (a.strafeTimer <= 0) {
        a.strafeTimer = 1.1 + Math.random() * 1.3;
        a.strafe = Math.random() < 0.5 ? -1 : 1;
      }
      mx += -uy * a.strafe * 0.9;
      my += ux * a.strafe * 0.9;
    }

    const l = Math.hypot(mx, my);
    if (l > 1e-6) {
      const speed = a.attr.speed * (casting ? a.castSlow : 1);
      this.world.moveActor(a, (mx / l) * speed * dt, (my / l) * speed * dt);
    }

    if (d <= a.attackRange && a.attackTimer <= 0 && !this.casts.has(a.id)) {
      if (this.trigger(a.id, 'attack')) {
        a.attackTimer = a.attackCooldown * a.attr.cooldownMul;
      } else {
        a.attackTimer = 0.35;
      }
    }
  }

  private advanceCasts(dt: number): void {
    for (const [id, cast] of [...this.casts]) {
      const a = this.world.byId(id);
      if (!a || !a.alive) {
        this.casts.delete(id);
        continue;
      }

      // 先更新按键状态（玩家：keys[0] 由触发槽位的 held 状态驱动）
      this.updateKeyState(a, cast, dt);

      // 施法速度属性：把「每秒 tick 数」放大
      const tickBudget = ((dt * 1000) / TICK_MS) * a.attr.castSpeed;
      const before = cast.vm.spentMana;
      cast.vm.advance(tickBudget);
      a.mana = Math.max(0, a.mana - (cast.vm.spentMana - before));
      cast.elapsed += dt;
      if (cast.vm.endRequested) cast.ended = true;

      // 超时（引导类最长引导时间）
      if (cast.meta.kind === 'channel' && cast.elapsed > cast.meta.duration && cast.vm.isRunning) {
        cast.vm.advance(Number.MAX_SAFE_INTEGER, 1);
      }

      if (!cast.vm.isDone) continue;

      if (cast.vm.failure) {
        this.casts.delete(id);
        this.stats.backfires++;
        this.world.fx.push({ kind: 'backfire', x: a.x, y: a.y });
        this.pushLog(`${a.name} 走火入魔：${cast.vm.failure}`);
        a.stun = 0.5;
        continue;
      }

      // 主动结束（调用了「结束施法」）：直接收尾，不再周期重启
      if (cast.ended) {
        this.casts.delete(id);
        continue;
      }

      // 本次执行完毕
      if (cast.meta.kind === 'duration' && cast.elapsed < cast.meta.duration) {
        // 进入周期等待，到点再触发一次
        cast.periodTimer -= dt;
        if (cast.periodTimer <= 0) {
          this.restartCastVm(a, cast);
        }
        continue;
      }

      this.casts.delete(id);
    }
  }

  /** 把按键物理状态写进 cast.keys（仅玩家；妖兽无按键） */
  private updateKeyState(a: Actor, cast: CastInstance, dt: number): void {
    if (cast.keys.length === 0) return;
    if (a.faction !== 'player' || cast.triggerSlot === null) return;
    const held = this.heldSlots.has(cast.triggerSlot);
    for (const k of cast.keys) {
      const prev = k.held;
      if (held && !prev) {
        k.pressEdge = true;
        k.heldTime = 0; // 重新按下，蓄力从头计
      }
      if (!held && prev) {
        k.releaseEdge = true;
        // 松开时保留蓄力值，让法术能在松开后的轮询里读到「刚松开时的蓄力时长」
      }
      k.held = held;
      if (held) k.heldTime += dt;
    }
  }

  private restartCastVm(a: Actor, cast: CastInstance): void {
    cast.fired += 1;
    cast.periodTimer = Math.max(0.05, cast.meta.period);
    cast.ended = false;
    const vm = new VM(this.program, this.world, a);
    vm.start(cast.spell);
    vm.setKeyState(cast.keys.length > 0 ? cast.keys : null);
    cast.vm = vm;
  }

  private updateProjectiles(dt: number): void {
    const keep = [];
    for (const p of this.world.projectiles) {
      p.x += p.dx * p.speed * dt;
      p.y += p.dy * p.speed * dt;
      p.life -= dt;

      let dead =
        p.life <= 0 || p.x < 0 || p.y < 0 || p.x > this.world.bounds.w || p.y > this.world.bounds.h;

      if (!dead) {
        for (const a of this.world.actors) {
          if (!a.alive || a.faction === p.faction || p.hit.has(a.id)) continue;
          if (Math.hypot(a.x - p.x, a.y - p.y) <= p.radius + a.radius) {
            const wasAlive = a.alive;
            this.world.damage(a.id, p.damage);
            if (wasAlive && !a.alive) this.stats.kills++;
            p.hit.add(a.id);
            if (p.pierce > 0) p.pierce--;
            else dead = true;
            break;
          }
        }
      }
      if (!dead) keep.push(p);
    }
    this.world.projectiles = keep;
  }

  private separate(): void {
    const list = this.world.aliveActors();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const min = a.radius + b.radius;
        if (d > 1e-6 && d < min) {
          const push = (min - d) / 2;
          const ux = dx / d;
          const uy = dy / d;
          this.world.moveActor(a, -ux * push, -uy * push);
          this.world.moveActor(b, ux * push, uy * push);
        }
      }
    }
  }

  private handleDamage(target: Actor): void {
    const cast = this.casts.get(target.id);
    if (!cast) {
      target.stun = Math.max(target.stun, 0.18);
      return;
    }
    if (!cast.meta.interruptible) {
      target.stun = Math.max(target.stun, 0.18);
      return;
    }
    this.casts.delete(target.id);
    this.stats.interrupts++;
    this.pushLog(`${target.name} 施法被打断`);
    target.stun = Math.max(target.stun, 0.18);
  }

  private checkEnd(): void {
    if (!this.player.alive) {
      this.state = 'defeat';
      this.pushLog('道消身陨……');
      return;
    }
    const foesLeft = this.world.aliveActors().filter((a) => a.faction === 'foe').length;
    if (foesLeft > 0) return;
    if (this.waveIndex >= WAVES.length - 1) {
      this.state = 'victory';
      this.pushLog('尽数伏诛，此局功成');
    } else {
      this.startWave(this.waveIndex + 1);
    }
  }

  // ---------------- 对外接口 ----------------

  cooldownLeft(actorId: number, spell: string): number {
    return this.cooldowns.get(actorId)?.get(spell) ?? 0;
  }

  /** 触发某单位绑定在指定槽位上的法术 */
  trigger(actorId: number, slot: string): boolean {
    const a = this.world.byId(actorId);
    if (!a || !a.alive) return false;
    if (this.casts.has(actorId)) return false; // 施法中，不能分心二用
    if (a.stun > 0) return false;

    const spell = a.bindings[slot];
    if (!spell) return false;
    if (!this.program.index.has(spell)) return false;

    const cost = this.costs[spell];
    if (cost && cost.errors.length > 0) {
      this.pushLog(`「${spell}」无法施展：${cost.errors[0]}`);
      return false;
    }
    if (this.cooldownLeft(actorId, spell) > 0) return false;

    const meta = this.metas[spell] ?? normalizeMeta(null);
    const vm = new VM(this.program, this.world, a);
    vm.start(spell);

    // 准备虚拟按键状态（玩家：按下瞬间给 keys[0] 一个 pressEdge）
    const keys = meta.keys.map(() => makeKeyState());
    const isPlayer = a.faction === 'player';
    if (isPlayer && keys.length > 0) keys[0].pressEdge = true;
    vm.setKeyState(keys.length > 0 ? keys : null);

    this.casts.set(actorId, {
      spell,
      meta,
      vm,
      elapsed: 0,
      periodTimer: Math.max(0.05, meta.period),
      fired: 1,
      keys,
      triggerSlot: isPlayer ? slot : null,
      ended: false,
    });
    this.world.fx.push({ kind: 'cast', x: a.x, y: a.y });
    if (meta.cooldown > 0) {
      let map = this.cooldowns.get(actorId);
      if (!map) {
        map = new Map();
        this.cooldowns.set(actorId, map);
      }
      map.set(spell, meta.cooldown * a.attr.cooldownMul);
    }
    this.stats.casts++;
    return true;
  }

  /**
   * 玩家按下某槽位的物理键。
   * - 按键型法术（声明了 keys）：起手进入持续施法，并标记该槽位按住
   * - 普通法术：等同 trigger 一次性触发
   */
  pressSlot(slot: string): boolean {
    this.heldSlots.add(slot);
    if (this.casts.has(this.player.id)) return false;
    return this.castPlayer(slot);
  }

  /** 玩家松开某槽位的物理键 */
  releaseSlot(slot: string): void {
    this.heldSlots.delete(slot);
  }

  castPlayer(slot: string): boolean {
    return this.trigger(this.player.id, slot);
  }

  aimAt(x: number, y: number): void {
    const dx = x - this.player.x;
    const dy = y - this.player.y;
    const l = Math.hypot(dx, dy);
    if (l > 1e-6) this.player.aim = { x: dx / l, y: dy / l };
  }

  setBinding(slot: string, spell: string): void {
    this.player.bindings[slot] = spell;
  }

  spellNames(): string[] {
    return Object.keys(this.book);
  }

  metaOf(spell: string): SpellMeta {
    return this.metas[spell] ?? normalizeMeta(null);
  }

  foesLeft(): number {
    return this.world.aliveActors().filter((a) => a.faction === 'foe').length;
  }

  restart(): void {
    this.world.reset();
    this.world.bounds = { w: ARENA_W, h: ARENA_H };
    this.world.onDamage = (target) => this.handleDamage(target);
    this.casts.clear();
    this.cooldowns.clear();
    this.heldSlots.clear();
    this.log = [];
    this.time = 0;
    this.state = 'fighting';
    this.stats = { casts: 0, interrupts: 0, backfires: 0, kills: 0 };
    this.player = this.spawnPlayer();
    this.startWave(0);
  }

  private nearestHostile(a: Actor): Actor | null {
    let best: Actor | null = null;
    let bestD = Infinity;
    for (const other of this.world.actors) {
      if (!other.alive || other.faction === a.faction) continue;
      const d = Math.hypot(other.x - a.x, other.y - a.y);
      if (d < bestD) {
        bestD = d;
        best = other;
      }
    }
    return best;
  }

  private pushLog(line: string): void {
    this.log.unshift(line);
    if (this.log.length > 8) this.log.pop();
  }
}

export { spellMeta };
