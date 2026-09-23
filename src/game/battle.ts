import {
  baseAttributes,
  TICK_MS,
  VM,
  World,
  analyzeBook,
  compileProgram,
  normalizeMeta,
  spellMeta,
} from '../core/index';
import type {
  Actor,
  AttrKey,
  Attributes,
  ControlSession,
  KeyState,
  Program,
  SpellBook,
  SpellCost,
  SpellMeta,
  WorldEvent,
  WorldEventType,
} from '../core/index';
import { makeKeyState } from '../core/input';
import { ChargeSession, type ChargeEnd, type SlotIntent } from '../core/input';

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
  /** 整次施法共享的核心控制会话，duration 重启 VM 不重建。 */
  controlSession: ControlSession;
  controlCharge: { vm: VM | null; mana: number; ticks: number };
  /** 已持续秒数 */
  elapsed: number;
  /** 跨帧 tick 信用；元法术整步执行造成的超支会在后续帧偿还 */
  tickCredit: number;
  /** 距离下次周期触发还剩多久（duration 用） */
  periodTimer: number;
  /** 已触发次数 */
  fired: number;
  /** 虚拟按键状态（引用共享，每帧原地更新） */
  keys: KeyState[];
  /** 触发本施法的槽位；玩家还用它把物理键状态映射到 keys[0] */
  triggerSlot: string;
  /** 已主动结束（调用过「结束施法」），优先于 duration 周期重启 */
  ended: boolean;
}

interface EventCast {
  readonly ownerId: number;
  readonly spell: string;
  readonly event: WorldEvent;
  readonly vm: VM;
  readonly session: ControlSession;
  readonly response: EventResponseSummary;
  tickCredit: number;
}

interface EventResponseSummary {
  eventId: number;
  type: WorldEventType;
  spell: string;
  state: 'running' | 'success' | 'failed';
  mana: number;
  ticks: number;
  error: string | null;
}

const ARENA_W = 1600;
const ARENA_H = 1200;

export const DEFAULT_PLAYER_BINDINGS: Record<string, string> = {
  mouse: '基础剑气',
  '1': '疾风步',
  '2': '三连剑',
  '3': '爆炎咒',
  '4': '微剑',
  '5': '蓄力火球',
};

export const DEFAULT_PLAYER_ATTRS: Attributes = baseAttributes({
  hpMax: 120,
  manaMax: 300,
  manaRegen: 24,
  shenshiMax: 64,
  speed: 170,
  castSpeed: 1,
  power: 1,
  armor: 0,
});

export interface BattleOptions {
  playerAttrs?: Partial<Attributes>;
  playerBindings?: Record<string, string>;
  autoStart?: boolean;
}

export class Battle {
  world: World;
  program: Program;
  costs: Record<string, SpellCost>;
  metas: Record<string, SpellMeta>;
  player: Actor;
  /** actorId → 触发槽位 → 当前施法 */
  casts = new Map<number, Map<string, CastInstance>>();
  /** actorId → 所有并发 VM 当前共同占用的神识 */
  private shenshiUsage = new Map<number, number>();
  private eventCasts = new Map<number, EventCast>();
  readonly eventResponses: EventResponseSummary[] = [];
  private nextEventCastId = 1;
  readonly chargeSessions = new Map<string, ChargeSession>();
  readonly finishedCharges: ChargeSession[] = [];
  private slotIntents: SlotIntent[] = [];
  private physicalSlots = new Set<string>();
  private inputOverflow = false;

  input: BattleInput = { up: false, down: false, left: false, right: false };
  /** 当前按住的槽位集合（玩家用，驱动键位法术的 keys[0]） */
  heldSlots = new Set<string>();
  time = 0;
  waveIndex = 0;
  state: BattleState = 'fighting';
  started = false;
  paused = false;
  log: string[] = [];
  stats: BattleStats = { casts: 0, interrupts: 0, backfires: 0, kills: 0 };
  private playerAttrs: Attributes;
  private playerBindings: Record<string, string>;

  constructor(
    private book: SpellBook,
    options: BattleOptions = {},
  ) {
    this.costs = analyzeBook(book);
    this.program = compileProgram(book);
    this.metas = Object.fromEntries(
      Object.entries(book).map(([n, sp]) => [n, normalizeMeta(sp.meta)]),
    );
    this.playerAttrs = { ...DEFAULT_PLAYER_ATTRS, ...(options.playerAttrs ?? {}) };
    this.playerBindings = { ...DEFAULT_PLAYER_BINDINGS, ...(options.playerBindings ?? {}) };

    this.world = new World();
    this.world.bounds = { w: ARENA_W, h: ARENA_H };
    this.world.onDamage = (target) => this.handleDamage(target);

    this.player = this.spawnPlayer();
    if (options.autoStart ?? true) this.start();
  }

