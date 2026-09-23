import { migrateSpellSource } from '../core/index';
import type { Attributes } from '../core/index';
import { ARENA_ATTR_CONSTRAINT_BY_KEY } from './arenaConfig';

export const SAVE_SCHEMA_VERSION = 2;
export const SAVE_STORAGE_KEY = 'daoyan.player-state';
/** 旧版或被拒绝的原件留在原槽，新版编辑增量写入独立槽。 */
export const SAVE_INCREMENTAL_KEY = 'daoyan.player-state.v2';

export interface PlayerState {
  spellSource: string;
  arenaAttrs: Attributes;
  arenaBindings: Record<string, string>;
}

interface VersionedSave extends PlayerState {
  version: number;
}

export type LoadResult =
  | { ok: true; state: PlayerState; migrated: boolean; diagnostics?: string[] }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeState(
  value: unknown,
  defaults: PlayerState,
  legacySemantics = false,
): LoadResult {
  if (!isRecord(value) || typeof value.spellSource !== 'string') {
    return { ok: false, message: '存档缺少法术书内容。' };
  }
  const storedFields = new Set(['version', 'spellSource', 'arenaAttrs', 'arenaBindings']);
  const runtimeFields = new Set([
    'mods',
    'controlRecords',
    'activeSessions',
    'eventQueue',
    'keyEdges',
    'grants',
    'projectiles',
    'balances',
    'refundRights',
  ]);
  for (const field of Object.keys(value)) {
    if (!storedFields.has(field) && !runtimeFields.has(field)) {
      return { ok: false, message: `存档含无法识别的字段“${field}”。` };
    }
  }
  const migratedBook = migrateSpellSource(value.spellSource, null, legacySemantics);
  if (!migratedBook.ok) {
    const first = migratedBook.diagnostics[0];
    const location = first.line > 0 ? `第 ${first.line} 行` : '法术书';
    return {
      ok: false,
      message: `存档中的法术书无法解析或安全迁移：${location}，${first.message}`,
    };
  }
  const spellSource = migratedBook.source;

  const attrs = { ...defaults.arenaAttrs };
  if (value.arenaAttrs !== undefined && !isRecord(value.arenaAttrs)) {
    return { ok: false, message: '存档中的演武属性格式不正确。' };
  }
  if (isRecord(value.arenaAttrs)) {
    for (const key of Object.keys(value.arenaAttrs)) {
      if (!(key in attrs) && key !== 'cooldownMul') {
        return { ok: false, message: `存档含未知演武属性“${key}”。` };
      }
    }
    for (const key of Object.keys(attrs) as Array<keyof Attributes>) {
      const candidate = value.arenaAttrs[key];
      if (candidate === undefined) continue;
      const constraint = ARENA_ATTR_CONSTRAINT_BY_KEY.get(key);
      if (
        typeof candidate !== 'number' ||
        !Number.isFinite(candidate) ||
        !constraint ||
        candidate < constraint.min ||
        candidate > constraint.max
      ) {
        return { ok: false, message: `存档中的演武属性“${key}”不在允许范围内。` };
      }
      attrs[key] = candidate;
    }
  }
  const bindings = { ...defaults.arenaBindings };
  if (value.arenaBindings !== undefined && !isRecord(value.arenaBindings)) {
    return { ok: false, message: '存档中的槽位绑定格式不正确。' };
  }
  if (isRecord(value.arenaBindings)) {
    for (const [slot, spell] of Object.entries(value.arenaBindings)) {
      if (!(slot in bindings) || typeof spell !== 'string') {
        return { ok: false, message: `存档中的槽位绑定“${slot}”格式不正确。` };
      }
      bindings[slot] = spell;
    }
  }
  // 法术书存档没有世界或活动会话。兼容读取历史运行态字段，但绝不将
  // Modifier 的旧时长解释为无限 maintain，也不恢复未经结算验证的租约。
  const diagnostics: string[] = [];
  if (value.mods !== undefined) {
    diagnostics.push('旧增益运行态未导入；其时长不会转换为新的控制记录。');
  }
  if (value.controlRecords !== undefined) {
    diagnostics.push('控制记录运行态未导入；无法验证控制者、会话及结算状态。');
  }
  for (const field of runtimeFields) {
    if (field !== 'mods' && field !== 'controlRecords' && value[field] !== undefined) {
      diagnostics.push(`运行态“${field}”未导入；无法验证会话与资源来源。`);
    }
  }
  return {
    ok: true,
    state: { spellSource, arenaAttrs: attrs, arenaBindings: bindings },
    migrated: false,
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}

/** 旧 v0/v1 以旧语义隔离校验；v2 是新的供能与属性合同。 */
export function decodePlayerState(text: string, defaults: PlayerState): LoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: '存档不是有效的 JSON 文件。' };
  }
  if (!isRecord(raw)) return { ok: false, message: '存档格式不正确。' };

  if (raw.version === undefined) {
    const loaded = normalizeState(raw, defaults, true);
    return loaded.ok ? { ...loaded, migrated: true } : loaded;
  }
  if (raw.version === 1) {
    const loaded = normalizeState(raw, defaults, true);
    return loaded.ok ? { ...loaded, migrated: true } : loaded;
  }
  if (raw.version !== SAVE_SCHEMA_VERSION) {
    return typeof raw.version === 'number' && raw.version > SAVE_SCHEMA_VERSION
      ? { ok: false, message: '存档来自更新版本，当前道衍无法安全读取。' }
      : { ok: false, message: `不支持的存档版本：${String(raw.version)}。` };
  }
  return normalizeState(raw, defaults);
}

