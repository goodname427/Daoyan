import type { Vec2 } from './types';
import { RESOURCE_SCALE, ResourceLedger, type EnergyPool } from './ledger';
import { sensePrice } from './pricing';
import {
  baseAttributes,
  computeAttributes,
  getControlPropertyDescriptor,
  tickModifiers,
} from './attributes';
import type {
  AttrKey,
  Attributes,
  ControlPropertyBinding,
  ControlPropertyBindings,
  ControlPropertyEffect,
  ControlPropertyKey,
  Modifier,
} from './attributes';

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
  /** 当前实际速度；由运动推进更新，朝向与上限变化不直接改写。 */
  velocity: Vec2;
  motionSource: 'projectile' | 'none';
  teleportAllowed: boolean;
  /** 主动运动计划只引用预付池，不持有 owner 的法力账户。 */
  behavior: 'glide' | 'thrust' | 'track';
  thrust: Vec2;
  trackTargetId: number | null;
  driveRemaining: number;
}

export interface Actor {
  kind: 'actor';
  id: number;
  name: string;
  faction: Faction;

  x: number;
  y: number;
  velocity: Vec2;
  motionSource: 'base' | 'spell' | 'none';
  teleportAllowed: boolean;
  /** 世界授予的不可兑换运动功率；仅角色拥有。 */
  movePower: number;
  baseSpeed: number;
  drive: Vec2;
  driveRemaining: number;
  drivePaid: boolean;
  /** 输入方向（单位向量），不受控制覆写影响 */
  baseAim: Vec2;
  /** 合成控制覆写后的有效准星方向 */
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
  attackInterval: number;
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

/** 核心内部审计字段。读取权由上层探查合同另行检查，不直接暴露给 DSL。 */
export type EntityAuditField =
  | 'position'
  | 'facing'
  | 'velocity'
  | 'speedMax'
  | 'motionSource'
  | 'movePower'
  | 'hp'
  | 'hpMax'
  | 'mana'
  | 'manaMax'
  | 'manaRegen'
  | 'shenshiUsed'
  | 'shenshiMax'
  | 'castSpeed'
  | 'manaCostMul'
  | 'armor'
  | 'damage'
  | 'perception'
  | 'lifetime'
  | 'resistances'
  | 'ownership'
  | 'sessions'
  | 'events';

export interface EntityAuditEvent {
  readonly at: number;
  readonly type: string;
  readonly summary: string;
}

export interface EntityAuditBinding {
  readonly isAvailable: () => boolean;
  readonly read: () => unknown;
  /** 本字段探查抗性；未声明的内建字段为 0。 */
  readonly senseResistance?: () => number;
}

export type EntityAuditBindings = Partial<Record<EntityAuditField, EntityAuditBinding>>;
export interface SenseGrant {
  /** 授权由权威世界配置；公开上界必须在整个授权期覆盖隐藏真值。 */
  readonly shenshiUpperBound: number;
  readonly resistanceUpperBound: number;
  /** 组合实体无 Actor 身份时，由授权者公布保守关系。 */
  readonly relation?: 1 | 2 | 8;
}
export interface SenseQuote {
  readonly distance: number;
  readonly relation: number;
  readonly targetShenshi: number;
  readonly readerShenshi: number;
  readonly resistance: number;
  readonly level: 0 | 1 | 2;
  readonly privateSelf: boolean;
}
/** 一个目标和一个字段构成有限监控范围；付款账户必须是启动者本人。 */
export interface ActiveMonitorRequest {
  readonly ownerId: number;
  readonly payerId: number;
  readonly targetId: number;
  readonly field: EntityAuditField;
  readonly intervalSeconds: number;
  readonly periods: number;
}
export interface ActiveMonitorSnapshot {
  readonly id: number;
  readonly ownerId: number;
  readonly targetId: number;
  readonly field: EntityAuditField;
  readonly nextScanAt: number | null;
  readonly finishedAt: number | null;
  readonly remainingPeriods: number;
  readonly paidMana: number;
  readonly paidTicks: number;
  readonly latest: EntityAuditResult | null;
}
interface ActiveMonitor extends ActiveMonitorSnapshot {
  readonly payerId: number;
  readonly intervalSeconds: number;
}
export type EntityAuditResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly observedAt: number;
      readonly targetId: number;
      readonly field: EntityAuditField;
    }
  | { readonly ok: false; readonly reason: 'unavailable' };

const MAX_AUDIT_EVENTS = 16;
const MAX_AUDIT_COMPOSITES = 64;
const MAX_CONTROL_SESSIONS = 64;
const MAX_AUDIT_SESSIONS = MAX_CONTROL_SESSIONS * 2;

function finiteAuditVector(value: unknown): Vec2 | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const vector = value as Partial<Vec2>;
  return Number.isFinite(vector.x) && Number.isFinite(vector.y)
    ? { x: vector.x!, y: vector.y! }
    : undefined;
}

/** binding 的数据也按字段校验，避免组合实体提供无限列表或可变引用。 */
function boundedAuditValue(field: EntityAuditField, value: unknown): unknown | undefined {
  if (field === 'position' || field === 'facing' || field === 'velocity')
    return finiteAuditVector(value);
  if (
    field === 'speedMax' ||
    field === 'movePower' ||
    field === 'hp' ||
    field === 'hpMax' ||
    field === 'mana' ||
    field === 'manaMax' ||
    field === 'manaRegen' ||
    field === 'shenshiUsed' ||
    field === 'shenshiMax' ||
    field === 'castSpeed' ||
    field === 'manaCostMul' ||
    field === 'armor' ||
    field === 'damage' ||
    field === 'perception' ||
    field === 'lifetime'
  )
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  if (field === 'motionSource')
    return typeof value === 'string' && value.length > 0 && value.length <= 32 ? value : undefined;
  if (field === 'ownership' || field === 'resistances') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const entries = Object.entries(value);
    if (entries.length > 16) return undefined;
    const result: Record<string, string | number | null> = Object.create(null);
    for (const [key, item] of entries) {
      if (key.length > 32) return undefined;
      if (field === 'resistances') {
        if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) return undefined;
        result[key] = item;
        continue;
      }
      if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
      else if (typeof item === 'string' && item.length <= 64) result[key] = item;
      else if (item === null) result[key] = null;
      else return undefined;
    }
    return result;
  }
  if (!Array.isArray(value)) return undefined;
  if (field === 'sessions') {
    if (value.length > MAX_AUDIT_SESSIONS) return undefined;
    const sessions: { id: number; role: string }[] = [];
    for (const item of value) {
      if (
        !item ||
        typeof item !== 'object' ||
        !Number.isSafeInteger(item.id) ||
        item.id < 1 ||
        typeof item.role !== 'string' ||
        item.role.length > 32
      )
        return undefined;
      sessions.push({ id: item.id, role: item.role });
    }
    return sessions;
  }
  if (value.length > MAX_AUDIT_EVENTS) return undefined;
  const events: EntityAuditEvent[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.at !== 'number' ||
      !Number.isFinite(item.at) ||
      typeof item.type !== 'string' ||
      item.type.length > 32 ||
      typeof item.summary !== 'string' ||
      item.summary.length > 160
    )
      return undefined;
    events.push({ at: item.at, type: item.type, summary: item.summary });
  }
  return events;
}

export type EntityCapability =
  'identity' | 'transform' | 'vitality' | 'caster' | 'movement' | 'projectile' | 'modifiers';

export type EntityWithCapability<C extends EntityCapability> = C extends 'projectile'
  ? Projectile
  : C extends 'vitality' | 'caster' | 'modifiers'
    ? Actor
    : Entity;

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
  attackInterval?: number;
  castSlow?: number;
}

/** 存续控制的状态。序号由 World 分配，替换时重新编号。 */
export interface ControlRecord {
  readonly targetId: number;
  readonly propertyKey: ControlPropertyKey;
  readonly effect: ControlPropertyEffect;
  readonly mode: ControlPropertyBinding['mode'];
  readonly writePolicy: ControlPropertyBinding['writePolicy'];
  readonly expiresAt: number | null;
  readonly controllerId: number;
  readonly controllerSessionId: number | null;
  readonly sequence: number;
  readonly paidPeriods: number;
  readonly nextPaymentAt: number | null;
}

export interface ControlSession {
  readonly id: number;
  readonly controllerId: number;
  readonly active: boolean;
  /** 返回 false 时本次效果不得发布；扣费方负责双资源的原子结算。 */
  charge(record: ControlRecord, phase: 'start' | 'period'): boolean;
  canControl(target: Entity, propertyKey: ControlPropertyKey): boolean;
  end(): void;
}

export interface ControlRequest {
  controllerId?: number;
  session?: ControlSession;
  canControl?: ControlSession['canControl'];
}

const MAX_CONTROL_RECORDS = 64;
const CONTROL_PERIOD = 0.25;
const EVENT_QUEUE_LIMIT = 1024;
const EVENT_ATTEMPT_LIMIT = 256;

export type WorldEventType = 'damage' | 'collision' | 'mana-exhausted' | 'disappear';
export interface WorldEvent {
  readonly eventId: number;
  readonly worldSequence: number;
  readonly simTime: number;
  readonly rootEventId: number;
  readonly parentEventId: number | null;
  readonly depth: number;
  readonly type: WorldEventType;
  readonly sourceId: number | null;
  readonly targetId: number | null;
  /** 提交时冻结的只读摘要；不得把实体对象或账户交给响应。 */
  readonly summary: Readonly<{ amount?: number; x?: number; y?: number }>;
}

interface EventSubscription {
  readonly sequence: number;
  readonly bindingId: string;
  readonly ownerId: number;
  readonly type: WorldEventType;
  readonly sourceId: number | null;
  readonly targetId: number | null;
  readonly sessionId: number | null;
  readonly respond: (event: WorldEvent) => void;
}

interface QueuedWorldEvent {
  readonly event: WorldEvent;
  readonly candidates: Array<{ sequence: number; projection: WorldEvent }>;
  readonly terminalEntity?: Entity;
}

interface EventRoot {
  attempts: number;
  pending: number;
  retained: number;
  seen: Set<string>;
}

