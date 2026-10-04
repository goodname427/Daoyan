import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = 'docs/versions/pilot-agent-intent-2026-09-24';
const developmentPath = `${root}/development.json`;
const planPath = `${root}/development-tasks.json`;
const handoffPath = `${root}/roadmap-handoff.md`;
const validatorPath = `${root}/validate-development-finalization.mjs`;

const readJson = (path) => JSON.parse(fs.readFileSync(path, 'utf8'));
const sha256 = (path) => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');

const development = readJson(developmentPath);
const plan = readJson(planPath);
const handoff = fs.readFileSync(handoffPath, 'utf8');

const expectedItems = [
  { id: 'dev-world-a3', dependsOn: [], commandCount: 12 },
  {
    id: 'dev-player-a3',
    dependsOn: ['dev-world-a3'],
    commandCount: 7,
  },
  { id: 'dev-battle-boundary-a1', dependsOn: [], commandCount: 30 },
];

assert.equal(development.versionId, 'pilot-agent-intent-2026-09-24');
assert.equal(development.scopeRevision, 13);
assert.equal(development.firstBatch, 'A');
assert.equal(development.owner, 'Version PM');
assert.equal(development.status, 'completed');
assert.equal(development.completed, true);
assert.deepEqual(
  development.workItems.map((item) => item.id),
  expectedItems.map((item) => item.id),
);

const itemSummary = [];
for (const expected of expectedItems) {
  const item = development.workItems.find(({ id }) => id === expected.id);
  assert.ok(item, expected.id);
  assert.equal(item.status, 'completed', expected.id);
  assert.equal(item.typecheck, 'passed', expected.id);
  assert.equal(item.targetedTests, 'passed', expected.id);
  assert.deepEqual(item.dependsOn, expected.dependsOn, expected.id);
  assert.equal(item.commands.length, expected.commandCount, expected.id);
  assert.ok(
    item.commands.every(({ exitCode }) => exitCode === 0),
    expected.id,
  );
  assert.ok(fs.existsSync(item.source), item.source);
  const source = readJson(item.source);
  assert.deepEqual(item.commands, source.commands, expected.id);
  assert.ok(item.evidence.includes(item.source), expected.id);
  for (const path of item.evidence) assert.ok(fs.existsSync(path), path);
  itemSummary.push({
    id: item.id,
    commands: item.commands.length,
    evidence: item.evidence.length,
  });
}

const repairItem = development.workItems.find(({ id }) => id === 'dev-battle-boundary-a1');
assert.equal(repairItem.evidenceRetention.status, 'partially-overwritten-by-version-gate');
assert.ok(!repairItem.evidence.includes(repairItem.evidenceRetention.historicalPath));
for (const path of repairItem.evidenceRetention.replacementEvidence) {
  assert.ok(fs.existsSync(path), path);
}

assert.equal(plan.roadmapHandoff.owner, 'Version PM');
assert.equal(plan.roadmapHandoff.path, handoffPath);
assert.ok(plan.roadmapHandoff.acceptance.length >= 2);
for (const text of [
  'pilot-agent-intent-2026-09-24',
  './design-review.md',
  './development.json',
  './tasks/design-acceptance-da-a-flow.json',
  './tasks/development-dev-battle-boundary-a1.json',
  '本轮已实现并实测',
  '仍待验证',
  '未来候选',
  '0017',
  '0020',
  '0024',
  '回退',
  'candidate.json',
  'docs/roadmap.md',
]) {
  assert.ok(handoff.includes(text), text);
}

assert.equal(development.versionValidation.status, 'passed');
assert.equal(development.versionValidation.completeGate.command, 'npm run verify:full');
assert.equal(development.versionValidation.completeGate.status, 'passed');
assert.equal(development.versionValidation.completeGate.exitCode, 0);
assert.equal(development.finalization.contractCheck.status, 'passed');
assert.deepEqual(
  development.finalization.contractCheck.workItems,
  expectedItems.map((item) => item.id),
);
assert.equal(development.finalization.contractCheck.exactTaskCommands, 'passed');
assert.equal(development.finalization.contractCheck.evidencePaths, 'passed');
assert.equal(development.finalization.contractCheck.roadmapHandoff, 'passed');
assert.equal(development.finalization.contractCheck.planningOwnership, 'passed');
assert.equal(development.finalization.contractCheck.planningGap, null);

for (const snapshot of development.finalization.sourceSnapshots) {
  assert.ok(fs.existsSync(snapshot.path), snapshot.path);
  assert.equal(sha256(snapshot.path), snapshot.sha256, snapshot.path);
}

const allowedChanges = new Set([
  'docs/dev/2026-10-04.md',
  developmentPath,
  `${root}/development.md`,
  handoffPath,
  validatorPath,
]);
const changedPaths = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
  encoding: 'utf8',
})
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => line.slice(3).replaceAll('\\', '/'))
  .sort();
for (const path of changedPaths) assert.ok(allowedChanges.has(path), path);
assert.ok(!changedPaths.includes('docs/status.md'));
assert.ok(!changedPaths.includes('docs/roadmap.md'));

const summary = {
  workItems: itemSummary,
  planningOwnership: plan.roadmapHandoff.owner,
  roadmapHandoff: 'valid',
  completeGate: development.versionValidation.completeGate.status,
  changedPaths,
};
const serializedSummary = JSON.stringify(summary, null, 2);
const recordedCheck = development.finalization.commands[0];
assert.equal(recordedCheck.command, `node ${validatorPath}`, 'recorded contract-check command');
assert.equal(recordedCheck.exitCode, 0, 'recorded contract-check exit code');
assert.equal(recordedCheck.result, serializedSummary, 'recorded contract-check output');

console.log(serializedSummary);