  private spawnPlayer(): Actor {
    return this.world.spawnActor({
      name: '修士',
      faction: 'player',
      x: ARENA_W / 2,
      y: ARENA_H / 2,
      attrs: this.playerAttrs,
      radius: 13,
      castSlow: 0.45,
      bindings: { ...this.playerBindings },
    });
  }

  // ---------------- 波次 ----------------

  startWave(index: number): void {
    for (const session of [...this.chargeSessions.values()])
      if (session.projectileId !== null) this.finishCharge(session, 'target-lost');
    this.waveIndex = index;
    const spec = WAVES[Math.min(index, WAVES.length - 1)];
    for (const projectile of this.world.projectiles) this.world.refundEntityEnergy(projectile.id);
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

    const foe =
      kind === 'chaser'
        ? this.world.spawnActor({
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
            attackInterval: 1.9,
            castSlow: 0.35,
            bindings: { attack: '妖兽·扑击' },
          })
        : this.world.spawnActor({
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
            attackInterval: 2.3,
            castSlow: 0.35,
            bindings: { attack: '妖兽·雷符' },
          });
    // 战场只公开可见目标的位置；其余属性仍须由权威规则逐字段授权。
    this.world.grantSenseField(this.player.id, foe.id, 'position', {
      shenshiUpperBound: foe.attr.shenshiMax,
      resistanceUpperBound: 0,
    });
    return foe;
  }

  // ---------------- 主循环 ----------------

  update(dt: number): void {
    if (!this.started || this.paused) return;
    if (this.state !== 'fighting') return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.expireChargeSessions();
    this.consumeSlotIntents();
    let remaining = dt;
    while (remaining > 0 && this.state === 'fighting') {
      // 世界在边界前使用已付费效果；核心在边界上先清理再续费。
      const slice = this.world.nextControlBoundaryIn(remaining);
      if (slice <= 0) {
        this.world.advanceControlTime(0);
        continue;
      }
      this.updateSlice(slice);
      const maintained = this.world
        .controlRecordSnapshot()
        .filter((record) => record.mode === 'maintain');
      this.world.advanceControlTime(slice);
      this.world.pruneControlRecords();
      this.reportEndedMaintains(maintained);
      remaining = Math.max(0, remaining - slice);
    }
  }

  private updateSlice(dt: number): void {
    const maintained = this.world
      .controlRecordSnapshot()
      .filter((record) => record.mode === 'maintain');
    this.time += dt;

    for (const a of this.world.actors) {
      if (!a.alive) {
        if (a.deathTimer > 0) a.deathTimer = Math.max(0, a.deathTimer - dt);
        continue;
      }
      this.world.tickActor(a, dt);
      if (a.faction === 'foe') a.attackTimer -= dt;
    }
    this.movePlayer(dt);
    for (const a of this.world.actors) {
      if (a.alive && a.faction === 'foe') this.updateFoe(a, dt);
    }
    this.advanceCasts(dt);
    this.advanceChargeSessions(dt);
    this.advanceEventCasts(dt);
    this.updateProjectiles(dt);
    this.world.dispatchWorldEvents();
    this.world.pruneControlRecords();
    this.reportEndedMaintains(maintained);
    this.separate();
    this.checkEnd();
  }

  private reportEndedMaintains(maintained: ReturnType<World['controlRecordSnapshot']>): void {
    const current = this.world.controlRecordSnapshot();
    for (const record of maintained) {
      if (
        current.some(
          (item) =>
            item.sequence === record.sequence ||
            (item.controllerSessionId === record.controllerSessionId &&
              item.targetId === record.targetId &&
              item.propertyKey === record.propertyKey),
        )
      )
        continue;
      const cast = [...this.casts.values()]
        .flatMap((slots) => [...slots.values()])
        .find((item) => item.controlSession.id === record.controllerSessionId);
      if (!cast) continue;
      const target = this.world.entityById(record.targetId);
      const reason = !target
        ? '目标死亡或移除'
        : !this.world.controlPropertyBinding(target, record.propertyKey)
          ? '目标缺少属性能力'
          : !cast.controlSession.canControl(target, record.propertyKey)
            ? '控制权限失效'
            : record.expiresAt !== null && record.expiresAt <= this.world.controlTimeNow
              ? '持续时间到期'
              : (cast.vm.failure ?? '维持续费失败（请检查法力余额）');
      this.pushLog(`「${cast.spell}」的 ${record.propertyKey} 维持结束：${reason}`);
    }
  }

  private movePlayer(dt: number): void {
    const p = this.player;
    const dx = (this.input.right ? 1 : 0) - (this.input.left ? 1 : 0);
    const dy = (this.input.down ? 1 : 0) - (this.input.up ? 1 : 0);
    this.world.advanceActorMotion(p, { x: dx, y: dy }, this.moveMul(p), dt);
  }

