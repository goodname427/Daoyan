import { TICK_MS, VM, World, analyzeBook, compileProgram } from '../core/index';
import type { Actor, Program, SpellBook, SpellCost } from '../core/index';

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

const ARENA_W = 1600;
const ARENA_H = 1200;

export class Battle {
  world: World;
  program: Program;
  costs: Record<string, SpellCost>;
  player: Actor;
  casts = new Map<number, VM>();

  input: BattleInput = { up: false, down: false, left: false, right: false };
  time = 0;
  waveIndex = 0;
  state: BattleState = 'fighting';
  log: string[] = [];
  stats: BattleStats = { casts: 0, interrupts: 0, backfires: 0, kills: 0 };

  constructor(private book: SpellBook) {
    this.costs = analyzeBook(book);
    this.program = compileProgram(book);
    this.world = new World();
    this.world.bounds = { w: ARENA_W, h: ARENA_H };
    this.world.onDamage = (target) => this.handleDamage(target);

    this.player = this.world.spawnActor({
      name: '修士',
      faction: 'player',
      x: ARENA_W / 2,
      y: ARENA_H / 2,
      hpMax: 120,
      manaMax: 300,
      manaRegen: 24,
      shenshiMax: 64,
      speed: 170,
      radius: 13,
      castSlow: 0.45,
      bindings: {
        mouse: '基础剑气',
        '1': '疾风步',
        '2': '三连剑',
        '3': '爆炎咒',
        '4': '微剑',
      },
    });

    this.startWave(0);
  }

  // ---------------- 波次 ----------------

  startWave(index: number): void {
    this.waveIndex = index;
    const spec = WAVES[Math.min(index, WAVES.length - 1)];
    this.world.projectiles = [];

    for (let i = 0; i < spec.chaser; i++) this.spawnFoe('chaser');
    for (let i = 0; i < spec.shooter; i++) this.spawnFoe('shooter');

    this.pushLog(`第 ${index + 1} 波：${spec.chaser} 扑击妖兽 / ${spec.shooter} 符修`);
  }

  private spawnFoe(kind: 'chaser' | 'shooter'): Actor {
    // 在离玩家足够远的位置生成
    let x = 0;
    let y = 0;
    for (let tries = 0; tries < 40; tries++) {
      x = 80 + Math.random() * (ARENA_W - 160);
      y = 80 + Math.random() * (ARENA_H - 160);
      if (Math.hypot(x - this.player.x, y - this.player.y) > 420) break;
    }

    const base = {
      faction: 'foe' as const,
      x,
      y,
      shenshiMax: 40,
      castSlow: 0.35,
    };

    if (kind === 'chaser') {
      return this.world.spawnActor({
        ...base,
        name: '扑击妖兽',
        hpMax: 60,
        manaMax: 220,
        manaRegen: 46,
        speed: 108,
        radius: 12,
        behavior: 'chaser',
        attackRange: 260,
        attackCooldown: 1.9,
        bindings: { attack: '妖兽·扑击' },
      });
    }
    return this.world.spawnActor({
      ...base,
      name: '妖兽符修',
      hpMax: 45,
      manaMax: 240,
      manaRegen: 52,
      speed: 88,
      radius: 11,
      behavior: 'shooter',
      attackRange: 460,
      attackCooldown: 2.3,
      bindings: { attack: '妖兽·雷符' },
    });
  }

  // ---------------- 主循环 ----------------

  update(dt: number): void {
    if (this.state !== 'fighting') return;
    this.time += dt;

    for (const a of this.world.actors) {
      if (!a.alive) continue;
      if (a.mana < a.manaMax) a.mana = Math.min(a.manaMax, a.mana + a.manaRegen * dt);
      if (a.stun > 0) a.stun = Math.max(0, a.stun - dt);
      if (a.hitFlash > 0) a.hitFlash = Math.max(0, a.hitFlash - dt);
      if (a.alive && a.faction === 'foe') a.attackTimer -= dt;
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
    const casting = this.casts.has(p.id);
    const speed = p.speed * (casting ? p.castSlow : 1);
    this.world.moveActor(p, (dx / l) * speed * dt, (dy / l) * speed * dt);
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
        // 进入攻击距离后绕圈，避免糊在一起
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
      const speed = a.speed * (casting ? a.castSlow : 1);
      this.world.moveActor(a, (mx / l) * speed * dt, (my / l) * speed * dt);
    }

    if (d <= a.attackRange && a.attackTimer <= 0 && !this.casts.has(a.id)) {
      if (this.trigger(a.id, 'attack')) {
        a.attackTimer = a.attackCooldown;
      } else {
        // 法力不足或法术有问题时短暂重试，避免空转刷屏
        a.attackTimer = 0.35;
      }
    }
  }

  private advanceCasts(dt: number): void {
    const tickBudget = (dt * 1000) / TICK_MS;
    for (const [id, vm] of [...this.casts]) {
      const a = this.world.byId(id);
      if (!a || !a.alive) {
        this.casts.delete(id);
        continue;
      }
      const before = vm.spentMana;
      vm.advance(tickBudget);
      // 法力按增量扣减：被打断时已消耗的部分不会退还
      a.mana = Math.max(0, a.mana - (vm.spentMana - before));
      if (vm.isDone) {
        this.casts.delete(id);
        if (vm.failure) {
          this.stats.backfires++;
          this.pushLog(`${a.name} 走火入魔：${vm.failure}`);
          a.stun = 0.5;
        }
      }
    }
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

  /** 简单分离，避免单位重叠成一坨 */
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
    if (this.casts.has(target.id)) {
      this.casts.delete(target.id);
      this.stats.interrupts++;
      this.pushLog(`${target.name} 施法被打断`);
    }
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

    const vm = new VM(this.program, this.world, a);
    vm.start(spell);
    this.casts.set(actorId, vm);
    this.stats.casts++;
    return true;
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

  foesLeft(): number {
    return this.world.aliveActors().filter((a) => a.faction === 'foe').length;
  }

  restart(): void {
    this.world.reset();
    this.world.bounds = { w: ARENA_W, h: ARENA_H };
    this.casts.clear();
    this.log = [];
    this.time = 0;
    this.state = 'fighting';
    this.stats = { casts: 0, interrupts: 0, backfires: 0, kills: 0 };
    this.player = this.world.spawnActor({
      name: '修士',
      faction: 'player',
      x: ARENA_W / 2,
      y: ARENA_H / 2,
      hpMax: 120,
      manaMax: 300,
      manaRegen: 24,
      shenshiMax: 64,
      speed: 170,
      radius: 13,
      castSlow: 0.45,
      bindings: {
        mouse: '基础剑气',
        '1': '疾风步',
        '2': '三连剑',
        '3': '爆炎咒',
        '4': '微剑',
      },
    });
    this.world.onDamage = (target) => this.handleDamage(target);
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
