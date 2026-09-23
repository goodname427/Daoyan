import type { Actor } from './world';

/** 法力、能量各用自己的百万分之一单位；不得把浮点容差当作余额。 */
export const RESOURCE_SCALE = 1_000_000;
export type EnergyPool = 'motion' | 'damage' | 'scan';
export type EnergyUse = 'motionWork' | 'controlLoss' | 'damage' | 'scan';

const MAX_SOURCES = 4096;
const MAX_RESERVATIONS = 4096;
const MAX_ENTRIES = 128;
const POOL_CAP = 1_000_000_000 * RESOURCE_SCALE;

function units(value: number, round: 'up' | 'down'): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('非法资源数量');
  const scaled = value * RESOURCE_SCALE;
  // Decimal projection of an exact micro balance can land just below its integer.
  const nearest = Math.round(scaled);
  const tolerance = Math.min(0.25, Math.max(1e-7, Math.abs(scaled) * Number.EPSILON * 2));
  const stable = Math.abs(scaled - nearest) <= tolerance ? nearest : scaled;
  const result = round === 'up' ? Math.ceil(stable) : Math.floor(stable);
  if (!Number.isSafeInteger(result)) throw new RangeError('资源计量溢出');
  return result;
}

function checkedAdd(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result)) throw new RangeError('资源累计溢出');
  return result;
}

interface Source {
  readonly id: number;
  readonly entityId: number;
  readonly payerId: number;
  readonly sessionId: number | null;
  readonly effectId: number | null;
  readonly pool: EnergyPool;
  readonly paid: number;
  readonly minted: number;
  balance: number;
  reserved: number;
  refunded: number;
  used: Record<EnergyUse, number>;
  ended: boolean;
}

interface Reservation {
  readonly id: number;
  readonly entityId: number;
  readonly pool: EnergyPool;
  readonly parts: Array<{ source: Source; amount: number }>;
  readonly amount: number;
  settled: boolean;
}

interface ManaAccount {
  opening: number;
  last: number;
  paid: number;
  refunded: number;
  regen: number;
  clampLoss: number;
  externalIn: number;
  externalOut: number;
}

export interface LedgerEntry {
  readonly sequence: number;
  readonly at: number;
  readonly kind: string;
  readonly payerId: number;
  readonly entityId: number | null;
  readonly sourceId: number | null;
  readonly pool: EnergyPool | null;
  readonly mana: number;
  readonly energy: number;
}

export interface EnergyBalance {
  readonly motion: number;
  readonly damage: number;
  readonly scan: number;
  readonly reserved: { readonly motion: number; readonly damage: number; readonly scan: number };
}

/** 活跃债权与有界历史分离；实体终结额保留至世界重置，保证重放幂等。 */
export class ResourceLedger {
  private nextSequence = 1;
  private nextReservation = 1;
  private sources: Source[] = [];
  private sourceHistory: Source[] = [];
  private reservations = new Map<number, Reservation>();
  private closed = new Map<number, number>();
  private entries: LedgerEntry[] = [];
  private accounts = new Map<number, ManaAccount>();
  private totals = {
    payerMana: 0,
    injectionMana: 0,
    mintedEnergy: 0,
    conversionLoss: 0,
    motionWork: 0,
    controlLoss: 0,
    damage: 0,
    scan: 0,
    hits: 0,
    scans: 0,
    terminationLoss: 0,
    refundedEnergy: 0,
    refundedMana: 0,
  };

  constructor(
    private readonly actor: (id: number) => Actor | null,
    private readonly now: () => number,
    private readonly canInject: (entityId: number, payerId: number) => boolean,
    private readonly manaCommitted?: (payerId: number) => void,
  ) {}

  reset(): void {
    this.sources = [];
    this.sourceHistory = [];
    this.reservations.clear();
    this.closed.clear();
    this.entries = [];
    this.accounts.clear();
    this.totals = {
      payerMana: 0,
      injectionMana: 0,
      mintedEnergy: 0,
      conversionLoss: 0,
      motionWork: 0,
      controlLoss: 0,
      damage: 0,
      scan: 0,
      terminationLoss: 0,
      hits: 0,
      scans: 0,
      refundedEnergy: 0,
      refundedMana: 0,
    };
    // 世界实体 ID 也不复用；凭证序号同样不复用。
  }