  /** 施法中的移动速度倍率 */
  private moveMul(a: Actor): number {
    const active = this.activeCasts(a.id);
    const charging = [...this.chargeSessions.values()].some((session) => session.actorId === a.id);
    if (active.length === 0 && !charging) return 1;
    return Math.min(
      ...(charging ? [a.castSlow] : []),
      ...active.map((cast) => (cast.meta.kind === 'channel' ? cast.meta.channelSlow : a.castSlow)),
    );
  }

  private updateFoe(a: Actor, dt: number): void {
    if (a.stun > 0) {
      this.world.advanceActorMotion(a, { x: 0, y: 0 }, 1, dt);
      return;
    }
    const target = this.nearestHostile(a);
    if (!target) {
      this.world.advanceActorMotion(a, { x: 0, y: 0 }, 1, dt);
      return;
    }
    const dx = target.x - a.x;
    const dy = target.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    this.world.setActorAim(a, { x: ux, y: uy });

    const casting = this.isCasting(a.id);
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

    this.world.advanceActorMotion(a, { x: mx, y: my }, casting ? a.castSlow : 1, dt);

    if (d <= a.attackRange && a.attackTimer <= 0) {
      if (this.trigger(a.id, 'attack')) {
        a.attackTimer = a.attackInterval;
      } else {
        a.attackTimer = 0.35;
      }
    }
  }

  private advanceCasts(dt: number): void {
    for (const [id, actorCasts] of [...this.casts]) {
      const a = this.world.byId(id);
      if (!a || !a.alive) {
        this.cancelCasts(id);
        continue;
      }

      for (const [slot, cast] of [...actorCasts]) {
        // 先更新按键状态（玩家：keys[0] 由触发槽位的 held 状态驱动）
        this.updateKeyState(a, cast, dt);

        // 每个实例都按完整施法速度独立推进；共享资源在 VM 钩子中实时结算。
        cast.tickCredit += ((dt * 1000) / TICK_MS) * a.attr.castSpeed;
        if ((cast.vm.isRunning || cast.vm.pendingTickDebt > 0) && cast.tickCredit > 0) {
          cast.tickCredit -= cast.vm.advance(cast.tickCredit);
        }
        cast.elapsed += dt;
        if (cast.vm.endRequested) cast.ended = true;

        // 超时（引导类最长引导时间）
        if (
          cast.meta.kind === 'channel' &&
          cast.elapsed > cast.meta.duration &&
          cast.vm.isRunning
        ) {
          cast.vm.advance(Number.MAX_SAFE_INTEGER, 1);
        }

        if (!cast.vm.isDone) continue;

        if (cast.vm.failure) {
          this.removeCast(id, slot);
          this.stats.backfires++;
          this.world.fx.push({ kind: 'backfire', x: a.x, y: a.y });
          this.pushLog(`${a.name} 施展「${cast.spell}」走火入魔：${cast.vm.failure}`);
          a.stun = 0.5;
          continue;
        }

        // 主动结束（调用了「结束施法」）：直接收尾，不再周期重启
        if (cast.ended) {
          this.removeCast(id, slot);
          continue;
        }

        // 维持续费产生的工作必须在下一次 duration VM 片段前偿还。
        if (cast.vm.pendingTickDebt > 0) continue;

        // 本次执行完毕
        if (cast.meta.kind === 'duration' && cast.elapsed < cast.meta.duration) {
          // 进入周期等待，到点再触发一次
          cast.periodTimer -= dt;
          if (cast.periodTimer <= 0) {
            this.restartCastVm(a, cast);
          }
          continue;
        }

        this.removeCast(id, slot);
      }
    }
  }

  /** 把按键物理状态写进 cast.keys（仅玩家；妖兽无按键） */
  private updateKeyState(a: Actor, cast: CastInstance, dt: number): void {
    if (cast.keys.length === 0) return;
    if (a.faction !== 'player') return;
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
    const vm = this.createBattleVm(a, cast.controlSession, true);
    cast.controlCharge.vm = vm;
    vm.start(cast.spell);
    vm.setKeyState(cast.keys.length > 0 ? cast.keys : null);
    cast.vm = vm;
    cast.tickCredit = -vm.spentTicks;
  }

  private updateProjectiles(dt: number): void {
    const removed: number[] = [];
    for (const p of this.world.projectiles) {
      const activeDt = Math.min(dt, Math.max(0, p.life));
      p.life -= dt;

      if (p.active && activeDt > 0) {
        this.world.advanceProjectileMotion(p, activeDt);
      }

      let dead = p.life <= 0;
      if (p.active) {
        dead = dead || p.x < 0 || p.y < 0 || p.x > this.world.bounds.w || p.y > this.world.bounds.h;
      }

      if (!dead && p.active) {
        for (const a of this.world.actors) {
          if (!a.alive || a.faction === p.faction || p.hit.has(a.id)) continue;
          if (Math.hypot(a.x - p.x, a.y - p.y) <= p.radius + a.radius) {
            const wasAlive = a.alive;
            this.world.hitProjectile(p, a.id);
            if (wasAlive && !a.alive) this.stats.kills++;
            if (p.pierce > 0) p.pierce--;
            else dead = true;
            break;
          }
        }
      }
      if (dead) removed.push(p.id);
    }
    for (const id of removed) this.world.removeProjectile(id);
  }

