import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeBook, compileProgram, migrateSpellSource, parseSpellbook } from '../core/index';
import { appendFirstBatchSpell, runFirstBatchDrive } from '../game/firstBatch';
import { appendB4Spell, B4_SPELL, runFirstBatchB4 } from '../game/firstBatchB4';
import { compileFiniteProgram } from '../game/finiteProgram';

for (const kind of ['J1', 'D1'] as const) {
  const source = appendFirstBatchSpell('', kind);
  const book = parseSpellbook(source);
  const success = runFirstBatchDrive(book, kind, 'success');
  assert.equal(success.success, true, `${kind} must commit through World/VM`);
  assert.equal(success.readReceipts, kind === 'J1' ? 15 : 14);
  assert.equal(success.payerPaid, kind === 'J1' ? 32 : 26);
  assert.equal(success.actionFacts, 1);
  assert.equal(success.astHash, compileProgram({ [`${kind}执行`]: book[`${kind}执行`] }).astHash);
  const revoked = runFirstBatchDrive(book, kind, 'revokedRead');
  assert.equal(revoked.success, false);
  assert.equal(revoked.readReceipts, 1);
  assert.equal(revoked.actionFacts, 0);
  const noSource = runFirstBatchDrive(book, kind, 'noSource');
  assert.equal(noSource.success, false);
  assert.equal(noSource.actionFacts, 0);
  console.log(
    `${kind} real World/VM: success ${success.readReceipts} reads, ${success.payerPaid} M; revoked/no source rejected`,
  );
}

const b4Book = parseSpellbook(B4_SPELL.source);
const b4 = runFirstBatchB4(b4Book, 'success');
assert.equal(b4.success, true);
assert.equal(b4.naturalContacts, 1);
assert.equal(b4.naturalShellAfter, 2);
assert.equal(b4.naturalFragmentAfter, 1);
assert.equal(b4.shellAfter, 3);
assert.equal(b4.wasteAfter, 1);
assert.equal(b4.readReceipts, 19);
assert.equal(b4.payerPaid, 44);
const empty = runFirstBatchB4(b4Book, 'emptyRead');
assert.equal(empty.emptyReadReceipt, true);
assert.equal(empty.payerPaid, 46);
assert.equal(empty.actionFacts, 1);
assert.equal(empty.readReceipts, 20);
const recontact = runFirstBatchB4(b4Book, 'recontact');
assert.equal(recontact.naturalContacts, 2);
assert.equal(recontact.actionFacts, 1);
assert.equal(recontact.success, false);
assert.equal(recontact.nextResponse?.capacity, 'capacityUnknown');
assert.equal(recontact.nextResponse?.capacityReadCount, 0);
assert.equal(recontact.nextResponse?.capacityReadPaid, 0);
assert.equal(recontact.nextResponse?.freshReadReceipts, 0);
assert.equal(recontact.nextResponse?.vmRan, false);
assert.equal(recontact.payerPaid, 44);
assert.equal(recontact.shellAfter, null);
for (const [scenario, expectedCapacity] of [
  ['recontactMeasured', 'sufficient'],
  ['recontactQueueFull', 'queueFull'],
] as const) {
  const measured = runFirstBatchB4(b4Book, scenario);
  assert.equal(measured.naturalContacts, 2);
  assert.equal(measured.actionFacts, 1);
  assert.equal(measured.success, false);
  assert.equal(measured.nextResponse?.capacity, expectedCapacity);
  assert.equal(measured.nextResponse?.capacityReadCount, 2);
  assert.equal(measured.nextResponse?.capacityReadPaid, 4);
  assert.equal(measured.nextResponse?.quote, 'invalidated');
  assert.equal(measured.nextResponse?.freshReadReceipts, 0);
  assert.equal(measured.nextResponse?.vmRan, false);
  assert.equal(measured.payerPaid, 48);
  assert.equal(measured.payerBalance, 2);
  assert.equal(measured.shellAfter, null);
}
const incompleteRecontact = runFirstBatchB4(
  parseSpellbook(B4_SPELL.source.replace('首批B4审计(1, 18)', '首批B4审计(1, 17)')),
  'recontact',
);
assert.equal(incompleteRecontact.success, false);
assert.equal(incompleteRecontact.naturalContacts, 1);
assert.equal(incompleteRecontact.nextResponse?.contactCommitted, false);
for (const scenario of [
  'noSource',
  'competingLot',
  'postStale',
  'revokedRead',
  'capacityUnknown',
  'queueFull',
  'outOfDomain',
] as const) {
  const outcome = runFirstBatchB4(b4Book, scenario);
  assert.equal(outcome.success, false, scenario);
  assert.equal(outcome.naturalShellAfter, 2);
  assert.equal(outcome.naturalFragmentAfter, 1);
  if (scenario === 'postStale') assert.equal(outcome.actionFacts, 1);
  else assert.equal(outcome.actionFacts, 0);
}
console.log(
  `B1→B4 real World/VM: natural fracture then ${b4.readReceipts} reads, ${b4.payerPaid} M, shell ${b4.naturalShellAfter}→${b4.shellAfter}; counterexamples rejected`,
);

