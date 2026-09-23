// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  decodePlayerState,
  encodePlayerState,
  loadPlayerState,
  savePlayerState,
  SAVE_INCREMENTAL_KEY,
  SAVE_SCHEMA_VERSION,
  SAVE_STORAGE_KEY,
} from '../src/app/persistence';
import type { PlayerState } from '../src/app/persistence';
import {
  compileProgram,
  metaIndex,
  migrateSpellSource,
  Op,
  parseSpellbook,
  serializeBook,
} from '../src/core/index';
import { DEFAULT_PLAYER_ATTRS, DEFAULT_PLAYER_BINDINGS } from '../src/game/battle';
import INITIAL_SPELLS from '../src/game/spells.dy?raw';
import DEMO_SPELLS from '../src/demo/spells.dy?raw';
import { importSpellPresets, SPELL_PRESETS } from '../src/app/spellPresets';

const defaults: PlayerState = {
  spellSource: serializeBook(parseSpellbook('spell 稳定 {}')),
  arenaAttrs: { ...DEFAULT_PLAYER_ATTRS },
  arenaBindings: { ...DEFAULT_PLAYER_BINDINGS },
};

describe('versioned player state', () => {
  it('keeps default and sample spells on the unified creation entry', () => {
    for (const source of [INITIAL_SPELLS, DEMO_SPELLS]) {
      expect(source).not.toMatch(/发射\s*\(|设置弹道(?:方向|速度|威力)\s*\(|激活弹道\s*\(/);
      // 经 AST 编译后检查实参个数，避免把嵌套调用的右括号误认作创建结束。
      const creations = compileProgram(parseSpellbook(source))
        .fns.flatMap((fn) => fn.code)
        .filter((inst) => inst.op === Op.CALLMETA && inst.a === metaIndex('创建弹道'));
      expect(creations.length).toBeGreaterThan(0);
      for (const creation of creations) expect(creation.b).toBe(5);
    }
    const migration = migrateSpellSource(INITIAL_SPELLS);
    expect(migration.ok).toBe(true);
    if (migration.ok) {
      for (const name of Object.keys(migration.book)) compileProgram(migration.book, name);
    }
  });

  it('selectively imports current user presets and preserves names, content and save round trips', () => {
    const original = 'spell 对手减速 { 自身实体() }\n\nspell 旧书 { 准星方向() }';
    const selected = importSpellPresets(original, [{ name: '对手减速', importAs: '对手减速2' }]);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const book = parseSpellbook(selected.source);
    expect(serializeBook({ 对手减速: book.对手减速 })).toBe(
      serializeBook(parseSpellbook('spell 对手减速 { 自身实体() }')),
    );
    expect(Object.keys(book)).toEqual(['对手减速', '旧书', '对手减速2']);
    compileProgram(book, '对手减速2');
    const repeated = importSpellPresets(selected.source, [
      { name: '对手减速', importAs: '任意新名' },
    ]);
    expect(repeated).toMatchObject({
      ok: true,
      source: selected.source,
      imported: [],
      skipped: ['对手减速'],
    });
    expect(
      importSpellPresets(original, [{ name: '对手减速', importAs: '对手减速' }]),
    ).toMatchObject({ ok: false });
    expect(
      importSpellPresets(original, [{ name: '对手破防', importAs: '错误;名称' }]),
    ).toMatchObject({ ok: false });
    for (const preset of SPELL_PRESETS) {
      const one = importSpellPresets(defaults.spellSource, [
        { name: preset.name, importAs: preset.name },
      ]);
      expect(one.ok).toBe(true);
      if (!one.ok) continue;
      const state = { ...defaults, spellSource: one.source };
      const decoded = decodePlayerState(encodePlayerState(state), defaults);
      expect(decoded).toMatchObject({ ok: true });
      if (decoded.ok)
        expect(
          compileProgram(parseSpellbook(decoded.state.spellSource), preset.name),
        ).toBeDefined();
    }
  });

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
      JSON.stringify({ spellSource: defaults.spellSource, arenaAttrs: { hpMax: 240 } }),
      defaults,
    );
    expect(loaded).toMatchObject({ ok: true, migrated: true });
    if (loaded.ok) {
      expect(loaded.state.arenaAttrs.hpMax).toBe(240);
      expect(loaded.state.arenaAttrs.manaMax).toBe(DEFAULT_PLAYER_ATTRS.manaMax);
      expect(loaded.state.arenaBindings).toEqual(DEFAULT_PLAYER_BINDINGS);
    }
  });

  it('drops legacy spell cooldowns and cooldown attributes while loading a current save', () => {
    const loaded = decodePlayerState(
      JSON.stringify({
        version: SAVE_SCHEMA_VERSION,
        spellSource: 'spell 旧术 @cooldown=12 { 自身位置() }',
        arenaAttrs: { ...defaults.arenaAttrs, cooldownMul: 0.5 },
      }),
      defaults,
    );

    expect(loaded).toMatchObject({ ok: true, migrated: false });
    if (loaded.ok) {
      expect(loaded.state.spellSource).not.toContain('@cooldown');
      expect(loaded.state.arenaAttrs).not.toHaveProperty('cooldownMul');
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

  it('rejects an old launch and retains the last save on an unsafe handle chain', () => {
    localStorage.clear();
    const legacy: PlayerState = {
      ...defaults,
      spellSource: 'spell 旧术 { 发射(自身位置(), 准星方向(), 18) }',
    };
    expect(savePlayerState(defaults)).toMatchObject({ ok: true });
    const previous = localStorage.getItem(SAVE_STORAGE_KEY);
    expect(savePlayerState(legacy)).toMatchObject({ ok: false });
    expect(localStorage.getItem(SAVE_STORAGE_KEY)).toBe(previous);
    const unsafe = {
      ...legacy,
      spellSource: 'spell 旧术 { var p: entity = 创建弹道(3) 设置弹道速度(p, 200) 激活弹道(p) }',
    };
    expect(savePlayerState(unsafe)).toMatchObject({ ok: false });
    expect(localStorage.getItem(SAVE_STORAGE_KEY)).toBe(previous);
    expect(
      decodePlayerState(JSON.stringify({ version: SAVE_SCHEMA_VERSION, ...unsafe }), defaults),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('第 1 行'),
    });
    expect(() => encodePlayerState(unsafe)).toThrow('无法解析或安全迁移');
    expect(savePlayerState({ ...legacy, spellSource: 'spell 旧术 { 不存在() }' })).toMatchObject({
      ok: false,
    });
    expect(localStorage.getItem(SAVE_STORAGE_KEY)).toBe(previous);
  });

  it('reads legacy modifiers without turning them into control leases and drops damaged records with a diagnostic', () => {
    const old = decodePlayerState(
      JSON.stringify({
        spellSource: 'spell 旧术 {}',
        mods: [{ attr: 'speed', value: 2, duration: -1 }],
      }),
      defaults,
    );
    expect(old).toMatchObject({ ok: true, migrated: true });
    if (!old.ok) return;
    expect(old.state.spellSource).toContain('spell 旧术');
    expect(old.state).not.toHaveProperty('mods');
    expect(old.diagnostics?.[0]).toContain('旧增益');

    const damaged = decodePlayerState(
      JSON.stringify({
        version: SAVE_SCHEMA_VERSION,
        spellSource: 'spell 稳定 {}',
        controlRecords: [{ propertyKey: 'speed', paidPeriods: -1 }],
      }),
      defaults,
    );
    expect(damaged).toMatchObject({ ok: true, migrated: false });
    if (!damaged.ok) return;
    expect(damaged.state).not.toHaveProperty('controlRecords');
    expect(damaged.diagnostics?.[0]).toContain('控制记录');
    expect(encodePlayerState(damaged.state)).not.toContain('controlRecords');
  });

  it('leaves a rejected local save untouched for recovery', () => {
    localStorage.clear();
    const damaged = JSON.stringify({
      version: SAVE_SCHEMA_VERSION,
      spellSource: 'spell 旧术 { 创建弹道(2) }',
    });
    localStorage.setItem(SAVE_STORAGE_KEY, damaged);
    expect(loadPlayerState(defaults)).toMatchObject({ ok: false });
    expect(localStorage.getItem(SAVE_STORAGE_KEY)).toBe(damaged);
    localStorage.setItem(SAVE_STORAGE_KEY, '');
    expect(loadPlayerState(defaults)).toMatchObject({ ok: false });
    expect(localStorage.getItem(SAVE_STORAGE_KEY)).toBe('');
  });

  it('keeps rejected original bytes while writing and loading later v2 changes separately', () => {
    localStorage.clear();
    const original = JSON.stringify({ version: 99, spellSource: 'spell 未来 {}' });
    localStorage.setItem(SAVE_STORAGE_KEY, original);
    expect(loadPlayerState(defaults)).toMatchObject({ ok: false });
    const next = { ...defaults, arenaBindings: { ...defaults.arenaBindings, '1': '新术' } };
    expect(savePlayerState(next)).toMatchObject({ ok: true });
    expect(localStorage.getItem(SAVE_STORAGE_KEY)).toBe(original);
    expect(localStorage.getItem(SAVE_INCREMENTAL_KEY)).toContain('新术');
    expect(loadPlayerState(defaults)).toMatchObject({ ok: true, state: next });
  });

  it('does not restore a running session or infer energy balances from a plain save', () => {
    localStorage.clear();
    const original = JSON.stringify({
      version: 2,
      spellSource: 'spell 稳定 {}',
      activeSessions: [{ id: 7 }],
      balances: { damage: 18 },
    });
    localStorage.setItem(SAVE_STORAGE_KEY, original);
    const loaded = loadPlayerState(defaults);
    expect(loaded).toMatchObject({ ok: true });
    if (!loaded.ok) return;
    expect(loaded.state).not.toHaveProperty('activeSessions');
    expect(loaded.state).not.toHaveProperty('balances');
    expect(loaded.diagnostics).toHaveLength(2);
    expect(savePlayerState(loaded.state)).toMatchObject({ ok: true });
    expect(localStorage.getItem(SAVE_STORAGE_KEY)).toBe(original);
    expect(localStorage.getItem(SAVE_INCREMENTAL_KEY)).not.toContain('balances');
  });

  it('rejects a damaged incremental save without overwriting either stored copy', () => {
    localStorage.clear();
    const original = encodePlayerState(defaults);
    localStorage.setItem(SAVE_STORAGE_KEY, original);
    localStorage.setItem(SAVE_INCREMENTAL_KEY, '{');
    expect(loadPlayerState(defaults)).toMatchObject({ ok: false });
    expect(savePlayerState(defaults)).toMatchObject({ ok: false });
    expect(localStorage.getItem(SAVE_STORAGE_KEY)).toBe(original);
    expect(localStorage.getItem(SAVE_INCREMENTAL_KEY)).toBe('{');
  });

  it('isolates valid v1 migration and rejects old five-parameter creation without replacing it', () => {
    localStorage.clear();
    const old = JSON.stringify({ version: 1, spellSource: 'spell 旧术 {}' });
    localStorage.setItem(SAVE_STORAGE_KEY, old);
    expect(loadPlayerState(defaults)).toMatchObject({ ok: true, migrated: true });
    expect(savePlayerState(defaults)).toMatchObject({ ok: true });
    expect(localStorage.getItem(SAVE_STORAGE_KEY)).toBe(old);
    expect(localStorage.getItem(SAVE_INCREMENTAL_KEY)).not.toBeNull();

    const five = JSON.stringify({
      version: 1,
      spellSource: 'spell 旧术 { 创建弹道(自身位置(), 准星方向(), 380, 18, 2.4) }',
    });
    expect(decodePlayerState(five, defaults)).toMatchObject({
      ok: false,
      message: expect.stringContaining('第 1 行'),
    });
  });

  it('rejects damaged bindings and unknown attributes instead of silently dropping them', () => {
    for (const broken of [
      { arenaBindings: [] },
      { arenaBindings: { '1': 42 } },
      { arenaBindings: { unknown: '基础剑气' } },
      { arenaAttrs: { unknown: 12 } },
      { futureState: { value: 1 } },
    ]) {
      expect(
        decodePlayerState(
          JSON.stringify({ version: 2, spellSource: 'spell 好 {}', ...broken }),
          defaults,
        ),
      ).toMatchObject({ ok: false });
    }
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
        spellSource: defaults.spellSource,
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
          spellSource: defaults.spellSource,
          arenaAttrs: [],
        }),
        defaults,
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining('演武属性') });
  });
});
