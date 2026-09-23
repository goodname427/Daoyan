import {
  analyzeBook,
  compileProgram,
  migrateSpellSource,
  parseSpellbook,
  serializeBook,
} from '../core/index';
import type { SpellBook } from '../core/index';

export const SPELL_PRESETS = [
  {
    name: '对手减速',
    summary: '获准扫描目标后，以 speedMax 控制降低对手后续主动移动上限；既有惯性仍保留。',
    setup:
      '推演：敌人数 1、神识 80、法力 400；演武：神识上限 80、法力上限 800，再绑定槽位。目标不可见、越距或抗性提高价格时可能拒绝。',
    source: `spell 对手减速 @kind=duration @period=10 @duration=1 -> bool {
  var seen: query<entities> = 扫描敌人(自身位置(), 240)
  if 查询可用(seen) {
    var foes: list<entity, 1> = 查询实体列表(seen)
    for foe in foes {
      return 调整速度(foe, 0.9, 1)
    }
  }
  return false
}`,
  },
  {
    name: '对手破防',
    summary: '获准扫描目标后，以 armor 负向控制削减护体；效果到期或施法会话结束后释放。',
    setup:
      '推演：敌人数 1、神识 80、法力 400；演武：神识上限 80、法力上限 400，再绑定槽位。空目标、不可见和关系/能力拒绝均不会暗中生效。',
    source: `spell 对手破防 @kind=duration @period=10 @duration=1 -> bool {
  var seen: query<entities> = 扫描敌人(自身位置(), 240)
  if 查询可用(seen) {
    var foes: list<entity, 1> = 查询实体列表(seen)
    for foe in foes {
      return 调整护体(foe, -6, 1)
    }
  }
  return false
}`,
  },
] as const;

export function importSpellPresets(
  source: string,
  requested: ReadonlyArray<{ name: string; importAs: string }>,
):
  | { ok: true; source: string; imported: string[]; skipped: string[] }
  | { ok: false; message: string } {
  const migration = migrateSpellSource(source);
  if (!migration.ok) return { ok: false, message: '当前法术书有解析或迁移错误，请先修正再导入。' };
  const next: SpellBook = { ...migration.book };
  const imported: string[] = [];
  const skipped: string[] = [];
  const fingerprints = new Set(
    Object.values(next).map((spell) => serializeBook({ [spell.name]: { ...spell, name: '预设' } })),
  );
  for (const item of requested) {
    const preset = SPELL_PRESETS.find((entry) => entry.name === item.name);
    if (!preset) return { ok: false, message: `未知预设：${item.name}` };
    const name = item.importAs.trim();
    if (!name || /\s|[{}()]/.test(name))
      return { ok: false, message: `“${name}”不是可用的法术名。` };
    const spell = parseSpellbook(preset.source)[preset.name];
    const fingerprint = serializeBook({ [spell.name]: { ...spell, name: '预设' } });
    if (fingerprints.has(fingerprint)) {
      skipped.push(preset.name);
      continue;
    }
    if (next[name]) return { ok: false, message: `法术“${name}”已存在；请保留原法术并改用新名。` };
    next[name] = { ...spell, name };
    fingerprints.add(fingerprint);
    imported.push(name);
  }
  if (!imported.length) return { ok: true, source, imported, skipped };
  const output = serializeBook(next);
  const roundTrip = migrateSpellSource(output);
  if (!roundTrip.ok) return { ok: false, message: '导入名称无法序列化为有效法术书。' };
  try {
    analyzeBook(roundTrip.book);
    compileProgram(roundTrip.book);
  } catch (error) {
    return { ok: false, message: `预设无法编译：${String(error)}` };
  }
  return { ok: true, source: output, imported, skipped };
}
