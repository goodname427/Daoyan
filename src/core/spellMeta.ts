import type { Spell } from './ast';

/**
 * 法术生命周期（参考 UE GAS 的能力模型，但大幅简化）。
 *
 * | 类型 | 语义 | 典型用途 |
 * | --- | --- | --- |
 * | `instant`  | 开始 → 执行 → 结束 | 剑气、爆发、位移 |
 * | `duration` | 开始 → 每周期重复执行 → 到期结束 | 护体罡气、持续灼烧、领域 |
 * | `channel`  | 开始 → 持续引导（几乎不能移动）→ 结束 | 蓄力大招 |
 */
export type SpellKind = 'instant' | 'duration' | 'channel';

export interface SpellMeta {
  kind: SpellKind;
  /** duration 类型：每隔多少秒重复执行一次 */
  period: number;
  /** duration / channel：持续多少秒 */
  duration: number;
  /** 冷却秒数（0 表示无冷却） */
  cooldown: number;
  /** 受击是否打断 */
  interruptible: boolean;
  /** channel 类型的移动速度倍率 */
  channelSlow: number;
  /**
   * 该法术需要的虚拟按键名（按索引访问）。
   * 例如 `['蓄力']` 表示需要 1 个键，DSL 里用 `按键松开(0)` 读取。
   * 物理键由玩家在游玩时自由配置（见 Battle.pressSlot / keyBinds）。
   */
  keys: string[];
}

export const DEFAULT_SPELL_META: SpellMeta = {
  kind: 'instant',
  period: 1,
  duration: 3,
  cooldown: 0,
  interruptible: true,
  channelSlow: 0.15,
  keys: [],
};

export const SPELL_KIND_LABELS: Record<SpellKind, string> = {
  instant: '瞬时',
  duration: '持续',
  channel: '引导',
};

export function normalizeMeta(patch?: Partial<SpellMeta> | null): SpellMeta {
  return { ...DEFAULT_SPELL_META, ...(patch ?? {}) };
}

export function spellMeta(spell: Spell): SpellMeta {
  return normalizeMeta(spell.meta);
}

/** 持续类法术在一次施放中会执行多少次 */
export function repeatCount(meta: SpellMeta): number {
  if (meta.kind !== 'duration') return 1;
  const p = Math.max(0.05, meta.period);
  return Math.max(1, Math.ceil(meta.duration / p));
}

export function describeMeta(meta: SpellMeta): string {
  const key = meta.keys.length > 0 ? ` · ${meta.keys.length}键[${meta.keys.join(',')}]` : '';
  switch (meta.kind) {
    case 'instant':
      return (meta.cooldown > 0 ? `瞬时 · 冷却 ${meta.cooldown}s` : '瞬时') + key;
    case 'duration':
      return `持续 ${meta.duration}s · 每 ${meta.period}s 触发（共 ${repeatCount(meta)} 次）${key}`;
    case 'channel':
      return `引导 ≤${meta.duration}s · 移速 ×${meta.channelSlow}${key}`;
  }
}