export class World {
  actors: Actor[] = [];
  projectiles: Projectile[] = [];
  events: string[] = [];
  /** 表现层事件队列，视图每帧消费 */
  fx: FxEvent[] = [];
  bounds = { w: 1600, h: 1200 };
  /** 提交后的兼容通知；仅用于打断旧实例，不能在此同步派发响应。 */
  onDamage: ((target: Actor, amount: number) => void) | null = null;
  private eventSequence = 1;
  private subscriptionSequence = 1;
  private subscriptions = new Map<number, EventSubscription>();
  private eventQueue: QueuedWorldEvent[] = [];
  private eventRoots = new Map<number, EventRoot>();
  private currentEvent: WorldEvent | null = null;
  private dispatchingEvents = false;
  private cycleAttempts = new Map<number, number>();
  private exhaustedAccounts = new Map<number, boolean>();
  private subscriptionShenshi = new Map<number, number>();
  private activeMonitors = new Map<number, ActiveMonitor>();
  private nextMonitorId = 1;
  private chargingMonitorId: number | null = null;
  private scanningMonitorId: number | null = null;
  private actorContacts = new Set<string>();
  readonly eventDrops = { queue: 0, depth: 0, root: 0, cycle: 0, capacity: 0 };
  /** 核心权威资源账；Battle 和界面只能读取其授权投影。 */
  readonly resourceLedger = new ResourceLedger(
    (id) => this.byId(id),
    () => this.controlTime,
    (entityId, payerId) => {
      const entity = this.entityById(entityId);
      return (
        !!entity &&
        this.entityAvailable(entity) &&
        (entity.kind === 'projectile' ? entity.ownerId === payerId : entity.id === payerId)
      );
    },
    (payerId) => this.observeManaThreshold(payerId),
  );

  /** 登记占用 1 神识；稳定 bindingId 是因果去重身份，重登不能绕过它。 */
  subscribeEvent(
    ownerId: number,
    bindingId: string,
    type: WorldEventType,
    respond: (event: WorldEvent) => void,
    options: { sourceId?: number; targetId?: number; session?: ControlSession } = {},
  ): number | null {
    const owner = this.byId(ownerId);
    if (
      !owner?.alive ||
      !bindingId ||
      bindingId.length > 128 ||
      !['damage', 'collision', 'mana-exhausted', 'disappear'].includes(type) ||
      this.subscriptions.size >= 256 ||
      [...this.subscriptions.values()].filter((item) => item.ownerId === ownerId).length >= 32 ||
      (options.session && (!options.session.active || options.session.controllerId !== ownerId)) ||
      !this.tryReserveSubscriptionShenshi(ownerId)
    )
      return null;
    const sequence = this.subscriptionSequence++;
    this.subscriptions.set(sequence, {
      sequence,
      bindingId,
      ownerId,
      type,
      sourceId: options.sourceId ?? null,
      targetId: options.targetId ?? null,
      sessionId: options.session?.id ?? null,
      respond,
    });
    return sequence;
  }

  unsubscribeEvent(sequence: number): void {
    const subscription = this.subscriptions.get(sequence);
    if (!subscription) return;
    this.subscriptions.delete(sequence);
    const used = (this.subscriptionShenshi.get(subscription.ownerId) ?? 0) - 1;
    if (used <= 0) this.subscriptionShenshi.delete(subscription.ownerId);
    else this.subscriptionShenshi.set(subscription.ownerId, used);
  }

  private tryReserveSubscriptionShenshi(id: number): boolean {
    const actor = this.byId(id);
    if (!actor?.alive) return false;
    const used = this.subscriptionShenshi.get(id) ?? 0;
    if (
      used +
        (this.auditShenshiUsage.get(id) ?? 0) +
        (this.auditVmShenshiTotal.get(id) ?? 0) +
        this.controlRecordShenshiUsed(id) >=
      actor.attr.shenshiMax
    )
      return false;
    this.subscriptionShenshi.set(id, used + 1);
    return true;
  }

  /** 建立时不读取目标；每个周期在授权和余额检查后付款，才产生快照。 */
  startActiveMonitor(request: ActiveMonitorRequest): number | null {
    const owner = this.byId(request.ownerId);
    const target = this.entityById(request.targetId);
    if (
      !owner?.alive ||
      owner.mana < 1 ||
      request.payerId !== request.ownerId ||
      !Number.isSafeInteger(request.targetId) ||
      (target ? !this.entityAvailable(target) : !this.auditComposites.has(request.targetId)) ||
      !Number.isSafeInteger(request.periods) ||
      request.periods < 1 ||
      request.periods > 256 ||
      !Number.isSafeInteger(request.intervalSeconds / CONTROL_PERIOD) ||
      request.intervalSeconds < CONTROL_PERIOD ||
      request.intervalSeconds > 60 ||
      this.activeMonitors.size >= 256 ||
      [...this.activeMonitors.values()].filter((monitor) => monitor.ownerId === owner.id).length >=
        32 ||
      !Number.isFinite(this.controlTime + request.intervalSeconds) ||
      !this.senseQuote(owner, request.targetId, request.field) ||
      !this.tryReserveSubscriptionShenshi(owner.id)
    )
      return null;
    const id = this.nextMonitorId++;
    this.activeMonitors.set(id, {
      ...request,
      id,
      nextScanAt: this.controlTime + request.intervalSeconds,
      finishedAt: null,
      remainingPeriods: request.periods,
      paidMana: 0,
      paidTicks: 0,
      latest: null,
    });
    return id;
  }

  stopActiveMonitor(id: number, ownerId: number): boolean {
    const monitor = this.activeMonitors.get(id);
    if (!monitor || monitor.ownerId !== ownerId) return false;
    this.activeMonitors.delete(id);
    const used = (this.subscriptionShenshi.get(ownerId) ?? 0) - 1;
    if (used <= 0) this.subscriptionShenshi.delete(ownerId);
    else this.subscriptionShenshi.set(ownerId, used);
    return true;
  }

  activeMonitorSnapshot(id: number, ownerId: number): ActiveMonitorSnapshot | null {
    this.pruneActiveMonitors();
    const monitor = this.activeMonitors.get(id);
    if (!monitor || monitor.ownerId !== ownerId) return null;
    return { ...monitor, latest: monitor.latest && structuredClone(monitor.latest) };
  }

  private pruneActiveMonitors(): void {
    for (const monitor of this.activeMonitors.values()) {
      if (monitor.id === this.scanningMonitorId) continue;
      const owner = this.byId(monitor.ownerId);
      const target = this.entityById(monitor.targetId);
      if (
        !owner?.alive ||
        (owner.mana < 1 && monitor.finishedAt === null && monitor.id !== this.chargingMonitorId) ||
        (target ? !this.entityAvailable(target) : !this.auditComposites.has(monitor.targetId)) ||
        !this.senseQuote(owner, monitor.targetId, monitor.field)
      )
        this.stopActiveMonitor(monitor.id, monitor.ownerId);
    }
  }

  private scanActiveMonitor(monitor: ActiveMonitor): void {
    this.scanningMonitorId = monitor.id;
    try {
      const owner = this.byId(monitor.ownerId);
      const target = this.entityById(monitor.targetId);
      const quote =
        owner?.alive &&
        (target ? this.entityAvailable(target) : this.auditComposites.has(monitor.targetId)) &&
        this.senseQuote(owner, monitor.targetId, monitor.field);
      if (!quote) {
        this.stopActiveMonitor(monitor.id, monitor.ownerId);
        return;
      }
      let price;
      try {
        price = sensePrice(quote);
      } catch {
        this.stopActiveMonitor(monitor.id, monitor.ownerId);
        return;
      }
      if (monitor.paidTicks + price.ticks.value > 600) {
        this.stopActiveMonitor(monitor.id, monitor.ownerId);
        return;
      }
      let paid: number | null;
      this.chargingMonitorId = monitor.id;
      try {
        paid = this.resourceLedger.payMana(monitor.payerId, price.mana.value, 'monitor');
      } catch {
        this.stopActiveMonitor(monitor.id, monitor.ownerId);
        return;
      } finally {
        this.chargingMonitorId = null;
      }
      if (paid === null) {
        this.stopActiveMonitor(monitor.id, monitor.ownerId);
        return;
      }
      const charged = {
        ...monitor,
        paidMana: monitor.paidMana + paid,
        paidTicks: monitor.paidTicks + price.ticks.value,
      };
      this.activeMonitors.set(monitor.id, charged);
      const result = this.readEntityAuditField(monitor.targetId, monitor.field);
      const currentTarget = this.entityById(monitor.targetId);
      if (
        !result.ok ||
        (currentTarget
          ? !this.entityAvailable(currentTarget)
          : !this.auditComposites.has(monitor.targetId)) ||
        !this.senseQuote(owner!, monitor.targetId, monitor.field)
      ) {
        this.stopActiveMonitor(monitor.id, monitor.ownerId);
        return;
      }
      this.activeMonitors.set(monitor.id, {
        ...charged,
        remainingPeriods: monitor.remainingPeriods - 1,
        nextScanAt:
          monitor.remainingPeriods === 1 || owner!.mana < 1
            ? null
            : monitor.nextScanAt! + monitor.intervalSeconds,
        finishedAt:
          monitor.remainingPeriods === 1 || owner!.mana < 1
            ? this.controlTime + monitor.intervalSeconds
            : null,
        latest: result,
      });
    } finally {
      this.scanningMonitorId = null;
    }
  }

  /** 只可由权威碰撞事务调用；零伤害接触也有独立摘要。 */
  private recordCollision(sourceId: number, targetId: number, x: number, y: number): void {
    this.queueWorldEvent('collision', sourceId, targetId, { x, y });
  }

  /** 一帧接触集合只在开始接触时生成碰撞，持续接触不重复发布。 */
  commitActorContacts(
    contacts: ReadonlyArray<{ sourceId: number; targetId: number; x: number; y: number }>,
  ): void {
    const next = new Set<string>();
    for (const contact of contacts) {
      const key = `${contact.sourceId}:${contact.targetId}`;
      next.add(key);
      if (!this.actorContacts.has(key))
        this.recordCollision(contact.sourceId, contact.targetId, contact.x, contact.y);
    }
    this.actorContacts = next;
  }

  /** 外层响应跨帧继续时保留因果根与去重状态。 */
  retainEventRoot(rootEventId: number): void {
    const root = this.eventRoots.get(rootEventId);
    if (root) root.retained++;
  }

  releaseEventRoot(rootEventId: number): void {
    const root = this.eventRoots.get(rootEventId);
    if (!root) return;
    root.retained = Math.max(0, root.retained - 1);
    this.releaseIdleRoot(rootEventId);
  }

  withEventCause<T>(event: WorldEvent, action: () => T): T {
    const previous = this.currentEvent;
    this.currentEvent = event;
    try {
      return action();
    } finally {
      this.currentEvent = previous;
    }
  }

