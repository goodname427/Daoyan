import type { Vec2 } from './types';
import { RESOURCE_SCALE, ResourceLedger, type EnergyPool } from './ledger';
import { sensePrice } from './pricing';
import { B4_AUDIT, B4_PRICE_VERSION } from './b4Audit';
import { sha256Hex } from './canonical';
import type { Program } from './compiler';
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

/** Finite, measured contact data. No material or collision constant is inferred from HP/damage. */
export interface NaturalBodyCertificate {
  readonly mass: number;
  readonly radius: number;
  readonly restitution: number;
  readonly massVersion: string;
  readonly shapeVersion: string;
  readonly materialVersion: string;
  readonly fracturedMaterialVersion: string;
  readonly attachedK0: number | null;
  readonly panelK0: number | null;
  readonly fractureThresholdLow: number | null;
  readonly intactThresholdHigh: number | null;
  readonly fractureWork: number | null;
  readonly peakDivisor: number;
  readonly heatSinkId: string;
  /** Optional physical lot linkage; B4 requires it for real material conservation. */
  readonly materialInventoryId?: string;
  readonly fragmentInventoryId?: string;
  /** Measured passive connector properties, owned by this World body. */
  readonly headIntegrityLower?: number;
  readonly headLoadLower?: number;
  readonly portApertureQ?: number;
  readonly portLoadLower?: number;
  readonly structuralError?: number;
  readonly contactLoadLower?: number;
  /** Hardware measured on this structure, independently of the program admission request. */
  readonly programHardware?: {
    readonly pageCapacityBytes: number;
    readonly slotCapacityBytes: number;
    readonly subscriptionSlots: number;
    readonly fifoSlots: number;
    readonly referenceSlots: number;
    readonly frameSlots: number;
  };
}

export interface NaturalContactPolicy {
  readonly version: string;
  readonly geometryEpsilon: number;
  readonly timeEpsilon: number;
  readonly rootEpsilon: number;
  readonly maxSubdivisions: number;
}

export interface NaturalContactFact {
  readonly id: string;
  readonly at: number;
  readonly firstId: number;
  readonly secondId: number;
  readonly impulse: number;
  readonly firstImpulse: Vec2;
  readonly secondImpulse: Vec2;
  readonly energyBefore: number;
  readonly energyAfter: number;
  readonly dissipated: number;
  readonly materialResults: readonly {
    bodyId: number;
    result: 'fractured' | 'intact' | 'unknown';
    impactFactId: string | null;
    structureFactId: string | null;
    attachedBefore: number | null;
    attachedAfter: number | null;
    fragmentK0: number;
  }[];
  readonly deformation: number | null;
  readonly heat: number | null;
  readonly heatSinkId: string | null;
  readonly versions: readonly [string, string];
  readonly policyVersion: string;
  readonly massVersions: readonly [string, string];
  readonly shapeVersions: readonly [string, string];
}

export interface NaturalContactFailure {
  readonly at: number;
  readonly bodyIds: readonly number[];
  readonly reason:
    | 'groupCertificateMissing'
    | 'contactCertificateMismatch'
    | 'subdivisionLimit'
    | 'heatSinkUnavailable';
}

export interface WorldEnergyInventory {
  readonly id: string;
  readonly ownerId: number;
  /** Exact E0/12 units for the approved finite source ledger. */
  readonly energy: number;
  readonly error: number;
  readonly version: string;
  readonly originFactId: string;
}

export interface WorldEnergyTransferFact {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly sinkId: string;
  readonly grantId: string;
  readonly fromBefore: number;
  readonly fromAfter: number;
  readonly toBefore: number;
  readonly toAfter: number;
  readonly heatBefore: number;
  readonly heatAfter: number;
  readonly fromVersionBefore: string;
  readonly fromVersionAfter: string;
  readonly toVersionBefore: string;
  readonly toVersionAfter: string;
  readonly sinkVersionBefore: string;
  readonly sinkVersionAfter: string;
  readonly potentialMove?: {
    readonly bodyId: number;
    readonly yBefore: number;
    readonly yAfter: number;
    readonly anchorId: string;
    readonly reactionEndpointId: string;
    readonly supportLoad: number;
  };
}

export interface WorldPotentialSource {
  readonly id: string;
  readonly bodyId: number;
  readonly ownerId: number;
  readonly anchorId: string;
  readonly gravity: number;
  readonly referenceY: number;
  readonly error: number;
  readonly version: string;
}

export interface WorldMaterialInventory {
  readonly id: string;
  readonly ownerId: number;
  readonly kind: 'k0';
  /** Exact q units; no implicit conversion from energy or mana. */
  readonly quantity: number;
  readonly capacity?: number;
  readonly version: string;
  readonly originFactId: string;
}

export interface WorldMaterialTransferFact {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly quantity: number;
  readonly fromBefore: number;
  readonly fromAfter: number;
  readonly toBefore: number;
  readonly toAfter: number;
  readonly grantId: string;
  readonly fromVersionBefore: string;
  readonly fromVersionAfter: string;
  readonly toVersionBefore: string;
  readonly toVersionAfter: string;
}

export interface WorldFiniteGrant {
  readonly id: string;
  readonly executorId: number;
  readonly issuerId: number | null;
  readonly revokeOnIssuerDeath: boolean;
  readonly kind: 'energy-transfer' | 'material-transfer' | 'read' | 'action' | 'contact' | 'pay';
  readonly sourceId: string | null;
  readonly targetId: string | null;
  readonly maxAmount: number;
  readonly version: string;
  readonly fields?: readonly string[];
  readonly phase?: 'R0' | 'R1' | 'R2' | 'R3' | 'POST';
}

export interface WorldAuditEndpoint {
  readonly version: () => string;
  readonly error: (field: string) => number;
  readonly read: (field: string) => number | string | boolean | null;
  readonly visibleTo: (executorId: number) => boolean;
  readonly matches?: () => readonly number[];
}

export interface WorldB4ReadRequest {
  readonly requestId: string;
  readonly executorId: number;
  readonly payerId: number;
  readonly payerGrantId: string;
  readonly programHash: string;
  readonly priceVersion: string;
  readonly index: number;
  readonly endpointVersions: Readonly<Record<string, string>>;
  readonly endpointGrantIds: Readonly<Record<string, string>>;
  readonly directScan?: boolean;
}

export interface WorldProgramCapacityCertificate {
  readonly profile?: 'B4' | 'J1' | 'D1';
  readonly version: string;
  readonly bodyId: number;
  readonly structureVersion: string;
  readonly programHash: string;
  readonly totalShenshi: number;
  readonly occupiedShenshi: number;
  readonly pageBytes: number;
  readonly pageCapacityBytes: number;
  readonly slotBytes: number;
  readonly slotCapacityBytes: number;
  readonly subscriptionFree: number;
  readonly fifoFree: number;
  readonly referenceFree: number;
  readonly frameFree: number;
}

export interface WorldProgramInstallation {
  readonly bodyId: number;
  readonly programHash: string;
  readonly measuredPageBytes: number;
  readonly occupiedBefore: number;
  readonly reservedPeakShenshi: number;
  readonly occupiedAtInstallPeak: number;
  readonly availableAfterInstallPeak: number;
}

export interface WorldB4ReadReceipt {
  readonly receiptId: string;
  readonly readId: string;
  readonly requestId: string;
  readonly payerId: number;
  readonly payerGrantId: string;
  readonly priceVersion: string;
  readonly mana: number;
  readonly ticks: number;
  readonly sampleVersion: string;
  readonly emptyResult: boolean;
  readonly raw: readonly {
    endpointId: string;
    field: string;
    value: number | string | boolean | null;
    error: number;
    version: string;
    grantId: string;
  }[];
}

export interface WorldB4ReadSession {
  readonly id: number;
  readonly requestId: string;
  readonly executorId: number;
  readonly payerId: number;
  readonly payerGrantId: string;
  readonly priceVersion: string;
  readonly programHash: string;
  readonly endpointVersions: readonly Readonly<Record<string, string>>[];
  readonly endpointGrantIds: readonly Readonly<Record<string, string>>[];
  readonly directScan: boolean;
}

export interface WorldAnchorCertificate {
  readonly id: string;
  readonly reactionEndpointId: string;
  readonly loadLower: number;
  readonly version: string;
}

export interface WorldB4ActionPlan {
  readonly sessionId: number;
  readonly requestId: string;
  readonly executorId: number;
  readonly targetId: number;
  readonly payerId: number;
  readonly programHash: string;
  readonly capacityVersion: string;
  readonly sourceLotId: string;
  readonly packageLotId: string;
  readonly auxiliaryLotId: string;
  readonly auxiliaryWorkingLotId: string;
  readonly clampSpentLotId: string;
  readonly auxiliaryHeatSinkId: string;
  readonly clampHeatSinkId: string;
  readonly stagingLotId: string;
  readonly depotLotId: string;
  readonly corpseLotId: string;
  readonly wasteLotId: string;
  readonly heatSinkId: string;
  readonly anchorId: string;
  readonly sliceId: string;
  readonly naturalStructureFactId: string;
  readonly repairedMaterialVersion: string;
  readonly repairedStructureVersion: string;
  readonly physicalGrantId: string;
  readonly sourceTransferGrantId: string;
  readonly auxiliaryTransferGrantId: string;
  readonly clampTransferGrantId: string;
  readonly materialTransferGrantId: string;
  readonly payerGrantId: string;
  readonly priceVersion: string;
  readonly loadEnergyFromSource: number;
  readonly loadEnergyToPackage: number;
  readonly loadHeat: number;
  readonly loadMaterial: number;
  readonly auxiliaryDraw: number;
  readonly auxiliaryToWork: number;
  readonly auxiliaryHeat: number;
  readonly clampWork: number;
  readonly actionEnergy: number;
  readonly structureWork: number;
  readonly actionHeat: number;
  readonly shellMaterial: number;
  readonly wasteMaterial: number;
  readonly impulse: Vec2;
}

export interface WorldB4ActionFact {
  readonly id: string;
  readonly structureFactId: string;
  readonly requestId: string;
  readonly naturalStructureFactId: string;
  readonly sourceLotId: string;
  readonly packageLotId: string;
  readonly sliceId: string;
  readonly packageBefore: number;
  readonly packageAfter: number;
  readonly heatBefore: number;
  readonly heatAfter: number;
  readonly corpseBefore: number;
  readonly corpseAfter: number;
  readonly stagingBefore: number;
  readonly stagingAfter: number;
  readonly wasteBefore: number;
  readonly wasteAfter: number;
  readonly structureWork: number;
  readonly impulsePair: readonly [Vec2, Vec2];
  readonly reactionEndpointId: string;
  readonly executorVelocityBefore: Vec2;
  readonly executorVelocityAfter: Vec2;
  readonly targetVelocityBefore: Vec2;
  readonly targetVelocityAfter: Vec2;
  readonly kineticBefore: number;
  readonly kineticAfter: number;
  readonly receiptId: string;
}

export interface WorldB4StageReceipt {
  readonly receiptId: string;
  readonly requestId: string;
  readonly phase: 'load' | 'action';
  readonly payerId: number;
  readonly mana: number;
  readonly ticks: number;
  readonly payerGrantId: string;
}

export interface WorldManaFundingFact {
  readonly id: string;
  readonly fromId: number;
  readonly payerId: number;
  readonly amount: number;
  readonly fromBefore: number;
  readonly fromAfter: number;
  readonly payerBefore: number;
  readonly payerAfter: number;
}

export type WorldDriveKind = 'J1' | 'D1';
export interface WorldDriveSession {
  readonly id: number;
  readonly kind: WorldDriveKind;
  readonly requestId: string;
  readonly executorId: number;
  readonly targetId: number;
  readonly reactionBodyId?: number;
  readonly reactionGrantId?: string;
  readonly payerId: number;
  readonly p0Id?: number;
  readonly p2Id?: number;
  readonly programHash: string;
  readonly capacityVersion: string;
  readonly sourceId: string;
  readonly packageId: string;
  readonly mainPotentialId: string;
  readonly auxiliaryPotentialId: string;
  readonly mainAcquisitionGrantId: string;
  readonly auxiliaryAcquisitionGrantId: string;
  readonly mainAcquisitionHeatSinkId: string;
  readonly auxiliaryAcquisitionHeatSinkId: string;
  readonly auxiliarySourceId: string;
  readonly auxiliaryWorkingId: string;
  readonly auxiliarySpentId: string;
  readonly auxiliaryHeatSinkId: string;
  readonly clampHeatSinkId: string;
  readonly actionHeatSinkId: string;
  readonly environmentHeatSinkId: string;
  readonly heatSinkId: string;
  readonly anchorId: string;
  readonly sourceGrantId: string;
  readonly auxiliaryTransferGrantId: string;
  readonly clampTransferGrantId: string;
  readonly actionGrantId: string;
  readonly payerGrantId: string;
  readonly p0GrantId?: string;
  readonly p2GrantId?: string;
  readonly readGrantIds: readonly Readonly<Record<string, string>>[];
  readonly impulse: Vec2;
}

export interface WorldDriveReadReceipt {
  readonly id: string;
  readonly requestId: string;
  readonly kind: WorldDriveKind;
  readonly readId: string;
  readonly endpointId: string;
  readonly value: number;
  readonly error: number;
  readonly field: 'energyRaw' | 'loadLower';
  readonly version: string;
  readonly grantId: string;
  readonly payerGrantId: string;
  readonly payerId: number;
  readonly mana: number;
  readonly ticks: number;
  readonly coveredByReceiptId?: string;
  readonly samples: readonly {
    readonly endpointId: string;
    readonly field: 'energyRaw' | 'loadLower';
    readonly value: number;
    readonly error: number;
    readonly version: string;
    readonly grantId: string;
  }[];
}

export interface WorldDriveStageReceipt {
  readonly id: string;
  readonly requestId: string;
  readonly kind: WorldDriveKind;
  readonly phase: 'H1' | 'acquire' | 'load' | 'clamp' | 'seal' | 'action';
  readonly payerId: number;
  readonly payerGrantId: string;
  readonly mana: number;
  readonly ticks: number;
}

export interface WorldDriveActionFact {
  readonly id: string;
  readonly requestId: string;
  readonly kind: WorldDriveKind;
  readonly targetId: number;
  readonly reactionBodyId: number | null;
  readonly reactionBodyVersion: string | null;
  readonly anchorId: string;
  readonly reactionEndpointId: string;
  readonly anchorImpulseBefore: Vec2;
  readonly anchorImpulseAfter: Vec2;
  readonly impulsePair: readonly [Vec2, Vec2];
  readonly velocityBefore: Vec2;
  readonly velocityAfter: Vec2;
  readonly kineticGain: number;
  readonly heatGain: number;
  readonly packageBefore: number;
  readonly packageAfter: number;
  readonly payerId: number;
  readonly mana: number;
}