  private separate(): void {
    const list = this.world.aliveActors();
    const contacts: Array<{ sourceId: number; targetId: number; x: number; y: number }> = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const min = a.radius + b.radius;
        if (d > 1e-6 && d < min) {
          contacts.push({ sourceId: a.id, targetId: b.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
          const push = (min - d) / 2;
          const ux = dx / d;
          const uy = dy / d;
          this.world.moveActor(a, -ux * push, -uy * push);
          this.world.moveActor(b, ux * push, uy * push);
          const an = a.velocity.x * ux + a.velocity.y * uy;
          const bn = b.velocity.x * ux + b.velocity.y * uy;
          if (an > 0) {
            a.velocity.x -= an * ux;
            a.velocity.y -= an * uy;
          }
          if (bn < 0) {
            b.velocity.x -= bn * ux;
            b.velocity.y -= bn * uy;
          }
        }
      }
    }
    this.world.commitActorContacts(contacts);
  }

  private handleDamage(target: Actor): void {
    for (const session of [...this.chargeSessions.values()])
      if (session.actorId === target.id && (!target.alive || session.interruptible))
        this.finishCharge(session, target.alive ? 'interrupted' : 'death');
    const interrupted = this.activeCasts(target.id).filter(
      (cast) => !target.alive || cast.meta.interruptible,
    );
    for (const cast of interrupted) {
      this.removeCast(target.id, cast.triggerSlot, true);
    }
    for (const [id, cast] of this.eventCasts)
      if (cast.ownerId === target.id && (!target.alive || this.metaOf(cast.spell).interruptible))
        this.finishEventCast(id, true);
    this.stats.interrupts += interrupted.length;
    if (interrupted.length > 0) {
      this.pushLog(`${target.name} 的 ${interrupted.length} 个法术被打断`);
    }
    target.stun = Math.max(target.stun, 0.18);
  }

  private checkEnd(): void {
    if (!this.player.alive) {
      this.state = 'defeat';
      for (const session of [...this.chargeSessions.values()]) this.finishCharge(session, 'death');
      for (const actorId of [...this.casts.keys()]) this.cancelCasts(actorId);
      for (const id of [...this.eventCasts.keys()]) this.finishEventCast(id, true);
      this.pushLog('道消身陨……');
      return;
    }
    const foesLeft = this.world.aliveActors().filter((a) => a.faction === 'foe').length;
    if (foesLeft > 0) return;
    if (this.waveIndex >= WAVES.length - 1) {
      this.state = 'victory';
      for (const session of [...this.chargeSessions.values()])
        this.finishCharge(session, 'cancelled');
      for (const actorId of [...this.casts.keys()]) this.cancelCasts(actorId);
      for (const id of [...this.eventCasts.keys()]) this.finishEventCast(id, true);
      this.pushLog('尽数伏诛，此局功成');
    } else {
      this.startWave(this.waveIndex + 1);
    }
  }

  // ---------------- 对外接口 ----------------

  activeCasts(actorId: number): CastInstance[] {
    return [...(this.casts.get(actorId)?.values() ?? [])];
  }

  isCasting(actorId: number): boolean {
    return (
      (this.casts.get(actorId)?.size ?? 0) > 0 ||
      [...this.chargeSessions.values()].some((session) => session.actorId === actorId)
    );
  }

  shenshiInUse(actorId: number): number {
    return this.shenshiUsage.get(actorId) ?? 0;
  }

  start(): void {
    if (this.started) {
      this.setPaused(false);
      return;
    }
    this.started = true;
    this.paused = false;
    this.startWave(0);
  }

  setPaused(paused: boolean): void {
    if (!this.started || this.state !== 'fighting') return;
    this.paused = paused;
    if (!paused) this.expireChargeSessions();
  }

  /** 触发某单位绑定在指定槽位上的法术 */
  subscribeSpellEvent(
    actorId: number,
    bindingId: string,
    type: WorldEventType,
    spell: string,
    options: { sourceId?: number; targetId?: number; session?: ControlSession } = {},
  ): number | null {
    if (!this.program.index.has(spell) || this.costs[spell]?.errors.length) return null;
    return this.world.subscribeEvent(
      actorId,
      bindingId,
      type,
      (event) => this.startEventCast(actorId, spell, event),
      options,
    );
  }

  unsubscribeSpellEvent(sequence: number): void {
    this.world.unsubscribeEvent(sequence);
  }

