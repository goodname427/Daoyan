import { analyzeBook, migrateSpellSource, sensePrice, VM, World } from '../core/index';
import type { Actor, SpellBook, WorldProgramInstallation } from '../core/index';
import { B4_AUDIT, B4_PRICE_VERSION } from '../core/b4Audit';
import { finiteIntentFaction, type FirstBatchIntentOrigin } from './firstBatch';
import { compileFiniteProgram } from './finiteProgram';

export const B4_SPELL = {
  name: 'B4修壳',
  source: (() => {
    const lines = ['spell B4修壳 -> bool {'];
    for (let i = 0; i < 16; i++) {
      if (i === 4) lines.push('首批B4装载(1)');
      if (i === 12) lines.push('首批B4封印(1)');
      lines.push(`首批B4审计(1, ${i})`);
    }
    lines.push(
      '首批B4锁款(1)',
      '首批B4修壳(1)',
      '首批B4审计(1, 16)',
      '首批B4审计(1, 17)',
      'return 首批B4审计(1, 18)',
      '}',
    );
    return lines.join('\n');
  })(),
};

export function appendB4Spell(source: string): string {
  const migration = migrateSpellSource(source);
  if (!migration.ok) {
    const first = migration.diagnostics[0];
    throw new Error(
      `现有法术书不能安全迁移：${first.spell || '法术书'}${first.line ? ` 第 ${first.line} 行` : ''}，${first.message}；原件已保留。`,
    );
  }
  const book = migration.book;
  if (book[B4_SPELL.name]) throw new Error('法术书已有“B4修壳”，原件已保留。');
  return `${source.trimEnd()}\n\n${B4_SPELL.source}\n`;
}

export type B4Case =
  | 'success'
  | 'emptyRead'
  | 'noSource'
  | 'competingLot'
  | 'postStale'
  | 'revokedRead'
  | 'capacityUnknown'
  | 'queueFull'
  | 'outOfDomain'
  | 'recontact'
  | 'recontactMeasured'
  | 'recontactQueueFull';

type RecontactCapacity = 'capacityUnknown' | 'queueFull' | 'sufficient';

export interface B4Result {
  scenario: B4Case;
  astHash: string;
  canonicalAstBytes: number;
  staticMana: number;
  staticTicks: number;
  staticShenshi: number;
  capacityTotal: number;
  capacityOccupied: number | null;
  capacityReservedPeak: number | null;
  capacityAvailable: number | null;
  vmRan: boolean;
  success: boolean;
  reason: string;
  naturalContacts: number;
  naturalShellAfter: number | null;
  naturalFragmentAfter: number | null;
  readReceipts: number;
  actionFacts: number;
  shellAfter: number | null;
  wasteAfter: number | null;
  payerPaid: number;
  payerBalance: number;
  vmMana: number;
  vmTicks: number;
  emptyReadReceipt: boolean;
  emptyReadTicks: number;
  nextResponse: {
    contactCommitted: boolean;
    quote: 'invalidated' | 'undetermined';
    capacity: RecontactCapacity;
    capacityReadCount: number;
    capacityReadPaid: number;
    freshReadReceipts: number;
    vmRan: false;
  } | null;
}

function checked(value: unknown, step: string): void {
  if (!value) throw new Error(`B1→B4 有限世界准备失败：${step}`);
}

const certificate = (materialVersion: string, panelK0: number) => ({
  mass: 2,
  radius: 0.5,
  restitution: 0.5,
  massVersion: `${materialVersion}-mass`,
  shapeVersion: `${materialVersion}-shape`,
  materialVersion,
  fracturedMaterialVersion: `${materialVersion}-fractured`,
  attachedK0: 3,
  panelK0,
  fractureThresholdLow: 1.75,
  intactThresholdHigh: 1.5,
  fractureWork: 2,
  peakDivisor: 3,
  heatSinkId: 'heat-B1-impact-01',
});

type PendingResponseIntent = { contactId: string; intentId: string };