export function encodePlayerState(state: PlayerState): string {
  const normalized = normalizeState(state, state);
  if (!normalized.ok) throw new Error(normalized.message);
  const save: VersionedSave = { version: SAVE_SCHEMA_VERSION, ...normalized.state };
  return JSON.stringify(save, null, 2);
}

export function loadPlayerState(defaults: PlayerState): LoadResult {
  try {
    const text =
      window.localStorage.getItem(SAVE_INCREMENTAL_KEY) ??
      window.localStorage.getItem(SAVE_STORAGE_KEY);
    return text !== null
      ? decodePlayerState(text, defaults)
      : { ok: true, state: defaults, migrated: false };
  } catch {
    return { ok: false, message: '浏览器拒绝访问本地存档，已使用默认配置。' };
  }
}

/** 只保存可全量规范化的法术书，避免把编辑草稿或迁移诊断写成坏存档。 */
export function savePlayerState(state: PlayerState): LoadResult {
  const normalized = normalizeState(state, state);
  if (!normalized.ok) {
    return { ok: false, message: `当前法术书尚不能保存：${normalized.message}` };
  }
  try {
    const original = window.localStorage.getItem(SAVE_STORAGE_KEY);
    const incremental = window.localStorage.getItem(SAVE_INCREMENTAL_KEY);
    if (incremental !== null) {
      const incrementalLoad = decodePlayerState(incremental, state);
      if (!incrementalLoad.ok || incrementalLoad.migrated) {
        return { ok: false, message: '新版增量存档无法安全读取，原件已保留。' };
      }
    }
    const originalLoad = original === null ? null : decodePlayerState(original, state);
    const preserveOriginal =
      incremental !== null ||
      (originalLoad !== null &&
        (!originalLoad.ok || originalLoad.migrated || Boolean(originalLoad.diagnostics?.length)));
    window.localStorage.setItem(
      preserveOriginal ? SAVE_INCREMENTAL_KEY : SAVE_STORAGE_KEY,
      encodePlayerState(normalized.state),
    );
    return normalized;
  } catch {
    return { ok: false, message: '浏览器拒绝写入本地存档。' };
  }
}
