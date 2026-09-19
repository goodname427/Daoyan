// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  decodePlayerState,
  encodePlayerState,
  loadPlayerState,
  savePlayerState,
  SAVE_SCHEMA_VERSION,
  SAVE_STORAGE_KEY,
} from '../src/app/persistence';
import type { PlayerState } from '../src/app/persistence';
import { parseSpellbook, serializeBook } from '../src/core/index';
import { DEFAULT_PLAYER_ATTRS, DEFAULT_PLAYER_BINDINGS } from '../src/game/battle';
import INITIAL_SPELLS from '../src/game/spells.dy?raw';

const defaults: PlayerState = {
  spellSource: serializeBook(parseSpellbook(INITIAL_SPELLS)),
  arenaAttrs: { ...DEFAULT_PLAYER_ATTRS },
  arenaBindings: { ...DEFAULT_PLAYER_BINDINGS },
};

describe('versioned player state', () => {
  it('round-trips the spellbook and arena setup in the current schema', () => {
    const state: PlayerState = {
      ...defaults,
      arenaAttrs: { ...defaults.arenaAttrs, hpMax: 240 },
      arenaBindings: { ...defaults.arenaBindings, '1': '三连剑' },
    };
    const loaded = decodePlayerState(encodePlayerState(state), defaults);
    expect(loaded).toEqual({ ok: true, state, migrated: false });
    expect(JSON.parse(encodePlayerState(state)).version).toBe(SAVE_SCHEMA_VERSION);
  });

  it('migrates an unversioned v0 save and fills settings added later', () => {
    const loaded = decodePlayerState(
      JSON.stringify({ spellSource: INITIAL_SPELLS, arenaAttrs: { hpMax: 240 } }),
      defaults,
    );
    expect(loaded).toMatchObject({ ok: true, migrated: true });
    if (loaded.ok) {
      expect(loaded.state.arenaAttrs.hpMax).toBe(240);
      expect(loaded.state.arenaAttrs.manaMax).toBe(DEFAULT_PLAYER_ATTRS.manaMax);
      expect(loaded.state.arenaBindings).toEqual(DEFAULT_PLAYER_BINDINGS);
    }
  });

  it('restores the last valid automatic save without replacing it with invalid editor input', () => {
    localStorage.clear();
    const state: PlayerState = {
      ...defaults,
      arenaAttrs: { ...defaults.arenaAttrs, hpMax: 240 },
    };

    expect(savePlayerState(state)).toMatchObject({ ok: true });
    const saved = localStorage.getItem(SAVE_STORAGE_KEY);
    expect(savePlayerState({ ...state, spellSource: 'spell {' })).toMatchObject({ ok: false });
    expect(localStorage.getItem(SAVE_STORAGE_KEY)).toBe(saved);
    expect(loadPlayerState(defaults)).toEqual({ ok: true, state, migrated: false });
  });

  it('stores and exports the canonical DSL rather than editor comments', () => {
    const state: PlayerState = { ...defaults, spellSource: '// 临时注释\nspell 基础剑气 {}' };

    const saved = savePlayerState(state);

    expect(saved).toMatchObject({ ok: true, state: { spellSource: 'spell 基础剑气 {\n\n}' } });
    expect(JSON.parse(localStorage.getItem(SAVE_STORAGE_KEY) ?? '{}').spellSource).toBe(
      'spell 基础剑气 {\n\n}',
    );
  });

  it('rejects malformed spellbooks and saves from a newer app', () => {
    expect(decodePlayerState('{', defaults)).toMatchObject({ ok: false });
    expect(
      decodePlayerState(JSON.stringify({ version: 99, spellSource: INITIAL_SPELLS }), defaults),
    ).toMatchObject({ ok: false, message: expect.stringContaining('更新版本') });
    expect(
      decodePlayerState(JSON.stringify({ version: 1, spellSource: 'spell {' }), defaults),
    ).toMatchObject({ ok: false, message: expect.stringContaining('无法解析') });
  });

  it.each([
    ['negative mana cost multiplier', 'manaCostMul', -1],
    ['non-positive cast speed', 'castSpeed', 0],
    ['attribute above the arena maximum', 'hpMax', 501],
  ])('rejects a save with %s', (_description, key, value) => {
    const loaded = decodePlayerState(
      JSON.stringify({
        version: SAVE_SCHEMA_VERSION,
        spellSource: INITIAL_SPELLS,
        arenaAttrs: { [key]: value },
      }),
      defaults,
    );

    expect(loaded).toMatchObject({ ok: false, message: expect.stringContaining('演武属性') });
  });

  it('rejects a malformed arena attribute object instead of silently using defaults', () => {
    expect(
      decodePlayerState(
        JSON.stringify({
          version: SAVE_SCHEMA_VERSION,
          spellSource: INITIAL_SPELLS,
          arenaAttrs: [],
        }),
        defaults,
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining('演武属性') });
  });
});