  private queueWorldEvent(
    type: WorldEventType,
    sourceId: number | null,
    targetId: number | null,
    summary: WorldEvent['summary'],
    terminalEntity?: Entity,
  ): void {
    if (this.eventQueue.length >= EVENT_QUEUE_LIMIT) {
      this.eventDrops.queue++;
      return;
    }
    const eventId = this.eventSequence++;
    const parent = this.currentEvent;
    const rootEventId = parent?.rootEventId ?? eventId;
    let root = this.eventRoots.get(rootEventId);
    if (!root) {
      if (this.eventRoots.size >= EVENT_QUEUE_LIMIT) {
        this.eventDrops.queue++;
        return;
      }
      root = { attempts: 0, pending: 0, retained: 0, seen: new Set() };
      this.eventRoots.set(rootEventId, root);
    }
    const event: WorldEvent = Object.freeze({
      eventId,
      worldSequence: eventId,
      simTime: this.controlTime,
      rootEventId,
      parentEventId: parent?.eventId ?? null,
      depth: (parent?.depth ?? -1) + 1,
      type,
      sourceId,
      targetId,
      summary: Object.freeze({ ...summary }),
    });
    const candidates = [...this.subscriptions.values()]
      .filter((item) => item.type === type)
      .flatMap((item) => {
        const projection = this.projectWorldEvent(item.ownerId, event, terminalEntity);
        return projection && this.eventMatches(item, projection)
          ? [{ sequence: item.sequence, projection }]
          : [];
      });
    root.pending++;
    this.eventQueue.push({ event, candidates, terminalEntity });
  }

  dispatchWorldEvents(): void {
    if (this.dispatchingEvents) return;
    this.dispatchingEvents = true;
    try {
      while (this.eventQueue.length > 0) {
        const queued = this.eventQueue.shift()!;
        const { event } = queued;
        const root = this.eventRoots.get(event.rootEventId)!;
        for (const { sequence, projection } of queued.candidates) {
          const sub = this.subscriptions.get(sequence);
          if (
            !sub ||
            !this.byId(sub.ownerId)?.alive ||
            (sub.sessionId !== null && !this.controlSessions.get(sub.sessionId)?.active)
          )
            continue;
          // 重投影只能删减发生时获准的字段，后授予的权限不补发历史信息。
          const delivered = this.projectWorldEvent(sub.ownerId, projection, queued.terminalEntity);
          if (!delivered || !this.eventMatches(sub, delivered)) continue;
          if (event.depth > 8) {
            this.eventDrops.depth++;
            continue;
          }
          const key = `${sub.ownerId}:${sub.bindingId}:${event.type}:${event.sourceId}:${event.targetId}`;
          if (root.seen.has(key)) continue;
          const cycle = Math.floor(event.simTime / CONTROL_PERIOD);
          const cycleUsed = this.cycleAttempts.get(cycle) ?? 0;
          if (root.attempts >= EVENT_ATTEMPT_LIMIT) {
            this.eventDrops.root++;
            continue;
          }
          if (cycleUsed >= EVENT_ATTEMPT_LIMIT) {
            this.eventDrops.cycle++;
            continue;
          }
          root.seen.add(key);
          root.attempts++;
          this.cycleAttempts.set(cycle, cycleUsed + 1);
          try {
            this.withEventCause(event, () => sub.respond(delivered));
          } catch {
            this.eventDrops.capacity++;
          }
        }
        root.pending--;
        this.releaseIdleRoot(event.rootEventId);
      }
    } finally {
      this.dispatchingEvents = false;
      const currentCycle = Math.floor(this.controlTime / CONTROL_PERIOD);
      for (const cycle of this.cycleAttempts.keys())
        if (cycle < currentCycle - 1) this.cycleAttempts.delete(cycle);
    }
  }

  private releaseIdleRoot(id: number): void {
    const root = this.eventRoots.get(id);
    if (root && root.pending === 0 && root.retained === 0) this.eventRoots.delete(id);
  }

  private eventMatches(subscription: EventSubscription, event: WorldEvent): boolean {
    return (
      (subscription.sourceId === null || subscription.sourceId === event.sourceId) &&
      (subscription.targetId === null || subscription.targetId === event.targetId)
    );
  }

  private projectWorldEvent(
    ownerId: number,
    event: WorldEvent,
    terminalEntity?: Entity,
  ): WorldEvent | null {
    const reader = this.byId(ownerId);
    if (!reader?.alive) return null;
    if (event.type === 'mana-exhausted') return event.targetId === ownerId ? event : null;
    const canRead = (id: number | null, field: EntityAuditField): boolean =>
      id !== null &&
      (id === ownerId || !!this.senseQuoteForEvent(reader, id, field, terminalEntity));
    const sourceVisible = canRead(event.sourceId, 'events');
    const targetVisible = canRead(event.targetId, 'events');
    const selfEvent =
      event.targetId === ownerId || (event.type === 'collision' && event.sourceId === ownerId);
    if (!selfEvent && !targetVisible) return null;
    const summary: { amount?: number; x?: number; y?: number } = {};
    if (targetVisible && canRead(event.targetId, 'hp') && event.summary.amount !== undefined)
      summary.amount = event.summary.amount;
    // 碰撞坐标属于接触源；受击/消失坐标属于目标。自身接触的必要摘要保留。
    const positionId = event.type === 'collision' ? event.sourceId : event.targetId;
    if (
      positionId === ownerId ||
      (canRead(positionId, 'events') && canRead(positionId, 'position'))
    ) {
      if (event.summary.x !== undefined) summary.x = event.summary.x;
      if (event.summary.y !== undefined) summary.y = event.summary.y;
    }
    return Object.freeze({
      ...event,
      sourceId: sourceVisible ? event.sourceId : null,
      targetId: targetVisible ? event.targetId : null,
      summary: Object.freeze(summary),
    });
  }

  /** 观察已提交的可用余额边沿，失败付款及初始不足不发事件。 */
  observeManaThreshold(id: number): void {
    const actor = this.byId(id);
    if (!actor?.alive) return;
    const exhausted = actor.mana < 1;
    const previous = this.exhaustedAccounts.get(id);
    this.exhaustedAccounts.set(id, exhausted);
    if (exhausted)
      for (const monitor of this.activeMonitors.values())
        if (monitor.ownerId === id && monitor.id !== this.chargingMonitorId)
          this.stopActiveMonitor(monitor.id, id);
    if (previous === false && exhausted) this.queueWorldEvent('mana-exhausted', id, id, {});
  }

  /** Actor 与 Projectile 共用同一 ID 空间，句柄在一次 World 生命周期内不复用。 */
  private nextEntityId = 1;
  private nextModifierId = 1;
  /** binding 是存储适配器，不进入可序列化实体状态。 */
  private propertyBindings = new WeakMap<Entity, ControlPropertyBindings>();
  private controlRecords: ControlRecord[] = [];
  private controlSessions = new Map<number, ControlSession>();
  private controlPermissions = new Map<number, ControlSession['canControl']>();
  private controlBase = new WeakMap<
    Entity,
    Partial<Record<ControlPropertyKey, ControlPropertyEffect>>
  >();
  private controlTime = 0;
  private nextControlSequence = 1;
  private nextControlSessionId = 1;
  private auditBindings = new WeakMap<Entity, EntityAuditBindings>();
  private auditEvents = new WeakMap<object, EntityAuditEvent[]>();
  private auditComposites = new Map<number, { bindings: EntityAuditBindings; token: object }>();
  private auditShenshiUsage = new Map<number, number>();
  private auditVmShenshiUsage = new WeakMap<object, { id: number; used: number }>();
  private auditVmShenshiTotal = new Map<number, number>();
  private senseGrants = new Map<string, SenseGrant>();
  private senseHidden = new Set<number>();
  private senseOccluded = new Set<number>();

  reset(): void {
    this.activeMonitors.clear();
    this.subscriptions.clear();
    this.eventQueue = [];
    this.eventRoots.clear();
    this.currentEvent = null;
    this.dispatchingEvents = false;
    this.cycleAttempts.clear();
    this.exhaustedAccounts.clear();
    this.subscriptionShenshi.clear();
    this.actorContacts.clear();
    for (const key of Object.keys(this.eventDrops) as Array<keyof typeof this.eventDrops>)
      this.eventDrops[key] = 0;
    this.resourceLedger.reset();
    this.actors = [];
    this.projectiles = [];
    this.events = [];
    this.fx = [];
    this.propertyBindings = new WeakMap();
    for (const session of this.controlSessions.values()) session.end();
    this.controlSessions.clear();
    this.controlPermissions.clear();
    this.controlRecords = [];
    this.controlBase = new WeakMap();
    this.controlTime = 0;
    this.auditBindings = new WeakMap();
    this.auditEvents = new WeakMap();
    this.auditComposites.clear();
    this.auditShenshiUsage.clear();
    this.auditVmShenshiUsage = new WeakMap();
    this.auditVmShenshiTotal.clear();
    this.senseGrants.clear();
    this.senseHidden.clear();
    this.senseOccluded.clear();
    // 保留计数器，避免重置前持有的句柄误指向新场景对象。
    this.nextModifierId = 1;
  }

  /** 每帧推进：法力回复、增益计时、属性重算 */
  tickActor(a: Actor, dt: number): void {
    if (!a.alive) return;
    if (!Number.isFinite(dt) || dt < 0) throw new RangeError('非法世界时间');
    this.resourceLedger.observeMana(a.id);
    a.mana = Math.min(a.attr.manaMax, a.mana + a.attr.manaRegen * dt);
    this.resourceLedger.recordManaWorldChange(a.id, 'regen');
    this.observeManaThreshold(a.id);
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
      velocity: { x: 0, y: 0 },
      motionSource: 'none',
      teleportAllowed: true,
      movePower: base.speed > 0 ? 4 : 0,
      baseSpeed: base.speed,
      drive: { x: 0, y: 0 },
      driveRemaining: 0,
      drivePaid: false,
      aim: { x: 1, y: 0 },
      baseAim: { x: 1, y: 0 },
      hp: base.hpMax,
      mana: base.manaMax,
      base,
      mods: [],
      attr: { ...base },
      radius: init.radius ?? 12,
      alive: true,
      bindings: init.bindings ?? {},
      behavior: init.behavior ?? null,
      attackRange: init.attackRange ?? 240,
      attackInterval: init.attackInterval ?? 1.6,
      attackTimer: 0,
      strafe: 0,
      strafeTimer: 0,
      castSlow: init.castSlow ?? 0.45,
      stun: 0,
      hitFlash: 0,
      deathTimer: 0,
    };
    this.propertyBindings.set(a, this.actorPropertyBindings(a));
    this.auditBindings.set(a, this.actorAuditBindings(a));
    this.actors.push(a);
    this.resourceLedger.observeMana(a.id);
    this.observeManaThreshold(a.id);
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

  /** 注能只向仍存在的实体发布来源；付款、容量与凭证创建由账本一笔完成。 */
  injectEntityEnergy(
    entityId: number,
    payerId: number,
    pool: EnergyPool,
    mana: number,
    sessionId: number | null = null,
    effectId: number | null = null,
  ): number | null {
    if (!this.entityById(entityId)) return null;
    return this.resourceLedger.inject(entityId, payerId, pool, mana, sessionId, effectId);
  }

  /** 销毁、死亡与取消重放均返回原结算额，不产生第二次退款。 */
  refundEntityEnergy(entityId: number): number {
    return this.resourceLedger.terminate(entityId);
  }

