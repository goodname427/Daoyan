import type { AttrKey } from '../core/index';

/** 演武场和存档边界共同遵循的玩家属性范围。 */
export const ARENA_ATTR_CONSTRAINTS: ReadonlyArray<{
  key: AttrKey;
  min: number;
  max: number;
  step: number;
}> = [
  { key: 'hpMax', min: 20, max: 500, step: 10 },
  { key: 'manaMax', min: 20, max: 800, step: 10 },
  { key: 'manaRegen', min: 0, max: 120, step: 1 },
  { key: 'shenshiMax', min: 8, max: 160, step: 1 },
  { key: 'speed', min: 0, max: 360, step: 5 },
  { key: 'castSpeed', min: 0.1, max: 5, step: 0.05 },
  { key: 'power', min: 0.1, max: 5, step: 0.05 },
  { key: 'manaCostMul', min: 0.1, max: 3, step: 0.05 },
  { key: 'cooldownMul', min: 0.1, max: 3, step: 0.05 },
  { key: 'perception', min: 0.1, max: 3, step: 0.05 },
  { key: 'armor', min: 0, max: 120, step: 1 },
];

export const ARENA_ATTR_CONSTRAINT_BY_KEY = new Map(
  ARENA_ATTR_CONSTRAINTS.map((constraint) => [constraint.key, constraint]),
);
