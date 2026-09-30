import { analyzeBook, migrateSpellSource, VM, World } from '../core/index';
import type { SpellBook } from '../core/index';
import { compileFiniteProgram } from './finiteProgram';

export type FirstBatchKind = 'J1' | 'D1';
export type FirstBatchCase = 'success' | 'noSource' | 'revokedRead';
export type FirstBatchIntentOrigin =
  'mouse' | 'keyboard' | 'gamepad' | 'monster-ai' | 'entity-event' | 'enemy-cultivator';

export function finiteIntentFaction(origin: FirstBatchIntentOrigin): 'player' | 'foe' {
  return origin === 'monster-ai' || origin === 'enemy-cultivator' ? 'foe' : 'player';
}

const READS = {
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

export const FIRST_BATCH_SPELLS: Record<FirstBatchKind, { name: string; source: string }> =
  Object.fromEntries(
    (['J1', 'D1'] as const).map((kind) => {
      const lines = [`spell ${kind}执行 -> bool {`];
      if (kind === 'J1') lines.push('首批J1阶段(1, 0)');
      READS[kind].forEach((_, i) => {
        if (i === 1) lines.push(`首批${kind}阶段(1, 3)`);
        if (i === 3) lines.push(`首批${kind}阶段(1, 1)`);
        if (i === 6) lines.push(`首批${kind}阶段(1, 4)`);
        if (i === 9) lines.push(`首批${kind}阶段(1, 5)`);
        if (i === (kind === 'J1' ? 13 : 12)) lines.push(`首批${kind}阶段(1, 2)`);
        lines.push(`${i === READS[kind].length - 1 ? 'return ' : ''}首批${kind}原读(1, ${i})`);
      });
      lines.push('}');
      return [kind, { name: `${kind}执行`, source: lines.join('\n') }];
    }),
  ) as Record<FirstBatchKind, { name: string; source: string }>;

function checked(value: unknown, step: string): void {
  if (!value) throw new Error(`有限世界准备失败：${step}`);
}

export interface FirstBatchResult {
  kind: FirstBatchKind;
  scenario: FirstBatchCase;
  astHash: string;
  canonicalAstBytes: number;
  staticMana: number;
  staticTicks: number;
  staticShenshi: number;
  capacityTotal: number;
  capacityOccupied: number;
  capacityReservedPeak: number;
  capacityAvailable: number;
  success: boolean;
  reason: string;
  payerPaid: number;
  payerBalance: number;
  readReceipts: number;
  actionFacts: number;
  actionImpulse: number | null;
  vmMana: number;
  vmTicks: number;
}

/** A bounded arena scene. All energy, grants, reads and payments are registered in the real World. */
export function runFirstBatchDrive(
  book: SpellBook,
  kind: FirstBatchKind,
  scenario: FirstBatchCase,
  origin: FirstBatchIntentOrigin = 'mouse',
): FirstBatchResult {
  const spell = FIRST_BATCH_SPELLS[kind].name;
  if (!book[spell]) throw new Error(`同书缺少“${spell}”。`);
  const cost = analyzeBook(book)[spell];
  if (cost.errors.length) throw new Error(`“${spell}”未通过静态预算：${cost.errors.join('；')}`);
  const program = compileFiniteProgram(book, spell);
  const world = new World();
  const faction = finiteIntentFaction(origin);
  const oppositeFaction = faction === 'player' ? 'foe' : 'player';
  const owner = world.spawnActor({
    faction,
    x: 0,
    y: 0,
    attrs: { manaMax: 60, manaRegen: 0, shenshiMax: 128 },
  });
  const donor = world.spawnActor({
    faction,
    x: -10,
    y: 0,
    attrs: { manaMax: 200, manaRegen: 0 },
  });
  owner.mana = 0;
  checked(
    world.fundFiniteMana(`fund-${kind}`, donor.id, owner.id, kind === 'J1' ? 32 : 40),
    '本人已结来源',
  );
  const p0 =
    kind === 'J1' ? world.spawnActor({ faction, x: -11, y: 0, attrs: { manaMax: 1 } }) : null;
  const p2 =
    kind === 'J1' ? world.spawnActor({ faction, x: -12, y: 0, attrs: { manaMax: 2 } }) : null;
  if (p0 && p2) {
    p0.mana = 0;
    p2.mana = 0;
    checked(world.fundFiniteMana('fund-P0', donor.id, p0.id, 1), 'P0 来源');
    checked(world.fundFiniteMana('fund-P2', donor.id, p2.id, 2), 'P2 来源');
  }
  const target = kind === 'J1' ? world.spawnActor({ faction: oppositeFaction, x: 1, y: 0 }) : owner;
  const body = (name: string) => ({
    mass: 1,
    radius: 0.5,
    restitution: 0,
    massVersion: `${name}-m`,
    shapeVersion: `${name}-s`,
    materialVersion: `${name}-x`,
    fracturedMaterialVersion: `${name}-xf`,
    attachedK0: 1,
    panelK0: 0,
    fractureThresholdLow: 1,
    intactThresholdHigh: 0.5,
    fractureWork: 0,
    peakDivisor: 1,
    heatSinkId: `heat-${name}`,
    contactLoadLower: 10,
    structuralError: 0,
  });
  checked(
    world.registerNaturalBody(owner.id, {
      ...body('owner'),
      programHardware: {
        pageCapacityBytes: 4096,
        slotCapacityBytes: 64,
        subscriptionSlots: 1,
        fifoSlots: 2,
        referenceSlots: 2,
        frameSlots: 1,
      },
    }),
    '执行体',
  );
  if (target !== owner) checked(world.registerNaturalBody(target.id, body('target')), '目标');
  const brick = kind === 'D1' ? world.spawnActor({ faction: oppositeFaction, x: 1, y: 0 }) : null;
  if (brick) checked(world.registerNaturalBody(brick.id, body('brick')), '足地接触');
  const mainWeight = world.spawnActor({
    faction,
    x: -50,
    y: -(kind === 'J1' ? 4 : 10 / 3),
  });
  const auxWeight = world.spawnActor({ faction, x: -51, y: -7 / 3 });
  for (const weight of [mainWeight, auxWeight])
    checked(world.registerNaturalBody(weight.id, body(`weight-${weight.id}`)), '重物');
  const ids = {
    source: `source-${kind}`,
    pack: `pack-${kind}`,
    aux: `aux-${kind}`,
    work: `work-${kind}`,
    spent: `spent-${kind}`,
    pot: `pot-${kind}`,
    auxPot: `aux-pot-${kind}`,
    anchor: `anchor-${kind}`,
    mainAcq: `heat-${kind}-main-acq`,
    auxAcq: `heat-${kind}-aux-acq`,
    mainHeat: `heat-${kind}-main`,
    auxHeat: `heat-${kind}-aux`,
    clampHeat: `heat-${kind}-clamp`,
    actionHeat: `heat-${kind}-action`,
    env: `heat-${kind}-env`,
  };
  for (const [id, weight] of [
    [ids.pot, mainWeight],
    [ids.auxPot, auxWeight],
  ] as const) {
    checked(
      world.registerFiniteAnchor({
        id: `anchor-${id}`,
        reactionEndpointId: `ground-${id}`,
        loadLower: 10,
        version: `v-${id}`,
      }),
      '势能锚',
    );
    checked(
      world.registerFinitePotentialSource({
        id,
        bodyId: weight.id,
        ownerId: owner.id,
        anchorId: `anchor-${id}`,
        gravity: 1,
        referenceY: 0,
        error: 0,
        version: `v-${id}`,
      }),
      '势能来源',
    );
  }
  for (const id of [ids.source, ids.pack, ids.aux, ids.work, ids.spent])
    checked(
      world.registerFiniteEnergyInventory({
        id,
        ownerId: owner.id,
        energy: 0,
        error: 0,
        version: `v-${id}`,
        originFactId: `initial-${id}`,
      }),
      '能量容器',
    );
  for (const id of [
    ids.mainAcq,
    ids.auxAcq,
    ids.mainHeat,
    ids.auxHeat,
    ids.clampHeat,
    ids.actionHeat,
    ids.env,
  ])
    checked(world.registerFiniteHeatSink(id, 0, 100, `v-${id}`), '热汇');
  checked(
    world.registerFiniteAnchor({
      id: ids.anchor,
      reactionEndpointId: `ground-${kind}`,
      loadLower: 10,
      version: 'anchor-v0',
    }),
    '反作用锚',
  );
  const grant = (
    id: string,
    grantKind: 'energy-transfer' | 'action' | 'contact' | 'pay' | 'read',
    sourceId: string,
    targetId: string | null,
    maxAmount: number,
    issuerId = owner.id,
    fields?: readonly string[],
  ) =>
    checked(
      world.registerFiniteGrant({
        id,
        kind: grantKind,
        sourceId,
        targetId,
        maxAmount,
        fields,
        executorId: owner.id,
        issuerId,
        revokeOnIssuerDeath: true,
        version: 'v1',
      }),
      `授权 ${id}`,
    );
  grant('g-main-acq', 'energy-transfer', ids.pot, ids.source, kind === 'J1' ? 48 : 40);
  grant('g-aux-acq', 'energy-transfer', ids.auxPot, ids.aux, 28);
  grant('g-main-load', 'energy-transfer', ids.source, ids.pack, 20);
  grant('g-aux-load', 'energy-transfer', ids.aux, ids.work, 12);
  grant('g-clamp', 'energy-transfer', ids.work, ids.spent, 3);
  grant('g-action', 'action', ids.pack, String(target.id), 1);
  if (brick) grant('g-contact', 'contact', String(brick.id), String(target.id), 1, brick.id);
  grant('g-pay', 'pay', kind === 'J1' ? 'acct-J1' : 'acct-M1-D1', null, kind === 'J1' ? 32 : 40);
  if (p0 && p2) {
    grant('g-p0', 'pay', 'acct-J1-P0', null, 1, p0.id);
    grant('g-p2', 'pay', 'acct-J1-P2', null, 2, p2.id);
  }
  const names: readonly string[] = READS[kind];
  const endpoints = (name: string): string[] =>
    name.endsWith('POST-H-R2') || name.endsWith('POST-H')
      ? [ids.actionHeat, ids.env]
      : name.endsWith('H-R0')
        ? [ids.mainAcq, ids.auxAcq, ids.env]
        : name.startsWith('JH-H-') || name.startsWith('D1-H-')
          ? [ids.mainHeat, ids.auxHeat, ids.clampHeat, ids.env]
          : name.startsWith('D1-A-')
            ? [ids.aux, ids.work, String(brick!.id), ids.anchor]
            : name.startsWith('JH-A-')
              ? [ids.aux, ids.work, ids.anchor]
              : name === 'JH-POST-S-R0'
                ? [ids.source, ids.anchor]
                : name === 'D1-POST-A'
                  ? [ids.source, ids.pack, String(target.id), String(brick!.id)]
                  : name === 'JH-M-R3'
                    ? [ids.source, ids.pack, ids.anchor]
                    : name.startsWith('D1-M-')
                      ? [ids.source, ids.pack, String(target.id)]
                      : [ids.source, ids.pack];
  const readGrantIds = names.map((name, i) =>
    Object.fromEntries(
      endpoints(name).map((id) => {
        const prior = i === 12 && kind === 'J1' ? `g-read-9-${id}` : `g-read-${i}-${id}`;
        if (i !== 12 || kind !== 'J1')
          grant(prior, 'read', id, null, 1, owner.id, [
            id === ids.anchor || id === String(target.id) || id === String(brick?.id)
              ? 'loadLower'
              : 'energyRaw',
          ]);
        return [id, prior];
      }),
    ),
  );
  checked(
    world.registerFiniteProgramCapacity(
      {
        profile: kind,
        version: `cap-${kind}`,
        bodyId: owner.id,
        structureVersion: 'owner-x',
        programHash: program.astHash,
        totalShenshi: owner.attr.shenshiMax,
        occupiedShenshi: 0,
        pageBytes: new TextEncoder().encode(program.canonicalAst).length,
        pageCapacityBytes: 4096,
        slotBytes: 64,
        slotCapacityBytes: 64,
        subscriptionFree: 1,
        fifoFree: 2,
        referenceFree: 2,
        frameFree: 1,
      },
      program,
    ),
    '程序容量',
  );
  const installation = world.finiteProgramInstallation(owner.id);
  checked(installation, '程序安装实测');
  checked(
    world.registerFiniteDriveSession({
      id: 1,
      kind,
      requestId: `request-${kind}`,
      executorId: owner.id,
      targetId: target.id,
      reactionBodyId: brick?.id,
      reactionGrantId: brick ? 'g-contact' : undefined,
      payerId: owner.id,
      p0Id: p0?.id,
      p2Id: p2?.id,
      programHash: program.astHash,
      capacityVersion: `cap-${kind}`,
      sourceId: ids.source,
      packageId: ids.pack,
      mainPotentialId: ids.pot,
      auxiliaryPotentialId: ids.auxPot,
      mainAcquisitionGrantId: 'g-main-acq',
      auxiliaryAcquisitionGrantId: 'g-aux-acq',
      mainAcquisitionHeatSinkId: ids.mainAcq,
      auxiliaryAcquisitionHeatSinkId: ids.auxAcq,
      auxiliarySourceId: ids.aux,
      auxiliaryWorkingId: ids.work,
      auxiliarySpentId: ids.spent,
      auxiliaryHeatSinkId: ids.auxHeat,
      clampHeatSinkId: ids.clampHeat,
      actionHeatSinkId: ids.actionHeat,
      environmentHeatSinkId: ids.env,
      heatSinkId: ids.mainHeat,
      anchorId: ids.anchor,
      sourceGrantId: 'g-main-load',
      auxiliaryTransferGrantId: 'g-aux-load',
      clampTransferGrantId: 'g-clamp',
      actionGrantId: 'g-action',
      payerGrantId: 'g-pay',
      p0GrantId: p0 ? 'g-p0' : undefined,
      p2GrantId: p2 ? 'g-p2' : undefined,
      readGrantIds,
      impulse: { x: 1, y: 0 },
    }),
    '执行会话',
  );
  if (scenario === 'noSource') mainWeight.y = 0;
  if (scenario === 'revokedRead')
    checked(world.revokeFiniteGrant(`g-read-1-${ids.source}`), '撤销读权');
  const before = owner.mana;
  const result = new VM(program, world, owner).run(spell);
  const action = world.driveActionFacts[0];
  const completeReads =
    world.driveReadReceipts.length === names.length &&
    world.driveReadReceipts.every((receipt, index) => receipt.readId === names[index]);
  const success = result.ok && result.returnValue === true && Boolean(action) && completeReads;
  return {
    kind,
    scenario,
    astHash: program.astHash,
    canonicalAstBytes: new TextEncoder().encode(program.canonicalAst).length,
    staticMana: cost.manaWorst,
    staticTicks: cost.tickWorst,
    staticShenshi: cost.shenshiPeak,
    capacityTotal: owner.attr.shenshiMax,
    capacityOccupied: installation!.occupiedBefore,
    capacityReservedPeak: installation!.reservedPeakShenshi,
    capacityAvailable: installation!.availableAfterInstallPeak,
    success,
    reason: action
      ? success
        ? '作用及全链原读已提交'
        : '作用已提交；读序或 POST 证据不全，不能宣称完整成功'
      : scenario === 'noSource'
        ? '无已证势能来源；未取得工作能量'
        : scenario === 'revokedRead'
          ? '读权已撤销；后续阶段未提交'
          : '条件未满足；本次未提交作用',
    payerPaid: before - owner.mana,
    payerBalance: owner.mana,
    readReceipts: world.driveReadReceipts.length,
    actionFacts: world.driveActionFacts.length,
    actionImpulse: action?.impulsePair[0].x ?? null,
    vmMana: result.mana,
    vmTicks: result.ticks,
  };
}

/** Only finite pilot source is offered as a new spell; legacy source is never rewritten. */
export function appendFirstBatchSpell(source: string, kind: FirstBatchKind): string {
  const migration = migrateSpellSource(source);
  if (!migration.ok) {
    const first = migration.diagnostics[0];
    throw new Error(
      `现有法术书不能安全迁移：${first.spell || '法术书'}${first.line ? ` 第 ${first.line} 行` : ''}，${first.message}；原件已保留。`,
    );
  }
  const book = migration.book;
  const { name, source: spell } = FIRST_BATCH_SPELLS[kind];
  if (book[name]) throw new Error(`法术书已有“${name}”，原件已保留。`);
  return `${source.trimEnd()}\n\n${spell}\n`;
}