  /** 实体权威移除先结算，再公布只读消失事实；重复移除无事件。 */
  removeProjectile(projectileId: number): boolean {
    const projectile = this.projectiles.find((item) => item.id === projectileId);
    if (!projectile) return false;
    this.refundEntityEnergy(projectileId);
    this.projectiles = this.projectiles.filter((item) => item !== projectile);
    this.pruneActiveMonitors();
    this.queueWorldEvent(
      'disappear',
      projectileId,
      projectileId,
      {
        x: projectile.x,
        y: projectile.y,
      },
      projectile,
    );
    return true;
  }

  /** 有限计划由所有者配置；后续每周期只消耗法球自己的余额。 */
  configureProjectileBehavior(
    ownerId: number,
    projectileId: number,
    behavior: Projectile['behavior'],
    thrust: Vec2 = { x: 0, y: 0 },
    trackTargetId: number | null = null,
  ): boolean {
    const projectile = this.ownedProjectile(ownerId, projectileId);
    if (
      !this.byId(ownerId)?.alive ||
      !projectile ||
      !projectile.active ||
      !['glide', 'thrust', 'track'].includes(behavior)
    )
      return false;
    if (![thrust.x, thrust.y].every(Number.isFinite) || Math.hypot(thrust.x, thrust.y) > 380)
      return false;
    if (behavior === 'track' && (!Number.isSafeInteger(trackTargetId) || trackTargetId === null))
      return false;
    projectile.behavior = behavior;
    projectile.thrust = { ...thrust };
    projectile.trackTargetId = behavior === 'track' ? trackTargetId : null;
    projectile.driveRemaining = 0;
    return true;
  }

  /** 在周期边沿付款后发布主动冲量；停供时速度只按阻力衰减。 */
  advanceProjectileMotion(projectile: Projectile, dt: number): void {
    if (!Number.isFinite(dt) || dt < 0) throw new RangeError('非法弹道时间');
    if (!projectile.active || this.entityById(projectile.id) !== projectile) return;
    let remaining = dt;
    while (remaining > 1e-9) {
      if (projectile.driveRemaining <= 1e-9) {
        this.driveProjectilePeriod(projectile);
        projectile.driveRemaining = CONTROL_PERIOD;
      }
      const step = Math.min(remaining, projectile.driveRemaining);
      const drag = 0.5;
      const factor = (1 - Math.exp(-drag * step)) / drag;
      projectile.x += projectile.velocity.x * factor;
      projectile.y += projectile.velocity.y * factor;
      projectile.velocity.x *= Math.exp(-drag * step);
      projectile.velocity.y *= Math.exp(-drag * step);
      projectile.driveRemaining = Math.max(0, projectile.driveRemaining - step);
      remaining -= step;
    }
  }

  private driveProjectilePeriod(projectile: Projectile): void {
    if (projectile.behavior === 'glide') return;
    // 当前没有独立死亡后行为授权入口；预付能量本身不授予继续做功的权限。
    if (!this.byId(projectile.ownerId)?.alive) {
      this.revokeProjectileBehavior(projectile);
      return;
    }
    let delta = projectile.thrust;
    if (projectile.behavior === 'track') {
      const targetId = projectile.trackTargetId;
      const owner = this.byId(projectile.ownerId);
      if (
        targetId === null ||
        !owner ||
        !owner.alive ||
        !this.senseQuote(owner, targetId, 'position')
      )
        return;
      if (!this.resourceLedger.consume(projectile.id, 'scan', 1, 'scan')) return;
      const target = this.entityWithCapability(targetId, 'vitality');
      if (!target || !target.alive || target.faction === projectile.faction) return;
      const dx = target.x - projectile.x;
      const dy = target.y - projectile.y;
      const length = Math.hypot(dx, dy);
      if (!Number.isFinite(length) || length < 1e-9) return;
      const push = Math.hypot(projectile.thrust.x, projectile.thrust.y);
      delta = { x: (dx / length) * push, y: (dy / length) * push };
    }
    const next = {
      x: projectile.velocity.x + delta.x,
      y: projectile.velocity.y + delta.y,
    };
    const speed = Math.hypot(next.x, next.y);
    if (!Number.isFinite(speed) || speed > projectile.speed + 1e-9) return;
    const before = Math.hypot(projectile.velocity.x, projectile.velocity.y);
    const work = Math.max(0, (speed * speed - before * before) / (380 * 380));
    const loss = (delta.x * delta.x + delta.y * delta.y) / (380 * 380);
    const cost =
      (Math.ceil(work * RESOURCE_SCALE) + Math.ceil(loss * RESOURCE_SCALE)) / RESOURCE_SCALE;
    if (!Number.isFinite(cost) || cost <= 0) return;
    const reservation = this.resourceLedger.reserve(projectile.id, 'motion', cost);
    if (reservation === null) return;
    if (!this.resourceLedger.settle(reservation, { motionWork: work, controlLoss: loss })) return;
    projectile.velocity = next;
    projectile.motionSource = 'projectile';
  }

  private revokeProjectileBehavior(projectile: Projectile): void {
    projectile.behavior = 'glide';
    projectile.thrust = { x: 0, y: 0 };
    projectile.trackTargetId = null;
  }

  /** 请求值不是能源；每次穿透命中都从可用 damage 池独立结算。 */
  hitProjectile(projectile: Projectile, targetId: number): boolean {
    const target = this.entityWithCapability(targetId, 'vitality');
    if (
      this.entityById(projectile.id) !== projectile ||
      !projectile.active ||
      !Number.isFinite(projectile.damage) ||
      projectile.damage < 0 ||
      !target ||
      !target.alive ||
      target.faction === projectile.faction ||
      projectile.hit.has(targetId)
    )
      return false;
    projectile.hit.add(targetId);
    this.recordCollision(projectile.id, targetId, projectile.x, projectile.y);
    const available = this.resourceLedger.balance(projectile.id);
    const released = Math.min(projectile.damage, available.damage - available.reserved.damage);
    if (!Number.isFinite(released) || released <= 0) return false;
    const reservation = this.resourceLedger.reserve(projectile.id, 'damage', released);
    if (reservation === null || !this.resourceLedger.settle(reservation, { damage: released }))
      return false;
    this.damage(targetId, released, true, projectile.id);
    return true;
  }

  hasCapability<C extends EntityCapability>(
    entity: Entity,
    capability: C,
  ): entity is EntityWithCapability<C> {
    if (capability === 'identity' || capability === 'transform' || capability === 'movement')
      return true;
    if (entity.kind === 'projectile') return capability === 'projectile';
    return capability === 'vitality' || capability === 'caster' || capability === 'modifiers';
  }

  /** 统一句柄解析与能力判定的单一入口。 */
  entityWithCapability<C extends EntityCapability>(
    id: number,
    capability: C,
  ): EntityWithCapability<C> | null {
    const entity = this.entityById(id);
    return entity && this.hasCapability(entity, capability) ? entity : null;
  }

  positionOf(id: number): Vec2 | null {
    const entity = this.entityById(id);
    return entity ? { x: entity.x, y: entity.y } : null;
  }

  /** 组合能力实体与 Actor/Projectile 共用句柄空间，仅安装其明确声明的审计能力。 */
  registerAuditComposite(bindings: EntityAuditBindings): number | null {
    if (this.auditComposites.size >= MAX_AUDIT_COMPOSITES) return null;
    const id = this.nextEntityId++;
    this.auditComposites.set(id, { bindings: { ...bindings }, token: {} });
    return id;
  }

  removeAuditComposite(id: number): void {
    this.auditComposites.delete(id);
    this.pruneActiveMonitors();
  }