  private startEventCast(actorId: number, spell: string, event: WorldEvent): void {
    const actor = this.world.byId(actorId);
    if (!actor?.alive) return;
    const response: EventResponseSummary = {
      eventId: event.eventId,
      type: event.type,
      spell,
      state: 'running',
      mana: 0,
      ticks: 0,
      error: null,
    };
    this.eventResponses.unshift(response);
    if (this.eventResponses.length > 32) this.eventResponses.pop();
    const active = [...this.eventCasts.values()].filter((cast) => cast.ownerId === actorId);
    if (active.length >= 32 || active.filter((cast) => cast.spell === spell).length >= 8) {
      this.world.eventDrops.capacity++;
      response.state = 'failed';
      response.error = '响应容量已满';
      return;
    }
    let vm: VM | null = null;
    const session = this.world.createControlSession(
      actorId,
      (record, phase) => vm?.chargeControl(record, phase) ?? false,
    );
    if (!session) {
      this.world.eventDrops.capacity++;
      response.state = 'failed';
      response.error = '会话或账户不可用';
      return;
    }
    vm = this.createBattleVm(actor, session, false);
    vm.setKeyState(null);
    vm.start(spell);
    const id = this.nextEventCastId++;
    this.world.retainEventRoot(event.rootEventId);
    this.eventCasts.set(id, {
      ownerId: actorId,
      spell,
      event,
      vm,
      session,
      response,
      tickCredit: 0,
    });
    this.world.withEventCause(event, () => vm!.advance(1));
    if (vm.isDone) this.finishEventCast(id);
  }

  private advanceEventCasts(dt: number): void {
    for (const [id, cast] of [...this.eventCasts]) {
      const actor = this.world.byId(cast.ownerId);
      if (!actor?.alive) {
        this.finishEventCast(id, true);
        continue;
      }
      cast.tickCredit += ((dt * 1000) / TICK_MS) * actor.attr.castSpeed;
      if ((cast.vm.isRunning || cast.vm.pendingTickDebt > 0) && cast.tickCredit > 0)
        cast.tickCredit -= this.world.withEventCause(cast.event, () =>
          cast.vm.advance(cast.tickCredit),
        );
      if (cast.vm.isDone) this.finishEventCast(id);
    }
  }

  private finishEventCast(id: number, cancel = false): void {
    const cast = this.eventCasts.get(id);
    if (!cast) return;
    if (cancel) cast.vm.cancel();
    cast.response.state = cast.vm.failure || cancel ? 'failed' : 'success';
    cast.response.mana = cast.vm.spentMana;
    cast.response.ticks = cast.vm.spentTicks;
    cast.response.error = cast.vm.failure ?? (cancel ? '会话已终止' : null);
    cast.session.end();
    this.eventCasts.delete(id);
    this.world.releaseEventRoot(cast.event.rootEventId);
    if (cast.vm.failure) this.pushLog(`「${cast.spell}」事件响应失败：${cast.vm.failure}`);
  }

  /** 触发某单位绑定在指定槽位上的法术 */
  trigger(actorId: number, slot: string, releasingCharge = false, spellOverride?: string): boolean {
    if (!this.started || this.paused) return false;
    const a = this.world.byId(actorId);
    if (!a || !a.alive) return false;
    if (a.stun > 0) return false;

    const spell = spellOverride ?? a.bindings[slot];
    if (!spell) return false;
    if (!this.program.index.has(spell)) return false;

    const cost = this.costs[spell];
    if (cost && cost.errors.length > 0) {
      this.pushLog(`「${spell}」无法施展：${cost.errors[0]}`);
      return false;
    }
    if (this.casts.get(actorId)?.has(slot)) return false;

    const meta = this.metas[spell] ?? normalizeMeta(null);
    if (meta.charge && !releasingCharge) return this.beginCharge(a, slot, meta);
    const controlCharge: { vm: VM | null; mana: number; ticks: number } = {
      vm: null,
      mana: 0,
      ticks: 0,
    };
    const controlSession = this.world.createControlSession(a.id, (record, phase) => {
      const activeVm = controlCharge.vm;
      if (!activeVm) return false;
      const manaBefore = activeVm.spentMana;
      const ticksBefore = activeVm.spentTicks;
      const paid = activeVm.chargeControl(record, phase);
      if (paid) {
        controlCharge.mana += activeVm.spentMana - manaBefore;
        controlCharge.ticks += activeVm.spentTicks - ticksBefore;
      }
      return paid;
    });
    if (!controlSession) return false;
    const vm = this.createBattleVm(a, controlSession, meta.kind !== 'instant');
    controlCharge.vm = vm;
    vm.start(spell);

    // 准备虚拟按键状态（玩家：按下瞬间给 keys[0] 一个 pressEdge）
    const keys = meta.keys.map(() => makeKeyState());
    const isPlayer = a.faction === 'player';
    if (isPlayer && keys.length > 0) keys[0].pressEdge = true;
    vm.setKeyState(keys.length > 0 ? keys : null);

    let actorCasts = this.casts.get(actorId);
    if (!actorCasts) {
      actorCasts = new Map();
      this.casts.set(actorId, actorCasts);
    }
    actorCasts.set(slot, {
      spell,
      meta,
      vm,
      controlSession,
      controlCharge,
      elapsed: 0,
      tickCredit: -vm.spentTicks,
      periodTimer: Math.max(0.05, meta.period),
      fired: 1,
      keys,
      triggerSlot: slot,
      ended: false,
    });
    this.world.fx.push({ kind: 'cast', x: a.x, y: a.y });
    this.stats.casts++;
    return true;
  }