/** Admit a prior intent to the carrier FIFO only against a committed contact. */
function enqueuePendingResponse(
  world: World,
  fifoSlots: number,
  queue: PendingResponseIntent[],
  contactId: string,
  intentId: string,
): boolean {
  if (
    !world.naturalContacts.some((fact) => fact.id === contactId) ||
    !Number.isSafeInteger(fifoSlots) ||
    queue.length >= fifoSlots ||
    queue.some((intent) => intent.intentId === intentId)
  )
    return false;
  queue.push({ contactId, intentId });
  return true;
}

/** Re-read the carrier after the new contact; the bridge owns its bounded pending-intent FIFO. */
function measureRecontactCapacity(
  world: World,
  carrier: Actor,
  installation: WorldProgramInstallation,
  programHash: string,
  registeredBodyVersion: string,
  fifoSlots: number,
  pendingIntents: readonly PendingResponseIntent[],
  contactId: string | null,
  authorized: boolean,
): { capacity: RecontactCapacity; readCount: number; paid: number } {
  if (
    !authorized ||
    !contactId ||
    installation.programHash !== programHash ||
    world.naturalBodyState(carrier.id)?.materialVersion !== registeredBodyVersion ||
    !Number.isSafeInteger(fifoSlots) ||
    fifoSlots < 1 ||
    pendingIntents.some(
      (intent) =>
        intent.contactId !== contactId ||
        !intent.intentId ||
        !world.naturalContacts.some((fact) => fact.id === intent.contactId),
    )
  )
    return { capacity: 'capacityUnknown', readCount: 0, paid: 0 };

  const values: number[] = [];
  let paid = 0;
  for (const field of ['shenshiUsed', 'shenshiMax'] as const) {
    const quote = world.senseQuote(carrier, carrier.id, field);
    if (!quote) return { capacity: 'capacityUnknown', readCount: values.length, paid };
    const price = sensePrice(quote).mana.value;
    if (world.resourceLedger.payMana(carrier.id, price, `b4-capacity:${field}`) === null)
      return { capacity: 'capacityUnknown', readCount: values.length, paid };
    paid += price;
    const reading = world.readEntityAuditField(carrier.id, field);
    if (!reading.ok || typeof reading.value !== 'number')
      return { capacity: 'capacityUnknown', readCount: values.length, paid };
    values.push(reading.value);
  }
  const [used, total] = values;
  const occupied = pendingIntents.length;
  if (
    !Number.isSafeInteger(used) ||
    !Number.isSafeInteger(total) ||
    used < 0 ||
    total !== carrier.attr.shenshiMax ||
    used < installation.reservedPeakShenshi ||
    installation.reservedPeakShenshi > total ||
    used > total
  )
    return { capacity: 'capacityUnknown', readCount: values.length, paid };
  if (occupied >= fifoSlots) return { capacity: 'queueFull', readCount: values.length, paid };
  return { capacity: 'sufficient', readCount: values.length, paid };
}

