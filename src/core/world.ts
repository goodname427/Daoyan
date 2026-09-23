import type { Vec2 } from './types';
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
}

export interface Actor {
  kind: 'actor';
  id: number;
  name: string;
  faction: Faction;

  x: number;
  y: number;
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

  reset(): void {
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

  /** 会话 ID 与控制记录序号在同一个 World 生命周期内不复用。 */
  createControlSession(
    controllerId: number,
    charge: ControlSession['charge'],
    canControl: ControlSession['canControl'] = () => true,
  ): ControlSession | null {
    const controller = this.entityById(controllerId);
    if (!controller || !this.entityAvailable(controller)) return null;
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
        this.removeControlRecords((record) => record.controllerSessionId === id);
      },
    };
    this.controlSessions.set(id, session);
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
    return next;
  }

  /** 在实体、binding 或权限外部变化后立即调用，幂等释放失效层。 */
  pruneControlRecords(): void {
    this.removeControlRecords((record) => !this.recordAvailable(record));
  }

  /** 模拟时钟；同一时刻先清理失效与到期，再按时间、序号结算维持。 */
  advanceControlTime(dt: number): void {
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
      this.controlTime = boundary;
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
    let after = this.controlValue(target, record.propertyKey, [...peers, record]) ?? record.effect;
    if (record.propertyKey === 'position' && typeof after !== 'number') {
      after = {
        x: Math.min(this.bounds.w - target.radius, Math.max(target.radius, after.x)),
        y: Math.min(this.bounds.h - target.radius, Math.max(target.radius, after.y)),
      };
    }
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
      return binding.apply(normalized, duration) || this.rejectControl('目标拒绝该效果');
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
    return true;
  }

  private rejectControl(reason: string): false {
    this.events.push(`控制失败：${reason}`);
    return false;
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
    for (const key of ['speed', 'damage', 'perception', 'armor'] as const)
      if (
        this.controlRecords.some((record) => record.targetId === a.id && record.propertyKey === key)
      )
        this.refreshControl(a, key);
    if (a.hp > a.attr.hpMax) a.hp = a.attr.hpMax;
    if (a.mana > a.attr.manaMax) a.mana = a.attr.manaMax;
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

  damage(id: number, amount: number): boolean {
    const a = this.entityWithCapability(id, 'vitality');
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
    if (!a.alive) this.pruneControlRecords();
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

  /** Transform 能力的统一位置写入；Actor 与 Projectile 走同一条语义。 */
  placeEntity(entity: Entity, x: number, y: number): void {
    entity.x = Math.min(this.bounds.w - entity.radius, Math.max(entity.radius, x));
    entity.y = Math.min(this.bounds.h - entity.radius, Math.max(entity.radius, y));
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
    return Number.isFinite(value) && (descriptor.merge !== 'multiply' || value > 0) ? value : null;
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
    return {
      position: {
        ...commit('position', (effect) => {
          const point = effect as Vec2;
          this.placeEntity(actor, point.x, point.y);
          return true;
        }),
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
        ...commit('position', (effect) => {
          const point = effect as Vec2;
          this.placeEntity(projectile, point.x, point.y);
          return true;
        }),
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
    this.propertyBindings.set(proj, this.projectilePropertyBindings(proj));
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

function validControlDuration(duration: number): boolean {
  return duration === 0 || (Number.isFinite(duration) && duration > 0);
}

function isPositiveFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
