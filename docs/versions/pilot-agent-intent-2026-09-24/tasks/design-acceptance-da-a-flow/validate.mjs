import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';

const folder = 'docs/versions/pilot-agent-intent-2026-09-24/tasks/design-acceptance-da-a-flow';
const result = JSON.parse(fs.readFileSync(`${folder}.json`, 'utf8'));
const play = JSON.parse(fs.readFileSync(`${folder}/independent-play-2026-10-03.json`, 'utf8'));
const contract = JSON.parse(
  fs.readFileSync(
    'docs/versions/pilot-agent-intent-2026-09-24/design-acceptance-tasks.json',
    'utf8',
  ),
).tasks.find((task) => task.id === 'da-a-flow');
const source = JSON.parse(fs.readFileSync(`${folder}/source-evidence.json`, 'utf8'));
const browser = JSON.parse(fs.readFileSync(`${folder}/browser-attempts.json`, 'utf8'));

assert.equal(result.taskId, contract.id);
assert.equal(result.scopeRevision, 13);
assert.equal(result.firstBatch, 'A');
assert.equal(result.status, 'blocked');
assert.equal(result.completed, false);
assert.equal(result.independence.participatedInDevelopment, false);
assert.equal(result.runtimeConfiguration.playerOperations, 38);
assert.equal(play.runtime.contractMaterialPlayerActions, 38);
assert.equal(result.runtimeConfiguration.screenshots.length, 0);
assert.equal(play.persistentScreenshotCapability.available, false);
assert.equal(result.scenarios.length, 8);
assert.equal(new Set(result.scenarios.map((scenario) => scenario.id)).size, 8);
assert.ok(result.scenarios.every((scenario) => scenario.independentPlayCovered));
assert.equal(result.scenarios.find((scenario) => scenario.id === 'DA01').verdict, 'passed');
assert.equal(result.scenarios.find((scenario) => scenario.id === 'DA06').verdict, 'deviation');
assert.equal(result.scenarios.find((scenario) => scenario.id === 'DA08').verdict, 'blocked');
for (const id of ['DV01', 'TB02', 'TB03', 'TB04'])
  assert.ok(result.openDeviations.some((item) => item.id === id && item.status === 'open'));
assert.ok(!result.openDeviations.some((item) => item.id === 'TB01'));
assert.ok(result.confirmedImplementationDeviations.some((item) => item.id === 'DV01'));
assert.match(result.runtimeConfiguration.persistenceImpact, /默认用户目录/);
assert.match(result.runtimeConfiguration.persistenceImpact, /无法断定/);

// These are explicitly historical pre-play artifacts, so their zero operation count remains factual.
assert.equal(source.runtime.playerOperations, 0);
assert.equal(browser.playerOperations, 0);
assert.equal(
  source.validation.workspaceFingerprint,
  source.validation.receipt.workspaceFingerprint,
);
assert.equal(source.validation.configFingerprint, source.validation.receipt.configFingerprint);
assert.equal(source.validation.receipt.exitCode, 0);

for (const scenario of result.scenarios) {
  assert.ok(
    scenario.contractSources.length && scenario.developmentTasks.length && scenario.evidence.length,
  );
  for (const evidencePath of [...scenario.contractSources, ...scenario.evidence])
    assert.ok(fs.existsSync(evidencePath), evidencePath);
}
for (const evidencePath of result.evidence) assert.ok(fs.existsSync(evidencePath), evidencePath);
for (const item of source.sources) {
  assert.ok(fs.existsSync(item.path), item.path);
  assert.match(item.sha256, /^[a-f0-9]{64}$/i, item.path);
}
for (const command of result.commands) {
  assert.equal(command.exitCode, 0);
  assert.ok(!/npm run (verify|verify:full|test|build)|playwright test/.test(command.command));
  assert.ok(!command.command.includes('(inline direct'));
}
assert.ok(result.failedAttempts.every((command) => command.exitCode !== 0));
assert.equal(result.delivery.committed, false);
assert.equal(result.delivery.pushed, false);

const markdown = fs.readFileSync(`${folder}/experience.md`, 'utf8');
assert.match(markdown, /默认用户目录/);
assert.match(markdown, /无法断定先前存档状态/);
for (let index = 1; index <= 8; index++) assert.ok(markdown.includes(`## DA0${index}`));
for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
  if (/^https?:/.test(match[1])) continue;
  assert.ok(fs.existsSync(path.resolve(folder, match[1].split('#')[0])), match[1]);
}

for (const evidencePath of result.evidence.filter((item) => /\.(md|json|mjs|txt)$/.test(item))) {
  const content = fs.readFileSync(evidencePath, 'utf8');
  assert.ok(!/[ \t]+$/m.test(content), `Trailing whitespace: ${evidencePath}`);
  assert.ok(content.endsWith('\n'), `Missing terminal newline: ${evidencePath}`);
}

const changes = fs
  .readFileSync(0, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => line.slice(3).replaceAll('\\', '/'));
assert.ok(changes.length > 0);
for (const changedPath of changes)
  assert.ok(
    contract.writePaths.some(
      (writePath) => changedPath === writePath || changedPath.startsWith(`${writePath}/`),
    ),
    `Outside writePaths: ${changedPath}`,
  );

console.log(
  JSON.stringify(
    {
      taskId: result.taskId,
      scenarios: 8,
      json: 'valid',
      links: 'valid',
      writePaths: 'valid',
      changedPaths: changes,
      independentPlayerOperations: 38,
      persistentScreenshots: 0,
      openItems: ['DV01', 'TB02', 'TB03', 'TB04'],
      overall: 'blocked',
      gate: 'reused-only',
      commands: 'direct-only',
    },
    null,
    2,
  ),
);
