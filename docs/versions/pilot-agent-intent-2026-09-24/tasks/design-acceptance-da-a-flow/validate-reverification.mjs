import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const taskPath = join(evidenceDir, '..', 'design-acceptance-da-a-flow.json');
const task = JSON.parse(readFileSync(taskPath, 'utf8'));
const run = JSON.parse(readFileSync(join(evidenceDir, 'native-run-2026-10-04.json'), 'utf8'));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

assert(task.taskId === 'da-a-flow', 'unexpected taskId');
assert(task.status === 'blocked' && task.completed === false, 'unexpected final status');
assert(task.conclusion === 'blocked-continue-return', 'unexpected conclusion');
assert(
  task.openDeviations
    .map((item) => item.id)
    .sort()
    .join(',') === 'DV02,TB03,TB04',
  'unexpected open deviations',
);
assert(
  task.closedItems
    .map((item) => item.id)
    .sort()
    .join(',') === 'DV01,TB02,TB04-save-isolation',
  'unexpected closed items',
);
assert(run.observations.oldBattle.dv01 === 'closed', 'DV01 is not closed in native evidence');
assert(run.screenshots.length === 9, 'expected nine screenshots');

const consoleEvidence = run.observations.console;
const consolePath = join(evidenceDir, consoleEvidence.evidence);
const consoleBytes = readFileSync(consolePath);
const consoleText = consoleBytes.toString('utf8');
const consoleSha256 = createHash('sha256').update(consoleBytes).digest('hex');
const cspWarnings =
  consoleText.match(/Electron Security Warning \(Insecure Content-Security-Policy\)/g) ?? [];
const applicationErrors =
  consoleText.match(
    /(?:^|\n).*?(?:ERROR:CONSOLE|Uncaught (?:Error|Exception)|Failed to load resource).*?(?=\n|$)/g,
  ) ?? [];

assert(
  consoleBytes.length === consoleEvidence.evidenceBytes,
  'console evidence byte count mismatch',
);
assert(consoleSha256 === consoleEvidence.evidenceSha256, 'console evidence sha256 mismatch');
assert(cspWarnings.length === consoleEvidence.warnings, 'console warning count mismatch');
assert(
  applicationErrors.length === consoleEvidence.applicationErrors,
  'console application error count mismatch',
);
assert(consoleText.includes(consoleEvidence.warning), 'console warning text mismatch');

for (const screenshot of run.screenshots) {
  const path = join(evidenceDir, screenshot.path);
  const bytes = readFileSync(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert(bytes.length === screenshot.bytes, `byte count mismatch: ${screenshot.path}`);
  assert(sha256 === screenshot.sha256, `sha256 mismatch: ${screenshot.path}`);
}

for (const path of task.evidence) assert(existsSync(path), `missing evidence: ${path}`);

console.log('acceptance-evidence-valid');