/** Finite B1 natural contact and B4 action share one real World and VM program. */
export function runFirstBatchB4(
  book: SpellBook,
  scenario: B4Case,
  origin: FirstBatchIntentOrigin = 'mouse',
): B4Result {
  if (!book[B4_SPELL.name]) throw new Error('同书缺少“B4修壳”。');
  const cost = analyzeBook(book)[B4_SPELL.name];
  if (cost.errors.length) throw new Error(`B4 静态预算未通过：${cost.errors.join('；')}`);
  const program = compileFiniteProgram(book, B4_SPELL.name);
  const world = new World();
  const faction = finiteIntentFaction(origin);
  const oppositeFaction = faction === 'player' ? 'foe' : 'player';
  checked(
    world.setNaturalContactPolicy({
      version: 'B1-contact-v1',
      geometryEpsilon: 1 / 1024,
      timeEpsilon: 1 / 4096,
      rootEpsilon: 1 / 8192,
      maxSubdivisions: 16,
    }),
    '接触策略',
  );
  const beacon = world.spawnActor({
    faction,
    x: 0,
    y: 0,
    attrs: { manaMax: 50, manaRegen: 0, shenshiMax: 1024 },
  });
  const treasury = world.spawnActor({
    faction,
    x: -20,
    y: 0,
    attrs: { manaMax: 50, manaRegen: 0 },
  });
  const corpse = world.spawnActor({ faction: oppositeFaction, x: 2, y: 0 });
  beacon.mana = 0;
  checked(world.fundFiniteMana('b4-funding', treasury.id, beacon.id, 50), '本人已结来源');
  const weightMain = world.spawnActor({ faction, x: -100, y: -2 });
  const weightAux = world.spawnActor({ faction, x: -110, y: -1 });
  checked(
    world.registerNaturalBody(weightMain.id, { ...certificate('main-weight', 0), restitution: 0 }),
    '主重物',
  );
  checked(
    world.registerNaturalBody(weightAux.id, {
      ...certificate('aux-weight', 0),
      mass: 1,
      restitution: 0,
    }),
    '辅重物',
  );
  for (const [id, load] of [
    ['main-anchor', 3],
    ['aux-anchor', 2],
    ['anchor-B1-v1', 24],
  ] as const)
    checked(
      world.registerFiniteAnchor({
        id,
        reactionEndpointId: id === 'anchor-B1-v1' ? 'ground-B1' : `ground-${id}`,
        loadLower: load,
        version: id === 'anchor-B1-v1' ? id : 'v0',
      }),
      `锚 ${id}`,
    );
  checked(
    world.registerFinitePotentialSource({
      id: 'potential-main',
      bodyId: weightMain.id,
      ownerId: beacon.id,
      anchorId: 'main-anchor',
      gravity: 4 / 3,
      referenceY: 0,
      error: 1,
      version: 'potential-main-v0',
    }),
    '主势能',
  );
  checked(
    world.registerFinitePotentialSource({
      id: 'potential-aux',
      bodyId: weightAux.id,
      ownerId: beacon.id,
      anchorId: 'aux-anchor',
      gravity: 5 / 3,
      referenceY: 0,
      error: 1,
      version: 'potential-aux-v0',
    }),
    '辅势能',
  );
  for (const id of ['source-B1-work', 'EL-B1-B4', 'Aux-B1-01', 'Aux-work-B1', 'clamp-spent-B1'])
    checked(
      world.registerFiniteEnergyInventory({
        id,
        ownerId: beacon.id,
        energy: 0,
        error: 0,
        version: `${id}-v0`,
        originFactId: `initial-${id}`,
      }),
      `能量 lot ${id}`,
    );
  for (const id of [
    'heat-B1-B4-01',
    'heat-B1-aux',
    'heat-B1-clamp',
    'heat-B1-acquire',
    'heat-B1-impact-01',
    'env-B1-heat-v1',
  ])
    checked(world.registerFiniteHeatSink(id, 0, 100, `${id}-v0`), `热汇 ${id}`);
  const grant = (
    id: string,
    kind: Parameters<World['registerFiniteGrant']>[0]['kind'],
    sourceId: string,
    targetId: string | null,
    maxAmount: number,
    fields?: readonly string[],
    phase?: 'R0' | 'R1' | 'R2' | 'R3' | 'POST',
    issuerId = beacon.id,
  ) =>
    checked(
      world.registerFiniteGrant({
        id,
        kind,
        sourceId,
        targetId,
        maxAmount,
        fields,
        phase,
        executorId: beacon.id,
        issuerId,
        revokeOnIssuerDeath: true,
        version: 'v1',
      }),
      `授权 ${id}`,
    );
  grant('acquire-main', 'energy-transfer', 'potential-main', 'source-B1-work', 64);
  grant('acquire-aux', 'energy-transfer', 'potential-aux', 'Aux-B1-01', 20);
  if (scenario !== 'noSource') {
    checked(
      world.transferFiniteEnergy(
        'acquire-main',
        beacon.id,
        'potential-main',
        'source-B1-work',
        64,
        0,
        'heat-B1-acquire',
        'acquire-main',
        'potential-main-v1',
        'source-B1-work-v1',
        'heat-B1-acquire-v1',
      ),
      '主源取得',
    );
  }
  checked(
    world.transferFiniteEnergy(
      'acquire-aux',
      beacon.id,
      'potential-aux',
      'Aux-B1-01',
      20,
      0,
      'heat-B1-acquire',
      'acquire-aux',
      'potential-aux-v1',
      'Aux-B1-01-v1',
      scenario === 'noSource' ? 'heat-B1-acquire-v1' : 'heat-B1-acquire-v2',
    ),
    '辅源取得',
  );
  for (const [id, quantity, ownerId, capacity] of [
    ['Corpse-k0-01', 3, corpse.id, undefined],
    ['fragment-B1-01', 0, corpse.id, undefined],
    ['Depot-k0-01', 4, beacon.id, undefined],
    ['staging-B4-k0', 0, beacon.id, undefined],
    ['waste-B4-k0-01', 0, beacon.id, 10],
  ] as const)
    checked(
      world.registerFiniteMaterialInventory({
        id,
        quantity,
        ownerId,
        capacity,
        kind: 'k0',
        version: `${id}-v0`,
        originFactId: `initial-${id}`,
      }),
      `材料 lot ${id}`,
    );
  world.sealFiniteInitialState();
  const carrierHardware = {
    pageCapacityBytes: 4096,
    slotCapacityBytes: 64,
    subscriptionSlots: 1,
    fifoSlots: scenario === 'queueFull' ? 0 : 1,
    referenceSlots: 1,
    frameSlots: 1,
  };
  checked(
    world.registerNaturalBody(beacon.id, {
      ...certificate('ball-v0', 0),
      headIntegrityLower: 1,
      headLoadLower: 1,
      structuralError: 0,
      programHardware: carrierHardware,
    }),
    '法球身体',
  );
  checked(
    world.registerNaturalBody(corpse.id, {
      ...certificate('Corpse-k0-01-v0', 1),
      fracturedMaterialVersion: 'Corpse-k0-01-v1',
      materialInventoryId: 'Corpse-k0-01',
      fragmentInventoryId: 'fragment-B1-01',
      portApertureQ: 1,
      portLoadLower: 1,
      structuralError: 0,
    }),
    '目标普通壳',
  );
  beacon.velocity.x = 1;
  corpse.velocity.x = -3;
  const [contact] = world.advanceNaturalContacts(0.25);
  checked(
    contact?.materialResults.some(
      (item) => item.bodyId === corpse.id && item.result === 'fractured',
    ),
    'B1 自然破壳',
  );
  const naturalStructureFactId = contact.materialResults.find(
    (item) => item.bodyId === corpse.id,
  )?.structureFactId;
  checked(naturalStructureFactId, 'B1 自然结构事实');
  const naturalShellAfter = world.finiteMaterialState('Corpse-k0-01')?.quantity ?? null;
  const naturalFragmentAfter = world.finiteMaterialState('fragment-B1-01')?.quantity ?? null;
  const capacityAdmitted =
    scenario !== 'outOfDomain' &&
    world.registerFiniteProgramCapacity(
      {
        version: 'capacity-B1-v1',
        bodyId: beacon.id,
        structureVersion: 'ball-v0',
        programHash: program.astHash,
        totalShenshi: 1024,
        occupiedShenshi: scenario === 'capacityUnknown' ? 1 : 0,
        pageBytes: new TextEncoder().encode(program.canonicalAst).length,
        pageCapacityBytes: 4096,
        slotBytes: 64,
        slotCapacityBytes: 64,
        subscriptionFree: 1,
        fifoFree: scenario === 'queueFull' ? 0 : 1,
        referenceFree: 1,
        frameFree: 1,
      },
      program,
    );
  if (!capacityAdmitted) {
    if (scenario !== 'capacityUnknown' && scenario !== 'queueFull' && scenario !== 'outOfDomain')
      throw new Error('B1→B4 有限世界准备失败：程序容量');
    return {
      scenario,
      astHash: program.astHash,
      canonicalAstBytes: new TextEncoder().encode(program.canonicalAst).length,
      staticMana: cost.manaWorst,
      staticTicks: cost.tickWorst,
      staticShenshi: cost.shenshiPeak,
      capacityTotal: beacon.attr.shenshiMax,
      capacityOccupied: null,
      capacityReservedPeak: null,
      capacityAvailable: null,
      vmRan: false,
      success: false,
      reason:
        scenario === 'outOfDomain'
          ? '域外：关键回路修复不在首批 A；自然破壳保留，未尝试付款或主动作用'
          : scenario === 'queueFull'
            ? 'queueFull：本体 FIFO 实满，后封未准入 VM；自然破壳保留'
            : 'capacityUnknown：旧占用证据与实体实测不符，未准入 VM；自然破壳保留',
      naturalContacts: world.naturalContacts.length,
      naturalShellAfter,
      naturalFragmentAfter,
      readReceipts: world.b4ReadReceipts.length,
      actionFacts: world.b4ActionFacts.length,
      shellAfter: world.finiteMaterialState('Corpse-k0-01')?.quantity ?? null,
      wasteAfter: world.finiteMaterialState('waste-B4-k0-01')?.quantity ?? null,
      payerPaid: 0,
      payerBalance: beacon.mana,
      vmMana: 0,
      vmTicks: 0,
      emptyReadReceipt: false,
      emptyReadTicks: 0,
      nextResponse: null,
    };
  }
  const installation = world.finiteProgramInstallation(beacon.id);
  checked(installation, '程序安装实测');
  grant('payerGrant-B4-v1', 'pay', 'acct-B1-B4', null, 44);
  grant('physicalGrant-B4-v1', 'action', 'EL-B1-B4', 'Corpse-k0-01', 1);
  grant('transfer-main', 'energy-transfer', 'source-B1-work', 'EL-B1-B4', 44);
  grant('transfer-aux', 'energy-transfer', 'Aux-B1-01', 'Aux-work-B1', 12);
  grant('transfer-clamp', 'energy-transfer', 'Aux-work-B1', 'clamp-spent-B1', 3);
  grant('transfer-material', 'material-transfer', 'Depot-k0-01', 'staging-B4-k0', 2);
  const endpointVersion = (id: string): string => {
    if (scenario === 'postStale' && world.b4ActionFacts.length && id === 'source-B1-work')
      return 'stale-after-action';
    if (world.finiteEnergyState(id)) return world.finiteEnergyState(id)!.version;
    if (world.finiteHeatState(id)) return world.finiteHeatState(id)!.version;
    if (id === 'Corpse-k0-01' || id === 'port-corpse-k0-v0')
      return world.naturalBodyState(corpse.id)!.materialVersion;
    if (id === 'head-B1-v0') return world.naturalBodyState(beacon.id)!.materialVersion;
    if (world.finiteMaterialState(id)) return world.finiteMaterialState(id)!.version;
    return 'anchor-B1-v1';
  };
  const sample = (id: string, field: string): number | string | null => {
    const energy = world.finiteEnergyState(id);
    const heat = world.finiteHeatState(id);
    const lot = world.finiteMaterialState(id);
    if (field === 'energyRaw') return energy?.energy ?? heat?.energy ?? null;
    if (field === 'err') return energy?.error ?? 0;
    if (
      [
        'lotVersion',
        'sealVersion',
        'sinkVersion',
        'environmentVersion',
        'structureVersion',
        'materialVersion',
        'connectionVersion',
      ].includes(field)
    )
      return endpointVersion(id);
    if (field === 'sliceState')
      return energy!.version.includes('retired')
        ? 'retired'
        : energy!.version.includes('R3')
          ? 'sealed'
          : 'available';
    if (field === 'Qk0Raw' || field === 'availableQ') return lot?.quantity ?? null;
    if (field === 'freeCapacityQ')
      return lot?.capacity === undefined ? null : lot.capacity - lot.quantity;
    if (field === 'freeCapacityLower') return heat!.capacity - heat!.energy;
    if (field === 'gapQ') return 3 - world.naturalBodyState(corpse.id)!.attachedK0!;
    if (field === 'thresholdLow') return 1.75;
    if (field === 'thresholdHigh') return 1.5;
    if (field === 'reactionEndpointId') return 'ground-B1';
    if (field === 'loadLower') return id === 'anchor-B1-v1' ? 24 : 1;
    if (field === 'integrityLower' || field === 'apertureQ') return 1;
    return null;
  };
  const allEndpoints = [...new Set(B4_AUDIT.flatMap((d) => d.projection.map((p) => p.endpointId)))];
  for (const id of allEndpoints)
    checked(
      world.registerFiniteAuditEndpoint(id, {
        version: () => endpointVersion(id),
        error: (field) => (field === 'energyRaw' ? (world.finiteEnergyState(id)?.error ?? 0) : 0),
        visibleTo: () => true,
        read: (field) => sample(id, field),
      }),
      `审计端 ${id}`,
    );
  const r0 = Object.fromEntries(allEndpoints.map((id) => [id, endpointVersion(id)]));
  const afterLoad = { ...r0 };
  for (const id of ['source-B1-work', 'EL-B1-B4', 'Aux-B1-01', 'heat-B1-B4-01', 'Depot-k0-01'])
    afterLoad[id] += '-b4-smoke-V1';
  const r3: Record<string, string> = { ...afterLoad, 'EL-B1-B4': 'seal-B4-b4-smoke-R3' };
  const post: Record<string, string> = {
    ...r3,
    'EL-B1-B4': 'seal-B4-b4-smoke-retired',
    'heat-B1-B4-01': `${r3['heat-B1-B4-01']}-action-b4-smoke`,
    'Corpse-k0-01': 'Corpse-k0-01-v2',
    'port-corpse-k0-v0': 'Corpse-k0-01-v2',
    'waste-B4-k0-01': 'waste-B4-b4-smoke',
  };
  const endpointVersions: Record<string, string>[] = [];
  const endpointGrantIds: Record<string, string>[] = [];
  for (let i = 0; i < B4_AUDIT.length; i++) {
    const descriptor = B4_AUDIT[i];
    const phaseVersions = i < 4 ? r0 : i < 12 ? afterLoad : i < 16 ? r3 : post;
    const versions: Record<string, string> = {};
    const grants: Record<string, string> = {};
    for (const projection of descriptor.projection) {
      const id = projection.endpointId;
      const grantId = `g-${i}-${id}`;
      versions[id] = phaseVersions[id];
      grants[id] = grantId;
      grant(
        grantId,
        'read',
        id,
        null,
        1,
        projection.fields,
        descriptor.phase,
        id === 'Corpse-k0-01' ? corpse.id : beacon.id,
      );
    }
    endpointVersions.push(versions);
    endpointGrantIds.push(grants);
  }
  checked(
    world.registerB4ReadSession({
      id: 1,
      requestId: 'b4-smoke',
      executorId: beacon.id,
      payerId: beacon.id,
      payerGrantId: 'payerGrant-B4-v1',
      priceVersion: B4_PRICE_VERSION,
      programHash: program.astHash,
      endpointVersions,
      endpointGrantIds,
      directScan: false,
    }),
    '审计会话',
  );
  checked(
    world.registerB4ActionPlan({
      sessionId: 1,
      requestId: 'b4-smoke',
      executorId: beacon.id,
      targetId: corpse.id,
      payerId: beacon.id,
      programHash: program.astHash,
      capacityVersion: 'capacity-B1-v1',
      sourceLotId: 'source-B1-work',
      packageLotId: 'EL-B1-B4',
      auxiliaryLotId: 'Aux-B1-01',
      auxiliaryWorkingLotId: 'Aux-work-B1',
      clampSpentLotId: 'clamp-spent-B1',
      auxiliaryHeatSinkId: 'heat-B1-aux',
      clampHeatSinkId: 'heat-B1-clamp',
      stagingLotId: 'staging-B4-k0',
      depotLotId: 'Depot-k0-01',
      corpseLotId: 'Corpse-k0-01',
      wasteLotId: 'waste-B4-k0-01',
      heatSinkId: 'heat-B1-B4-01',
      anchorId: 'anchor-B1-v1',
      sliceId: 'slice-B4-01',
      naturalStructureFactId: naturalStructureFactId!,
      physicalGrantId: 'physicalGrant-B4-v1',
      sourceTransferGrantId: 'transfer-main',
      auxiliaryTransferGrantId: 'transfer-aux',
      clampTransferGrantId: 'transfer-clamp',
      materialTransferGrantId: 'transfer-material',
      payerGrantId: 'payerGrant-B4-v1',
      priceVersion: B4_PRICE_VERSION,
      repairedMaterialVersion: 'Corpse-k0-01-v2',
      repairedStructureVersion: 'X-B1-B4-01',
      loadEnergyFromSource: 44,
      loadEnergyToPackage: 32,
      loadHeat: 12,
      loadMaterial: 2,
      auxiliaryDraw: 12,
      auxiliaryToWork: 8,
      auxiliaryHeat: 4,
      clampWork: 3,
      actionEnergy: 24,
      structureWork: 12,
      actionHeat: 12,
      shellMaterial: 1,
      wasteMaterial: 1,
      impulse: { x: -4, y: 0 },
    }),
    'B4 作用计划',
  );
  if (scenario === 'competingLot')
    checked(
      world.transferFiniteMaterial(
        'competing-lot',
        beacon.id,
        'Depot-k0-01',
        'staging-B4-k0',
        2,
        'transfer-material',
        'competing-depot-v1',
        'competing-staging-v1',
      ),
      '材料竞争',
    );
  if (scenario === 'revokedRead')
    checked(world.revokeFiniteGrant(`g-0-${B4_AUDIT[0].projection[0].endpointId}`), '撤销首读授权');
  const before = beacon.mana;
  const result = new VM(program, world, beacon).run(B4_SPELL.name);
  const action = world.b4ActionFacts[0];
  const completeReads =
    world.b4ReadReceipts.length === B4_AUDIT.length &&
    world.b4ReadReceipts.every((receipt, index) => receipt.readId === B4_AUDIT[index].readId);
  const firstSuccess = result.ok && result.returnValue === true && Boolean(action) && completeReads;
  const recontactCase =
    scenario === 'recontact' ||
    scenario === 'recontactMeasured' ||
    scenario === 'recontactQueueFull';
  if (recontactCase && firstSuccess) {
    beacon.x = 0;
    corpse.x = 2;
    beacon.velocity.x = 1;
    corpse.velocity.x = -3;
    world.advanceNaturalContacts(0.25);
  }
  const secondContact =
    recontactCase && world.naturalContacts.length > 1 ? world.naturalContacts.at(-1)! : null;
  // The first program installation and nineteen receipts cover the first contact only.
  // A new contact invalidates that quote even when it does not fracture more shell.
  // The carrier's one-slot FIFO is owned by this bridge. An earlier, distinct
  // manual intent can occupy that slot after the second contact is committed.
  const pendingIntents: PendingResponseIntent[] = [];
  if (scenario === 'recontactQueueFull' && secondContact)
    checked(
      enqueuePendingResponse(
        world,
        carrierHardware.fifoSlots,
        pendingIntents,
        secondContact.id,
        `manual-before-b4-${secondContact.id}`,
      ),
      '再撞前序意图入本体 FIFO',
    );
  const capacity = secondContact
    ? measureRecontactCapacity(
        world,
        beacon,
        installation!,
        program.astHash,
        'ball-v0',
        carrierHardware.fifoSlots,
        pendingIntents,
        secondContact.id,
        scenario !== 'recontact',
      )
    : { capacity: 'capacityUnknown' as const, readCount: 0, paid: 0 };
  const nextResponse: B4Result['nextResponse'] = recontactCase
    ? {
        contactCommitted: secondContact !== null,
        quote: secondContact ? 'invalidated' : 'undetermined',
        capacity: capacity.capacity,
        capacityReadCount: capacity.readCount,
        capacityReadPaid: capacity.paid,
        freshReadReceipts: world.b4ReadReceipts.filter(
          (receipt) => receipt.requestId === 'b4-recontact',
        ).length,
        vmRan: false,
      }
    : null;
  let emptyReadReceipt = false;
  if (scenario === 'emptyRead' && firstSuccess) {
    grant('payerGrant-B4-empty', 'pay', 'acct-B1-B4', null, 2);
    const versions: Record<string, string> = {};
    const grants: Record<string, string> = {};
    for (const projection of B4_AUDIT[3].projection) {
      const id = projection.endpointId;
      const grantId = `g-empty-${id}`;
      versions[id] = endpointVersion(id);
      grants[id] = grantId;
      grant(
        grantId,
        'read',
        id,
        null,
        1,
        projection.fields,
        'R0',
        id === 'Corpse-k0-01' ? corpse.id : beacon.id,
      );
    }
    const emptyVersions = Array.from({ length: B4_AUDIT.length }, (_, index) =>
      index === 3 ? versions : {},
    );
    const emptyGrants = Array.from({ length: B4_AUDIT.length }, (_, index) =>
      index === 3 ? grants : {},
    );
    checked(
      world.registerB4ReadSession({
        id: 2,
        requestId: 'b4-empty',
        executorId: beacon.id,
        payerId: beacon.id,
        payerGrantId: 'payerGrant-B4-empty',
        priceVersion: B4_PRICE_VERSION,
        programHash: program.astHash,
        endpointVersions: emptyVersions,
        endpointGrantIds: emptyGrants,
        directScan: true,
      }),
      '获准空读会话',
    );
    const readOk = world.vmB4Read(
      2,
      3,
      program.astHash,
      (payerId, mana, _ticks, kind) => world.resourceLedger.payMana(payerId, mana, kind) !== null,
    );
    emptyReadReceipt = readOk && world.b4ReadReceipts.at(-1)?.emptyResult === true;
  }
  const success =
    firstSuccess && (scenario !== 'emptyRead' || emptyReadReceipt) && nextResponse === null;
  return {
    scenario,
    astHash: program.astHash,
    canonicalAstBytes: new TextEncoder().encode(program.canonicalAst).length,
    staticMana: cost.manaWorst,
    staticTicks: cost.tickWorst,
    staticShenshi: cost.shenshiPeak,
    capacityTotal: beacon.attr.shenshiMax,
    capacityOccupied: installation!.occupiedBefore,
    capacityReservedPeak: installation!.reservedPeakShenshi,
    capacityAvailable: installation!.availableAfterInstallPeak,
    vmRan: true,
    success,
    reason:
      scenario === 'emptyRead' && emptyReadReceipt
        ? '获准空读另付 2 M；原 B4 修壳保留，未新增修壳作用'
        : nextResponse
          ? !action
            ? '首次修壳未提交；再撞未证，旧报价不可用于新请求；capacityUnknown，第二 VM 未执行'
            : nextResponse.contactCommitted
              ? `首次修壳已提交；再撞自然事实已结，旧报价及读覆盖撤证；${nextResponse.capacity}：${nextResponse.capacity === 'queueFull' ? '同版本体 FIFO 已被在途意图占满' : nextResponse.capacity === 'sufficient' ? '新读本体占用及 FIFO 余位足额，但新 B4 价与读集未证' : '新接触下本体占用未获准重读'}，第二 VM 未执行`
              : '首次修壳已提交；再撞接触未证，旧报价不可用于新请求；capacityUnknown，第二 VM 未执行'
          : action
            ? scenario === 'postStale'
              ? '壳修已提交；POST 失证，已付与自然事实保留'
              : success
                ? '普通惰性壳修及 POST 全链已提交'
                : '普通壳修已提交；读序或 POST 证据不全，不能宣称完整成功'
            : scenario === 'noSource'
              ? '无已证主源；自然破壳保留，壳修未提交'
              : scenario === 'competingLot'
                ? '同 lot 竞争；自然破壳保留，壳修未提交'
                : scenario === 'revokedRead'
                  ? '读权撤销；读前拒绝，未扣本笔且自然破壳保留'
                  : '条件未满足；自然破壳保留，壳修未提交',
    naturalContacts: world.naturalContacts.length,
    naturalShellAfter,
    naturalFragmentAfter,
    readReceipts: world.b4ReadReceipts.length,
    actionFacts: world.b4ActionFacts.length,
    shellAfter:
      nextResponse === null ? (world.finiteMaterialState('Corpse-k0-01')?.quantity ?? null) : null,
    wasteAfter: world.finiteMaterialState('waste-B4-k0-01')?.quantity ?? null,
    payerPaid: before - beacon.mana,
    payerBalance: beacon.mana,
    vmMana: result.mana,
    vmTicks: result.ticks,
    emptyReadReceipt,
    emptyReadTicks: emptyReadReceipt ? world.b4ReadReceipts.at(-1)!.ticks : 0,
    nextResponse,
  };
}