  private beginCharge(a: Actor, slot: string, meta: SpellMeta): boolean {
    if (this.chargeSessions.has(`${a.id}:${slot}`) || this.casts.get(a.id)?.has(slot)) return false;
    if (
      !['prepare', 'projectile'].includes(meta.charge ?? '') ||
      !Number.isFinite(meta.duration) ||
      meta.duration <= 0 ||
      !Number.isFinite(meta.period) ||
      meta.period <= 0 ||
      (meta.charge === 'projectile' &&
        (!Number.isFinite(meta.chargeMana ?? 5) || (meta.chargeMana ?? 5) <= 0))
    )
      return false;
    const used = this.shenshiInUse(a.id);
    if (!this.world.tryReserveEntityShenshi(a.id, 1)) return false;
    this.shenshiUsage.set(a.id, used + 1);
    const session = new ChargeSession(
      a.id,
      slot,
      meta.charge!,
      meta.duration,
      Math.max(0.25, meta.period),
      meta.charge === 'projectile' ? (this.nearestHostile(a)?.id ?? null) : null,
      a.bindings[slot],
      meta.interruptible,
      meta.chargeMana ?? 5,
    );
    if (meta.charge === 'projectile') {
      // 名额和账户在付款前验证；旧五参创建仍由原入口即激活。
      if (this.world.projectiles.filter((item) => item.ownerId === a.id).length >= 16) {
        this.releaseChargeShenshi(a.id);
        return false;
      }
      const createPrice = 8 + meta.duration * 2;
      if (this.world.resourceLedger.payMana(a.id, createPrice, 'charge-create') === null) {
        this.releaseChargeShenshi(a.id);
        return false;
      }
      const projectile = this.world.spawnProjectile({
        faction: a.faction,
        ownerId: a.id,
        x: a.x,
        y: a.y,
        dx: a.aim.x,
        dy: a.aim.y,
        speed: 380,
        damage: 0,
        life: meta.duration,
        active: false,
      });
      if (!projectile) {
        this.releaseChargeShenshi(a.id);
        return false;
      }
      session.projectileId = projectile.id;
      session.state = 'held';
      session.workTicks = 2 + Math.ceil(meta.duration / 2);
    } else if (this.world.resourceLedger.payMana(a.id, 1, 'charge-start') === null) {
      this.releaseChargeShenshi(a.id);
      return false;
    }
    this.chargeSessions.set(`${a.id}:${slot}`, session);
    this.stats.casts++;
    return true;
  }

  private releaseChargeShenshi(actorId: number): void {
    const next = Math.max(0, this.shenshiInUse(actorId) - 1);
    if (next === 0) this.shenshiUsage.delete(actorId);
    else this.shenshiUsage.set(actorId, next);
    this.world.reportEntityShenshiUsage(actorId, next);
  }

  private finishCharge(session: ChargeSession, reason: ChargeEnd): void {
    if (!session.finish(reason)) return;
    if (reason !== 'released' && session.projectileId !== null)
      this.world.removeProjectile(session.projectileId);
    this.releaseChargeShenshi(session.actorId);
    const key = `${session.actorId}:${session.slot}`;
    if (this.chargeSessions.get(key) === session) this.chargeSessions.delete(key);
    this.finishedCharges.push(session);
    if (this.finishedCharges.length > 64) this.finishedCharges.shift();
  }

  cancelCharge(slot: string): void {
    const session = this.chargeSessions.get(`${this.player.id}:${slot}`);
    if (session) this.finishCharge(session, 'cancelled');
  }

  private expireChargeSessions(): void {
    for (const session of [...this.chargeSessions.values()]) {
      const actor = this.world.byId(session.actorId);
      if (!actor?.alive) this.finishCharge(session, 'death');
      else if (session.projectileId !== null && !this.world.entityById(session.projectileId))
        this.finishCharge(session, 'target-lost');
      else if (session.targetId !== null && !this.world.byId(session.targetId)?.alive)
        this.finishCharge(session, 'target-lost');
      else if (
        session.elapsed >=
        (session.mode === 'prepare' ? session.duration * 2 : session.duration) - 1e-9
      )
        this.finishCharge(session, 'expired');
    }
  }