  private entry(
    kind: string,
    payerId: number,
    entityId: number | null,
    sourceId: number | null,
    pool: EnergyPool | null,
    mana: number,
    energy: number,
  ): number {
    const sequence = this.nextSequence++;
    this.entries.push({
      sequence,
      at: this.now(),
      kind,
      payerId,
      entityId,
      sourceId,
      pool,
      mana: mana / RESOURCE_SCALE,
      energy: energy / RESOURCE_SCALE,
    });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    return sequence;
  }

  /** 导入和战斗补满等外部变动单列，不伪装成退款。 */
  observeMana(actorId: number): void {
    const actor = this.actor(actorId);
    if (!actor) return;
    const balance = units(actor.mana, 'down');
    const account = this.accounts.get(actorId);
    if (!account) {
      this.accounts.set(actorId, {
        opening: balance,
        last: balance,
        paid: 0,
        refunded: 0,
        regen: 0,
        clampLoss: 0,
        externalIn: 0,
        externalOut: 0,
      });
      return;
    }
    if (balance > account.last) {
      account.externalIn = checkedAdd(account.externalIn, balance - account.last);
      this.entry('mana-external-in', actorId, null, null, null, balance - account.last, 0);
    } else if (balance < account.last) {
      account.externalOut = checkedAdd(account.externalOut, account.last - balance);
      this.entry('mana-external-out', actorId, null, null, null, account.last - balance, 0);
    }
    account.last = balance;
  }

  /** 世界调用前先 observeMana；该变化不能被重新解释为外部调整。 */
  recordManaWorldChange(actorId: number, kind: 'regen' | 'clampLoss'): void {
    const actor = this.actor(actorId);
    const account = this.accounts.get(actorId);
    if (!actor || !account) return;
    const balance = units(actor.mana, 'down');
    const delta = balance - account.last;
    if (kind === 'regen' && delta >= 0) account.regen = checkedAdd(account.regen, delta);
    else if (kind === 'clampLoss' && delta <= 0)
      account.clampLoss = checkedAdd(account.clampLoss, -delta);
    else throw new RangeError('非法法力账户变化');
    account.last = balance;
    if (delta !== 0)
      this.entry(
        kind === 'regen' ? 'mana-regen' : 'mana-clamp',
        actorId,
        null,
        null,
        null,
        Math.abs(delta),
        0,
      );
  }

  manaAccountSnapshot(actorId: number) {
    this.observeMana(actorId);
    const account = this.accounts.get(actorId);
    if (!account) return null;
    return {
      ...account,
      balance: account.last,
      unit: 'micro' as const,
      conserved:
        BigInt(account.opening) +
          BigInt(account.regen) +
          BigInt(account.externalIn) +
          BigInt(account.refunded) ===
        BigInt(account.last) +
          BigInt(account.paid) +
          BigInt(account.clampLoss) +
          BigInt(account.externalOut),
    };
  }

  /** 付款成功才记分录；外部共享账户钩子只能在全部预检之后调用一次。 */
  payMana(
    payerId: number,
    amount: number,
    kind: string,
    spend?: (amount: number) => boolean,
  ): number | null {
    const payer = this.actor(payerId);
    const debit = units(amount, 'up');
    if (!payer || !payer.alive || units(payer.mana, 'down') < debit) return null;
    this.observeMana(payerId);
    const account = this.accounts.get(payerId)!;
    const next = checkedAdd(this.totals.payerMana, debit);
    const nextPaid = checkedAdd(account.paid, debit);
    const paid = debit / RESOURCE_SCALE;
    if (spend) {
      if (!spend(paid)) return null;
    } else {
      payer.mana = (units(payer.mana, 'down') - debit) / RESOURCE_SCALE;
    }
    this.totals.payerMana = next;
    account.paid = nextPaid;
    account.last = units(payer.mana, 'down');
    this.entry(kind, payerId, null, null, null, debit, 0);
    this.manaCommitted?.(payerId);
    return paid;
  }

