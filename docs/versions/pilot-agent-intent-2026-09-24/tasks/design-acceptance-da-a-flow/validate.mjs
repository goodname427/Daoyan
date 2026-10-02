import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';

const folder = 'docs/versions/pilot-agent-intent-2026-09-24/tasks/design-acceptance-da-a-flow';
const result = JSON.parse(fs.readFileSync(`${folder}.json`, 'utf8'));
const contract = JSON.parse(fs.readFileSync('docs/versions/pilot-agent-intent-2026-09-24/design-acceptance-tasks.json', 'utf8')).tasks.find(t => t.id === 'da-a-flow');
const source = JSON.parse(fs.readFileSync(`${folder}/source-evidence.json`, 'utf8'));
const browser = JSON.parse(fs.readFileSync(`${folder}/browser-attempts.json`, 'utf8'));
const scope = JSON.parse(fs.readFileSync(`${folder}/delivery-scope.json`, 'utf8').replace(/^\uFEFF/, ''));
assert.equal(scope.deliveryBase, result.developmentFingerprint.head);
assert.equal(scope.head, scope.deliveryBase);
assert.deepEqual(scope.outsideWritePaths, []);
assert.deepEqual(scope.committedTaskPaths, []);
assert.ok(scope.excludedHistoricalPaths.length > 0);
for (const p of scope.workspaceTaskPaths) assert.ok(contract.writePaths.some(w => p === w || p.startsWith(`${w}/`)), `Outside delivery scope: ${p}`);
assert.equal(result.taskId, contract.id);
assert.equal(result.scopeRevision, 13);
assert.equal(result.firstBatch, 'A');
assert.equal(result.status, 'blocked');
assert.equal(result.completed, false);
assert.equal(result.independence.participatedInDevelopment, false);
assert.equal(result.scenarios.length, 8);
assert.equal(new Set(result.scenarios.map(s => s.id)).size, 8);
assert.equal(source.validation.workspaceFingerprint, source.validation.receipt.workspaceFingerprint);
assert.equal(source.validation.configFingerprint, source.validation.receipt.configFingerprint);
assert.equal(source.validation.receipt.exitCode, 0);
assert.equal(source.runtime.playerOperations, 0);
assert.equal(browser.playerOperations, 0);
assert.ok(result.openDeviations.some(d => d.id === 'TB01' && d.status === 'open'));
for (const s of result.scenarios) {
  assert.ok(s.contractSources.length && s.developmentTasks.length && s.evidence.length);
  assert.equal(s.independentPlayCovered, false);
  assert.notEqual(s.verdict, 'passed');
  for (const p of [...s.contractSources, ...s.evidence]) assert.ok(fs.existsSync(p), p);
}
for (const p of result.evidence) assert.ok(fs.existsSync(p), p);
for (const s of source.sources) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(s.path)).digest('hex'), s.sha256, s.path);
for (const c of result.commands) {
  assert.equal(c.exitCode, 0);
  assert.ok(!/npm run (verify|verify:full|test|build)|playwright test/.test(c.command));
}
assert.ok(result.failedAttempts.every(c => c.exitCode !== 0));
assert.equal(result.delivery.committed, false);
assert.equal(result.delivery.pushed, false);
const md = fs.readFileSync(`${folder}/experience.md`, 'utf8');
for (const p of result.evidence.filter(p => /\.(md|json|mjs|txt)$/.test(p))) {
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(!/[ \t]+$/m.test(content), `Trailing whitespace: ${p}`);
  assert.ok(content.endsWith('\n'), `Missing terminal newline: ${p}`);
}
for (let i = 1; i <= 8; i++) assert.ok(md.includes(`## DA0${i}`));
for (const match of md.matchAll(/\]\(([^)]+)\)/g)) {
  if (/^https?:/.test(match[1])) continue;
  assert.ok(fs.existsSync(path.resolve(folder, match[1].split('#')[0])), match[1]);
}
const changes = fs.readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean).map(line => line.slice(3).replaceAll('\\', '/'));
assert.ok(changes.length > 0);
assert.deepEqual([...changes].sort(), [...scope.workspaceTaskPaths].sort());
for (const p of changes) assert.ok(contract.writePaths.some(w => p === w || p.startsWith(`${w}/`)), `Outside writePaths: ${p}`);
console.log(JSON.stringify({taskId:result.taskId,scenarios:8,json:'valid',links:'valid',writePaths:'valid',changedPaths:changes,independentPlayCovered:0,overall:'blocked',gate:'reused-only',commands:'direct-only'}, null, 2));
