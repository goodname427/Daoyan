import { describe, expect, it } from 'vitest';
import { compileProgram, parseSpellbook } from '../src/core/index';
import {
  appendFirstBatchSpell,
  runFirstBatchDrive,
  type FirstBatchIntentOrigin,
} from '../src/game/firstBatch';
import { appendB4Spell, runFirstBatchB4 } from '../src/game/firstBatchB4';
import { compileFiniteProgram } from '../src/game/finiteProgram';

describe('first batch player bridge to real World and VM', () => {
  it('keeps World outcomes equal across intent origins while each scene owns its payer and grants', () => {
    const origins: FirstBatchIntentOrigin[] = [
      'mouse',
      'keyboard',
      'gamepad',
      'monster-ai',
      'entity-event',
      'enemy-cultivator',
    ];
    const book = parseSpellbook(
      appendB4Spell(appendFirstBatchSpell(appendFirstBatchSpell('', 'J1'), 'D1')),
    );
    for (const kind of ['J1', 'D1'] as const) {
      const expected = runFirstBatchDrive(book, kind, 'success', 'mouse');
      for (const origin of origins)
        expect(runFirstBatchDrive(book, kind, 'success', origin)).toEqual(expected);
      const rejected = runFirstBatchDrive(book, kind, 'revokedRead', 'mouse');
      for (const origin of origins)
        expect(runFirstBatchDrive(book, kind, 'revokedRead', origin)).toEqual(rejected);
      expect(JSON.stringify(expected)).not.toMatch(/fund-P0|acct-J1-P2|targetId|grantId/);
    }
    const expectedB4 = runFirstBatchB4(book, 'success', 'mouse');
    for (const origin of origins)
      expect(runFirstBatchB4(book, 'success', origin)).toEqual(expectedB4);
    const rejectedB4 = runFirstBatchB4(book, 'revokedRead', 'mouse');
    for (const origin of origins)
      expect(runFirstBatchB4(book, 'revokedRead', origin)).toEqual(rejectedB4);
    expect(JSON.stringify(expectedB4)).not.toMatch(/Corpse-k0-01|targetId|grantId|treasury/);
  });

  it.each(['J1', 'D1'] as const)('%s keeps the same book and actual receipts', (kind) => {
    const source = appendFirstBatchSpell('spell 原术 { 自身位置() }', kind);
    const book = parseSpellbook(source);
    const success = runFirstBatchDrive(book, kind, 'success');
    expect(success.success).toBe(true);
    expect(success.actionFacts).toBe(1);
    expect(success.actionImpulse).toBe(1);
    expect(success.readReceipts).toBe(kind === 'J1' ? 15 : 14);
    expect(success.payerPaid).toBe(kind === 'J1' ? 32 : 26);
    expect(success.capacityReservedPeak).toBe(kind === 'J1' ? 38 : 37);
    expect(success.staticMana).toBeGreaterThanOrEqual(success.vmMana);
    expect(success.staticTicks).toBeGreaterThanOrEqual(success.vmTicks);
    expect(success.astHash).toBe(compileProgram({ [`${kind}执行`]: book[`${kind}执行`] }).astHash);

    const revoked = runFirstBatchDrive(book, kind, 'revokedRead');
    expect(revoked.success).toBe(false);
    expect(revoked.actionFacts).toBe(0);
    expect(revoked.readReceipts).toBe(1);
    expect(revoked.payerPaid).toBe(kind === 'J1' ? 9 : 1);
    const noSource = runFirstBatchDrive(book, kind, 'noSource');
    expect(noSource.success).toBe(false);
    expect(noSource.actionFacts).toBe(0);
  });

  it('recompiles edits and leaves the original source intact on name collision', () => {
    const source = appendFirstBatchSpell('', 'J1');
    const oldBook = parseSpellbook(source);
    const revised = parseSpellbook(source.replace('首批J1原读(1, 14)', '首批J1原读(1, 13)'));
    expect(compileProgram(revised).astHash).not.toBe(compileProgram(oldBook).astHash);
    const oldOutcome = runFirstBatchDrive(oldBook, 'J1', 'success');
    const revisedOutcome = runFirstBatchDrive(revised, 'J1', 'success');
    expect(oldOutcome.success).toBe(true);
    expect(revisedOutcome.astHash).not.toBe(oldOutcome.astHash);
    expect(revisedOutcome.success).toBe(false);
    expect(() => appendFirstBatchSpell(source, 'J1')).toThrow('原件已保留');
  });

  it('recompiles transitive same-book helpers for all three finite entries after returning to edit', () => {
    let source = 'spell 二级 -> num { return 0 }\nspell 旁注 -> num { return 二级() }\n';
    for (const kind of ['J1', 'D1'] as const) source = appendFirstBatchSpell(source, kind);
    source = appendB4Spell(source);
    for (const name of ['J1执行', 'D1执行', 'B4修壳'])
      source = source.replace(`spell ${name} -> bool {`, `spell ${name} -> bool {\n旁注()`);
    const original = parseSpellbook(source);
    const revised = parseSpellbook(source.replace('return 0', 'return 1'));
    for (const kind of ['J1', 'D1'] as const) {
      const spell = `${kind}执行`;
      const first = runFirstBatchDrive(original, kind, 'success');
      const edited = runFirstBatchDrive(revised, kind, 'success');
      expect(first.success).toBe(true);
      expect(edited.success).toBe(true);
      expect(edited.astHash).toBe(compileFiniteProgram(revised, spell).astHash);
      expect(edited.astHash).not.toBe(first.astHash);
      expect(edited.readReceipts).toBe(first.readReceipts);
      expect(edited.payerPaid).toBe(first.payerPaid);
      expect(edited.staticTicks).toBeGreaterThanOrEqual(edited.vmTicks);
    }
    const firstB4 = runFirstBatchB4(original, 'success');
    const editedB4 = runFirstBatchB4(revised, 'success');
    expect(firstB4.success).toBe(true);
    expect(editedB4.success).toBe(true);
    expect(editedB4.astHash).toBe(compileFiniteProgram(revised, 'B4修壳').astHash);
    expect(editedB4.astHash).not.toBe(firstB4.astHash);
    expect(editedB4.readReceipts).toBe(19);
    expect(editedB4.payerPaid).toBe(44);
    expect(editedB4.staticTicks).toBeGreaterThanOrEqual(editedB4.vmTicks);
    const unrelated = parseSpellbook(`${source}\nspell 闲术 -> num { return 9 }`);
    expect(compileFiniteProgram(unrelated, 'J1执行').astHash).toBe(
      compileFiniteProgram(original, 'J1执行').astHash,
    );
  });

  it('commits B1 natural fracture before B4 and preserves it across failures', () => {
    const book = parseSpellbook(appendB4Spell(''));
    const success = runFirstBatchB4(book, 'success');
    expect(success.success).toBe(true);
    expect(success.naturalShellAfter).toBe(2);
    expect(success.naturalFragmentAfter).toBe(1);
    expect(success.readReceipts).toBe(19);
    expect(success.actionFacts).toBe(1);
    expect(success.shellAfter).toBe(3);
    expect(success.wasteAfter).toBe(1);
    expect(success.payerPaid).toBe(44);
    expect(success.capacityReservedPeak).toBe(559);
    const empty = runFirstBatchB4(book, 'emptyRead');
    expect(empty.emptyReadReceipt).toBe(true);
    expect(empty.payerPaid).toBe(46);
    expect(empty.readReceipts).toBe(20);
    expect(empty.emptyReadTicks).toBe(21);
    expect(empty.actionFacts).toBe(1);
    const recontact = runFirstBatchB4(book, 'recontact');
    expect(recontact.naturalContacts).toBe(2);
    expect(recontact.actionFacts).toBe(1);
    expect(recontact.payerPaid).toBe(44);
    expect(success.staticMana).toBeGreaterThanOrEqual(success.vmMana);
    for (const scenario of [
      'noSource',
      'competingLot',
      'postStale',
      'revokedRead',
      'capacityUnknown',
      'queueFull',
      'outOfDomain',
    ] as const) {
      const failed = runFirstBatchB4(book, scenario);
      expect(failed.success).toBe(false);
      expect(failed.naturalShellAfter).toBe(2);
      expect(failed.naturalFragmentAfter).toBe(1);
      expect(failed.actionFacts).toBe(scenario === 'postStale' ? 1 : 0);
      if (
        scenario === 'capacityUnknown' ||
        scenario === 'queueFull' ||
        scenario === 'outOfDomain'
      ) {
        expect(failed.vmRan).toBe(false);
        expect(failed.payerPaid).toBe(0);
      }
    }
    expect(() => appendB4Spell(appendB4Spell(''))).toThrow('原件已保留');
    const edited = parseSpellbook(
      appendB4Spell('').replace('首批B4审计(1, 18)', '首批B4审计(1, 17)'),
    );
    const revised = runFirstBatchB4(edited, 'success');
    expect(revised.astHash).not.toBe(success.astHash);
    expect(revised.success).toBe(false);
    expect(revised.naturalShellAfter).toBe(2);
  });
});