const DRIVE_READ_IDS = {
  J1: [
    'JH-H-R0',
    'JH-M-R0',
    'JH-A-R0',
    'JH-M-R1',
    'JH-A-R1',
    'JH-H-R1',
    'JH-M-R2',
    'JH-A-R2',
    'JH-H-R2',
    'JH-M-R3',
    'JH-A-R3',
    'JH-H-R3',
    'JH-POST-S-R0',
    'JH-POST-P-R1',
    'JH-POST-H-R2',
  ],
  D1: [
    'D1-H-R0',
    'D1-M-R0',
    'D1-A-R0',
    'D1-M-R1',
    'D1-A-R1',
    'D1-H-R1',
    'D1-M-R2',
    'D1-A-R2',
    'D1-H-R2',
    'D1-M-R3',
    'D1-A-R3',
    'D1-H-R3',
    'D1-POST-A',
    'D1-POST-H',
  ],
} as const;

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
  private finiteEnergy = new Map<string, WorldEnergyInventory>();
  private finitePotentialSources = new Map<string, WorldPotentialSource>();
  private finiteMaterial = new Map<string, WorldMaterialInventory>();
  private finiteHeat = new Map<string, { energy: number; capacity: number; version: string }>();
  private finiteGrants = new Map<string, WorldFiniteGrant>();
  private revokedFiniteGrants = new Set<string>();
  private finiteGrantUsed = new Map<string, number>();
  private finiteAuditEndpoints = new Map<string, WorldAuditEndpoint>();
  private finiteProgramCapacity = new Map<number, WorldProgramCapacityCertificate>();
  private finiteProgramInstallations = new Map<number, WorldProgramInstallation>();
  readonly b4ReadReceipts: WorldB4ReadReceipt[] = [];
  private b4ReadCursor = new Map<string, number>();
  private b4ReadSessions = new Map<number, WorldB4ReadSession>();
  private finiteAnchors = new Map<string, WorldAnchorCertificate>();
  private finiteAnchorImpulses = new Map<string, Vec2>();
  private b4ActionPlans = new Map<number, WorldB4ActionPlan>();
  private b4Loaded = new Set<string>();
  private b4Sealed = new Set<string>();
  private b4Locked = new Set<string>();
  private b4RetiredSlices = new Set<string>();
  private b4SliceLocks = new Map<string, string>();
  private b4LockSnapshots = new Map<
    string,
    {
      shellVersion: string;
      packageVersion: string;
      anchorVersion: string;
      contactCount: number;
      executorVelocity: Vec2;
      targetVelocity: Vec2;
    }
  >();
  readonly b4ActionFacts: WorldB4ActionFact[] = [];
  readonly b4StageReceipts: WorldB4StageReceipt[] = [];
  readonly finiteEnergyTransfers: WorldEnergyTransferFact[] = [];
  readonly finiteMaterialTransfers: WorldMaterialTransferFact[] = [];
  readonly finiteManaFunding: WorldManaFundingFact[] = [];
  private driveSessions = new Map<number, WorldDriveSession>();
  private driveSnapshots = new Map<
    string,
    {
      targetStructure: string;
      targetVelocity: Vec2;
      anchorVersion: string;
    }
  >();
  private driveCursors = new Map<string, number>();
  private driveStages = new Map<
    string,
    Set<'H1' | 'acquire' | 'load' | 'clamp' | 'seal' | 'action'>
  >();
  readonly driveReadReceipts: WorldDriveReadReceipt[] = [];
  readonly driveStageReceipts: WorldDriveStageReceipt[] = [];
  readonly driveActionFacts: WorldDriveActionFact[] = [];
  private finiteInitialOpen = true;

  sealFiniteInitialState(): void {
    this.finiteInitialOpen = false;
  }

  registerFiniteAuditEndpoint(id: string, binding: WorldAuditEndpoint): boolean {
    if (!id || this.finiteAuditEndpoints.has(id)) return false;
    this.finiteAuditEndpoints.set(id, binding);
    return true;
  }

  registerFiniteProgramCapacity(
    certificate: WorldProgramCapacityCertificate,
    program: Program,
  ): boolean {
    const body = this.entityById(certificate.bodyId);
    const hardware = this.naturalBodies.get(certificate.bodyId)?.certificate.programHardware;
    const activeSubscriptions = [...this.subscriptions.values()].filter(
      (subscription) => subscription.ownerId === certificate.bodyId,
    ).length;
    const actualPageBytes = program?.canonicalAst
      ? new TextEncoder().encode(program.canonicalAst).length
      : -1;
    const installPeak =
      certificate.profile === 'J1'
        ? 8 + 2 + 2 + DRIVE_READ_IDS.J1.length + 1 + 10
        : certificate.profile === 'D1'
          ? 8 + 2 + 2 + 1 + DRIVE_READ_IDS.D1.length + 10
          : 2 *
              (8 +
                B4_AUDIT.length +
                B4_AUDIT.reduce(
                  (sum, read) =>
                    sum +
                    read.projection.reduce(
                      (fields, endpoint) => fields + endpoint.fields.length,
                      0,
                    ),
                  0,
                ) +
                B4_AUDIT.reduce((sum, read) => sum + read.projection.length, 0)) +
            1;
    const numbers = [
      certificate.totalShenshi,
      certificate.occupiedShenshi,
      certificate.pageBytes,
      certificate.pageCapacityBytes,
      certificate.slotBytes,
      certificate.slotCapacityBytes,
      certificate.subscriptionFree,
      certificate.fifoFree,
      certificate.referenceFree,
      certificate.frameFree,
    ];
    if (
      !body ||
      body.kind !== 'actor' ||
      !hardware ||
      !program ||
      sha256Hex(program.canonicalAst) !== program.astHash ||
      program.astHash !== certificate.programHash ||
      !certificate.version ||
      !certificate.structureVersion ||
      this.naturalBodies.get(certificate.bodyId)?.materialVersion !==
        certificate.structureVersion ||
      !/^[a-f0-9]{64}$/.test(certificate.programHash) ||
      !numbers.every((value) => Number.isSafeInteger(value) && value >= 0) ||
      certificate.totalShenshi !== body.attr.shenshiMax ||
      certificate.occupiedShenshi > certificate.totalShenshi ||
      certificate.totalShenshi - certificate.occupiedShenshi < installPeak ||
      certificate.pageBytes !== actualPageBytes ||
      certificate.pageBytes > 4096 ||
      certificate.pageBytes > certificate.pageCapacityBytes ||
      certificate.pageCapacityBytes !== hardware.pageCapacityBytes ||
      certificate.slotBytes < 64 ||
      certificate.slotBytes > certificate.slotCapacityBytes ||
      certificate.slotCapacityBytes !== hardware.slotCapacityBytes ||
      certificate.subscriptionFree !== hardware.subscriptionSlots - activeSubscriptions ||
      certificate.fifoFree !== hardware.fifoSlots ||
      certificate.referenceFree !== hardware.referenceSlots ||
      certificate.frameFree !== hardware.frameSlots ||
      certificate.subscriptionFree < 1 ||
      certificate.fifoFree < 1 ||
      certificate.referenceFree < 1 ||
      certificate.frameFree < 1 ||
      this.finiteProgramCapacity.has(certificate.bodyId)
    )
      return false;
    const actualUsed = this.entityShenshiUsed(body.id);
    if (certificate.occupiedShenshi !== actualUsed) return false;
    this.finiteProgramCapacity.set(certificate.bodyId, { ...certificate });
    this.finiteProgramInstallations.set(certificate.bodyId, {
      bodyId: certificate.bodyId,
      programHash: program.astHash,
      measuredPageBytes: actualPageBytes,
      occupiedBefore: actualUsed,
      reservedPeakShenshi: installPeak,
      occupiedAtInstallPeak: actualUsed + installPeak,
      availableAfterInstallPeak: body.attr.shenshiMax - actualUsed - installPeak,
    });
    return true;
  }

  finiteProgramInstallation(bodyId: number): WorldProgramInstallation | null {
    const installed = this.finiteProgramInstallations.get(bodyId);
    return installed ? { ...installed } : null;
  }

  registerB4ReadSession(session: WorldB4ReadSession): boolean {
    if (
      !Number.isSafeInteger(session.id) ||
      session.id <= 0 ||
      this.b4ReadSessions.has(session.id) ||
      [...this.b4ReadSessions.values()].some(
        (existing) => existing.requestId === session.requestId,
      ) ||
      !/^[a-zA-Z0-9_-]{1,96}$/.test(session.requestId) ||
      session.priceVersion !== B4_PRICE_VERSION ||
      session.payerId !== session.executorId ||
      this.finiteGrants.get(session.payerGrantId)?.issuerId !== session.payerId ||
      session.endpointVersions.length !== B4_AUDIT.length ||
      session.endpointGrantIds.length !== B4_AUDIT.length ||
      this.finiteProgramCapacity.get(session.executorId)?.programHash !== session.programHash ||
      (this.finiteProgramCapacity.get(session.executorId)?.profile !== undefined &&
        this.finiteProgramCapacity.get(session.executorId)?.profile !== 'B4') ||
      !this.finiteManaFunding.some((fact) => fact.payerId === session.payerId && fact.amount >= 50)
    )
      return false;
    this.b4ReadSessions.set(session.id, {
      ...session,
      endpointVersions: session.endpointVersions.map((versions) => ({ ...versions })),
      endpointGrantIds: session.endpointGrantIds.map((grants) => ({ ...grants })),
    });
    return true;
  }

  registerFiniteAnchor(certificate: WorldAnchorCertificate): boolean {
    if (
      !this.finiteInitialOpen ||
      !certificate.id ||
      !certificate.reactionEndpointId ||
      !certificate.version ||
      this.finiteAnchors.has(certificate.id) ||
      !Number.isFinite(certificate.loadLower) ||
      certificate.loadLower < 0
    )
      return false;
    this.finiteAnchors.set(certificate.id, { ...certificate });
    this.finiteAnchorImpulses.set(certificate.id, { x: 0, y: 0 });
    return true;
  }

  finiteAnchorReactionState(id: string): Vec2 | null {
    const impulse = this.finiteAnchorImpulses.get(id);
    return impulse ? { ...impulse } : null;
  }

  registerB4ActionPlan(plan: WorldB4ActionPlan): boolean {
    const session = this.b4ReadSessions.get(plan.sessionId);
    const capacity = this.finiteProgramCapacity.get(plan.executorId);
    const targetBody = this.naturalBodies.get(plan.targetId);
    const corpseLot = this.finiteMaterial.get(plan.corpseLotId);
    const naturalStructure = this.naturalContacts.some((contact) =>
      contact.materialResults.some(
        (change) =>
          change.bodyId === plan.targetId &&
          change.result === 'fractured' &&
          change.structureFactId === plan.naturalStructureFactId &&
          change.attachedAfter === targetBody?.attachedK0,
      ),
    );
    const numbers = [
      plan.loadEnergyFromSource,
      plan.loadEnergyToPackage,
      plan.loadHeat,
      plan.loadMaterial,
      plan.actionEnergy,
      plan.structureWork,
      plan.actionHeat,
      plan.shellMaterial,
      plan.wasteMaterial,
      plan.auxiliaryDraw,
      plan.auxiliaryToWork,
      plan.auxiliaryHeat,
      plan.clampWork,
    ];
    if (
      !session ||
      this.b4ActionPlans.has(plan.sessionId) ||
      session.directScan ||
      session.requestId !== plan.requestId ||
      session.executorId !== plan.executorId ||
      session.payerId !== plan.payerId ||
      session.programHash !== plan.programHash ||
      plan.priceVersion !== B4_PRICE_VERSION ||
      capacity?.version !== plan.capacityVersion ||
      !this.entityById(plan.targetId) ||
      !targetBody ||
      targetBody.certificate.materialInventoryId !== plan.corpseLotId ||
      !corpseLot ||
      corpseLot.ownerId !== plan.targetId ||
      corpseLot.kind !== 'k0' ||
      corpseLot.version !== targetBody.materialVersion ||
      targetBody.attachedK0 !== corpseLot.quantity ||
      !naturalStructure ||
      !this.finiteAnchors.has(plan.anchorId) ||
      !numbers.every((value) => Number.isSafeInteger(value) && value >= 0) ||
      plan.loadEnergyFromSource !== plan.loadEnergyToPackage + plan.loadHeat ||
      plan.auxiliaryDraw !== plan.auxiliaryToWork + plan.auxiliaryHeat ||
      plan.clampWork > plan.auxiliaryToWork ||
      plan.actionEnergy !== plan.structureWork + plan.actionHeat ||
      plan.loadMaterial !== plan.shellMaterial + plan.wasteMaterial ||
      plan.loadEnergyFromSource !== 44 ||
      plan.loadEnergyToPackage !== 32 ||
      plan.loadHeat !== 12 ||
      plan.auxiliaryDraw !== 12 ||
      plan.auxiliaryToWork !== 8 ||
      plan.auxiliaryHeat !== 4 ||
      plan.clampWork !== 3 ||
      plan.loadMaterial !== 2 ||
      plan.actionEnergy !== 24 ||
      plan.structureWork !== 12 ||
      plan.actionHeat !== 12 ||
      plan.shellMaterial !== 1 ||
      plan.wasteMaterial !== 1 ||
      plan.sourceLotId !== 'source-B1-work' ||
      plan.packageLotId !== 'EL-B1-B4' ||
      plan.auxiliaryLotId !== 'Aux-B1-01' ||
      plan.depotLotId !== 'Depot-k0-01' ||
      plan.corpseLotId !== 'Corpse-k0-01' ||
      plan.wasteLotId !== 'waste-B4-k0-01' ||
      plan.heatSinkId !== 'heat-B1-B4-01' ||
      new Set([plan.depotLotId, plan.stagingLotId, plan.corpseLotId, plan.wasteLotId]).size !== 4 ||
      !Number.isFinite(plan.impulse.x) ||
      !Number.isFinite(plan.impulse.y) ||
      Math.hypot(plan.impulse.x, plan.impulse.y) === 0 ||
      !plan.sourceLotId ||
      !plan.packageLotId ||
      !plan.sliceId ||
      !plan.auxiliaryLotId ||
      !plan.auxiliaryWorkingLotId ||
      !plan.clampSpentLotId ||
      !plan.auxiliaryHeatSinkId ||
      !plan.clampHeatSinkId ||
      !plan.naturalStructureFactId ||
      !plan.physicalGrantId ||
      !plan.payerGrantId ||
      !plan.repairedMaterialVersion ||
      !plan.repairedStructureVersion ||
      !plan.sourceTransferGrantId ||
      !plan.auxiliaryTransferGrantId ||
      !plan.clampTransferGrantId ||
      !plan.materialTransferGrantId
    )
      return false;
    this.b4ActionPlans.set(plan.sessionId, { ...plan, impulse: { ...plan.impulse } });
    return true;
  }

  private b4ReadsFresh(requestId: string, start: number, end: number): boolean {
    for (let index = start; index < end; index++) {
      const readId = B4_AUDIT[index].readId;
      const receipt = this.b4ReadReceipts.find(
        (entry) => entry.requestId === requestId && entry.readId === readId,
      );
      if (!receipt) return false;
      for (const sample of receipt.raw) {
        const endpoint = this.finiteAuditEndpoints.get(sample.endpointId);
        if (!endpoint || endpoint.version() !== sample.version) return false;
      }
    }
    return true;
  }

  /** The action slice is bounded by independent R0 and sealed R3 samples, not a plan's target values. */
  private b4MeasuredSlice(requestId: string): number | null {
    const sample = (readId: string, endpointId: string, field: string) => {
      const entry = this.b4ReadReceipts.find(
        (receipt) => receipt.requestId === requestId && receipt.readId === readId,
      );
      const raw = entry?.raw.find((item) => item.endpointId === endpointId && item.field === field);
      return raw && typeof raw.value === 'number' ? raw : null;
    };
    const s0 = sample('Read-B4-main-R0', 'source-B1-work', 'energyRaw');
    const p0 = sample('Read-B4-main-R0', 'EL-B1-B4', 'energyRaw');
    const h0 = sample('Read-B4-heat-R0', 'heat-B1-B4-01', 'energyRaw');
    const s3 = sample('Read-B4-main-R3', 'source-B1-work', 'energyRaw');
    const p3 = sample('Read-B4-main-R3', 'EL-B1-B4', 'energyRaw');
    const h3 = sample('Read-B4-heat-R3', 'heat-B1-B4-01', 'energyRaw');
    if (!s0 || !p0 || !h0 || !s3 || !p3 || !h3) return null;
    const sourceLower = (s0.value as number) - s0.error - (s3.value as number) - s3.error;
    const heatUpper = (h3.value as number) + h3.error - (h0.value as number) + h0.error;
    const packageLower = (p3.value as number) - p3.error - (p0.value as number) - p0.error;
    const sealedLower = (p3.value as number) - p3.error;
    return Math.min(sourceLower - heatUpper, packageLower, sealedLower);
  }

  vmB4Load(
    sessionId: number,
    programHash: string | undefined,
    charge: (payerId: number, mana: number, ticks: number, kind: string) => boolean,
  ): boolean {
    const plan = this.b4ActionPlans.get(sessionId);
    if (!plan || !programHash || plan.programHash !== programHash) return false;
    if (this.b4Loaded.has(plan.requestId)) return true;
    const source = this.finiteEnergy.get(plan.sourceLotId);
    const pack = this.finiteEnergy.get(plan.packageLotId);
    const auxiliary = this.finiteEnergy.get(plan.auxiliaryLotId);
    const work = this.finiteEnergy.get(plan.auxiliaryWorkingLotId);
    const clampSpent = this.finiteEnergy.get(plan.clampSpentLotId);
    const depot = this.finiteMaterial.get(plan.depotLotId);
    const staging = this.finiteMaterial.get(plan.stagingLotId);
    const loadSink = this.finiteHeat.get(plan.heatSinkId);
    const auxSink = this.finiteHeat.get(plan.auxiliaryHeatSinkId);
    const clampSink = this.finiteHeat.get(plan.clampHeatSinkId);
    const loadHeatBySink = new Map<string, number>();
    for (const [id, amount] of [
      [plan.heatSinkId, plan.loadHeat],
      [plan.auxiliaryHeatSinkId, plan.auxiliaryHeat],
      [plan.clampHeatSinkId, plan.clampWork],
    ] as const)
      loadHeatBySink.set(id, (loadHeatBySink.get(id) ?? 0) + amount);
    const heatFits = [...loadHeatBySink].every(([id, amount]) => {
      const sink = this.finiteHeat.get(id);
      return !!sink && sink.energy + amount <= sink.capacity;
    });
    if (
      this.b4ReadCursor.get(plan.requestId) !== 4 ||
      !this.b4ReadsFresh(plan.requestId, 0, 4) ||
      !source ||
      !this.b4HasAcquiredSource(plan.sourceLotId) ||
      !pack ||
      !auxiliary ||
      !this.b4HasAcquiredSource(plan.auxiliaryLotId) ||
      !work ||
      !clampSpent ||
      !depot ||
      !staging ||
      !loadSink ||
      !auxSink ||
      !clampSink ||
      new Set([
        plan.sourceLotId,
        plan.packageLotId,
        plan.auxiliaryLotId,
        plan.auxiliaryWorkingLotId,
        plan.clampSpentLotId,
      ]).size !== 5 ||
      source.energy < plan.loadEnergyFromSource ||
      auxiliary.energy < plan.auxiliaryDraw ||
      depot.quantity < plan.loadMaterial ||
      pack.energy !== 0 ||
      work.energy !== 0 ||
      clampSpent.energy !== 0 ||
      staging.quantity !== 0 ||
      !heatFits ||
      !this.validFiniteGrant(
        plan.sourceTransferGrantId,
        plan.executorId,
        'energy-transfer',
        plan.sourceLotId,
        plan.packageLotId,
        plan.loadEnergyFromSource,
      ) ||
      !this.validFiniteGrant(
        plan.auxiliaryTransferGrantId,
        plan.executorId,
        'energy-transfer',
        plan.auxiliaryLotId,
        plan.auxiliaryWorkingLotId,
        plan.auxiliaryDraw,
      ) ||
      !this.validFiniteGrant(
        plan.clampTransferGrantId,
        plan.executorId,
        'energy-transfer',
        plan.auxiliaryWorkingLotId,
        plan.clampSpentLotId,
        plan.clampWork,
      ) ||
      !this.validFiniteGrant(
        plan.materialTransferGrantId,
        plan.executorId,
        'material-transfer',
        plan.depotLotId,
        plan.stagingLotId,
        plan.loadMaterial,
      ) ||
      !this.validFiniteGrant(plan.payerGrantId, plan.executorId, 'pay', 'acct-B1-B4', null, 5)
    )
      return false;
    if (!charge(plan.payerId, 5, 10, 'b4-load')) return false;
    const suffix = `${plan.requestId}-V1`;
    const main = this.transferFiniteEnergy(
      `LoadTx-B4-main-${plan.requestId}`,
      plan.executorId,
      plan.sourceLotId,
      plan.packageLotId,
      plan.loadEnergyFromSource,
      plan.loadHeat,
      plan.heatSinkId,
      plan.sourceTransferGrantId,
      `${source.version}-${suffix}`,
      `${pack.version}-${suffix}`,
      `${loadSink.version}-${suffix}`,
    );
    const aux = this.transferFiniteEnergy(
      `LoadTx-B4-aux-${plan.requestId}`,
      plan.executorId,
      plan.auxiliaryLotId,
      plan.auxiliaryWorkingLotId,
      plan.auxiliaryDraw,
      plan.auxiliaryHeat,
      plan.auxiliaryHeatSinkId,
      plan.auxiliaryTransferGrantId,
      `${auxiliary.version}-${suffix}`,
      `${work.version}-${suffix}`,
      `${auxSink.version}-${suffix}`,
    );
    const clamp =
      aux &&
      this.transferFiniteEnergy(
        `LoadTx-B4-clamp-${plan.requestId}`,
        plan.executorId,
        plan.auxiliaryWorkingLotId,
        plan.clampSpentLotId,
        plan.clampWork,
        plan.clampWork,
        plan.clampHeatSinkId,
        plan.clampTransferGrantId,
        `${work.version}-${suffix}-clamped`,
        `${clampSpent.version}-${suffix}`,
        `${clampSink.version}-${suffix}`,
      );
    const material = this.transferFiniteMaterial(
      `LoadTx-B4-k0-${plan.requestId}`,
      plan.executorId,
      plan.depotLotId,
      plan.stagingLotId,
      plan.loadMaterial,
      plan.materialTransferGrantId,
      `${depot.version}-${suffix}`,
      `${staging.version}-${suffix}`,
    );
    if (!main || !aux || !clamp || !material) return false;
    this.b4Loaded.add(plan.requestId);
    this.finiteGrantUsed.set(
      plan.payerGrantId,
      (this.finiteGrantUsed.get(plan.payerGrantId) ?? 0) + 5,
    );
    this.b4StageReceipts.push({
      receiptId: `receipt-B4-load-${plan.requestId}-v1`,
      requestId: plan.requestId,
      phase: 'load',
      payerId: plan.payerId,
      mana: 5,
      ticks: 10,
      payerGrantId: plan.payerGrantId,
    });
    return true;
  }

  vmB4Seal(sessionId: number, programHash: string | undefined): boolean {
    const plan = this.b4ActionPlans.get(sessionId);
    if (!plan || !programHash || plan.programHash !== programHash) return false;
    if (this.b4Sealed.has(plan.requestId)) return true;
    const pack = this.finiteEnergy.get(plan.packageLotId);
    if (
      !this.b4Loaded.has(plan.requestId) ||
      this.b4ReadCursor.get(plan.requestId) !== 12 ||
      !this.b4ReadsFresh(plan.requestId, 8, 12) ||
      !pack ||
      pack.energy < plan.actionEnergy ||
      this.b4RetiredSlices.has(plan.sliceId)
    )
      return false;
    this.finiteEnergy.set(plan.packageLotId, {
      ...pack,
      version: `seal-B4-${plan.requestId}-R3`,
    });
    this.b4Sealed.add(plan.requestId);
    return true;
  }

  vmB4Lock(sessionId: number, programHash: string | undefined): boolean {
    const plan = this.b4ActionPlans.get(sessionId);
    if (!plan || !programHash || plan.programHash !== programHash) return false;
    if (this.b4Locked.has(plan.requestId)) return true;
    const body = this.entityById(plan.executorId);
    const target = this.entityById(plan.targetId);
    const pack = this.finiteEnergy.get(plan.packageLotId);
    const staged = this.finiteMaterial.get(plan.stagingLotId);
    const corpse = this.finiteMaterial.get(plan.corpseLotId);
    const waste = this.finiteMaterial.get(plan.wasteLotId);
    const anchor = this.finiteAnchors.get(plan.anchorId);
    const capacity = this.finiteProgramCapacity.get(plan.executorId);
    const natural = this.naturalContacts.find((contact) =>
      contact.materialResults.some(
        (change) =>
          change.bodyId === plan.targetId && change.structureFactId === plan.naturalStructureFactId,
      ),
    );
    const gap = this.naturalBodies.get(plan.targetId);
    if (
      !body ||
      !target ||
      !this.entityAvailable(body) ||
      !this.b4Sealed.has(plan.requestId) ||
      this.b4ReadCursor.get(plan.requestId) !== 16 ||
      !this.b4ReadsFresh(plan.requestId, 12, 16) ||
      !natural ||
      !gap ||
      !pack ||
      !staged ||
      !corpse ||
      gap.certificate.materialInventoryId !== plan.corpseLotId ||
      corpse.ownerId !== plan.targetId ||
      corpse.kind !== 'k0' ||
      corpse.version !== gap.materialVersion ||
      !natural.materialResults.some(
        (change) =>
          change.bodyId === plan.targetId &&
          change.result === 'fractured' &&
          change.structureFactId === plan.naturalStructureFactId &&
          change.attachedAfter === gap.attachedK0,
      ) ||
      !waste ||
      !anchor ||
      !capacity ||
      capacity.version !== plan.capacityVersion ||
      capacity.programHash !== programHash ||
      gap.attachedK0 === null ||
      gap.attachedK0 !== corpse.quantity ||
      gap.certificate.attachedK0 === null ||
      gap.certificate.attachedK0 - gap.attachedK0 !== plan.shellMaterial ||
      (this.b4MeasuredSlice(plan.requestId) ?? -1) < plan.actionEnergy ||
      pack.energy < plan.actionEnergy ||
      staged.quantity < plan.loadMaterial ||
      waste.quantity !== 0 ||
      waste.capacity === undefined ||
      waste.capacity - waste.quantity < plan.wasteMaterial ||
      anchor.loadLower < plan.structureWork ||
      Math.hypot(body.x - target.x, body.y - target.y) >
        gap.certificate.radius +
          (this.naturalBodies.get(body.id)?.certificate.radius ?? 0) +
          (this.naturalContactPolicy?.geometryEpsilon ?? 0) ||
      this.b4RetiredSlices.has(plan.sliceId) ||
      (this.b4SliceLocks.has(plan.sliceId) &&
        this.b4SliceLocks.get(plan.sliceId) !== plan.requestId) ||
      !this.validFiniteGrant(
        plan.physicalGrantId,
        plan.executorId,
        'action',
        plan.packageLotId,
        plan.corpseLotId,
        1,
      ) ||
      !this.validFiniteGrant(plan.payerGrantId, plan.executorId, 'pay', 'acct-B1-B4', null, 15)
    )
      return false;
    if (!this.resourceLedger.reserveMana(plan.payerId, `b4:${plan.requestId}`, 15)) return false;
    this.b4Locked.add(plan.requestId);
    this.b4SliceLocks.set(plan.sliceId, plan.requestId);
    this.b4LockSnapshots.set(plan.requestId, {
      shellVersion: gap.materialVersion,
      packageVersion: pack.version,
      anchorVersion: anchor.version,
      contactCount: this.naturalContacts.length,
      executorVelocity: { ...body.velocity },
      targetVelocity: { ...target.velocity },
    });
    return true;
  }

  /** Release a cast's unspent action/POST reservation without undoing paid work. */
  releaseB4Lock(sessionId: number, programHash: string | undefined): void {
    const plan = this.b4ActionPlans.get(sessionId);
    if (!plan || plan.programHash !== programHash) return;
    this.resourceLedger.releaseManaReservation(plan.payerId, `b4:${plan.requestId}`);
    this.b4Locked.delete(plan.requestId);
    this.b4LockSnapshots.delete(plan.requestId);
    if (this.b4SliceLocks.get(plan.sliceId) === plan.requestId)
      this.b4SliceLocks.delete(plan.sliceId);
  }

  vmB4Action(
    sessionId: number,
    programHash: string | undefined,
    charge: (
      payerId: number,
      mana: number,
      ticks: number,
      kind: string,
      reservationId?: string,
    ) => boolean,
  ): boolean {
    const plan = this.b4ActionPlans.get(sessionId);
    if (!plan || !programHash || plan.programHash !== programHash) return false;
    if (this.b4ActionFacts.some((fact) => fact.requestId === plan.requestId)) return true;
    const reject = (): false => {
      this.resourceLedger.releaseManaReservation(plan.payerId, `b4:${plan.requestId}`);
      this.b4Locked.delete(plan.requestId);
      this.b4LockSnapshots.delete(plan.requestId);
      if (this.b4SliceLocks.get(plan.sliceId) === plan.requestId)
        this.b4SliceLocks.delete(plan.sliceId);
      return false;
    };
    const pack = this.finiteEnergy.get(plan.packageLotId);
    const heat = this.finiteHeat.get(plan.heatSinkId);
    const staged = this.finiteMaterial.get(plan.stagingLotId);
    const corpse = this.finiteMaterial.get(plan.corpseLotId);
    const waste = this.finiteMaterial.get(plan.wasteLotId);
    const shell = this.naturalBodies.get(plan.targetId);
    const executor = this.entityById(plan.executorId);
    const target = this.entityById(plan.targetId);
    const anchor = this.finiteAnchors.get(plan.anchorId);
    const snapshot = this.b4LockSnapshots.get(plan.requestId);
    const capacity = this.finiteProgramCapacity.get(plan.executorId);
    const executorMass = this.naturalBodies.get(plan.executorId)?.certificate.mass;
    const targetMass = shell?.certificate.mass;
    const executorVelocityAfter =
      executorMass && executor
        ? {
            x: executor.velocity.x - plan.impulse.x / executorMass,
            y: executor.velocity.y - plan.impulse.y / executorMass,
          }
        : null;
    const targetVelocityAfter =
      targetMass && target
        ? {
            x: target.velocity.x + plan.impulse.x / targetMass,
            y: target.velocity.y + plan.impulse.y / targetMass,
          }
        : null;
    const kinetic = (mass: number, velocity: Vec2) =>
      (mass * (velocity.x ** 2 + velocity.y ** 2)) / 2;
    const kineticBefore =
      executorMass && targetMass && executor && target
        ? kinetic(executorMass, executor.velocity) + kinetic(targetMass, target.velocity)
        : NaN;
    const kineticAfter =
      executorMass && targetMass && executorVelocityAfter && targetVelocityAfter
        ? kinetic(executorMass, executorVelocityAfter) + kinetic(targetMass, targetVelocityAfter)
        : NaN;
    if (
      !this.b4Locked.has(plan.requestId) ||
      this.b4SliceLocks.get(plan.sliceId) !== plan.requestId ||
      !pack ||
      !heat ||
      !staged ||
      !corpse ||
      !waste ||
      !shell ||
      shell.certificate.materialInventoryId !== plan.corpseLotId ||
      corpse.ownerId !== plan.targetId ||
      corpse.kind !== 'k0' ||
      corpse.version !== shell.materialVersion ||
      !executor ||
      !target ||
      !this.entityAvailable(executor) ||
      !anchor ||
      !snapshot ||
      !capacity ||
      capacity.programHash !== programHash ||
      capacity.version !== plan.capacityVersion ||
      snapshot.shellVersion !== shell.materialVersion ||
      snapshot.packageVersion !== pack.version ||
      snapshot.anchorVersion !== anchor.version ||
      snapshot.contactCount !== this.naturalContacts.length ||
      snapshot.executorVelocity.x !== executor.velocity.x ||
      snapshot.executorVelocity.y !== executor.velocity.y ||
      snapshot.targetVelocity.x !== target.velocity.x ||
      snapshot.targetVelocity.y !== target.velocity.y ||
      !executorVelocityAfter ||
      !targetVelocityAfter ||
      !Number.isFinite(kineticAfter) ||
      Math.abs(kineticAfter - kineticBefore) > 1e-9 ||
      shell.attachedK0 === null ||
      shell.attachedK0 !== corpse.quantity ||
      staged.quantity !== plan.shellMaterial + plan.wasteMaterial ||
      waste.capacity === undefined ||
      waste.capacity - waste.quantity < plan.wasteMaterial ||
      pack.energy < plan.actionEnergy ||
      heat.energy + plan.actionHeat > heat.capacity ||
      !this.validFiniteGrant(
        plan.physicalGrantId,
        plan.executorId,
        'action',
        plan.packageLotId,
        plan.corpseLotId,
        1,
      ) ||
      !this.validFiniteGrant(plan.payerGrantId, plan.executorId, 'pay', 'acct-B1-B4', null, 10)
    )
      return reject();
    if (!charge(plan.payerId, 10, 20, 'b4-action', `b4:${plan.requestId}`)) return reject();
    const receiptId = `receipt-B4-action-${plan.requestId}-v1`;
    const fact: WorldB4ActionFact = {
      id: `A-B1-B4-${plan.requestId}`,
      structureFactId: plan.repairedStructureVersion,
      requestId: plan.requestId,
      naturalStructureFactId: plan.naturalStructureFactId,
      sourceLotId: plan.sourceLotId,
      packageLotId: plan.packageLotId,
      sliceId: plan.sliceId,
      packageBefore: pack.energy,
      packageAfter: pack.energy - plan.actionEnergy,
      heatBefore: heat.energy,
      heatAfter: heat.energy + plan.actionHeat,
      corpseBefore: corpse.quantity,
      corpseAfter: corpse.quantity + plan.shellMaterial,
      stagingBefore: staged.quantity,
      stagingAfter: staged.quantity - plan.loadMaterial,
      wasteBefore: waste.quantity,
      wasteAfter: waste.quantity + plan.wasteMaterial,
      structureWork: plan.structureWork,
      impulsePair: [
        plan.impulse,
        {
          x: plan.impulse.x === 0 ? 0 : -plan.impulse.x,
          y: plan.impulse.y === 0 ? 0 : -plan.impulse.y,
        },
      ],
      reactionEndpointId: anchor.reactionEndpointId,
      executorVelocityBefore: { ...executor.velocity },
      executorVelocityAfter,
      targetVelocityBefore: { ...target.velocity },
      targetVelocityAfter,
      kineticBefore,
      kineticAfter,
      receiptId,
    };
    this.finiteEnergy.set(plan.packageLotId, {
      ...pack,
      energy: fact.packageAfter,
      version: `seal-B4-${plan.requestId}-retired`,
    });
    this.finiteHeat.set(plan.heatSinkId, {
      ...heat,
      energy: fact.heatAfter,
      version: `${heat.version}-action-${plan.requestId}`,
    });
    this.finiteMaterial.set(plan.stagingLotId, {
      ...staged,
      quantity: fact.stagingAfter,
      version: `${staged.version}-spent`,
    });
    this.finiteMaterial.set(plan.corpseLotId, {
      ...corpse,
      quantity: fact.corpseAfter,
      version: plan.repairedMaterialVersion,
    });
    this.finiteMaterial.set(plan.wasteLotId, {
      ...waste,
      quantity: fact.wasteAfter,
      version: `waste-B4-${plan.requestId}`,
    });
    shell.attachedK0 = fact.corpseAfter;
    shell.materialVersion = plan.repairedMaterialVersion;
    shell.panelAttached = true;
    executor.velocity = { ...executorVelocityAfter };
    target.velocity = { ...targetVelocityAfter };
    this.b4RetiredSlices.add(plan.sliceId);
    this.finiteGrantUsed.set(
      plan.payerGrantId,
      (this.finiteGrantUsed.get(plan.payerGrantId) ?? 0) + 10,
    );
    this.finiteGrantUsed.set(
      plan.physicalGrantId,
      (this.finiteGrantUsed.get(plan.physicalGrantId) ?? 0) + 1,
    );
    this.b4StageReceipts.push({
      receiptId,
      requestId: plan.requestId,
      phase: 'action',
      payerId: plan.payerId,
      mana: 10,
      ticks: 20,
      payerGrantId: plan.payerGrantId,
    });
    this.b4ActionFacts.push(fact);
    return true;
  }

  vmB4Read(
    sessionId: number,
    index: number,
    programHash: string | undefined,
    charge: (
      payerId: number,
      mana: number,
      ticks: number,
      kind: string,
      reservationId?: string,
    ) => boolean,
  ): boolean {
    const session = this.b4ReadSessions.get(sessionId);
    if (!session || !programHash || session.programHash !== programHash) return false;
    const plan = this.b4ActionPlans.get(sessionId);
    if (
      !session.directScan &&
      (!plan ||
        (index >= 4 && index < 12 && !this.b4Loaded.has(session.requestId)) ||
        (index >= 12 && index < 16 && !this.b4Sealed.has(session.requestId)) ||
        (index >= 16 && !this.b4ActionFacts.some((fact) => fact.requestId === session.requestId)))
    )
      return false;
    const receipt = this.executeB4Read(
      {
        requestId: session.requestId,
        executorId: session.executorId,
        payerId: session.payerId,
        payerGrantId: session.payerGrantId,
        programHash,
        priceVersion: session.priceVersion,
        index,
        endpointVersions: session.endpointVersions[index] ?? {},
        endpointGrantIds: session.endpointGrantIds[index] ?? {},
        directScan: session.directScan,
      },
      charge,
    );
    if (!receipt && index >= 16 && plan) {
      this.resourceLedger.releaseManaReservation(plan.payerId, `b4:${plan.requestId}`);
      this.b4Locked.delete(plan.requestId);
      this.b4LockSnapshots.delete(plan.requestId);
      if (this.b4SliceLocks.get(plan.sliceId) === plan.requestId)
        this.b4SliceLocks.delete(plan.sliceId);
    }
    if (receipt && index === 18 && plan) {
      this.resourceLedger.releaseManaReservation(plan.payerId, `b4:${plan.requestId}`);
      this.b4Locked.delete(plan.requestId);
      this.b4LockSnapshots.delete(plan.requestId);
      if (this.b4SliceLocks.get(plan.sliceId) === plan.requestId)
        this.b4SliceLocks.delete(plan.sliceId);
    }
    return !!receipt;
  }

  /** Resolve the fixed audit projection from this World's inventories and body certificates. */
  private finiteB4Field(
    executorId: number,
    endpointId: string,
    field: string,
  ): { value: number | string | boolean; error: number; version: string } | null {
    const energy = this.finiteEnergy.get(endpointId);
    const heat = this.finiteHeat.get(endpointId);
    const material = this.finiteMaterial.get(endpointId);
    const anchor = this.finiteAnchors.get(endpointId);
    const corpseLot = this.finiteMaterial.get('Corpse-k0-01');
    const target = corpseLot && this.naturalBodies.get(corpseLot.ownerId);
    const head = this.naturalBodies.get(executorId);
    const version =
      endpointId === 'Corpse-k0-01' || endpointId === 'port-corpse-k0-v0'
        ? target?.materialVersion
        : endpointId === 'head-B1-v0'
          ? head?.materialVersion
          : (energy?.version ?? heat?.version ?? material?.version ?? anchor?.version);
    if (!version) return null;
    let value: number | string | boolean | null | undefined;
    let error = 0;
    if (field === 'energyRaw') {
      value = energy?.energy ?? heat?.energy;
      error = energy?.error ?? 0;
    } else if (field === 'err') {
      value =
        energy?.error ??
        (heat ? 0 : undefined) ??
        (endpointId === 'head-B1-v0'
          ? head?.certificate.structuralError
          : endpointId === 'port-corpse-k0-v0'
            ? target?.certificate.structuralError
            : undefined);
    } else if (field === 'lotVersion') value = energy?.version ?? material?.version;
    else if (field === 'sliceState' && endpointId === 'EL-B1-B4')
      value = energy?.version.includes('retired')
        ? 'retired'
        : energy?.version.includes('R3')
          ? 'sealed'
          : 'available';
    else if (field === 'sealVersion' && endpointId === 'EL-B1-B4') value = energy?.version;
    else if (field === 'loadLower')
      value =
        anchor?.loadLower ??
        (endpointId === 'head-B1-v0'
          ? head?.certificate.headLoadLower
          : endpointId === 'port-corpse-k0-v0'
            ? target?.certificate.portLoadLower
            : undefined);
    else if (field === 'reactionEndpointId') value = anchor?.reactionEndpointId;
    else if (field === 'structureVersion') value = version;
    else if (field === 'integrityLower' && endpointId === 'head-B1-v0')
      value = head?.certificate.headIntegrityLower;
    else if (field === 'freeCapacityLower') value = heat ? heat.capacity - heat.energy : undefined;
    else if (field === 'sinkVersion' || field === 'environmentVersion') value = heat?.version;
    else if (field === 'Qk0Raw') {
      if (endpointId === 'Corpse-k0-01') {
        if (
          !target ||
          target.certificate.materialInventoryId !== endpointId ||
          target.attachedK0 !== material?.quantity
        )
          return null;
      }
      value = material?.quantity;
    } else if (field === 'availableQ') value = material?.quantity;
    else if (field === 'freeCapacityQ')
      value = material?.capacity === undefined ? undefined : material.capacity - material.quantity;
    else if (field === 'thresholdLow') value = target?.certificate.fractureThresholdLow;
    else if (field === 'thresholdHigh') value = target?.certificate.intactThresholdHigh;
    else if (field === 'gapQ')
      value =
        target?.certificate.attachedK0 === null || target?.attachedK0 === null
          ? undefined
          : (target?.certificate.attachedK0 ?? NaN) - (target?.attachedK0 ?? NaN);
    else if (field === 'materialVersion') value = target?.materialVersion;
    else if (field === 'apertureQ') value = target?.certificate.portApertureQ;
    else if (field === 'connectionVersion') value = target?.materialVersion;
    if (
      value === null ||
      value === undefined ||
      (typeof value === 'number' && !Number.isFinite(value)) ||
      !Number.isFinite(error) ||
      error < 0
    )
      return null;
    return { value, error, version };
  }

  executeB4Read(
    request: WorldB4ReadRequest,
    charge: (
      payerId: number,
      mana: number,
      ticks: number,
      kind: string,
      reservationId?: string,
    ) => boolean,
  ): WorldB4ReadReceipt | null {
    const descriptor = B4_AUDIT[request.index];
    const receiptId = descriptor && `receipt-B4-read-${descriptor.readId}-${request.requestId}-v1`;
    if (!descriptor || !receiptId || !/^[a-zA-Z0-9_-]{1,96}$/.test(request.requestId)) return null;
    const previous = this.b4ReadReceipts.find((receipt) => receipt.receiptId === receiptId);
    if (previous) return previous;
    const cursor = this.b4ReadCursor.get(request.requestId) ?? 0;
    if (request.directScan ? request.index !== 3 || cursor !== 0 : request.index !== cursor)
      return null;
    const body = this.entityById(request.executorId);
    const capacity = this.finiteProgramCapacity.get(request.executorId);
    if (
      !body ||
      !this.entityAvailable(body) ||
      !capacity ||
      request.programHash !== capacity.programHash ||
      request.priceVersion !== B4_PRICE_VERSION ||
      request.payerId !== request.executorId ||
      !this.finiteManaFunding.some(
        (fact) => fact.payerId === request.payerId && fact.amount >= 50,
      ) ||
      this.finiteGrants.get(request.payerGrantId)?.issuerId !== request.payerId ||
      this.naturalBodyState(request.executorId)?.materialVersion !== capacity.structureVersion ||
      !this.validFiniteGrant(
        request.payerGrantId,
        request.executorId,
        'pay',
        'acct-B1-B4',
        null,
        descriptor.mana,
      )
    )
      return null;
    const payer = this.byId(request.payerId);
    const reservationId = descriptor.phase === 'POST' ? `b4:${request.requestId}` : undefined;
    const reservedForThis =
      reservationId && this.resourceLedger.reservedManaFor(payer?.id ?? -1, reservationId);
    if (
      !payer?.alive ||
      payer.mana - this.resourceLedger.reservedMana(payer.id) + (reservedForThis || 0) <
        descriptor.mana
    )
      return null;
    const raw: WorldB4ReadReceipt['raw'][number][] = [];
    let emptyResult = false;
    for (const projection of descriptor.projection) {
      const endpoint = this.finiteAuditEndpoints.get(projection.endpointId);
      const grantId = request.endpointGrantIds[projection.endpointId];
      const grant = grantId && this.finiteGrants.get(grantId);
      if (
        !endpoint ||
        !grant ||
        this.revokedFiniteGrants.has(grantId) ||
        grant.kind !== 'read' ||
        grant.executorId !== request.executorId ||
        grant.sourceId !== projection.endpointId ||
        grant.phase !== descriptor.phase ||
        grant.maxAmount - (this.finiteGrantUsed.get(grantId) ?? 0) < 1 ||
        !projection.fields.every((field) => grant.fields?.includes(field)) ||
        (grant.revokeOnIssuerDeath && grant.issuerId !== null && !this.byId(grant.issuerId)?.alive)
      )
        return null;
      try {
        if (!endpoint.visibleTo(request.executorId)) return null;
        const version = endpoint.version();
        if (!version || version !== request.endpointVersions[projection.endpointId]) return null;
        if (request.directScan && projection.endpointId === 'Corpse-k0-01') {
          const gap = this.finiteB4Field(request.executorId, projection.endpointId, 'gapQ');
          if (!gap || typeof gap.value !== 'number') return null;
          emptyResult = gap.value === 0;
        }
        for (const field of projection.fields) {
          const actual = this.finiteB4Field(request.executorId, projection.endpointId, field);
          if (!actual || actual.version !== version) return null;
          const value = endpoint.read(field);
          const error = endpoint.error(field);
          if (
            value === null ||
            (typeof value === 'number' && !Number.isFinite(value)) ||
            !Number.isFinite(error) ||
            error !== actual.error ||
            value !== actual.value
          )
            return null;
          raw.push({
            endpointId: projection.endpointId,
            field,
            value: actual.value,
            error: actual.error,
            version: actual.version,
            grantId,
          });
        }
      } catch {
        return null;
      }
    }
    if (
      !charge(
        request.payerId,
        descriptor.mana,
        descriptor.ticks,
        `b4-read:${descriptor.readId}`,
        reservationId,
      )
    )
      return null;
    const receipt: WorldB4ReadReceipt = {
      receiptId,
      readId: descriptor.readId,
      requestId: request.requestId,
      payerId: request.payerId,
      payerGrantId: request.payerGrantId,
      priceVersion: request.priceVersion,
      mana: descriptor.mana,
      ticks: descriptor.ticks,
      sampleVersion: `sample-${descriptor.readId}-${this.b4ReadReceipts.length + 1}`,
      emptyResult,
      raw,
    };
    this.b4ReadReceipts.push(receipt);
    this.finiteGrantUsed.set(
      request.payerGrantId,
      (this.finiteGrantUsed.get(request.payerGrantId) ?? 0) + descriptor.mana,
    );
    for (const grantId of new Set(
      descriptor.projection.map(({ endpointId }) => request.endpointGrantIds[endpointId]),
    )) {
      if (!grantId) continue;
      this.finiteGrantUsed.set(grantId, (this.finiteGrantUsed.get(grantId) ?? 0) + 1);
    }
    if (!request.directScan) this.b4ReadCursor.set(request.requestId, cursor + 1);
    return receipt;
  }

  registerFiniteGrant(grant: WorldFiniteGrant): boolean {
    const sourceOwner =
      grant.sourceId &&
      (grant.kind === 'material-transfer'
        ? this.finiteMaterial.get(grant.sourceId)?.ownerId
        : grant.kind === 'contact'
          ? this.naturalBodies.has(Number(grant.sourceId))
            ? Number(grant.sourceId)
            : undefined
          : this.finiteEnergy.get(grant.sourceId)?.ownerId);
    if (
      !grant.id ||
      !grant.version ||
      !this.entityById(grant.executorId) ||
      (grant.issuerId !== null && !this.byId(grant.issuerId)) ||
      !Number.isFinite(grant.maxAmount) ||
      grant.maxAmount <= 0 ||
      (['energy-transfer', 'material-transfer', 'action', 'contact'].includes(grant.kind) &&
        sourceOwner !== grant.issuerId) ||
      this.finiteGrants.has(grant.id)
    )
      return false;
    this.finiteGrants.set(grant.id, { ...grant });
    return true;
  }

  revokeFiniteGrant(grantId: string): boolean {
    if (!this.finiteGrants.has(grantId)) return false;
    this.revokedFiniteGrants.add(grantId);
    return true;
  }

  private validFiniteGrant(
    grantId: string,
    executorId: number,
    kind: WorldFiniteGrant['kind'],
    sourceId: string | null,
    targetId: string | null,
    amount: number,
  ): boolean {
    const grant = this.finiteGrants.get(grantId);
    const executor = this.entityById(executorId);
    return (
      !!grant &&
      !!executor &&
      this.entityAvailable(executor) &&
      !this.revokedFiniteGrants.has(grantId) &&
      grant.executorId === executorId &&
      grant.kind === kind &&
      grant.sourceId === sourceId &&
      grant.targetId === targetId &&
      grant.maxAmount - (this.finiteGrantUsed.get(grantId) ?? 0) >= amount &&
      (!grant.revokeOnIssuerDeath || grant.issuerId === null || !!this.byId(grant.issuerId)?.alive)
    );
  }

  registerFiniteEnergyInventory(inventory: WorldEnergyInventory): boolean {
    if (
      !this.finiteInitialOpen ||
      !inventory.id ||
      !inventory.version ||
      !inventory.originFactId ||
      !this.entityById(inventory.ownerId) ||
      this.finiteEnergy.has(inventory.id) ||
      !Number.isSafeInteger(inventory.energy) ||
      inventory.energy < 0 ||
      !Number.isSafeInteger(inventory.error) ||
      inventory.error < 0
    )
      return false;
    this.finiteEnergy.set(inventory.id, { ...inventory });
    return true;
  }

  /** A first-batch reservoir is measured from a finite body's height and mass. */
  registerFinitePotentialSource(source: WorldPotentialSource): boolean {
    const body = this.entityById(source.bodyId);
    const mass = this.naturalBodies.get(source.bodyId)?.certificate.mass;
    const anchor = this.finiteAnchors.get(source.anchorId);
    const height = body ? Math.abs(body.y - source.referenceY) : NaN;
    const raw = mass ? mass * source.gravity * height * 12 : NaN;
    const energy = Math.round(raw);
    if (
      !this.finiteInitialOpen ||
      !body ||
      !mass ||
      !anchor ||
      !Number.isFinite(source.gravity) ||
      source.gravity <= 0 ||
      !Number.isFinite(source.referenceY) ||
      !Number.isSafeInteger(source.error) ||
      source.error < 0 ||
      !Number.isSafeInteger(energy) ||
      energy <= 0 ||
      Math.abs(raw - energy) > 1e-8 ||
      anchor.loadLower < mass * source.gravity ||
      this.finitePotentialSources.has(source.id)
    )
      return false;
    if (
      !this.registerFiniteEnergyInventory({
        id: source.id,
        ownerId: source.ownerId,
        energy,
        error: source.error,
        version: source.version,
        originFactId: `potential-${source.id}-${source.version}`,
      })
    )
      return false;
    this.finitePotentialSources.set(source.id, { ...source });
    return true;
  }

  /** B4's working inventory must be filled by an actual, single-use transfer from a separate reservoir. */
  private b4HasAcquiredSource(id: string): boolean {
    const inventory = this.finiteEnergy.get(id);
    return (
      !!inventory &&
      this.finiteEnergyTransfers.some(
        (fact) =>
          fact.toId === id &&
          fact.id === inventory.originFactId &&
          fact.fromId !== id &&
          this.finitePotentialSources.has(fact.fromId) &&
          !!fact.potentialMove &&
          fact.toAfter === inventory.energy,
      )
    );
  }

  /** Transfer mana between real Actor balances, recording the debit and net receipt. */
  fundFiniteMana(
    id: string,
    fromId: number,
    payerId: number,
    amount: number,
  ): WorldManaFundingFact | null {
    const from = this.byId(fromId),
      payer = this.byId(payerId);
    if (
      !id ||
      this.finiteManaFunding.some((fact) => fact.id === id) ||
      !from?.alive ||
      !payer?.alive ||
      fromId === payerId ||
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      from.mana < amount ||
      payer.mana + amount > payer.attr.manaMax ||
      this.resourceLedger.reservedMana(fromId) > 0
    )
      return null;
    const fact: WorldManaFundingFact = {
      id,
      fromId,
      payerId,
      amount,
      fromBefore: from.mana,
      fromAfter: from.mana - amount,
      payerBefore: payer.mana,
      payerAfter: payer.mana + amount,
    };
    from.mana = fact.fromAfter;
    payer.mana = fact.payerAfter;
    this.finiteManaFunding.push(fact);
    return fact;
  }

  /** Fixed first-batch drive session; samples and actions remain owned by this World. */
  registerFiniteDriveSession(session: WorldDriveSession): boolean {
    const ids = DRIVE_READ_IDS[session.kind];
    const capacity = this.finiteProgramCapacity.get(session.executorId);
    const funded = (payerId: number, amount: number) =>
      this.finiteManaFunding.some((fact) => fact.payerId === payerId && fact.amount >= amount);
    if (
      !ids ||
      !Number.isSafeInteger(session.id) ||
      session.id <= 0 ||
      this.driveSessions.has(session.id) ||
      [...this.driveSessions.values()].some(
        (existing) => existing.requestId === session.requestId,
      ) ||
      !/^[a-zA-Z0-9_-]{1,96}$/.test(session.requestId) ||
      !this.naturalBodies.has(session.executorId) ||
      !this.naturalBodies.has(session.targetId) ||
      (session.kind === 'D1' &&
        (!session.reactionBodyId ||
          session.reactionBodyId === session.targetId ||
          !this.naturalBodies.has(session.reactionBodyId) ||
          !session.reactionGrantId)) ||
      capacity?.version !== session.capacityVersion ||
      capacity.programHash !== session.programHash ||
      capacity.profile !== session.kind ||
      this.naturalBodies.get(session.executorId)?.materialVersion !== capacity.structureVersion ||
      session.readGrantIds.length !== ids.length ||
      this.finiteEnergy.get(session.sourceId)?.energy !== 0 ||
      this.finiteEnergy.get(session.auxiliarySourceId)?.energy !== 0 ||
      !this.finitePotentialSources.has(session.mainPotentialId) ||
      !this.finitePotentialSources.has(session.auxiliaryPotentialId) ||
      this.finiteEnergy.get(session.packageId)?.energy !== 0 ||
      this.finiteEnergy.get(session.auxiliaryWorkingId)?.energy !== 0 ||
      this.finiteEnergy.get(session.auxiliarySpentId)?.energy !== 0 ||
      !this.finiteHeat.has(session.heatSinkId) ||
      !this.finiteHeat.has(session.mainAcquisitionHeatSinkId) ||
      !this.finiteHeat.has(session.auxiliaryAcquisitionHeatSinkId) ||
      !this.finiteHeat.has(session.auxiliaryHeatSinkId) ||
      !this.finiteHeat.has(session.clampHeatSinkId) ||
      !this.finiteHeat.has(session.actionHeatSinkId) ||
      !this.finiteHeat.has(session.environmentHeatSinkId) ||
      !this.finiteAnchors.has(session.anchorId) ||
      !Number.isFinite(session.impulse.x) ||
      !Number.isFinite(session.impulse.y) ||
      Math.hypot(session.impulse.x, session.impulse.y) === 0 ||
      !funded(session.payerId, session.kind === 'J1' ? 32 : 40) ||
      this.finiteGrants.get(session.payerGrantId)?.issuerId !== session.payerId ||
      (session.kind === 'J1' &&
        (!session.p0Id ||
          !session.p2Id ||
          new Set([session.payerId, session.p0Id, session.p2Id]).size !== 3 ||
          !funded(session.p0Id, 1) ||
          !funded(session.p2Id, 2) ||
          this.finiteGrants.get(session.p0GrantId ?? '')?.issuerId !== session.p0Id ||
          this.finiteGrants.get(session.p2GrantId ?? '')?.issuerId !== session.p2Id))
    )
      return false;
    this.driveSessions.set(session.id, {
      ...session,
      readGrantIds: session.readGrantIds.map((grants) => ({ ...grants })),
      impulse: { ...session.impulse },
    });
    this.driveSnapshots.set(session.requestId, {
      targetStructure: this.naturalBodies.get(session.targetId)!.materialVersion,
      targetVelocity: { ...this.entityById(session.targetId)!.velocity },
      anchorVersion: this.finiteAnchors.get(session.anchorId)!.version,
    });
    return true;
  }

  private driveReadsFresh(session: WorldDriveSession): boolean {
    const end = session.kind === 'J1' ? 13 : 12;
    for (let index = 3; index < end; index++) {
      const receipt = this.driveReadReceipts.find(
        (r) =>
          r.requestId === session.requestId && r.readId === DRIVE_READ_IDS[session.kind][index],
      );
      if (!receipt) return false;
      // R1/R2 are immutable paid history; only the final R3 barrier must still
      // match the live endpoints after sealing. Earlier phase versions changed
      // legitimately during the same transaction.
      if (index < 9) continue;
      const samples = this.driveReadEndpoints(session, index);
      if (
        !samples ||
        receipt.samples.length !== samples.length ||
        receipt.samples.some((paid, i) => {
          const actual = samples[i];
          const grant = this.finiteGrants.get(paid.grantId);
          return (
            paid.endpointId !== actual.id ||
            paid.field !== actual.field ||
            paid.version !== actual.version ||
            paid.value !== actual.value ||
            paid.error !== actual.error ||
            !grant ||
            this.revokedFiniteGrants.has(paid.grantId) ||
            (grant.revokeOnIssuerDeath &&
              grant.issuerId !== null &&
              !this.byId(grant.issuerId)?.alive)
          );
        })
      )
        return false;
    }
    return true;
  }

  private driveReadEndpoints(
    session: WorldDriveSession,
    index: number,
  ):
    | {
        id: string;
        value: number;
        version: string;
        error: number;
        field: 'energyRaw' | 'loadLower';
      }[]
    | null {
    const name = DRIVE_READ_IDS[session.kind][index];
    if (!name) return null;
    const energy = (id: string) => {
      const lot = this.finiteEnergy.get(id);
      return lot
        ? {
            id,
            value: lot.energy,
            version: lot.version,
            error: lot.error,
            field: 'energyRaw' as const,
          }
        : null;
    };
    const heat = (id: string) => {
      const sink = this.finiteHeat.get(id);
      return sink
        ? { id, value: sink.energy, version: sink.version, error: 0, field: 'energyRaw' as const }
        : null;
    };
    const anchor = () => {
      const body = this.finiteAnchors.get(session.anchorId);
      return body
        ? {
            id: session.anchorId,
            value: body.loadLower,
            version: body.version,
            error: 0,
            field: 'loadLower' as const,
          }
        : null;
    };
    const contact = (id: number | undefined) => {
      const body = id === undefined ? undefined : this.naturalBodies.get(id);
      const load = body?.certificate.contactLoadLower;
      return body && load !== undefined
        ? {
            id: String(id),
            value: load,
            version: body.materialVersion,
            error: body.certificate.structuralError ?? 0,
            field: 'loadLower' as const,
          }
        : null;
    };
    const samples =
      name.endsWith('POST-H-R2') || name.endsWith('POST-H')
        ? [heat(session.actionHeatSinkId), heat(session.environmentHeatSinkId)]
        : name.endsWith('H-R0')
          ? [
              heat(session.mainAcquisitionHeatSinkId),
              heat(session.auxiliaryAcquisitionHeatSinkId),
              heat(session.environmentHeatSinkId),
            ]
          : name.startsWith('JH-H-') || name.startsWith('D1-H-')
            ? [
                heat(session.heatSinkId),
                heat(session.auxiliaryHeatSinkId),
                heat(session.clampHeatSinkId),
                heat(session.environmentHeatSinkId),
              ]
            : name.startsWith('JH-A-') || name.startsWith('D1-A-')
              ? session.kind === 'D1'
                ? [
                    energy(session.auxiliarySourceId),
                    energy(session.auxiliaryWorkingId),
                    contact(session.reactionBodyId),
                    anchor(),
                  ]
                : [energy(session.auxiliarySourceId), energy(session.auxiliaryWorkingId), anchor()]
              : name === 'JH-POST-S-R0'
                ? [energy(session.sourceId), anchor()]
                : name === 'D1-POST-A'
                  ? [
                      energy(session.sourceId),
                      energy(session.packageId),
                      contact(session.targetId),
                      contact(session.reactionBodyId),
                    ]
                  : name === 'JH-M-R3'
                    ? [energy(session.sourceId), energy(session.packageId), anchor()]
                    : session.kind === 'D1' && name.startsWith('D1-M-')
                      ? [
                          energy(session.sourceId),
                          energy(session.packageId),
                          contact(session.targetId),
                        ]
                      : [energy(session.sourceId), energy(session.packageId)];
    return samples.every((sample) => sample !== null)
      ? (samples as NonNullable<(typeof samples)[number]>[])
      : null;
  }

  vmFiniteDriveRead(
    kind: WorldDriveKind,
    sessionId: number,
    index: number,
    programHash: string | undefined,
    charge: (payerId: number, mana: number, ticks: number, kind: string) => boolean,
  ): boolean {
    const session = this.driveSessions.get(sessionId);
    if (!session || session.kind !== kind || session.programHash !== programHash) return false;
    const capacity = this.finiteProgramCapacity.get(session.executorId);
    if (
      !capacity ||
      capacity.version !== session.capacityVersion ||
      this.naturalBodies.get(session.executorId)?.materialVersion !== capacity.structureVersion
    )
      return false;
    const names = DRIVE_READ_IDS[session.kind];
    const cursor = this.driveCursors.get(session.requestId) ?? 0;
    const existing = this.driveReadReceipts.find(
      (r) => r.requestId === session.requestId && r.readId === names[index],
    );
    if (existing) return true;
    const stages = this.driveStages.get(session.requestId) ?? new Set();
    const loadStart = 3;
    const postStart = session.kind === 'J1' ? 13 : 12;
    if (
      index !== cursor ||
      !names[index] ||
      (session.kind === 'J1' && !stages.has('H1')) ||
      (index >= 1 && !stages.has('acquire')) ||
      (index >= loadStart && !stages.has('load')) ||
      (index >= 6 && !stages.has('clamp')) ||
      (index >= 9 && !stages.has('seal')) ||
      (index >= postStart && !stages.has('action'))
    )
      return false;
    const samples = this.driveReadEndpoints(session, index);
    const grantIds = session.readGrantIds[index];
    const payerId =
      session.kind === 'J1' && index === 0
        ? session.p0Id!
        : session.kind === 'J1' && index >= 13
          ? session.p2Id!
          : session.payerId;
    const payerGrant =
      session.kind === 'J1' && index === 0
        ? session.p0GrantId!
        : session.kind === 'J1' && index >= 13
          ? session.p2GrantId!
          : session.payerGrantId;
    const payerSource =
      session.kind === 'J1' && index === 0
        ? 'acct-J1-P0'
        : session.kind === 'J1' && index >= 13
          ? 'acct-J1-P2'
          : session.kind === 'J1'
            ? 'acct-J1'
            : 'acct-M1-D1';
    const coverCandidate = session.kind === 'J1' && index === 12;
    const prior =
      coverCandidate &&
      this.driveReadReceipts.find(
        (receipt) => receipt.requestId === session.requestId && receipt.readId === 'JH-M-R3',
      );
    const covered =
      !!prior &&
      !!samples &&
      samples.every((sample) =>
        prior.samples.some(
          (paid) =>
            paid.endpointId === sample.id &&
            paid.field === sample.field &&
            paid.version === sample.version &&
            paid.value === sample.value &&
            paid.error === sample.error &&
            paid.grantId === grantIds[sample.id],
        ),
      );
    const mana = covered ? 0 : 1;
    if (
      !samples ||
      samples.length > 4 ||
      samples.some((sample) => {
        const grantId = grantIds[sample.id];
        const grant = this.finiteGrants.get(grantId);
        return (
          sample.error > 1 ||
          !this.validFiniteGrant(
            grantId,
            session.executorId,
            'read',
            sample.id,
            null,
            covered ? 0 : 1,
          ) ||
          !grant?.fields?.includes(sample.field)
        );
      }) ||
      (coverCandidate && !covered) ||
      !this.validFiniteGrant(
        payerGrant,
        session.executorId,
        'pay',
        payerSource,
        null,
        Math.max(mana, 1),
      ) ||
      this.finiteGrants.get(payerGrant)?.issuerId !== payerId ||
      !this.byId(payerId)?.alive
    )
      return false;
    const ticks = covered ? 1 : 10;
    if (!charge(payerId, mana, ticks, `drive-read:${names[index]}`)) return false;
    const first = samples[0];
    this.driveReadReceipts.push({
      id: `receipt-${names[index]}-${session.requestId}`,
      requestId: session.requestId,
      kind: session.kind,
      readId: names[index],
      endpointId: first.id,
      value: first.value,
      error: first.error,
      field: first.field,
      version: first.version,
      grantId: grantIds[first.id],
      samples: samples.map((sample) => ({
        endpointId: sample.id,
        field: sample.field,
        value: sample.value,
        error: sample.error,
        version: sample.version,
        grantId: grantIds[sample.id],
      })),
      payerGrantId: payerGrant,
      payerId,
      mana,
      ticks,
      coveredByReceiptId: prior ? prior.id : undefined,
    });
    if (!covered)
      for (const grantId of new Set(samples.map((sample) => grantIds[sample.id])))
        this.finiteGrantUsed.set(grantId, (this.finiteGrantUsed.get(grantId) ?? 0) + 1);
    if (mana > 0)
      this.finiteGrantUsed.set(payerGrant, (this.finiteGrantUsed.get(payerGrant) ?? 0) + mana);
    this.driveCursors.set(session.requestId, cursor + 1);
    return true;
  }

  vmFiniteDriveStage(
    kind: WorldDriveKind,
    sessionId: number,
    phase: 'H1' | 'acquire' | 'load' | 'clamp' | 'seal' | 'action',
    programHash: string | undefined,
    charge: (payerId: number, mana: number, ticks: number, kind: string) => boolean,
  ): boolean {
    const session = this.driveSessions.get(sessionId);
    if (
      !session ||
      session.kind !== kind ||
      session.programHash !== programHash ||
      (phase === 'H1' && session.kind !== 'J1')
    )
      return false;
    const capacity = this.finiteProgramCapacity.get(session.executorId);
    if (
      !capacity ||
      capacity.version !== session.capacityVersion ||
      this.naturalBodies.get(session.executorId)?.materialVersion !== capacity.structureVersion
    )
      return false;
    const stages =
      this.driveStages.get(session.requestId) ??
      new Set<'H1' | 'acquire' | 'load' | 'clamp' | 'seal' | 'action'>();
    if (stages.has(phase)) return true;
    const cursor = this.driveCursors.get(session.requestId) ?? 0;
    const payerSource = session.kind === 'J1' ? 'acct-J1' : 'acct-M1-D1';
    const mana =
      phase === 'H1'
        ? 9
        : phase === 'acquire'
          ? 0
          : phase === 'clamp' || phase === 'seal'
            ? 0
            : phase === 'load'
              ? session.kind === 'D1'
                ? 4
                : 0
              : session.kind === 'J1'
                ? 12
                : 8;
    if (
      !this.validFiniteGrant(
        session.payerGrantId,
        session.executorId,
        'pay',
        payerSource,
        null,
        Math.max(mana, 1),
      )
    )
      return false;
    if (phase === 'H1') {
      if (cursor !== 0 || !charge(session.payerId, mana, 12, 'j1-h1')) return false;
    } else if (phase === 'acquire') {
      const main = this.finiteEnergy.get(session.mainPotentialId);
      const auxiliary = this.finiteEnergy.get(session.auxiliaryPotentialId);
      const mainSink = this.finiteHeat.get(session.mainAcquisitionHeatSinkId);
      const auxiliarySink = this.finiteHeat.get(session.auxiliaryAcquisitionHeatSinkId);
      const targetMain = this.finiteEnergy.get(session.sourceId);
      const targetAuxiliary = this.finiteEnergy.get(session.auxiliarySourceId);
      if (
        cursor !== 1 ||
        !main ||
        !auxiliary ||
        !mainSink ||
        !auxiliarySink ||
        !targetMain ||
        !targetAuxiliary ||
        main.energy < (kind === 'J1' ? 48 : 40) ||
        auxiliary.energy < 28 ||
        targetMain.energy !== 0 ||
        targetAuxiliary.energy !== 0 ||
        mainSink.energy + 8 > mainSink.capacity ||
        auxiliarySink.energy + 8 > auxiliarySink.capacity ||
        !this.validFiniteGrant(
          session.mainAcquisitionGrantId,
          session.executorId,
          'energy-transfer',
          session.mainPotentialId,
          session.sourceId,
          main.energy,
        ) ||
        !this.validFiniteGrant(
          session.auxiliaryAcquisitionGrantId,
          session.executorId,
          'energy-transfer',
          session.auxiliaryPotentialId,
          session.auxiliarySourceId,
          auxiliary.energy,
        )
      )
        return false;
      if (!charge(session.payerId, 0, 1, `${kind.toLowerCase()}-acquire`)) return false;
      const mainFact = this.transferFiniteEnergy(
        `Acquire-${kind}-${session.requestId}`,
        session.executorId,
        session.mainPotentialId,
        session.sourceId,
        main.energy,
        8,
        session.mainAcquisitionHeatSinkId,
        session.mainAcquisitionGrantId,
        `${main.version}-spent`,
        `Acquire-${kind}-${session.requestId}`,
        `${mainSink.version}-acquired`,
      );
      if (!mainFact) return false;
      const auxiliaryFact = this.transferFiniteEnergy(
        `Acquire-${kind}-aux-${session.requestId}`,
        session.executorId,
        session.auxiliaryPotentialId,
        session.auxiliarySourceId,
        auxiliary.energy,
        8,
        session.auxiliaryAcquisitionHeatSinkId,
        session.auxiliaryAcquisitionGrantId,
        `${auxiliary.version}-spent`,
        `Acquire-${kind}-aux-${session.requestId}`,
        `${auxiliarySink.version}-acquired`,
      );
      if (!auxiliaryFact) return false;
    } else if (phase === 'load') {
      const source = this.finiteEnergy.get(session.sourceId);
      const pack = this.finiteEnergy.get(session.packageId);
      const sink = this.finiteHeat.get(session.heatSinkId);
      const auxiliary = this.finiteEnergy.get(session.auxiliarySourceId);
      const working = this.finiteEnergy.get(session.auxiliaryWorkingId);
      const auxiliaryHeat = this.finiteHeat.get(session.auxiliaryHeatSinkId);
      if (
        cursor !== 3 ||
        !this.b4HasAcquiredSource(session.sourceId) ||
        !this.b4HasAcquiredSource(session.auxiliarySourceId) ||
        !source ||
        source.energy < 20 ||
        !pack ||
        pack.energy !== 0 ||
        !sink ||
        sink.energy + 4 > sink.capacity ||
        !auxiliary ||
        auxiliary.energy < 12 ||
        !working ||
        working.energy !== 0 ||
        !auxiliaryHeat ||
        auxiliaryHeat.energy + 4 > auxiliaryHeat.capacity ||
        !this.validFiniteGrant(
          session.sourceGrantId,
          session.executorId,
          'energy-transfer',
          session.sourceId,
          session.packageId,
          20,
        ) ||
        !this.validFiniteGrant(
          session.auxiliaryTransferGrantId,
          session.executorId,
          'energy-transfer',
          session.auxiliarySourceId,
          session.auxiliaryWorkingId,
          12,
        ) ||
        (session.kind === 'J1' && !stages.has('H1'))
      )
        return false;
      if (!charge(session.payerId, mana, 10, `${session.kind.toLowerCase()}-load`)) return false;
      const moved = this.transferFiniteEnergy(
        `LoadTx-${session.kind}-${session.requestId}`,
        session.executorId,
        session.sourceId,
        session.packageId,
        20,
        4,
        session.heatSinkId,
        session.sourceGrantId,
        `${source.version}-loaded`,
        `${pack.version}-loaded`,
        `${sink.version}-loaded`,
      );
      if (!moved) return false;
      const auxiliaryMoved = this.transferFiniteEnergy(
        `LoadTx-${session.kind}-aux-${session.requestId}`,
        session.executorId,
        session.auxiliarySourceId,
        session.auxiliaryWorkingId,
        12,
        4,
        session.auxiliaryHeatSinkId,
        session.auxiliaryTransferGrantId,
        `${auxiliary.version}-loaded`,
        `${working.version}-loaded`,
        `${auxiliaryHeat.version}-loaded`,
      );
      if (!auxiliaryMoved) return false;
    } else if (phase === 'clamp') {
      const working = this.finiteEnergy.get(session.auxiliaryWorkingId);
      const spent = this.finiteEnergy.get(session.auxiliarySpentId);
      const heat = this.finiteHeat.get(session.clampHeatSinkId);
      if (
        cursor !== 6 ||
        !stages.has('load') ||
        !working ||
        working.energy < 3 ||
        !spent ||
        spent.energy !== 0 ||
        !heat ||
        heat.energy + 3 > heat.capacity ||
        !this.validFiniteGrant(
          session.clampTransferGrantId,
          session.executorId,
          'energy-transfer',
          session.auxiliaryWorkingId,
          session.auxiliarySpentId,
          3,
        )
      )
        return false;
      if (!charge(session.payerId, 0, 1, `${kind.toLowerCase()}-clamp`)) return false;
      const clampMoved = this.transferFiniteEnergy(
        `LoadTx-${session.kind}-clamp-${session.requestId}`,
        session.executorId,
        session.auxiliaryWorkingId,
        session.auxiliarySpentId,
        3,
        3,
        session.clampHeatSinkId,
        session.clampTransferGrantId,
        `${working.version}-clamped`,
        `${spent.version}-clamped`,
        `${heat.version}-clamped`,
      );
      if (!clampMoved) return false;
    } else if (phase === 'seal') {
      const pack = this.finiteEnergy.get(session.packageId);
      if (cursor !== 9 || !stages.has('clamp') || !pack || pack.energy < 16) return false;
      if (!charge(session.payerId, 0, 1, `${kind.toLowerCase()}-seal`)) return false;
      this.finiteEnergy.set(session.packageId, {
        ...pack,
        version: `seal-${kind}-${session.requestId}-R3`,
      });
    } else {
      const target = this.entityById(session.targetId);
      const executor = this.entityById(session.executorId);
      const cert = this.naturalBodies.get(session.targetId)?.certificate;
      const executorCert = this.naturalBodies.get(session.executorId)?.certificate;
      const snapshot = this.driveSnapshots.get(session.requestId);
      const pack = this.finiteEnergy.get(session.packageId);
      const heat = this.finiteHeat.get(session.actionHeatSinkId);
      const anchor = this.finiteAnchors.get(session.anchorId);
      const anchorImpulse = this.finiteAnchorImpulses.get(session.anchorId);
      const reactionEntity = session.reactionBodyId
        ? this.entityById(session.reactionBodyId)
        : null;
      const reactionBody = session.reactionBodyId
        ? this.naturalBodies.get(session.reactionBodyId)
        : null;
      const impulse = session.impulse;
      const next =
        target && cert
          ? {
              x: target.velocity.x + impulse.x / cert.mass,
              y: target.velocity.y + impulse.y / cert.mass,
            }
          : null;
      const kineticGain =
        next && target && cert
          ? (cert.mass / 2) *
            (next.x ** 2 + next.y ** 2 - target.velocity.x ** 2 - target.velocity.y ** 2)
          : NaN;
      if (
        cursor !== (session.kind === 'J1' ? 13 : 12) ||
        !stages.has('load') ||
        !this.driveReadsFresh(session) ||
        !target ||
        !cert ||
        !pack ||
        pack.energy < 12 ||
        !heat ||
        !anchor ||
        !anchorImpulse ||
        !executor ||
        !executorCert ||
        !snapshot ||
        this.naturalBodies.get(session.targetId)?.materialVersion !== snapshot.targetStructure ||
        target.velocity.x !== snapshot.targetVelocity.x ||
        target.velocity.y !== snapshot.targetVelocity.y ||
        anchor.version !== snapshot.anchorVersion ||
        Math.hypot(executor.x - target.x, executor.y - target.y) >
          executorCert.radius + cert.radius + (this.naturalContactPolicy?.geometryEpsilon ?? 0) ||
        anchor.loadLower < Math.hypot(impulse.x, impulse.y) ||
        (session.kind === 'D1' &&
          (!reactionEntity ||
            !reactionBody ||
            (reactionBody.certificate.contactLoadLower ?? -1) < Math.hypot(impulse.x, impulse.y) ||
            Math.hypot(target.x - reactionEntity.x, target.y - reactionEntity.y) >
              cert.radius +
                reactionBody.certificate.radius +
                (this.naturalContactPolicy?.geometryEpsilon ?? 0) ||
            !this.validFiniteGrant(
              session.reactionGrantId ?? '',
              session.executorId,
              'contact',
              String(session.reactionBodyId),
              String(session.targetId),
              1,
            ))) ||
        !next ||
        !Number.isFinite(kineticGain) ||
        Math.abs(kineticGain - 0.5) > 1e-9 ||
        heat.energy + 6 > heat.capacity ||
        !this.validFiniteGrant(
          session.actionGrantId,
          session.executorId,
          'action',
          session.packageId,
          String(session.targetId),
          1,
        )
      )
        return false;
      if (!charge(session.payerId, mana, 20, `${session.kind.toLowerCase()}-action`)) return false;
      const fact: WorldDriveActionFact = {
        id: `A-${session.kind}-${session.requestId}`,
        requestId: session.requestId,
        kind: session.kind,
        targetId: session.targetId,
        reactionBodyId: session.reactionBodyId ?? null,
        reactionBodyVersion: reactionBody?.materialVersion ?? null,
        anchorId: session.anchorId,
        reactionEndpointId: anchor.reactionEndpointId,
        anchorImpulseBefore: { ...anchorImpulse },
        anchorImpulseAfter: { x: anchorImpulse.x - impulse.x, y: anchorImpulse.y - impulse.y },
        impulsePair: [{ ...impulse }, { x: -impulse.x, y: -impulse.y }],
        velocityBefore: { ...target.velocity },
        velocityAfter: next,
        kineticGain,
        heatGain: 0.5,
        packageBefore: pack.energy,
        packageAfter: pack.energy - 12,
        payerId: session.payerId,
        mana,
      };
      target.velocity = { ...next };
      this.finiteAnchorImpulses.set(session.anchorId, { ...fact.anchorImpulseAfter });
      this.finiteEnergy.set(session.packageId, {
        ...pack,
        energy: fact.packageAfter,
        version: `${pack.version}-spent`,
      });
      this.finiteHeat.set(session.actionHeatSinkId, {
        ...heat,
        energy: heat.energy + 6,
        version: `${heat.version}-action`,
      });
      this.finiteGrantUsed.set(
        session.actionGrantId,
        (this.finiteGrantUsed.get(session.actionGrantId) ?? 0) + 1,
      );
      if (session.kind === 'D1' && session.reactionGrantId)
        this.finiteGrantUsed.set(
          session.reactionGrantId,
          (this.finiteGrantUsed.get(session.reactionGrantId) ?? 0) + 1,
        );
      this.driveActionFacts.push(fact);
    }
    if (mana > 0)
      this.finiteGrantUsed.set(
        session.payerGrantId,
        (this.finiteGrantUsed.get(session.payerGrantId) ?? 0) + mana,
      );
    this.driveStageReceipts.push({
      id: `receipt-${session.kind}-${phase}-${session.requestId}`,
      requestId: session.requestId,
      kind: session.kind,
      phase,
      payerId: session.payerId,
      payerGrantId: session.payerGrantId,
      mana,
      ticks:
        phase === 'H1'
          ? 12
          : phase === 'acquire' || phase === 'clamp' || phase === 'seal'
            ? 1
            : phase === 'load'
              ? 10
              : 20,
    });
    stages.add(phase);
    this.driveStages.set(session.requestId, stages);
    return true;
  }

  finiteEnergyState(id: string): WorldEnergyInventory | null {
    const inventory = this.finiteEnergy.get(id);
    return inventory ? { ...inventory } : null;
  }

  registerFiniteHeatSink(id: string, energy: number, capacity: number, version: string): boolean {
    if (
      !this.finiteInitialOpen ||
      !id ||
      !version ||
      this.finiteHeat.has(id) ||
      !Number.isSafeInteger(energy) ||
      energy < 0 ||
      !Number.isSafeInteger(capacity) ||
      capacity < energy
    )
      return false;
    this.finiteHeat.set(id, { energy, capacity, version });
    return true;
  }

  finiteHeatState(id: string): { energy: number; capacity: number; version: string } | null {
    const sink = this.finiteHeat.get(id);
    return sink ? { ...sink } : null;
  }

  transferFiniteEnergy(
    factId: string,
    executorId: number,
    fromId: string,
    toId: string,
    amount: number,
    heat: number,
    sinkId: string,
    grantId: string,
    fromAfterVersion: string,
    toAfterVersion: string,
    sinkAfterVersion: string,
  ): WorldEnergyTransferFact | null {
    const from = this.finiteEnergy.get(fromId),
      to = this.finiteEnergy.get(toId);
    const sink = this.finiteHeat.get(sinkId);
    const potential = this.finitePotentialSources.get(fromId);
    const potentialBody = potential && this.entityById(potential.bodyId);
    const potentialMass = potential && this.naturalBodies.get(potential.bodyId)?.certificate.mass;
    const potentialAnchor = potential && this.finiteAnchors.get(potential.anchorId);
    if (
      !factId ||
      !fromAfterVersion ||
      !toAfterVersion ||
      !sinkAfterVersion ||
      this.finiteEnergyTransfers.some((fact) => fact.id === factId) ||
      !from ||
      !to ||
      !sink ||
      fromId === toId ||
      !Number.isSafeInteger(amount) ||
      !Number.isSafeInteger(heat) ||
      amount <= 0 ||
      heat < 0 ||
      from.energy < amount ||
      sink.energy + heat > sink.capacity ||
      !Number.isSafeInteger(to.energy + amount - heat) ||
      !this.validFiniteGrant(grantId, executorId, 'energy-transfer', fromId, toId, amount)
    )
      return null;
    if (
      potential &&
      (!potentialBody ||
        !potentialMass ||
        !potentialAnchor ||
        potentialAnchor.loadLower < potentialMass * potential.gravity ||
        Math.abs(
          potentialMass *
            potential.gravity *
            Math.abs(potentialBody.y - potential.referenceY) *
            12 -
            from.energy,
        ) > 1e-8)
    )
      return null;
    const stored = amount - heat;
    if (stored < 0) return null;
    const potentialMove =
      potential && potentialBody && potentialMass && potentialAnchor
        ? {
            bodyId: potential.bodyId,
            yBefore: potentialBody.y,
            yAfter:
              potential.referenceY +
              (Math.sign(potentialBody.y - potential.referenceY) * (from.energy - amount)) /
                (12 * potentialMass * potential.gravity),
            anchorId: potential.anchorId,
            reactionEndpointId: potentialAnchor.reactionEndpointId,
            supportLoad: potentialMass * potential.gravity,
          }
        : undefined;
    const fact: WorldEnergyTransferFact = {
      id: factId,
      fromId,
      toId,
      sinkId,
      grantId,
      fromBefore: from.energy,
      fromAfter: from.energy - amount,
      toBefore: to.energy,
      toAfter: to.energy + stored,
      heatBefore: sink.energy,
      heatAfter: sink.energy + heat,
      fromVersionBefore: from.version,
      fromVersionAfter: fromAfterVersion,
      toVersionBefore: to.version,
      toVersionAfter: toAfterVersion,
      sinkVersionBefore: sink.version,
      sinkVersionAfter: sinkAfterVersion,
      potentialMove,
    };
    if (potentialMove && potentialBody) potentialBody.y = potentialMove.yAfter;
    this.finiteEnergy.set(fromId, { ...from, energy: fact.fromAfter, version: fromAfterVersion });
    this.finiteEnergy.set(toId, {
      ...to,
      energy: fact.toAfter,
      version: toAfterVersion,
      originFactId: fact.id,
    });
    this.finiteHeat.set(sinkId, { ...sink, energy: fact.heatAfter, version: sinkAfterVersion });
    this.finiteEnergyTransfers.push(fact);
    this.finiteGrantUsed.set(grantId, (this.finiteGrantUsed.get(grantId) ?? 0) + amount);
    return fact;
  }

  registerFiniteMaterialInventory(inventory: WorldMaterialInventory): boolean {
    if (
      !this.finiteInitialOpen ||
      !inventory.id ||
      !inventory.version ||
      !inventory.originFactId ||
      !this.entityById(inventory.ownerId) ||
      this.finiteMaterial.has(inventory.id) ||
      !Number.isSafeInteger(inventory.quantity) ||
      inventory.quantity < 0 ||
      (inventory.capacity !== undefined &&
        (!Number.isSafeInteger(inventory.capacity) || inventory.capacity < inventory.quantity))
    )
      return false;
    this.finiteMaterial.set(inventory.id, { ...inventory });
    return true;
  }

  finiteMaterialState(id: string): WorldMaterialInventory | null {
    const inventory = this.finiteMaterial.get(id);
    return inventory ? { ...inventory } : null;
  }

  transferFiniteMaterial(
    factId: string,
    executorId: number,
    fromId: string,
    toId: string,
    quantity: number,
    grantId: string,
    fromAfterVersion: string,
    toAfterVersion: string,
  ): WorldMaterialTransferFact | null {
    const from = this.finiteMaterial.get(fromId),
      to = this.finiteMaterial.get(toId);
    if (
      !factId ||
      !fromAfterVersion ||
      !toAfterVersion ||
      this.finiteMaterialTransfers.some((fact) => fact.id === factId) ||
      !from ||
      !to ||
      fromId === toId ||
      from.kind !== to.kind ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      from.quantity < quantity ||
      !Number.isSafeInteger(to.quantity + quantity) ||
      (to.capacity !== undefined && to.quantity + quantity > to.capacity) ||
      !this.validFiniteGrant(grantId, executorId, 'material-transfer', fromId, toId, quantity)
    )
      return null;
    const fact: WorldMaterialTransferFact = {
      id: factId,
      fromId,
      toId,
      quantity,
      grantId,
      fromBefore: from.quantity,
      fromAfter: from.quantity - quantity,
      toBefore: to.quantity,
      toAfter: to.quantity + quantity,
      fromVersionBefore: from.version,
      fromVersionAfter: fromAfterVersion,
      toVersionBefore: to.version,
      toVersionAfter: toAfterVersion,
    };
    this.finiteMaterial.set(fromId, {
      ...from,
      quantity: fact.fromAfter,
      version: fromAfterVersion,
    });
    this.finiteMaterial.set(toId, { ...to, quantity: fact.toAfter, version: toAfterVersion });
    this.finiteMaterialTransfers.push(fact);
    this.finiteGrantUsed.set(grantId, (this.finiteGrantUsed.get(grantId) ?? 0) + quantity);
    return fact;
  }
  /** Explicit finite physical certificates on the same entities used by spells and combat. */
  private naturalBodies = new Map<
    number,
    {
      certificate: NaturalBodyCertificate;
      attachedK0: number | null;
      materialVersion: string;
      panelAttached: boolean | null;
    }
  >();
  readonly naturalContacts: NaturalContactFact[] = [];
  readonly naturalContactFailures: NaturalContactFailure[] = [];
  private naturalTime = 0;
  private naturalContactPolicy: NaturalContactPolicy | null = null;

  setNaturalContactPolicy(policy: NaturalContactPolicy): boolean {
    if (this.naturalContacts.length > 0 || this.naturalBodies.size > 0) return false;
    if (
      !policy.version ||
      ![policy.geometryEpsilon, policy.timeEpsilon, policy.rootEpsilon].every(
        (value) => Number.isFinite(value) && value > 0,
      ) ||
      !Number.isSafeInteger(policy.maxSubdivisions) ||
      policy.maxSubdivisions <= 0
    )
      return false;
    this.naturalContactPolicy = { ...policy };
    return true;
  }

  registerNaturalBody(entityId: number, certificate: NaturalBodyCertificate): boolean {
    if (!this.entityById(entityId) || this.naturalBodies.has(entityId)) return false;
    const positive = [certificate.mass, certificate.radius, certificate.peakDivisor];
    const nonnegative = [
      certificate.restitution,
      certificate.attachedK0,
      certificate.panelK0,
      certificate.fractureThresholdLow,
      certificate.intactThresholdHigh,
      certificate.fractureWork,
      certificate.headIntegrityLower,
      certificate.headLoadLower,
      certificate.portApertureQ,
      certificate.portLoadLower,
      certificate.structuralError,
      certificate.contactLoadLower,
    ].filter((n): n is number => n !== null && n !== undefined);
    const hardware = certificate.programHardware;
    const hardwareNumbers = hardware ? Object.values(hardware) : [];
    if (
      !positive.every((n) => Number.isFinite(n) && n > 0) ||
      !nonnegative.every((n) => Number.isFinite(n) && n >= 0) ||
      certificate.restitution > 1 ||
      (certificate.panelK0 !== null &&
        certificate.attachedK0 !== null &&
        certificate.panelK0 > certificate.attachedK0) ||
      !certificate.massVersion ||
      !certificate.shapeVersion ||
      !certificate.materialVersion ||
      !certificate.fracturedMaterialVersion ||
      !certificate.heatSinkId ||
      !hardwareNumbers.every((value) => Number.isSafeInteger(value) && value >= 0)
    )
      return false;
    this.naturalBodies.set(entityId, {
      certificate: { ...certificate },
      attachedK0: certificate.attachedK0,
      materialVersion: certificate.materialVersion,
      panelAttached: certificate.panelK0 === null ? null : certificate.panelK0 > 0,
    });
    return true;
  }

  naturalBodyState(
    entityId: number,
  ): { attachedK0: number | null; materialVersion: string } | null {
    const body = this.naturalBodies.get(entityId);
    return body ? { attachedK0: body.attachedK0, materialVersion: body.materialVersion } : null;
  }

  /**
   * Sweep measured discs on this World. Contact facts precede material facts; missing
   * material proof leaves the bilateral impulse and dissipated energy in place.
   * The caller must not also advance these registered bodies through legacy motion.
   */
  advanceNaturalContacts(dt: number): readonly NaturalContactFact[] {
    if (!Number.isFinite(dt) || dt < 0) throw new Error('invalid natural time');
    const policy = this.naturalContactPolicy;
    if (!policy) throw new Error('missing natural contact policy');
    const emitted: NaturalContactFact[] = [];
    const bodies = [...this.naturalBodies.keys()]
      .sort((a, b) => a - b)
      .map((id) => ({ entity: this.entityById(id), state: this.naturalBodies.get(id)! }))
      .filter(
        (
          body,
        ): body is {
          entity: Entity;
          state: {
            certificate: NaturalBodyCertificate;
            attachedK0: number | null;
            materialVersion: string;
            panelAttached: boolean | null;
          };
        } => !!body.entity,
      );
    const move = (seconds: number) => {
      for (const { entity } of bodies) {
        entity.x += entity.velocity.x * seconds;
        entity.y += entity.velocity.y * seconds;
      }
      this.naturalTime += seconds;
    };
    let remaining = dt;
    let unresolved = false;
    for (let iteration = 0; iteration < policy.maxSubdivisions && remaining > 0; iteration++) {
      const candidates: Array<{
        a: (typeof bodies)[number];
        b: (typeof bodies)[number];
        t: number;
        nx: number;
        ny: number;
      }> = [];
      for (let i = 0; i < bodies.length; i++)
        for (let j = i + 1; j < bodies.length; j++) {
          const a = bodies[i],
            b = bodies[j];
          const px = b.entity.x - a.entity.x,
            py = b.entity.y - a.entity.y;
          const vx = b.entity.velocity.x - a.entity.velocity.x;
          const vy = b.entity.velocity.y - a.entity.velocity.y;
          const radius = a.state.certificate.radius + b.state.certificate.radius;
          const aa = vx * vx + vy * vy;
          const bb = 2 * (px * vx + py * vy);
          const cc = px * px + py * py - radius * radius;
          if (aa === 0 || bb >= 0) continue;
          const discriminant = bb * bb - 4 * aa * cc;
          if (discriminant < 0 || cc < -policy.geometryEpsilon) continue;
          const t = cc <= 0 ? 0 : (-bb - Math.sqrt(discriminant)) / (2 * aa);
          if (t < -policy.rootEpsilon || t > remaining) continue;
          const at = Math.max(0, t);
          const dx = px + vx * at,
            dy = py + vy * at;
          const length = Math.hypot(dx, dy);
          if (length <= 0) continue;
          const nx = dx / length,
            ny = dy / length;
          if (vx * nx + vy * ny >= 0) continue;
          candidates.push({ a, b, t: at, nx, ny });
        }
      if (candidates.length === 0) break;
      candidates.sort(
        (x, y) => x.t - y.t || x.a.entity.id - y.a.entity.id || x.b.entity.id - y.b.entity.id,
      );
      const earliest = candidates[0].t;
      move(earliest);
      remaining -= earliest;
      const group = candidates.filter(
        (candidate) => Math.abs(candidate.t - earliest) <= policy.timeEpsilon,
      );
      // Grouped roots need a material and impulse group certificate. This pair
      // solver must not silently consume one panel twice or let bodies pass through.
      if (group.length > 1) {
        this.naturalContactFailures.push({
          at: this.naturalTime,
          bodyIds: [...new Set(group.flatMap(({ a, b }) => [a.entity.id, b.entity.id]))].sort(
            (a, b) => a - b,
          ),
          reason: 'groupCertificateMissing',
        });
        unresolved = true;
        break;
      }
      const impulses = new Map<number, Vec2>();
      for (const { a, b, nx, ny } of group) {
        const ca = a.state.certificate,
          cb = b.state.certificate;
        if (ca.restitution !== cb.restitution || ca.heatSinkId !== cb.heatSinkId) {
          this.naturalContactFailures.push({
            at: this.naturalTime,
            bodyIds: [a.entity.id, b.entity.id],
            reason: 'contactCertificateMismatch',
          });
          unresolved = true;
          break;
        }
        const relative =
          (b.entity.velocity.x - a.entity.velocity.x) * nx +
          (b.entity.velocity.y - a.entity.velocity.y) * ny;
        const impulse = (-(1 + ca.restitution) * relative) / (1 / ca.mass + 1 / cb.mass);
        // Facts use one representation for a zero component regardless of normal sign.
        const canonicalImpulse = (value: number) => (value === 0 ? 0 : value);
        const firstImpulse = {
          x: canonicalImpulse(-impulse * nx),
          y: canonicalImpulse(-impulse * ny),
        };
        const secondImpulse = {
          x: canonicalImpulse(impulse * nx),
          y: canonicalImpulse(impulse * ny),
        };
        for (const [id, delta] of [
          [a.entity.id, firstImpulse],
          [b.entity.id, secondImpulse],
        ] as const) {
          const total = impulses.get(id) ?? { x: 0, y: 0 };
          impulses.set(id, { x: total.x + delta.x, y: total.y + delta.y });
        }
        const reducedMass = 1 / (1 / ca.mass + 1 / cb.mass);
        const dissipated =
          (reducedMass * relative * relative * (1 - ca.restitution * ca.restitution)) / 2;
        const sink = this.finiteHeat.get(ca.heatSinkId);
        const factId = `C-natural-${this.naturalContacts.length + emitted.length + 1}`;
        const preMaterialVersions: [string, string] = [
          a.state.materialVersion,
          b.state.materialVersion,
        ];
        // Plan both ends against the same temporary lot ledger. A later end
        // must see inventory consumed by the earlier end before heat is checked.
        const plannedInventories = new Map<string, WorldMaterialInventory>();
        const plannedInventory = (id: string) =>
          plannedInventories.get(id) ?? this.finiteMaterial.get(id);
        let deformation = 0;
        let materialUnresolved = false;
        const materialResults = [a, b].map(({ entity, state }) => {
          const cert = state.certificate;
          const before = state.attachedK0;
          const peak = dissipated / cert.peakDivisor;
          let result: 'fractured' | 'intact' | 'unknown' = 'intact';
          if (
            state.panelAttached === null ||
            state.attachedK0 === null ||
            (state.panelAttached &&
              (cert.panelK0 === null ||
                cert.fractureThresholdLow === null ||
                cert.intactThresholdHigh === null ||
                cert.fractureWork === null))
          )
            result = 'unknown';
          else if (state.panelAttached) {
            result =
              peak > cert.fractureThresholdLow! && dissipated >= cert.fractureWork!
                ? 'fractured'
                : peak < cert.intactThresholdHigh!
                  ? 'intact'
                  : 'unknown';
          }
          if (result === 'fractured') {
            const attached = cert.materialInventoryId
              ? plannedInventory(cert.materialInventoryId)
              : undefined;
            const fragment = cert.fragmentInventoryId
              ? plannedInventory(cert.fragmentInventoryId)
              : undefined;
            if (
              !cert.materialInventoryId ||
              !cert.fragmentInventoryId ||
              !attached ||
              !fragment ||
              cert.materialInventoryId === cert.fragmentInventoryId ||
              attached.kind !== 'k0' ||
              fragment.kind !== 'k0' ||
              attached.ownerId !== entity.id ||
              fragment.ownerId !== entity.id ||
              attached.quantity < cert.panelK0! ||
              attached.quantity !== state.attachedK0 ||
              !Number.isSafeInteger(fragment.quantity + cert.panelK0!) ||
              (fragment.capacity !== undefined &&
                fragment.quantity + cert.panelK0! > fragment.capacity)
            )
              result = 'unknown';
            else {
              plannedInventories.set(cert.materialInventoryId, {
                ...attached,
                quantity: attached.quantity - cert.panelK0!,
                version: cert.fracturedMaterialVersion,
              });
              plannedInventories.set(cert.fragmentInventoryId!, {
                ...fragment,
                quantity: fragment.quantity + cert.panelK0!,
                version: `fragment-${factId}`,
              });
            }
          }
          if (result === 'fractured') {
            deformation += cert.fractureWork!;
          } else if (result === 'unknown') materialUnresolved = true;
          return {
            bodyId: entity.id,
            result,
            impactFactId: result === 'fractured' ? `N-${factId}-${entity.id}` : null,
            structureFactId: result === 'fractured' ? `X-${factId}-${entity.id}` : null,
            attachedBefore: before,
            attachedAfter: result === 'fractured' ? before! - cert.panelK0! : before,
            fragmentK0: result === 'fractured' ? cert.panelK0! : 0,
          };
        });
        // The proven fracture work is already committed to the material side.
        // Keep only the remaining, still unallocated loss in the named sink.
        if (deformation > dissipated) {
          // Thresholds alone cannot certify more work than the contact lost.
          // Discard provisional material transfers and retain the bilateral C.
          plannedInventories.clear();
          for (const result of materialResults) {
            if (result.result !== 'fractured') continue;
            result.result = 'unknown';
            result.impactFactId = null;
            result.structureFactId = null;
            result.attachedAfter = result.attachedBefore;
            result.fragmentK0 = 0;
          }
          materialUnresolved = true;
          deformation = 0;
        }
        const heatRequired = dissipated - deformation;
        if (!sink || sink.capacity - sink.energy < heatRequired) {
          this.naturalContactFailures.push({
            at: this.naturalTime,
            bodyIds: [a.entity.id, b.entity.id],
            reason: 'heatSinkUnavailable',
          });
          unresolved = true;
          break;
        }
        for (const [id, inventory] of plannedInventories) this.finiteMaterial.set(id, inventory);
        for (const [index, body] of [a, b].entries()) {
          if (materialResults[index].result !== 'fractured') continue;
          body.state.attachedK0 = materialResults[index].attachedAfter;
          body.state.panelAttached = false;
          body.state.materialVersion = body.state.certificate.fracturedMaterialVersion;
        }
        const energyBefore =
          (ca.mass * (a.entity.velocity.x ** 2 + a.entity.velocity.y ** 2)) / 2 +
          (cb.mass * (b.entity.velocity.x ** 2 + b.entity.velocity.y ** 2)) / 2;
        const fact: NaturalContactFact = {
          id: factId,
          at: this.naturalTime,
          firstId: a.entity.id,
          secondId: b.entity.id,
          impulse,
          firstImpulse,
          secondImpulse,
          energyBefore,
          energyAfter: energyBefore - dissipated,
          dissipated,
          materialResults,
          deformation: materialUnresolved ? null : deformation,
          heat: materialUnresolved ? null : dissipated - deformation,
          heatSinkId: ca.heatSinkId,
          versions: preMaterialVersions,
          policyVersion: policy.version,
          massVersions: [ca.massVersion, cb.massVersion],
          shapeVersions: [ca.shapeVersion, cb.shapeVersion],
        };
        // An unknown material split still commits the velocity change. The
        // sink holds only loss not already spent on proven deformation;
        // fact.heat remains unknown and cannot be presented as measured heat.
        this.finiteHeat.set(ca.heatSinkId, {
          ...sink,
          energy: sink.energy + heatRequired,
          version: `${sink.version}-${factId}`,
        });
        emitted.push(fact);
      }
      if (unresolved) break;
      for (const { entity, state } of bodies) {
        const delta = impulses.get(entity.id);
        if (!delta) continue;
        entity.velocity.x += delta.x / state.certificate.mass;
        entity.velocity.y += delta.y / state.certificate.mass;
      }
      if (iteration === policy.maxSubdivisions - 1 && remaining > 0) {
        this.naturalContactFailures.push({
          at: this.naturalTime,
          bodyIds: bodies.map(({ entity }) => entity.id),
          reason: 'subdivisionLimit',
        });
        unresolved = true;
      }
    }
    if (!unresolved && remaining > 0) move(remaining);
    this.naturalContacts.push(...emitted);
    return emitted;
  }
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
    if (this.entityShenshiUsed(id) >= actor.attr.shenshiMax) return false;
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
    this.finiteEnergy.clear();
    this.finitePotentialSources.clear();
    this.finiteMaterial.clear();
    this.finiteHeat.clear();
    this.finiteGrants.clear();
    this.revokedFiniteGrants.clear();
    this.finiteGrantUsed.clear();
    this.finiteAuditEndpoints.clear();
    this.finiteProgramCapacity.clear();
    this.finiteProgramInstallations.clear();
    this.b4ReadReceipts.length = 0;
    this.b4ReadCursor.clear();
    this.b4ReadSessions.clear();
    this.finiteAnchors.clear();
    this.finiteAnchorImpulses.clear();
    this.b4ActionPlans.clear();
    this.b4Loaded.clear();
    this.b4Sealed.clear();
    this.b4Locked.clear();
    this.b4RetiredSlices.clear();
    this.b4SliceLocks.clear();
    this.b4LockSnapshots.clear();
    this.b4ActionFacts.length = 0;
    this.b4StageReceipts.length = 0;
    this.finiteEnergyTransfers.length = 0;
    this.finiteMaterialTransfers.length = 0;
    this.finiteManaFunding.length = 0;
    this.driveSessions.clear();
    this.driveSnapshots.clear();
    this.driveCursors.clear();
    this.driveStages.clear();
    this.driveReadReceipts.length = 0;
    this.driveStageReceipts.length = 0;
    this.driveActionFacts.length = 0;
    this.naturalBodies.clear();
    this.naturalContacts.length = 0;
    this.naturalContactFailures.length = 0;
    this.naturalTime = 0;
    this.naturalContactPolicy = null;
    this.finiteInitialOpen = true;
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
  private entityShenshiUsed(id: number): number {
    return (
      (this.auditShenshiUsage.get(id) ?? 0) +
      (this.auditVmShenshiTotal.get(id) ?? 0) +
      (this.subscriptionShenshi.get(id) ?? 0) +
      this.controlRecordShenshiUsed(id) +
      (this.finiteProgramInstallations.get(id)?.reservedPeakShenshi ?? 0)
    );
  }

  reportEntityShenshiUsage(id: number, used: number): boolean {
    const actor = this.entityWithCapability(id, 'caster');
    if (!actor || !Number.isSafeInteger(used) || used < 0) return false;
    const previous = this.auditShenshiUsage.get(id) ?? 0;
    if (used > previous && this.entityShenshiUsed(id) - previous + used > actor.attr.shenshiMax)
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
    if (!Number.isSafeInteger(next) || this.entityShenshiUsed(id) + amount > actor.attr.shenshiMax)
      return false;
    return this.reportEntityShenshiUsage(id, next);
  }

  /** 无 Battle 共享账户时，多个并发 VM 的占用仍按施法实例求和。 */
  reportVmShenshiUsage(id: number, vm: object, used: number): boolean {
    const actor = this.entityWithCapability(id, 'caster');
    if (!actor || !Number.isSafeInteger(used) || used < 0) return false;
    const previous = this.auditVmShenshiUsage.get(vm);
    if (previous && previous.id !== id) return false;
    const total = (this.auditVmShenshiTotal.get(id) ?? 0) - (previous?.used ?? 0) + used;
    if (!Number.isSafeInteger(total) || total < 0) return false;
    if (
      used > (previous?.used ?? 0) &&
      this.entityShenshiUsed(id) - (previous?.used ?? 0) + used > actor.attr.shenshiMax
    )
      return false;
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
    if (
      !Number.isSafeInteger(this.entityShenshiUsed(id) + amount) ||
      this.entityShenshiUsed(id) + amount > actor.attr.shenshiMax
    )
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
      if (!controller || this.entityShenshiUsed(controllerId) + 1 > controller.attr.shenshiMax)
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
      shenshiUsed: this.auditBinding(() => this.entityShenshiUsed(actor.id), available),
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
