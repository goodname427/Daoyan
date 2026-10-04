import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = 'docs/versions/pilot-agent-intent-2026-09-24';
const developmentPath = `${root}/development.json`;
const planPath = `${root}/development-tasks.json`;
const handoffPath = `${root}/roadmap-handoff.md`;
const runtimePath = '.daoyan-agent/releases/versions/pilot-agent-intent-2026-09-24.json';
const gateLog =
  '.daoyan-agent/runs/secretary-formal-pilot-agent-intent-2026-09-24-13-development-17/full-verify-1.log';

const readJson = (path) => JSON.parse(fs.readFileSync(path, 'utf8'));
const sha256 = (path) => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');

const development = readJson(developmentPath);
const plan = readJson(planPath);
const runtime = readJson(runtimePath);
const handoff = fs.readFileSync(handoffPath, 'utf8');

assert.ok(fs.existsSync(gateLog), `missing complete-gate log: ${gateLog}`);
const gateOutput = fs.readFileSync(gateLog, 'utf8');
for (const marker of [
  '> daoyan@0.2.0 verify:full',
  'Tests  660 passed (660)',
  '27 passed',
  '> daoyan@0.2.0 build',
  'built in',
]) {
  assert.ok(gateOutput.includes(marker), `complete-gate log missing marker: ${marker}`);
}

assert.equal(development.versionId, 'pilot-agent-intent-2026-09-24');
assert.equal(development.scopeRevision, 13);
assert.equal(development.firstBatch, 'A');
assert.equal(development.owner, 'Version PM');
assert.equal(development.status, 'completed');
assert.equal(development.completed, true);

const formalIds = runtime.workItems
  .filter((item) => item.status !== 'skipped')
  .map((item) => item.id);
assert.deepEqual(formalIds, ['dev-battle-boundary-a1']);
assert.deepEqual(
  development.workItems.map((item) => item.id),
  formalIds,
  'development results must match current formal work items',
);

const item = development.workItems[0];
assert.equal(item.status, 'completed');
assert.equal(item.typecheck, 'passed');
assert.equal(item.targetedTests, 'passed');
assert.deepEqual(item.dependsOn, []);
assert.equal(item.commands.length, 30);
assert.ok(item.commands.every(({ exitCode }) => exitCode === 0));
assert.ok(fs.existsSync(item.source), item.source);
const source = readJson(item.source);
assert.deepEqual(item.commands, source.commands);
assert.ok(item.evidence.includes(item.source));
for (const path of item.evidence) assert.ok(fs.existsSync(path), path);

assert.deepEqual(
  development.historicalAcceptedDeliveries.map(({ id }) => id),
  ['dev-world-a3', 'dev-player-a3'],
);
assert.ok(
  development.historicalAcceptedDeliveries.every(({ note }) =>
    note.includes('不属于当前正式版本 workItems'),
  ),
);

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
  gateLog,
]) {
  assert.ok(handoff.includes(text), text);
}

assert.equal(development.versionValidation.status, 'passed');
assert.equal(development.versionValidation.completeGate.command, 'npm run verify:full');
assert.equal(development.versionValidation.completeGate.status, 'passed');
assert.equal(development.versionValidation.completeGate.exitCode, 0);
assert.ok(development.versionValidation.completeGate.evidence.includes(gateLog));
assert.equal(development.finalization.contractCheck.status, 'passed');
assert.deepEqual(development.finalization.contractCheck.workItems, formalIds);
assert.deepEqual(development.finalization.contractCheck.historicalAcceptedDeliveries, [
  'dev-world-a3',
  'dev-player-a3',
]);
assert.equal(development.finalization.contractCheck.formalRuntimeMatch, 'passed');
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
  `${root}/validate-development-finalization.mjs`,
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

console.log(
  JSON.stringify(
    {
      workItems: [{ id: item.id, commands: item.commands.length, evidence: item.evidence.length }],
      historicalAcceptedDeliveries: development.historicalAcceptedDeliveries.map(({ id }) => id),
      formalRuntimeMatch: 'passed',
      planningOwnership: plan.roadmapHandoff.owner,
      roadmapHandoff: 'valid',
      completeGateLog: gateLog,
      changedPaths,
    },
    null,
    2,
  ),
);