const original = readFileSync(new URL('../game/spells.dy', import.meta.url), 'utf8');
const shared = parseSpellbook(
  appendB4Spell(appendFirstBatchSpell(appendFirstBatchSpell(original, 'J1'), 'D1')),
);
for (const kind of ['J1', 'D1'] as const)
  assert.equal(runFirstBatchDrive(shared, kind, 'success').success, true);
assert.equal(runFirstBatchB4(shared, 'success').success, true);
let helperSource = 'spell 二级 -> num { return 0 }\nspell 旁注 -> num { return 二级() }\n';
for (const kind of ['J1', 'D1'] as const) helperSource = appendFirstBatchSpell(helperSource, kind);
helperSource = appendB4Spell(helperSource);
for (const name of ['J1执行', 'D1执行', 'B4修壳'])
  helperSource = helperSource.replace(`spell ${name} -> bool {`, `spell ${name} -> bool {\n旁注()`);
const helperBook = parseSpellbook(helperSource);
const revisedHelperBook = parseSpellbook(helperSource.replace('return 0', 'return 1'));
assert.equal(migrateSpellSource(helperSource).ok, true);
assert.equal(migrateSpellSource(helperSource.replace('return 0', 'return 1')).ok, true);
const budgetEditedSource = helperSource.replace('return 0', '自身位置()\nreturn 0');
assert.equal(migrateSpellSource(budgetEditedSource).ok, true);
assert.notEqual(
  analyzeBook(parseSpellbook(budgetEditedSource))['J1执行'].tickWorst,
  analyzeBook(helperBook)['J1执行'].tickWorst,
);
const unrelatedHelperBook = parseSpellbook(`${helperSource}\nspell 闲术 -> num { return 9 }`);
assert.equal(
  compileFiniteProgram(unrelatedHelperBook, 'J1执行').astHash,
  compileFiniteProgram(helperBook, 'J1执行').astHash,
);
for (const kind of ['J1', 'D1'] as const) {
  const before = runFirstBatchDrive(helperBook, kind, 'success');
  const after = runFirstBatchDrive(revisedHelperBook, kind, 'success');
  assert.equal(before.success, true);
  assert.equal(after.success, true);
  assert.notEqual(after.astHash, before.astHash);
  assert.equal(after.astHash, compileFiniteProgram(revisedHelperBook, `${kind}执行`).astHash);
  assert.equal(after.readReceipts, before.readReceipts);
  assert.ok(after.staticMana >= after.vmMana);
  assert.ok(after.staticTicks >= after.vmTicks);
}
const helperB4 = runFirstBatchB4(helperBook, 'success');
const revisedHelperB4 = runFirstBatchB4(revisedHelperBook, 'success');
assert.equal(helperB4.success, true);
assert.equal(revisedHelperB4.success, true);
assert.notEqual(revisedHelperB4.astHash, helperB4.astHash);
assert.equal(revisedHelperB4.astHash, compileFiniteProgram(revisedHelperBook, 'B4修壳').astHash);
assert.equal(revisedHelperB4.readReceipts, 19);
assert.ok(revisedHelperB4.staticMana >= revisedHelperB4.vmMana);
assert.ok(revisedHelperB4.staticTicks >= revisedHelperB4.vmTicks);
console.log(
  'Transitive same-book helper edit: J1, D1 and B4 recompiled and committed through World/VM',
);
console.log('Existing player book + three finite spells: all three World/VM scenes succeeded');