  private consumeSlotIntents(): void {
    if (this.inputOverflow) {
      for (const session of [...this.chargeSessions.values()])
        this.finishCharge(session, 'cancelled');
      this.slotIntents = [];
      this.inputOverflow = false;
      this.physicalSlots.clear();
      this.heldSlots.clear();
      return;
    }
    const intents = this.slotIntents.splice(0);
    for (const intent of intents) {
      if (intent.type === 'press') {
        this.heldSlots.add(intent.slot);
        this.castPlayer(intent.slot);
      } else {
        this.heldSlots.delete(intent.slot);
        const session = this.chargeSessions.get(`${this.player.id}:${intent.slot}`);
        if (session) this.releaseCharge(session);
      }
    }
  }

  private releaseCharge(session: ChargeSession): void {
    const actor = this.world.byId(session.actorId);
    if (!actor?.alive) {
      this.finishCharge(session, 'death');
      return;
    }
    if (session.mode === 'prepare') {
      if (session.elapsed < session.duration) {
        this.finishCharge(session, 'early-release');
        return;
      }
      session.state = 'releasing';
      this.finishCharge(session, 'released');
      // 效果只在合法松开后启动一次，原 VM 仍按自己的 tick 与法力合同执行。
      this.trigger(actor.id, session.slot, true, session.spell);
      return;
    }
    const projectile =
      session.projectileId === null
        ? null
        : this.world.ownedProjectile(actor.id, session.projectileId);
    if (!projectile || (session.targetId !== null && !this.world.byId(session.targetId)?.alive)) {
      this.finishCharge(session, 'target-lost');
      return;
    }
    if (session.periods === 0) {
      this.finishCharge(session, 'early-release');
      return;
    }
    const balance = this.world.resourceLedger.balance(projectile.id);
    const available = balance.damage - balance.reserved.damage;
    if (
      available <= 0 ||
      this.world.resourceLedger.payMana(actor.id, 4.5, 'charge-release') === null
    ) {
      this.finishCharge(session, 'exhausted');
      return;
    }
    projectile.damage = available;
    projectile.dx = actor.aim.x;
    projectile.dy = actor.aim.y;
    projectile.x = actor.x + projectile.dx * (actor.radius + projectile.radius);
    projectile.y = actor.y + projectile.dy * (actor.radius + projectile.radius);
    projectile.active = true;
    if (
      !this.world.applyImpulse(projectile.id, { x: projectile.dx * 380, y: projectile.dy * 380 })
    ) {
      projectile.active = false;
      this.finishCharge(session, 'cancelled');
      return;
    }
    this.world.fx.push({ kind: 'shoot', x: projectile.x, y: projectile.y });
    session.workTicks += 3;
    this.finishCharge(session, 'released');
  }

  private advanceChargeSessions(dt: number): void {
    for (const session of [...this.chargeSessions.values()]) {
      const actor = this.world.byId(session.actorId);
      if (!actor?.alive) {
        this.finishCharge(session, 'death');
        continue;
      }
      const next = Math.min(session.duration, session.elapsed + dt);
      while ((session.periods + 1) * session.period <= next + 1e-9) {
        if (session.mode === 'projectile') {
          const projectile =
            session.projectileId === null
              ? null
              : this.world.ownedProjectile(actor.id, session.projectileId);
          if (
            !projectile ||
            (session.targetId !== null && !this.world.byId(session.targetId)?.alive)
          ) {
            this.finishCharge(session, 'target-lost');
            break;
          }
          if (
            this.world.injectEntityEnergy(
              projectile.id,
              actor.id,
              'damage',
              session.manaPerPeriod,
            ) === null
          ) {
            this.finishCharge(session, 'exhausted');
            break;
          }
        } else if (this.world.resourceLedger.payMana(actor.id, 1, 'charge-work') === null) {
          this.finishCharge(session, 'exhausted');
          break;
        }
        session.periods++;
        session.workTicks++;
      }
      if (session.terminal) continue;
      if (session.mode === 'prepare')
        session.workTicks +=
          ((Math.min(session.duration, session.elapsed + dt) -
            Math.min(session.duration, session.elapsed)) *
            1000) /
          TICK_MS;
      session.elapsed = session.mode === 'prepare' ? session.elapsed + dt : next;
      if (session.mode === 'prepare' && session.elapsed >= session.duration) session.state = 'held';
      if (session.mode === 'projectile' && session.elapsed >= session.duration)
        this.finishCharge(session, 'expired');
    }
  }

  /**
   * 玩家按下某槽位的物理键。
   * - 按键型法术（声明了 keys）：起手进入持续施法，并标记该槽位按住
   * - 普通法术：等同 trigger 一次性触发
   */
  pressSlot(slot: string): boolean {
    if (!this.started || this.state !== 'fighting' || this.physicalSlots.has(slot)) return false;
    if (this.slotIntents.length >= 64) {
      this.inputOverflow = true;
      return false;
    }
    this.physicalSlots.add(slot);
    this.slotIntents.push({ slot, type: 'press' });
    return true;
  }

