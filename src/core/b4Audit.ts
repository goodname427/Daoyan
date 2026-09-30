export interface AuditProjection {
  readonly endpointId: string;
  readonly fields: readonly string[];
}
export interface AuditDescriptor {
  readonly readId: string;
  readonly phase: 'R0' | 'R1' | 'R2' | 'R3' | 'POST';
  readonly projection: readonly AuditProjection[];
  readonly mana: number;
  readonly ticks: number;
}

export const B4_PRICE_VERSION = 'mdai-B4-audit-v1';
export const B4_WORK_VERSION = 'audit-work-v1';

const endpoints = {
  S: ['source-B1-work', 'energyRaw,err,lotVersion'],
  P: ['EL-B1-B4', 'energyRaw,err,sliceState,sealVersion'],
  U: ['Aux-B1-01', 'energyRaw,err,lotVersion'],
  A: ['anchor-B1-v1', 'loadLower,reactionEndpointId,structureVersion'],
  H: ['head-B1-v0', 'integrityLower,loadLower,err,structureVersion'],
  T: ['heat-B1-B4-01', 'energyRaw,err,freeCapacityLower,sinkVersion'],
  E: ['env-B1-heat-v1', 'energyRaw,err,freeCapacityLower,environmentVersion'],
  C: ['Corpse-k0-01', 'Qk0Raw,thresholdLow,thresholdHigh,gapQ,structureVersion,materialVersion'],
  R: ['port-corpse-k0-v0', 'apertureQ,loadLower,err,connectionVersion'],
  D: ['Depot-k0-01', 'Qk0Raw,availableQ,lotVersion'],
  W: ['waste-B4-k0-01', 'Qk0Raw,freeCapacityQ,lotVersion'],
} as const;

const project = (...keys: (keyof typeof endpoints)[]): AuditProjection[] =>
  keys.map((key) => ({
    endpointId: endpoints[key][0],
    fields: endpoints[key][1].split(','),
  }));

const pre = [
  ['main', project('S', 'P'), 1, 10],
  ['aux', project('U', 'A', 'H'), 2, 14],
  ['heat', project('T', 'E'), 1, 11],
  ['material', project('C', 'R', 'D', 'W'), 2, 21],
] as const;

/** Fixed index 0–18; each ID has its own grant, sample and receipt. */
export const B4_AUDIT: readonly AuditDescriptor[] = [
  ...(['R0', 'R1', 'R2', 'R3'] as const).flatMap((phase) =>
    pre.map(([name, projection, mana, ticks]) => ({
      readId: `Read-B4-${name}-${phase}`,
      phase,
      projection,
      mana,
      ticks,
    })),
  ),
  { readId: 'POST-B4-main', phase: 'POST', projection: project('S', 'P', 'D'), mana: 2, ticks: 14 },
  { readId: 'POST-B4-heat', phase: 'POST', projection: project('T', 'E'), mana: 1, ticks: 11 },
  {
    readId: 'POST-B4-material',
    phase: 'POST',
    projection: project('C', 'R', 'H', 'W'),
    mana: 2,
    ticks: 22,
  },
];