  /** 缺句柄、缺能力或失效 binding 统一明确拒绝，不返回伪造的零值。 */
  readEntityAuditField(id: number, field: EntityAuditField): EntityAuditResult {
    const entity = this.entityById(id);
    const composite = entity ? null : this.auditComposites.get(id);
    const binding = entity ? this.auditBindings.get(entity)?.[field] : composite?.bindings[field];
    try {
      if (!binding?.isAvailable()) return { ok: false, reason: 'unavailable' };
      const value = boundedAuditValue(field, binding.read());
      if (value === undefined) return { ok: false, reason: 'unavailable' };
      return { ok: true, value, observedAt: this.controlTime, targetId: id, field };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  setSenseVisibility(id: number, visible: boolean, occluded = false): void {
    if (visible) this.senseHidden.delete(id);
    else this.senseHidden.add(id);
    if (occluded) this.senseOccluded.add(id);
    else this.senseOccluded.delete(id);
    this.pruneActiveMonitors();
  }

  grantSenseField(
    readerId: number,
    targetId: number,
    field: EntityAuditField,
    grant: SenseGrant,
  ): void {
    if (
      !Number.isFinite(grant.shenshiUpperBound) ||
      grant.shenshiUpperBound < 0 ||
      !Number.isFinite(grant.resistanceUpperBound) ||
      grant.resistanceUpperBound < 0
    )
      throw new RangeError('非法探查公开上界');
    if (grant.relation !== undefined && ![1, 2, 8].includes(grant.relation))
      throw new RangeError('非法探查公开关系');
    const target = this.entityById(targetId);
    const binding = target
      ? this.auditBindings.get(target)?.[field]
      : this.auditComposites.get(targetId)?.bindings[field];
    const resistance = binding?.senseResistance?.() ?? 0;
    if (!Number.isFinite(resistance) || resistance < 0 || resistance > grant.resistanceUpperBound)
      throw new RangeError('探查抗性公开上界不足');
    if (target?.kind === 'actor' && target.attr.shenshiMax > grant.shenshiUpperBound)
      throw new RangeError('探查公开上界不足');
    this.senseGrants.set(`${readerId}:${targetId}:${field}`, { ...grant });
  }

  revokeSenseField(readerId: number, targetId: number, field: EntityAuditField): void {
    this.senseGrants.delete(`${readerId}:${targetId}:${field}`);
    this.pruneActiveMonitors();
  }

  /** 只返回已授权的公开定价输入；值始终在实扣之后由审计 binding 读取。 */
  senseQuote(reader: Actor, targetId: number, field: EntityAuditField): SenseQuote | null {
    return this.senseQuoteForEvent(reader, targetId, field);
  }

  /** 终止事件仅借用刚移除实体的能力和位置校验权限，不读取新的载荷值。 */
  private senseQuoteForEvent(
    reader: Actor,
    targetId: number,
    field: EntityAuditField,
    terminalEntity?: Entity,
  ): SenseQuote | null {
    const terminal = terminalEntity?.id === targetId ? terminalEntity : undefined;
    const target = this.entityById(targetId) ?? terminal;
    const composite = target ? null : this.auditComposites.get(targetId);
    const binding = target ? this.auditBindings.get(target)?.[field] : composite?.bindings[field];
    try {
      if (!binding || (!terminal && !binding.isAvailable())) return null;
    } catch {
      return null;
    }
    const self = targetId === reader.id;
    const privateField =
      field === 'mana' ||
      field === 'shenshiUsed' ||
      field === 'resistances' ||
      field === 'sessions' ||
      field === 'events' ||
      field === 'ownership' ||
      field === 'motionSource' ||
      field === 'movePower';
    const grant = this.senseGrants.get(`${reader.id}:${targetId}:${field}`);
    if (!self && !grant && field !== 'position' && field !== 'facing') return null;
    if (!self && privateField && !grant) return null;
    const perception = reader.attr.perception;
    if (!Number.isFinite(perception) || perception <= 0) return null;
    const radius = 240 * perception;
    if (!Number.isFinite(radius)) return null;
    let distance = 0;
    if (!self) {
      if (this.senseHidden.has(targetId) || this.senseOccluded.has(targetId)) return null;
      const position = target
        ? { x: target.x, y: target.y }
        : this.readEntityAuditField(targetId, 'position');
      if (!position || ('ok' in position && !position.ok)) return null;
      const point = 'ok' in position ? (position.value as Vec2) : position;
      distance = Math.hypot(point.x - reader.x, point.y - reader.y);
      if (!Number.isFinite(distance) || distance > radius) return null;
    }
    const privateSelf = self && privateField;
    const readerShenshi = reader.attr.shenshiMax;
    if (!Number.isFinite(readerShenshi) || readerShenshi <= 0) return null;
    // 非自身字段的隐藏输入只取授权时固定的公开界，不按目标真值变档。
    const targetShenshi = self ? readerShenshi : (grant?.shenshiUpperBound ?? 0);
    const resistance = self ? 0 : (grant?.resistanceUpperBound ?? 0);
    if (target?.kind === 'actor' && !self && !grant) return null;
    const relation = target ? this.entityCostMultiplier(reader, target) : (grant?.relation ?? 8);
    const level: 0 | 1 | 2 = privateField ? 2 : field === 'position' || field === 'facing' ? 0 : 1;
    return {
      distance: self || field === 'position' || field === 'facing' ? distance : radius,
      relation,
      targetShenshi,
      readerShenshi,
      resistance,
      level,
      privateSelf,
    };
  }

  /** 单条历史和每实体历史均设硬上限；只存摘要，不保存任意载荷。 */
  recordEntityAuditEvent(id: number, type: string, summary: string): boolean {
    const owner = this.entityById(id) ?? this.auditComposites.get(id)?.token;
    if (
      !owner ||
      typeof type !== 'string' ||
      typeof summary !== 'string' ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(type)
    )
      return false;
    const history = this.auditEvents.get(owner) ?? [];
    history.push({ at: this.controlTime, type, summary: summary.slice(0, 160) });
    if (history.length > MAX_AUDIT_EVENTS) history.shift();
    this.auditEvents.set(owner, history);
    return true;
  }

  /** VM 或 Battle 的共享神识账户提交后同步当前占用。 */
  reportEntityShenshiUsage(id: number, used: number): boolean {
    if (!this.entityWithCapability(id, 'caster') || !Number.isSafeInteger(used) || used < 0)
      return false;
    if (used === 0) this.auditShenshiUsage.delete(id);
    else this.auditShenshiUsage.set(id, used);
    return true;
  }

  tryReserveEntityShenshi(id: number, amount: number): boolean {
    const actor = this.entityWithCapability(id, 'caster');
    if (!actor || !Number.isSafeInteger(amount) || amount < 0) return false;
    const used = this.auditShenshiUsage.get(id) ?? 0;
    const next = used + amount;
    if (
      !Number.isSafeInteger(next + (this.auditVmShenshiTotal.get(id) ?? 0)) ||
      next +
        (this.auditVmShenshiTotal.get(id) ?? 0) +
        (this.subscriptionShenshi.get(id) ?? 0) +
        this.controlRecordShenshiUsed(id) >
        actor.attr.shenshiMax
    )
      return false;
    return this.reportEntityShenshiUsage(id, next);
  }

  /** 无 Battle 共享账户时，多个并发 VM 的占用仍按施法实例求和。 */
  reportVmShenshiUsage(id: number, vm: object, used: number): boolean {
    if (!this.entityWithCapability(id, 'caster') || !Number.isSafeInteger(used) || used < 0)
      return false;
    const previous = this.auditVmShenshiUsage.get(vm);
    if (previous && previous.id !== id) return false;
    const total = (this.auditVmShenshiTotal.get(id) ?? 0) - (previous?.used ?? 0) + used;
    if (!Number.isSafeInteger(total) || total < 0) return false;
    if (used === 0) this.auditVmShenshiUsage.delete(vm);
    else this.auditVmShenshiUsage.set(vm, { id, used });
    if (total === 0) this.auditVmShenshiTotal.delete(id);
    else this.auditVmShenshiTotal.set(id, total);
    return true;
  }

  /** 无 Battle 钩子的 VM 也从同一施法者容量逐笔原子保留。 */
  tryReserveVmShenshi(id: number, vm: object, amount: number): boolean {
    const actor = this.entityWithCapability(id, 'caster');
    if (!actor || !Number.isSafeInteger(amount) || amount < 0) return false;
    const previous = this.auditVmShenshiUsage.get(vm);
    if (previous && previous.id !== id) return false;
    const used = this.auditVmShenshiTotal.get(id) ?? 0;
    const allUsed =
      used +
      (this.auditShenshiUsage.get(id) ?? 0) +
      (this.subscriptionShenshi.get(id) ?? 0) +
      this.controlRecordShenshiUsed(id);
    if (!Number.isSafeInteger(allUsed + amount) || allUsed + amount > actor.attr.shenshiMax)
      return false;
    return this.reportVmShenshiUsage(id, vm, (previous?.used ?? 0) + amount);
  }

  /** 会话 ID 与控制记录序号在同一个 World 生命周期内不复用。 */
  createControlSession(
    controllerId: number,
    charge: ControlSession['charge'],
    canControl: ControlSession['canControl'] = () => true,
  ): ControlSession | null {
    const controller = this.entityById(controllerId);
    if (!controller || !this.entityAvailable(controller)) return null;
    if (this.controlSessions.size >= MAX_CONTROL_SESSIONS) return null;
    const id = this.nextControlSessionId++;
    const sessions = this.controlSessions;
    const session: ControlSession = {
      id,
      controllerId,
      get active() {
        return sessions.get(id) === session;
      },
      charge,
      canControl,
      end: () => {
        if (!sessions.delete(id)) return;
        for (const [sequence, sub] of this.subscriptions)
          if (sub.sessionId === id) this.unsubscribeEvent(sequence);
        this.removeControlRecords((record) => record.controllerSessionId === id);
        this.recordEntityAuditEvent(controllerId, 'session-end', `session ${id}`);
      },
    };
    this.controlSessions.set(id, session);
    this.recordEntityAuditEvent(controllerId, 'session-start', `session ${id}`);
    return session;
  }

  /** 只返回副本，避免外部篡改效果、到期和付费状态。 */
  controlRecordSnapshot(): ControlRecord[] {
    return this.controlRecords.map((record) => ({
      ...record,
      effect: typeof record.effect === 'number' ? record.effect : { ...record.effect },
    }));
  }

  get controlTimeNow(): number {
    return this.controlTime;
  }

  /** Battle 只读取下一结算边界，周期规则仍由核心持有。 */
  nextControlBoundaryIn(maxDt: number): number {
    // 新租约可能在当前片段内建立；片段最长不超过一个结算周期。
    let next = Math.min(maxDt, CONTROL_PERIOD);
    for (const record of this.controlRecords) {
      if (record.expiresAt !== null)
        next = Math.min(next, Math.max(0, record.expiresAt - this.controlTime));
      if (record.nextPaymentAt !== null)
        next = Math.min(next, Math.max(0, record.nextPaymentAt - this.controlTime));
    }
    for (const monitor of this.activeMonitors.values())
      next = Math.min(
        next,
        Math.max(0, (monitor.nextScanAt ?? monitor.finishedAt!) - this.controlTime),
      );
    return next;
  }

  /** 在实体、binding 或权限外部变化后立即调用，幂等释放失效层。 */
  pruneControlRecords(): void {
    this.removeControlRecords((record) => !this.recordAvailable(record));
  }

  /** 模拟时钟；同一时刻先清理失效与到期，再按时间、序号结算维持。 */
  advanceControlTime(dt: number): void {
    if (this.scanningMonitorId !== null) throw new RangeError('监控扫描期间不能重入模拟时钟');
    if (!Number.isFinite(dt) || dt < 0) throw new RangeError('非法控制时间');
    const end = this.controlTime + dt;
    if (!Number.isFinite(end)) throw new RangeError('控制时间溢出');
    while (true) {
      let boundary = end;
      for (const record of this.controlRecords) {
        if (record.expiresAt !== null && record.expiresAt > this.controlTime)
          boundary = Math.min(boundary, record.expiresAt);
        if (record.nextPaymentAt !== null && record.nextPaymentAt > this.controlTime)
          boundary = Math.min(boundary, record.nextPaymentAt);
      }
      for (const monitor of this.activeMonitors.values())
        if ((monitor.nextScanAt ?? monitor.finishedAt!) > this.controlTime)
          boundary = Math.min(boundary, monitor.nextScanAt ?? monitor.finishedAt!);
      this.controlTime = boundary;
      for (const monitor of this.activeMonitors.values())
        if (monitor.finishedAt !== null && monitor.finishedAt <= boundary)
          this.stopActiveMonitor(monitor.id, monitor.ownerId);
      this.pruneActiveMonitors();
      this.removeControlRecords(
        (record) =>
          (record.expiresAt !== null && record.expiresAt <= boundary) ||
          !this.recordAvailable(record),
      );
      const due = this.controlRecords
        .filter((record) => record.nextPaymentAt !== null && record.nextPaymentAt <= boundary)
        .sort((a, b) => a.nextPaymentAt! - b.nextPaymentAt! || a.sequence - b.sequence);
      for (const record of due) {
        if (!this.controlRecords.includes(record)) continue;
        const session = this.controlSessions.get(record.controllerSessionId!);
        if (
          !session ||
          !this.recordAvailable(record) ||
          !this.chargeControl(session, record, 'period') ||
          !session.active ||
          !this.controlRecords.includes(record)
        ) {
          this.removeControlRecords((item) => item === record);
          continue;
        }
        this.controlRecords[this.controlRecords.indexOf(record)] = {
          ...record,
          paidPeriods: record.paidPeriods + 1,
          nextPaymentAt: record.nextPaymentAt! + CONTROL_PERIOD,
        };
      }
      for (const monitor of [...this.activeMonitors.values()]
        .filter((item) => item.nextScanAt !== null && item.nextScanAt <= boundary)
        .sort((a, b) => a.nextScanAt! - b.nextScanAt! || a.id - b.id))
        if (this.activeMonitors.has(monitor.id)) this.scanActiveMonitor(monitor);
      if (boundary >= end) break;
    }
  }

  /** 查询目标对稳定逻辑属性声明的能力；没有 binding 时明确返回 null。 */
  controlPropertyBinding(
    target: number | Entity,
    propertyKey: string,
  ): ControlPropertyBinding | null {
    const entity = typeof target === 'number' ? this.entityById(target) : target;
    const descriptor = getControlPropertyDescriptor(propertyKey);
    if (!entity || !descriptor || this.entityById(entity.id) !== entity) return null;
    const binding = this.propertyBindings.get(entity)?.[descriptor.propertyKey];
    return binding?.isAvailable() ? binding : null;
  }

  /** 续费测量时剔除本层，防止已生效的维持被误算为零强度。 */
  controlEffectStrength(record: ControlRecord): number {
    const target = this.entityById(record.targetId);
    const binding = target && this.controlPropertyBinding(target, record.propertyKey);
    if (!target || !binding) throw new RangeError('控制目标能力失效');
    const peers = this.controlRecords.filter(
      (item) =>
        item.targetId === target.id &&
        item.propertyKey === record.propertyKey &&
        (record.mode === 'maintain'
          ? item.controllerSessionId !== record.controllerSessionId
          : item.controllerId !== record.controllerId),
    );
    const before =
      this.controlValue(target, record.propertyKey, [...peers]) ?? binding.readBase?.();
    const after =
      this.controlValue(target, record.propertyKey, [...peers, record]) ?? record.effect;
    if (before === undefined) throw new RangeError('控制属性无基础值');
    const strength = binding.effectStrength(record.effect, before, after);
    if (!Number.isFinite(strength) || strength < 0) throw new RangeError('非法控制效果强度');
    return strength;
  }

  /** 统一控制入口：完成全部校验及首周期结算后才替换同源记录。 */
  applyEntityControl(
    targetId: number,
    propertyKey: string,
    effect: unknown,
    duration: number,
    request: ControlRequest = {},
  ): boolean {
    if (propertyKey === 'position') return this.rejectControl('位置须使用独立传送效果');
    const descriptor = getControlPropertyDescriptor(propertyKey);
    if (!descriptor) return this.rejectControl(`缺少属性能力：${propertyKey}`);
    if (!Number.isFinite(duration) || duration < 0)
      return this.rejectControl('非法时间：须为有限非负秒数，0 表示无限');
    const normalized = descriptor.normalize(effect);
    if (normalized === null) return this.rejectControl(`非法效果参数：${propertyKey} 不接受该值`);
    const binding = this.controlPropertyBinding(targetId, descriptor.propertyKey);
    if (!binding) return this.rejectControl(`目标无效或缺少 ${propertyKey} 属性 binding`);
    if (!binding.supportsDuration(duration))
      return this.rejectControl(`${propertyKey} binding 不支持该时间`);
    const resistance = binding.resistance();
    if (!Number.isFinite(resistance) || resistance < 0) return this.rejectControl('目标抗性非法');
    const target = this.entityById(targetId)!;
    const session = request.session;
    if (session && (!session.active || this.controlSessions.get(session.id) !== session))
      return this.rejectControl('控制会话已结束');
    if (binding.mode === 'maintain' && !session)
      return this.rejectControl('维持控制需要有效施法实例');
    const controllerId = session?.controllerId ?? request.controllerId ?? 0;
    if (controllerId !== 0) {
      const controller = this.entityById(controllerId);
      if (!controller || !this.entityAvailable(controller))
        return this.rejectControl('控制者已失效');
    }
    const canControl = request.canControl ?? session?.canControl;
    if (canControl && !this.canControl(canControl, target, descriptor.propertyKey))
      return this.rejectControl('无权限控制目标属性');
    if (binding.mode === 'write' && binding.writePolicy === 'commit') {
      const candidate: ControlRecord = {
        targetId,
        propertyKey: descriptor.propertyKey,
        effect: normalized,
        mode: 'write',
        writePolicy: 'commit',
        expiresAt: null,
        controllerId,
        controllerSessionId: null,
        sequence: this.nextControlSequence,
        paidPeriods: 0,
        nextPaymentAt: null,
      };
      try {
        this.controlEffectStrength(candidate);
      } catch {
        return this.rejectControl('非法控制效果');
      }
      if (session && !this.chargeControl(session, candidate, 'start'))
        return this.rejectControl('法力余额不足或执行上限已达，详见施法结果');
      if (!binding.apply(normalized, duration)) return this.rejectControl('目标拒绝该效果');
      this.recordEntityAuditEvent(targetId, 'control', descriptor.propertyKey);
      return true;
    }
    const old = this.controlRecords.find(
      (record) =>
        record.targetId === targetId &&
        record.propertyKey === descriptor.propertyKey &&
        (binding.mode === 'maintain'
          ? record.controllerSessionId === session!.id
          : record.mode === 'write' && record.controllerId === controllerId),
    );
    if (!old && this.controlRecords.length >= MAX_CONTROL_RECORDS)
      return this.rejectControl('控制记录容量已满');
    if (!old && controllerId !== 0) {
      const controller = this.byId(controllerId);
      if (
        !controller ||
        (this.auditShenshiUsage.get(controllerId) ?? 0) +
          (this.auditVmShenshiTotal.get(controllerId) ?? 0) +
          (this.subscriptionShenshi.get(controllerId) ?? 0) +
          this.controlRecordShenshiUsed(controllerId) +
          1 >
          controller.attr.shenshiMax
      )
        return this.rejectControl('控制记录神识不足');
    }
    const expiresAt = duration === 0 ? null : this.controlTime + duration;
    if (expiresAt !== null && !Number.isFinite(expiresAt))
      return this.rejectControl('控制到期时间溢出');
    const record: ControlRecord = {
      targetId,
      propertyKey: descriptor.propertyKey,
      effect: typeof normalized === 'number' ? normalized : { ...normalized },
      mode: binding.mode,
      writePolicy: binding.writePolicy,
      expiresAt,
      controllerId,
      controllerSessionId: binding.mode === 'maintain' ? session!.id : null,
      sequence: this.nextControlSequence,
      paidPeriods: binding.mode === 'maintain' ? 1 : 0,
      nextPaymentAt: binding.mode === 'maintain' ? this.controlTime + CONTROL_PERIOD : null,
    };
    if (!this.validControlValue(target, descriptor.propertyKey, record, old))
      return this.rejectControl('非法效果参数：合并后超出属性领域');
    try {
      this.controlEffectStrength(record);
    } catch {
      return this.rejectControl('非法控制效果');
    }
    if (session && !this.chargeControl(session, record, 'start'))
      return this.rejectControl('法力余额不足或执行上限已达，详见施法结果');
    if (
      session &&
      (!session.active ||
        !this.recordAvailableCandidate(target, binding) ||
        !this.canControl(session.canControl, target, descriptor.propertyKey))
    )
      return this.rejectControl('目标能力、权限或施法实例已失效');
    if (old) {
      this.controlRecords.splice(this.controlRecords.indexOf(old), 1);
      this.controlPermissions.delete(old.sequence);
    }
    this.captureControlBase(target, descriptor.propertyKey);
    this.controlRecords.push(record);
    if (canControl) this.controlPermissions.set(record.sequence, canControl);
    this.nextControlSequence++;
    this.refreshControl(target, descriptor.propertyKey);
    this.recordEntityAuditEvent(targetId, 'control', descriptor.propertyKey);
    return true;
  }

  private rejectControl(reason: string): false {
    this.events.push(`控制失败：${reason}`);
    return false;
  }

  private controlRecordShenshiUsed(controllerId: number): number {
    return this.controlRecords.filter((record) => record.controllerId === controllerId).length;
  }

  /** 同一实体能力按关系定价，而不是按 Actor / Projectile 拆成不同元法术。 */
  entityCostMultiplier(caster: Actor, target: Entity): number {
    if (target.id === caster.id) return 1;
    if ('ownerId' in target && target.ownerId === caster.id) return 1;
    if (target.faction === caster.faction) return 2;
    return 8;
  }

  /** 兼容旧调用名；新的元法术按统一实体关系计价。 */
  controlCostMultiplier(caster: Actor, target: Entity): number {
    return this.entityCostMultiplier(caster, target);
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
    this.refreshControl(a, 'rotation');
    for (const key of [
      'speed',
      'damage',
      'perception',
      'armor',
      'hpMax',
      'manaMax',
      'manaRegen',
      'shenshiMax',
      'castSpeed',
      'manaCostMul',
    ] as const)
      if (
        this.controlRecords.some((record) => record.targetId === a.id && record.propertyKey === key)
      )
        this.refreshControl(a, key);
    if (a.hp > a.attr.hpMax) a.hp = a.attr.hpMax;
    if (a.mana > a.attr.manaMax) {
      this.resourceLedger.observeMana(a.id);
      a.mana = a.attr.manaMax;
      this.resourceLedger.recordManaWorldChange(a.id, 'clampLoss');
      this.observeManaThreshold(a.id);
    }
  }

  /** 鼠标与 AI 更新基础朝向，仍有效的控制层继续优先。 */
  setActorAim(actor: Actor, direction: Vec2): void {
    actor.baseAim = { ...direction };
    this.refreshControl(actor, 'rotation');
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

  damage(id: number, amount: number, conserved = false, sourceId: number | null = null): boolean {
    const a = this.entityWithCapability(id, 'vitality');
    if (!a || !a.alive || !Number.isFinite(amount) || amount <= 0) return false;
    const real = conserved
      ? Math.min(a.hp, Math.max(0, amount - Math.max(0, a.attr.armor)))
      : Math.max(1, amount - a.attr.armor);
    if (real <= 0) return false;
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
    this.recordEntityAuditEvent(a.id, 'damage', `${real}`);
    this.onDamage?.(a, real);
    if (!a.alive) {
      for (const projectile of this.projectiles)
        if (projectile.ownerId === a.id) this.revokeProjectileBehavior(projectile);
      this.pruneActiveMonitors();
      for (const [sequence, sub] of this.subscriptions)
        if (sub.ownerId === a.id) this.unsubscribeEvent(sequence);
      for (const session of [...this.controlSessions.values()])
        if (session.controllerId === a.id) session.end();
      this.exhaustedAccounts.delete(a.id);
      this.pruneControlRecords();
      this.refundEntityEnergy(a.id);
    }
    this.queueWorldEvent(
      'damage',
      sourceId,
      a.id,
      { amount: real, x: a.x, y: a.y },
      a.alive ? undefined : a,
    );
    if (!a.alive) this.queueWorldEvent('disappear', a.id, a.id, { x: a.x, y: a.y }, a);
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

  /** 普通移动按模拟时间和已预付的 0.25 秒世界功率积分。 */
  advanceActorMotion(a: Actor, intent: Vec2, speedScale: number, dt: number): void {
    if (!a.alive || !Number.isFinite(dt) || dt <= 0) return;
    const length = Math.hypot(intent.x, intent.y);
    const speedMax = Number.isFinite(a.attr.speed) ? Math.max(0, a.attr.speed) : 0;
    const desired =
      a.stun > 0 ||
      a.baseSpeed <= 0 ||
      !Number.isFinite(speedScale) ||
      speedScale <= 0 ||
      !Number.isFinite(length) ||
      length < 1e-9
        ? { x: 0, y: 0 }
        : {
            x: (intent.x / length) * speedMax * speedScale,
            y: (intent.y / length) * speedMax * speedScale,
          };
    const requested =
      Number.isFinite(desired.x) && Number.isFinite(desired.y) ? desired : { x: 0, y: 0 };
    const changed = Math.hypot(requested.x - a.drive.x, requested.y - a.drive.y) > 0.1;
    if (changed) {
      a.driveRemaining = 0;
      a.drive = requested;
      a.drivePaid = false;
    }
    let remaining = dt;
    while (remaining > 1e-9) {
      if (a.driveRemaining <= 1e-9 && Math.hypot(a.drive.x, a.drive.y) > 0) {
        const ratio = Math.hypot(a.drive.x, a.drive.y) / a.baseSpeed;
        const price = Math.max(1, ratio * ratio);
        if (Number.isFinite(price) && a.movePower + 1e-9 >= price) {
          a.movePower = Math.max(0, a.movePower - price);
          a.drivePaid = true;
        } else {
          a.drivePaid = false;
        }
        a.driveRemaining = CONTROL_PERIOD;
      }
      const step = Math.min(remaining, a.driveRemaining > 1e-9 ? a.driveRemaining : CONTROL_PERIOD);
      const active = a.drivePaid && a.driveRemaining > 1e-9 && Math.hypot(a.drive.x, a.drive.y) > 0;
      const target = active ? a.drive : { x: 0, y: 0 };
      const decay = Math.exp(-20 * step);
      const factor = (1 - decay) / 20;
      const vx = a.velocity.x;
      const vy = a.velocity.y;
      this.moveActor(
        a,
        target.x * step + (vx - target.x) * factor,
        target.y * step + (vy - target.y) * factor,
      );
      a.velocity = {
        x: target.x + (vx - target.x) * decay,
        y: target.y + (vy - target.y) * decay,
      };
      if (
        (a.x <= a.radius && a.velocity.x < 0) ||
        (a.x >= this.bounds.w - a.radius && a.velocity.x > 0)
      )
        a.velocity.x = 0;
      if (
        (a.y <= a.radius && a.velocity.y < 0) ||
        (a.y >= this.bounds.h - a.radius && a.velocity.y > 0)
      )
        a.velocity.y = 0;
      if (active) a.motionSource = 'base';
      if (a.baseSpeed > 0) a.movePower = Math.min(4, a.movePower + 4 * step);
      a.driveRemaining = Math.max(0, a.driveRemaining - step);
      remaining -= step;
    }
  }

  /** 元法术扣款后发布一次冲量；实际速度不由朝向或上限覆写。 */
  applyImpulse(targetId: number, delta: Vec2): boolean {
    const target = this.entityById(targetId);
    if (
      !target ||
      !this.entityAvailable(target) ||
      (target.kind === 'projectile' && !target.active)
    )
      return false;
    const x = target.velocity.x + delta.x;
    const y = target.velocity.y + delta.y;
    if (![x, y].every(Number.isFinite)) return false;
    const before = Math.hypot(target.velocity.x, target.velocity.y);
    const after = Math.hypot(x, y);
    const max = target.kind === 'actor' ? target.attr.speed : target.speed;
    if (
      !Number.isFinite(max) ||
      max < 0 ||
      !Number.isFinite(after) ||
      (after > max + 1e-9 && after > before + 1e-9)
    )
      return false;
    target.velocity = { x, y };
    target.motionSource = target.kind === 'actor' ? 'spell' : 'projectile';
    return true;
  }

  /** 检查可公开的传送前置条件；失败不改变任何世界状态。 */
  canTeleportEntity(
    targetId: number,
    point: Vec2,
    canControl?: ControlSession['canControl'],
  ): boolean {
    const target = this.entityById(targetId);
    if (
      !target ||
      !this.entityAvailable(target) ||
      !target.teleportAllowed ||
      !this.controlPropertyBinding(target, 'position')
    )
      return false;
    if (canControl && !this.canControl(canControl, target, 'position')) return false;
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < target.radius ||
      point.y < target.radius ||
      point.x > this.bounds.w - target.radius ||
      point.y > this.bounds.h - target.radius
    )
      return false;
    if (
      this.actors.some(
        (a) =>
          a !== target &&
          a.alive &&
          Math.hypot(a.x - point.x, a.y - point.y) < a.radius + target.radius,
      )
    )
      return false;
    return true;
  }

  /** 传送只在所有空间和能力检查通过后提交坐标。 */
  teleportEntity(
    targetId: number,
    point: Vec2,
    canControl?: ControlSession['canControl'],
  ): boolean {
    if (!this.canTeleportEntity(targetId, point, canControl)) return false;
    const target = this.entityById(targetId)!;
    target.x = point.x;
    target.y = point.y;
    this.recordEntityAuditEvent(target.id, 'control', 'teleport');
    return true;
  }

  private entityAvailable(entity: Entity): boolean {
    return entity.kind === 'actor' ? entity.alive : entity.life > 0;
  }

  private canControl(
    check: ControlSession['canControl'],
    target: Entity,
    key: ControlPropertyKey,
  ): boolean {
    try {
      return check(target, key);
    } catch {
      return false;
    }
  }

  private chargeControl(
    session: ControlSession,
    record: ControlRecord,
    phase: 'start' | 'period',
  ): boolean {
    try {
      return session.charge(record, phase);
    } catch {
      return false;
    }
  }

  private recordAvailableCandidate(target: Entity, binding: ControlPropertyBinding): boolean {
    return this.entityById(target.id) === target && binding.isAvailable();
  }

  private recordAvailable(record: ControlRecord): boolean {
    const target = this.entityById(record.targetId);
    const binding = target && this.controlPropertyBinding(target, record.propertyKey);
    if (
      !target ||
      !binding ||
      binding.mode !== record.mode ||
      binding.writePolicy !== record.writePolicy
    )
      return false;
    const permission = this.controlPermissions.get(record.sequence);
    if (permission && !this.canControl(permission, target, record.propertyKey)) return false;
    if (record.mode === 'maintain') {
      const session = this.controlSessions.get(record.controllerSessionId!);
      if (
        !session ||
        !session.active ||
        !this.canControl(session.canControl, target, record.propertyKey)
      )
        return false;
    }
    if (record.controllerId !== 0) {
      const controller = this.entityById(record.controllerId);
      if (!controller || !this.entityAvailable(controller)) return false;
    }
    return true;
  }

  private removeControlRecords(predicate: (record: ControlRecord) => boolean): void {
    const affected = new Map<string, { target: Entity; key: ControlPropertyKey }>();
    this.controlRecords = this.controlRecords.filter((record) => {
      if (!predicate(record)) return true;
      this.controlPermissions.delete(record.sequence);
      const target = this.entityById(record.targetId);
      if (target)
        affected.set(`${target.id}:${record.propertyKey}`, { target, key: record.propertyKey });
      return false;
    });
    for (const { target, key } of affected.values()) this.refreshControl(target, key);
  }

  private captureControlBase(target: Entity, key: ControlPropertyKey): void {
    const binding = this.propertyBindings.get(target)?.[key];
    if (!binding?.readBase) return;
    const base = this.controlBase.get(target) ?? {};
    if (base[key] === undefined) {
      const value = binding.readBase();
      base[key] = typeof value === 'number' ? value : { ...value };
      this.controlBase.set(target, base);
    }
  }

  private controlValue(
    target: Entity,
    key: ControlPropertyKey,
    records: ControlRecord[],
  ): ControlPropertyEffect | null {
    const binding = this.propertyBindings.get(target)?.[key];
    if (!binding?.readBase || !binding.writeEffective) return null;
    const descriptor = getControlPropertyDescriptor(key)!;
    const base = binding.readBase();
    const ordered = records.sort((a, b) => a.sequence - b.sequence);
    if (descriptor.merge === 'replace') {
      const value = ordered.at(-1)?.effect ?? base;
      return typeof value === 'number' ? value : { ...value };
    }
    let add = 0;
    let multiply = 1;
    for (const record of ordered) {
      if (descriptor.merge === 'add') add += record.effect as number;
      else multiply *= record.effect as number;
    }
    const value = ((base as number) + add) * multiply;
    if (!Number.isFinite(value)) return null;
    if (key === 'manaRegen') return value >= 0 ? value : null;
    if (key === 'castSpeed' || key === 'manaCostMul')
      return value >= 0.25 && value <= 4 ? value : null;
    if (key === 'shenshiMax') return Number.isSafeInteger(value) && value > 0 ? value : null;
    if (key === 'hpMax' || key === 'manaMax') return value > 0 ? value : null;
    return descriptor.merge !== 'multiply' || value > 0 ? value : null;
  }

  private validControlValue(
    target: Entity,
    key: ControlPropertyKey,
    next: ControlRecord,
    old?: ControlRecord,
  ): boolean {
    const peers = this.controlRecords.filter(
      (record) => record !== old && record.targetId === target.id && record.propertyKey === key,
    );
    return this.controlValue(target, key, [...peers, next]) !== null;
  }

  private refreshControl(target: Entity, key: ControlPropertyKey): void {
    const binding = this.propertyBindings.get(target)?.[key];
    if (!binding?.writeEffective) return;
    const records = this.controlRecords.filter(
      (record) => record.targetId === target.id && record.propertyKey === key,
    );
    const value = this.controlValue(target, key, records);
    if (value !== null) binding.writeEffective(value);
    if (records.length === 0) {
      const base = this.controlBase.get(target);
      if (base) delete base[key];
    }
  }

  private actorPropertyBindings(actor: Actor): ControlPropertyBindings {
    const bind = (
      propertyKey: ControlPropertyKey,
      mode: ControlPropertyBinding['mode'],
      writePolicy: ControlPropertyBinding['writePolicy'],
      supportsDuration: (duration: number) => boolean,
      apply: ControlPropertyBinding['apply'],
    ) => this.binding(propertyKey, mode, writePolicy, supportsDuration, apply, () => actor.alive);
    const commit = (
      propertyKey: ControlPropertyKey,
      apply: (effect: ControlPropertyEffect) => boolean,
    ) => bind(propertyKey, 'write', 'commit', (duration) => duration === 0, apply);
    const maintain = (
      propertyKey: ControlPropertyKey,
      apply: (effect: ControlPropertyEffect, duration: number) => boolean,
    ) => bind(propertyKey, 'maintain', null, validControlDuration, apply);
    const attribute = (
      key: 'hpMax' | 'manaMax' | 'manaRegen' | 'shenshiMax' | 'castSpeed' | 'manaCostMul',
    ): ControlPropertyBinding => ({
      ...maintain(key, () => true),
      readBase: () => computeAttributes(actor.base, actor.mods)[key],
      writeEffective: (value) => {
        actor.attr[key] = value as number;
        if (key === 'hpMax' && actor.hp > actor.attr.hpMax) actor.hp = actor.attr.hpMax;
        if (key === 'manaMax' && actor.mana > actor.attr.manaMax) {
          this.resourceLedger.observeMana(actor.id);
          actor.mana = actor.attr.manaMax;
          this.resourceLedger.recordManaWorldChange(actor.id, 'clampLoss');
          this.observeManaThreshold(actor.id);
        }
      },
      effectStrength: (_effect, before, after) => {
        if (typeof before !== 'number' || typeof after !== 'number') return Number.NaN;
        if (key === 'hpMax' || key === 'manaMax' || key === 'shenshiMax')
          return Math.abs(after - before) / 10;
        if (key === 'castSpeed' || key === 'manaCostMul')
          return Math.abs(Math.log2(after / before));
        if (key === 'manaRegen') return Math.abs(after - before) * CONTROL_PERIOD;
        return Math.abs(after - before);
      },
    });
    return {
      position: {
        ...commit('position', () => false),
        readBase: () => ({ x: actor.x, y: actor.y }),
      },
      rotation: {
        ...bind('rotation', 'write', 'overlay', validControlDuration, (effect) => {
          actor.aim = { ...(effect as Vec2) };
          return true;
        }),
        readBase: () => actor.baseAim,
        writeEffective: (value: ControlPropertyEffect) => {
          actor.aim = { ...(value as Vec2) };
        },
      },
      speed: {
        ...maintain('speed', () => true),
        readBase: () => computeAttributes(actor.base, actor.mods).speed,
        writeEffective: (value: ControlPropertyEffect) => {
          actor.attr.speed = value as number;
        },
      },
      damage: {
        ...maintain('damage', () => true),
        readBase: () => computeAttributes(actor.base, actor.mods).power,
        writeEffective: (value: ControlPropertyEffect) => {
          actor.attr.power = value as number;
        },
      },
      perception: {
        ...maintain('perception', () => true),
        readBase: () => computeAttributes(actor.base, actor.mods).perception,
        writeEffective: (value: ControlPropertyEffect) => {
          actor.attr.perception = value as number;
        },
      },
      armor: {
        ...maintain('armor', () => true),
        readBase: () => computeAttributes(actor.base, actor.mods).armor,
        writeEffective: (value: ControlPropertyEffect) => {
          actor.attr.armor = value as number;
        },
      },
      hpMax: attribute('hpMax'),
      manaMax: attribute('manaMax'),
      manaRegen: attribute('manaRegen'),
      shenshiMax: attribute('shenshiMax'),
      castSpeed: attribute('castSpeed'),
      manaCostMul: attribute('manaCostMul'),
    };
  }

  private projectilePropertyBindings(projectile: Projectile): ControlPropertyBindings {
    const bind = (
      propertyKey: ControlPropertyKey,
      mode: ControlPropertyBinding['mode'],
      writePolicy: ControlPropertyBinding['writePolicy'],
      supportsDuration: (duration: number) => boolean,
      apply: ControlPropertyBinding['apply'],
    ) =>
      this.binding(
        propertyKey,
        mode,
        writePolicy,
        supportsDuration,
        apply,
        () => projectile.life > 0,
      );
    const commit = (
      propertyKey: ControlPropertyKey,
      apply: (effect: ControlPropertyEffect) => boolean,
    ) => bind(propertyKey, 'write', 'commit', (duration) => duration === 0, apply);
    const overlay = (
      propertyKey: ControlPropertyKey,
      apply: (effect: ControlPropertyEffect) => boolean,
    ) => bind(propertyKey, 'write', 'overlay', validControlDuration, apply);
    return {
      position: {
        ...commit('position', () => false),
        readBase: () => ({ x: projectile.x, y: projectile.y }),
      },
      rotation: {
        ...overlay('rotation', (effect) => {
          const direction = effect as Vec2;
          projectile.dx = direction.x;
          projectile.dy = direction.y;
          return true;
        }),
        readBase: () =>
          this.controlBase.get(projectile)?.rotation ?? { x: projectile.dx, y: projectile.dy },
        writeEffective: (value: ControlPropertyEffect) => {
          projectile.dx = (value as Vec2).x;
          projectile.dy = (value as Vec2).y;
        },
      },
      speed: {
        ...overlay('speed', (effect) => {
          const next = projectile.speed * (effect as number);
          if (!isPositiveFiniteNumber(next)) return false;
          projectile.speed = next;
          return true;
        }),
        readBase: () => this.controlBase.get(projectile)?.speed ?? projectile.speed,
        writeEffective: (value: ControlPropertyEffect) => {
          projectile.speed = value as number;
        },
      },
      damage: {
        ...overlay('damage', (effect) => {
          const next = projectile.damage * (effect as number);
          if (!isPositiveFiniteNumber(next)) return false;
          projectile.damage = next;
          return true;
        }),
        readBase: () => this.controlBase.get(projectile)?.damage ?? projectile.damage,
        writeEffective: (value: ControlPropertyEffect) => {
          projectile.damage = value as number;
        },
      },
      lifetime: {
        ...commit('lifetime', (effect) => {
          projectile.life = effect as number;
          return true;
        }),
        readBase: () => projectile.life,
      },
    };
  }

  private binding(
    propertyKey: ControlPropertyKey,
    mode: ControlPropertyBinding['mode'],
    writePolicy: ControlPropertyBinding['writePolicy'],
    supportsDuration: (duration: number) => boolean,
    apply: ControlPropertyBinding['apply'],
    isAvailable: () => boolean,
  ): ControlPropertyBinding {
    return {
      propertyKey,
      mode,
      writePolicy,
      isAvailable,
      supportsDuration,
      resistance: () => 0,
      effectStrength: (_effect, before, after) =>
        typeof before === 'number' && typeof after === 'number'
          ? Math.abs(after - before)
          : typeof before !== 'number' && typeof after !== 'number'
            ? Math.hypot(after.x - before.x, after.y - before.y)
            : Number.NaN,
      apply,
    };
  }

  private auditBinding(read: () => unknown, isAvailable: () => boolean): EntityAuditBinding {
    return { read, isAvailable };
  }

  private commonAuditBindings(entity: Entity): EntityAuditBindings {
    const available = () => this.entityById(entity.id) === entity;
    const sessions = () => {
      const controller = [...this.controlSessions.values()]
        .filter((session) => session.controllerId === entity.id)
        .map((session) => ({ id: session.id, role: 'controller' as const }));
      const target = this.controlRecords
        .filter((record) => record.targetId === entity.id && record.controllerSessionId !== null)
        .map((record) => ({ id: record.controllerSessionId!, role: 'target' as const }));
      return [
        ...new Map(
          [...controller, ...target].map((entry) => [`${entry.id}:${entry.role}`, entry]),
        ).values(),
      ];
    };
    return {
      position: this.auditBinding(() => ({ x: entity.x, y: entity.y }), available),
      velocity: this.auditBinding(() => entity.velocity, available),
      motionSource: this.auditBinding(() => entity.motionSource, available),
      ownership: this.auditBinding(
        () => ({
          ownerId: entity.kind === 'actor' ? entity.id : entity.ownerId,
          faction: entity.faction,
        }),
        available,
      ),
      sessions: this.auditBinding(sessions, available),
      events: this.auditBinding(() => this.auditEvents.get(entity) ?? [], available),
      resistances: this.auditBinding(() => {
        const result: Record<string, number> = {};
        for (const [key, binding] of Object.entries(this.propertyBindings.get(entity) ?? {})) {
          if (binding?.isAvailable()) result[key] = binding.resistance();
        }
        return result;
      }, available),
    };
  }

  private actorAuditBindings(actor: Actor): EntityAuditBindings {
    const available = () => this.entityById(actor.id) === actor;
    return {
      ...this.commonAuditBindings(actor),
      facing: this.auditBinding(() => actor.aim, available),
      speedMax: this.auditBinding(() => actor.attr.speed, available),
      movePower: this.auditBinding(() => actor.movePower, available),
      hp: this.auditBinding(() => actor.hp, available),
      hpMax: this.auditBinding(() => actor.attr.hpMax, available),
      mana: this.auditBinding(() => actor.mana, available),
      manaMax: this.auditBinding(() => actor.attr.manaMax, available),
      manaRegen: this.auditBinding(() => actor.attr.manaRegen, available),
      shenshiUsed: this.auditBinding(
        () =>
          (this.auditShenshiUsage.get(actor.id) ?? 0) +
          (this.auditVmShenshiTotal.get(actor.id) ?? 0) +
          (this.subscriptionShenshi.get(actor.id) ?? 0) +
          this.controlRecordShenshiUsed(actor.id),
        available,
      ),
      shenshiMax: this.auditBinding(() => actor.attr.shenshiMax, available),
      castSpeed: this.auditBinding(() => actor.attr.castSpeed, available),
      manaCostMul: this.auditBinding(() => actor.attr.manaCostMul, available),
      armor: this.auditBinding(() => actor.attr.armor, available),
      damage: this.auditBinding(() => actor.attr.power, available),
      perception: this.auditBinding(() => actor.attr.perception, available),
    };
  }

  private projectileAuditBindings(projectile: Projectile): EntityAuditBindings {
    const available = () => this.entityById(projectile.id) === projectile;
    return {
      ...this.commonAuditBindings(projectile),
      facing: this.auditBinding(() => ({ x: projectile.dx, y: projectile.dy }), available),
      speedMax: this.auditBinding(() => projectile.speed, available),
      damage: this.auditBinding(() => projectile.damage, available),
      lifetime: this.auditBinding(() => projectile.life, available),
    };
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
      velocity: p.active === false ? { x: 0, y: 0 } : { x: p.dx * p.speed, y: p.dy * p.speed },
      motionSource: p.active === false ? 'none' : 'projectile',
      teleportAllowed: true,
      behavior: 'glide',
      thrust: { x: 0, y: 0 },
      trackTargetId: null,
      driveRemaining: 0,
    };
    this.propertyBindings.set(proj, this.projectilePropertyBindings(proj));
    this.auditBindings.set(proj, this.projectileAuditBindings(proj));
    this.projectiles.push(proj);
    this.recordEntityAuditEvent(proj.id, 'spawn', `owner ${proj.ownerId}`);
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

function validControlDuration(duration: number): boolean {
  return duration === 0 || (Number.isFinite(duration) && duration > 0);
}

function isPositiveFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