  /** 1 M 注入 0.8 E；一笔事务预检容量、余额和累计，再付款并发布来源。 */
  canInjectBatch(
    entityId: number,
    payerId: number,
    requests: ReadonlyArray<{ pool: EnergyPool; mana: number }>,
  ): boolean {
    if (
      !this.canInject(entityId, payerId) ||
      this.closed.has(entityId) ||
      this.sources.length + requests.length > MAX_SOURCES
    )
      return false;
    const planned = { motion: 0, damage: 0, scan: 0 };
    try {
      for (const request of requests) {
        if (!['motion', 'damage', 'scan'].includes(request.pool)) return false;
        const payment = units(request.mana, 'up');
        if (payment <= 0) return false;
        planned[request.pool] = checkedAdd(
          planned[request.pool],
          Math.floor(payment / 5) * 4 + Math.floor(((payment % 5) * 4) / 5),
        );
      }
      for (const pool of ['motion', 'damage', 'scan'] as const) {
        if (this.balance(entityId)[pool] * RESOURCE_SCALE + planned[pool] > POOL_CAP) return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  inject(
    entityId: number,
    payerId: number,
    pool: EnergyPool,
    mana: number,
    sessionId: number | null = null,
    effectId: number | null = null,
  ): number | null {
    if (!['motion', 'damage', 'scan'].includes(pool)) return null;
    if (
      !this.canInject(entityId, payerId) ||
      this.closed.has(entityId) ||
      this.sources.length >= MAX_SOURCES
    )
      return null;
    const payment = units(mana, 'up');
    if (payment <= 0) return null;
    const energy = Math.floor(payment / 5) * 4 + Math.floor(((payment % 5) * 4) / 5);
    const loss = payment - energy;
    const balance = this.sources.reduce(
      (sum, source) =>
        sum +
        (source.entityId === entityId && source.pool === pool && !source.ended
          ? source.balance
          : 0),
      0,
    );
    if (checkedAdd(balance, energy) > POOL_CAP) return null;
    const nextInjection = checkedAdd(this.totals.injectionMana, payment);
    const nextMinted = checkedAdd(this.totals.mintedEnergy, energy);
    const nextLoss = checkedAdd(this.totals.conversionLoss, loss);
    const paid = this.payMana(payerId, payment / RESOURCE_SCALE, 'injection');
    if (paid === null) return null;
    const id = this.nextSequence;
    this.sources.push({
      id,
      entityId,
      payerId,
      sessionId,
      effectId,
      pool,
      paid: payment,
      minted: energy,
      balance: energy,
      reserved: 0,
      refunded: 0,
      used: { motionWork: 0, controlLoss: 0, damage: 0, scan: 0 },
      ended: false,
    });
    this.totals.injectionMana = nextInjection;
    this.totals.mintedEnergy = nextMinted;
    this.totals.conversionLoss = nextLoss;
    this.entry('energy-in', payerId, entityId, id, pool, payment, energy);
    this.retireSources();
    return id;
  }

  balance(entityId: number): EnergyBalance {
    const value = { motion: 0, damage: 0, scan: 0 };
    const reserved = { motion: 0, damage: 0, scan: 0 };
    for (const source of this.sources) {
      if (source.entityId !== entityId || source.ended) continue;
      value[source.pool] += source.balance;
      reserved[source.pool] += source.reserved;
    }
    return {
      motion: value.motion / RESOURCE_SCALE,
      damage: value.damage / RESOURCE_SCALE,
      scan: value.scan / RESOURCE_SCALE,
      reserved: {
        motion: reserved.motion / RESOURCE_SCALE,
        damage: reserved.damage / RESOURCE_SCALE,
        scan: reserved.scan / RESOURCE_SCALE,
      },
    };
  }

  /** 没有余额/预留的来源不再占活跃容量；累计账已独立保存，历史明细可淘汰。 */
  private retireSources(): void {
    this.sources = this.sources.filter((source) => {
      if (source.balance !== 0 || source.reserved !== 0) return true;
      source.ended = true;
      this.sourceHistory.push(source);
      return false;
    });
    if (this.sourceHistory.length > MAX_ENTRIES)
      this.sourceHistory.splice(0, this.sourceHistory.length - MAX_ENTRIES);
  }

  reserve(entityId: number, pool: EnergyPool, amount: number): number | null {
    if (!['motion', 'damage', 'scan'].includes(pool)) return null;
    if (this.closed.has(entityId) || this.reservations.size >= MAX_RESERVATIONS) return null;
    const requested = units(amount, 'up');
    if (requested <= 0) return null;
    const candidates = this.sources.filter(
      (source) => source.entityId === entityId && source.pool === pool && !source.ended,
    );
    if (candidates.reduce((sum, source) => sum + source.balance - source.reserved, 0) < requested)
      return null;
    let rest = requested;
    const parts: Reservation['parts'] = [];
    for (const source of candidates) {
      const take = Math.min(rest, source.balance - source.reserved);
      if (take > 0) {
        source.reserved += take;
        parts.push({ source, amount: take });
        rest -= take;
      }
      if (rest === 0) break;
    }
    const id = this.nextReservation++;
    this.reservations.set(id, { id, entityId, pool, parts, amount: requested, settled: false });
    return id;
  }

  /** 实际消耗可小于预留；余量原池释放。重复结算不再改账。 */
  settle(reservationId: number, use: Partial<Record<EnergyUse, number>>): boolean {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.settled) return false;
    const keys = (['motionWork', 'controlLoss', 'damage', 'scan'] as const).filter(
      (key) => use[key] !== undefined,
    );
    if (Object.keys(use).length !== keys.length) return false;
    if (
      keys.some((key) =>
        reservation.pool === 'motion'
          ? !['motionWork', 'controlLoss'].includes(key)
          : key !== reservation.pool,
      )
    )
      return false;
    const quantities = keys.map((key) => units(use[key]!, 'up'));
    const total = quantities.reduce(checkedAdd, 0);
    if (total > reservation.amount) return false;
    const nextTotals = keys.map((key, index) => checkedAdd(this.totals[key], quantities[index]));
    const nextHits =
      use.damage && use.damage > 0 ? checkedAdd(this.totals.hits, 1) : this.totals.hits;
    const nextScans =
      use.scan && use.scan > 0 ? checkedAdd(this.totals.scans, 1) : this.totals.scans;
    const available = reservation.parts.map((part) => part.amount);
    const allocated: Array<{ source: Source; key: EnergyUse; amount: number }> = [];
    for (let i = 0; i < keys.length; i++) {
      let rest = quantities[i];
      for (let j = 0; j < reservation.parts.length && rest > 0; j++) {
        const take = Math.min(rest, available[j]);
        if (take > 0) {
          allocated.push({ source: reservation.parts[j].source, key: keys[i], amount: take });
          available[j] -= take;
          rest -= take;
        }
      }
    }
    for (const part of reservation.parts) {
      part.source.reserved -= part.amount;
    }
    for (const item of allocated) {
      item.source.balance -= item.amount;
      item.source.used[item.key] += item.amount;
      this.entry(
        item.key,
        item.source.payerId,
        reservation.entityId,
        item.source.id,
        reservation.pool,
        0,
        item.amount,
      );
    }
    for (let i = 0; i < keys.length; i++) this.totals[keys[i]] = nextTotals[i];
    this.totals.hits = nextHits;
    this.totals.scans = nextScans;
    reservation.settled = true;
    // ID 单调且不复用，删除后的旧 ID 永远不能再次结算，无须保留完整预留。
    this.reservations.delete(reservationId);
    this.retireSources();
    return true;
  }

  consume(entityId: number, pool: EnergyPool, amount: number, use: EnergyUse): boolean {
    if (pool === 'motion' ? !['motionWork', 'controlLoss'].includes(use) : use !== pool)
      return false;
    const reservation = this.reserve(entityId, pool, amount);
    return reservation !== null && this.settle(reservation, { [use]: amount });
  }

  /** 清理先解除所有未做功预留，然后按来源 FIFO 退不超过剩余 E 的法力。 */
  terminate(entityId: number): number {
    const previous = this.closed.get(entityId);
    if (previous !== undefined) return previous / RESOURCE_SCALE;
    for (const reservation of this.reservations.values()) {
      if (reservation.entityId === entityId && !reservation.settled)
        this.settle(reservation.id, {});
    }
    const plannedBalances = new Map<number, number>();
    const plan: Array<{ source: Source; refund: number }> = [];
    let returned = 0;
    let refundedEnergy = this.totals.refundedEnergy;
    let refundedMana = this.totals.refundedMana;
    let terminationLoss = this.totals.terminationLoss;
    for (const source of this.sources) {
      if (source.entityId !== entityId || source.ended) continue;
      const candidate = this.actor(source.payerId);
      const beneficiary = candidate?.alive ? candidate : null;
      if (beneficiary) this.observeMana(beneficiary.id);
      let capacity = 0;
      if (beneficiary) {
        try {
          const balance = plannedBalances.get(beneficiary.id) ?? units(beneficiary.mana, 'down');
          capacity = Math.max(0, units(beneficiary.attr.manaMax, 'down') - balance);
        } catch {
          /* 失效账户的剩余能源归终止损耗。 */
        }
      }
      const refund = Math.min(source.balance, source.paid - source.refunded, capacity);
      const loss = source.balance - refund;
      refundedEnergy = checkedAdd(refundedEnergy, refund);
      refundedMana = checkedAdd(refundedMana, refund);
      terminationLoss = checkedAdd(terminationLoss, loss);
      returned = checkedAdd(returned, refund);
      if (beneficiary && refund > 0)
        plannedBalances.set(
          beneficiary.id,
          (plannedBalances.get(beneficiary.id) ?? units(beneficiary.mana, 'down')) + refund,
        );
      plan.push({ source, refund });
    }
    for (const [payerId, balance] of plannedBalances) {
      const account = this.accounts.get(payerId)!;
      account.refunded = checkedAdd(account.refunded, balance - account.last);
    }
    for (const [payerId, balance] of plannedBalances) {
      this.actor(payerId)!.mana = balance / RESOURCE_SCALE;
      this.accounts.get(payerId)!.last = balance;
    }
    for (const { source, refund } of plan) {
      source.refunded += refund;
      source.balance = 0;
      source.ended = true;
      this.entry('refund', source.payerId, entityId, source.id, source.pool, refund, refund);
    }
    this.totals.refundedEnergy = refundedEnergy;
    this.totals.refundedMana = refundedMana;
    for (const payerId of plannedBalances.keys()) this.manaCommitted?.(payerId);
    this.totals.terminationLoss = terminationLoss;
    this.closed.set(entityId, returned);
    this.retireSources();
    return returned / RESOURCE_SCALE;
  }

  snapshot() {
    const balance = this.sources.reduce((sum, source) => sum + source.balance, 0);
    const t = this.totals;
    return {
      unit: 'micro' as const,
      totals: { ...t },
      entries: this.entries.map((entry) => ({ ...entry })),
      sources: this.sources.length,
      reservations: this.reservations.size,
      conserved:
        BigInt(t.injectionMana) ===
        BigInt(balance) +
          BigInt(t.motionWork) +
          BigInt(t.controlLoss) +
          BigInt(t.damage) +
          BigInt(t.scan) +
          BigInt(t.terminationLoss) +
          BigInt(t.refundedEnergy) +
          BigInt(t.conversionLoss),
    };
  }

  /** 内部授权视图；凭证只来自实际付款，不根据实体当前属性补造来源。 */
  sourceSnapshot(entityId: number) {
    return [...this.sourceHistory, ...this.sources]
      .filter((source) => source.entityId === entityId)
      .sort((a, b) => a.id - b.id)
      .map((source) => ({
        id: source.id,
        entityId: source.entityId,
        payerId: source.payerId,
        sessionId: source.sessionId,
        effectId: source.effectId,
        pool: source.pool,
        paidMana: source.paid / RESOURCE_SCALE,
        mintedEnergy: source.minted / RESOURCE_SCALE,
        balance: source.balance / RESOURCE_SCALE,
        reserved: source.reserved / RESOURCE_SCALE,
        refundableEnergy:
          Math.min(source.balance - source.reserved, source.paid - source.refunded) /
          RESOURCE_SCALE,
        refundedMana: source.refunded / RESOURCE_SCALE,
        used: {
          motionWork: source.used.motionWork / RESOURCE_SCALE,
          controlLoss: source.used.controlLoss / RESOURCE_SCALE,
          damage: source.used.damage / RESOURCE_SCALE,
          scan: source.used.scan / RESOURCE_SCALE,
        },
        ended: source.ended,
      }));
  }
}