  /** 玩家松开某槽位的物理键 */
  releaseSlot(slot: string): void {
    if (!this.physicalSlots.delete(slot)) return;
    if (this.slotIntents.length >= 64) {
      this.inputOverflow = true;
      return;
    }
    this.slotIntents.push({ slot, type: 'release' });
  }

  castPlayer(slot: string): boolean {
    return this.trigger(this.player.id, slot);
  }

  aimAt(x: number, y: number): void {
    const dx = x - this.player.x;
    const dy = y - this.player.y;
    const l = Math.hypot(dx, dy);
    if (l > 1e-6) this.world.setActorAim(this.player, { x: dx / l, y: dy / l });
  }

  setBinding(slot: string, spell: string): void {
    this.playerBindings[slot] = spell;
    this.player.bindings[slot] = spell;
  }

  setPlayerBaseAttr(key: AttrKey, value: number, refillResource = false): void {
    const safeValue = Number.isFinite(value) ? value : DEFAULT_PLAYER_ATTRS[key];
    this.playerAttrs[key] = safeValue;
    this.player.base[key] = safeValue;
    this.world.recompute(this.player);
    if (refillResource && key === 'hpMax') this.player.hp = this.player.attr.hpMax;
    if (refillResource && key === 'manaMax') {
      this.player.mana = this.player.attr.manaMax;
      this.world.observeManaThreshold(this.player.id);
    }
  }

  setPlayerBaseAttrs(attrs: Partial<Attributes>, refillResource = false): void {
    for (const [key, value] of Object.entries(attrs) as Array<[AttrKey, number]>) {
      this.setPlayerBaseAttr(key, value, refillResource);
    }
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
    for (const id of [...this.eventCasts.keys()]) this.finishEventCast(id, true);
    for (const actorId of this.casts.keys()) this.cancelCasts(actorId);
    for (const session of [...this.chargeSessions.values()])
      this.finishCharge(session, 'cancelled');
    this.world.reset();
    this.world.bounds = { w: ARENA_W, h: ARENA_H };
    this.world.onDamage = (target) => this.handleDamage(target);
    this.casts.clear();
    this.shenshiUsage.clear();
    this.heldSlots.clear();
    this.physicalSlots.clear();
    this.slotIntents = [];
    this.inputOverflow = false;
    this.finishedCharges.length = 0;
    this.eventResponses.length = 0;
    this.clearPlayerInput();
    this.log = [];
    this.time = 0;
    this.state = 'fighting';
    this.started = true;
    this.paused = false;
    this.stats = { casts: 0, interrupts: 0, backfires: 0, kills: 0 };
    this.player = this.spawnPlayer();
    this.startWave(0);
  }

  private createBattleVm(a: Actor, controlSession: ControlSession, retain: boolean): VM {
    return new VM(this.program, this.world, a, {
      controlSession,
      retainControlSessionOnCompletion: retain,
      resources: {
        tryReserveShenshi: (amount) => {
          const current = this.shenshiInUse(a.id);
          if (!this.world.tryReserveEntityShenshi(a.id, amount)) return false;
          this.shenshiUsage.set(a.id, current + amount);
          return true;
        },
        releaseShenshi: (amount) => {
          const next = Math.max(0, this.shenshiInUse(a.id) - amount);
          if (next === 0) this.shenshiUsage.delete(a.id);
          else this.shenshiUsage.set(a.id, next);
          this.world.reportEntityShenshiUsage(a.id, next);
        },
      },
    });
  }

  private removeCast(actorId: number, slot: string, cancel = false): void {
    const actorCasts = this.casts.get(actorId);
    const cast = actorCasts?.get(slot);
    if (!actorCasts || !cast) return;
    const maintained = this.world
      .controlRecordSnapshot()
      .filter(
        (record) =>
          record.mode === 'maintain' && record.controllerSessionId === cast.controlSession.id,
      );
    if (maintained.length > 0)
      this.pushLog(
        `「${cast.spell}」维持结束：${cast.vm.failure ?? (cancel ? '施法取消或受击打断' : cast.ended ? '主动结束施法' : '施法实例完成')}`,
      );
    if (cancel) cast.vm.cancel();
    cast.controlSession.end();
    actorCasts.delete(slot);
    if (actorCasts.size === 0) this.casts.delete(actorId);
  }

  private cancelCasts(actorId: number): void {
    const actorCasts = this.casts.get(actorId);
    if (!actorCasts) return;
    for (const [slot] of actorCasts) this.removeCast(actorId, slot, true);
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

  private clearPlayerInput(): void {
    this.input.up = false;
    this.input.down = false;
    this.input.left = false;
    this.input.right = false;
    this.heldSlots.clear();
    this.physicalSlots.clear();
    this.slotIntents = [];
    this.inputOverflow = false;
  }
}

export { spellMeta };
