import { parseSpellbook, serializeBook } from '../core/index';
import type { Attributes } from '../core/index';
import { ARENA_ATTR_CONSTRAINT_BY_KEY } from './arenaConfig';

export const SAVE_SCHEMA_VERSION = 1;
export const SAVE_STORAGE_KEY = 'daoyan.player-state';

export interface PlayerState {
  spellSource: string;
  arenaAttrs: Attributes;
  arenaBindings: Record<string, string>;
}

interface VersionedSave extends PlayerState {
  version: number;
}

export type LoadResult =
  { ok: true; state: PlayerState; migrated: boolean } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeState(value: unknown, defaults: PlayerState): LoadResult {
  if (!isRecord(value) || typeof value.spellSource !== 'string') {
    return { ok: false, message: '存档缺少法术书内容。' };
  }
  let spellSource: string;
  try {
    // 存档是可交换的数据，不是编辑器草稿：只保留 AST 可表达的规范 DSL。
    spellSource = serializeBook(parseSpellbook(value.spellSource));
  } catch {
    return { ok: false, message: '存档中的法术书无法解析。' };
  }

  const attrs = { ...defaults.arenaAttrs };
  if (value.arenaAttrs !== undefined && !isRecord(value.arenaAttrs)) {
    return { ok: false, message: '存档中的演武属性格式不正确。' };
  }
  if (isRecord(value.arenaAttrs)) {
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
  if (isRecord(value.arenaBindings)) {
    for (const [slot, spell] of Object.entries(value.arenaBindings)) {
      if (typeof spell === 'string') bindings[slot] = spell;
    }
  }
  return {
    ok: true,
    state: { spellSource, arenaAttrs: attrs, arenaBindings: bindings },
    migrated: false,
  };
}

/** 将历史 v0（无 version 字段）和当前 v1 收敛为应用状态。 */
export function decodePlayerState(text: string, defaults: PlayerState): LoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: '存档不是有效的 JSON 文件。' };
  }
  if (!isRecord(raw)) return { ok: false, message: '存档格式不正确。' };

  if (raw.version === undefined) {
    const loaded = normalizeState(raw, defaults);
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
  const save: VersionedSave = { version: SAVE_SCHEMA_VERSION, ...state };
  return JSON.stringify(save, null, 2);
}

export function loadPlayerState(defaults: PlayerState): LoadResult {
  try {
    const text = window.localStorage.getItem(SAVE_STORAGE_KEY);
    return text
      ? decodePlayerState(text, defaults)
      : { ok: true, state: defaults, migrated: false };
  } catch {
    return { ok: false, message: '浏览器拒绝访问本地存档，已使用默认配置。' };
  }
}

/** 只保存可解析法术书，避免把编辑中的语法错误变成下次启动时的坏存档。 */
export function savePlayerState(state: PlayerState): LoadResult {
  const normalized = normalizeState(state, state);
  if (!normalized.ok) {
    return { ok: false, message: '当前法术书尚不能保存：请先修正语法错误。' };
  }
  try {
    window.localStorage.setItem(SAVE_STORAGE_KEY, encodePlayerState(normalized.state));
    return normalized;
  } catch {
    return { ok: false, message: '浏览器拒绝写入本地存档。' };
  }
}
