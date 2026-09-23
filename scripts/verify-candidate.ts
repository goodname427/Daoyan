import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { parseCandidateEvidence } from './candidate-evidence';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2] ?? '';
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new Error('请提供正式版本 id');
const documentRoot = resolve(root, 'docs/versions', id);
const manifest = resolve(documentRoot, 'candidate.json');
const runDirectory = resolve(
  root,
  '.daoyan-agent/runs',
  `candidate-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
await mkdir(runDirectory, { recursive: true });
const prettierOptions = (await resolveConfig(resolve(root, '.prettierrc.json'))) ?? {};

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(
    path,
    await format(JSON.stringify(value), { ...prettierOptions, parser: 'json' }),
    'utf8',
  );
}

function run(label: string, command: string, args: string[], env = process.env): number {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`;
  writeFileSync(resolve(runDirectory, `${label}.log`), output, 'utf8');
  process.stdout.write(output);
  return result.status ?? 1;
}

async function blocked(reason: string, label: string): Promise<never> {
  const evidence = relative(root, resolve(runDirectory, `${label}.log`)).replaceAll('\\', '/');
  await writeJson(manifest, {
    schemaVersion: 1,
    status: 'blocked',
    blocker: reason,
    evidence: [evidence],
  });
  throw new Error(reason);
}

const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
if (revision.status !== 0) throw new Error('无法读取候选代码修订');
const productStatus = spawnSync(
  'git',
  [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--',
    'src',
    'package.json',
    'package-lock.json',
    'vite.config.ts',
    'electron',
  ],
  { cwd: root, encoding: 'utf8' },
);
if (productStatus.status !== 0 || productStatus.stdout.trim()) {
  throw new Error('游戏源码或构建配置尚未提交，不能生成候选修订证据');
}
const sourceRevision = revision.stdout.trim();
const buildCode = run('build', process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
if (buildCode !== 0) await blocked(`候选构建失败，退出码 ${buildCode}`, 'build');
const builtAt = new Date().toISOString();

const assets = (await readdir(resolve(root, 'dist/assets'))).filter((name) =>
  /\.(css|js)$/.test(name),
);
const files = ['dist/index.html', ...assets.map((name) => `dist/assets/${name}`)];
const artifacts = await Promise.all(
  files.map(async (path) => ({
    path,
    sha256: createHash('sha256')
      .update(await readFile(resolve(root, path)))
      .digest('hex'),
  })),
);
const reportPath = resolve(runDirectory, 'browser-report.json');
const browserCode = run(
  'browser',
  process.execPath,
  ['scripts/run-playwright.mjs', 'test', '--config', 'playwright.candidate.config.ts'],
  { ...process.env, CANDIDATE_BROWSER_REPORT: reportPath },
);
if (browserCode !== 0) await blocked(`候选浏览器体验失败，退出码 ${browserCode}`, 'browser');

const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
  suites?: { suites?: unknown[]; specs?: unknown[] }[];
};
const checks: { title: string; passed: boolean }[] = [];
function collect(suite: unknown): void {
  if (!suite || typeof suite !== 'object') return;
  const data = suite as { suites?: unknown[]; specs?: unknown[] };
  for (const spec of data.specs ?? []) {
    const item = spec as { title?: string; tests?: { results?: { status?: string }[] }[] };
    checks.push({
      title: item.title ?? '',
      passed: Boolean(
        item.tests?.length &&
        item.tests.every((test) => test.results?.some((result) => result.status === 'passed')),
      ),
    });
  }
  for (const child of data.suites ?? []) collect(child);
}
for (const suite of report.suites ?? []) collect(suite);
if (checks.length !== 3 || checks.some((check) => !check.passed)) {
  await blocked('候选浏览器报告未包含三个通过的实际体验检查', 'browser');
}
const summaryPath = resolve(documentRoot, 'candidate-browser.json');
await writeJson(summaryPath, { sourceRevision, checks, finishedAt: new Date().toISOString() });
const candidate = parseCandidateEvidence({
  schemaVersion: 1,
  status: 'passed',
  sourceRevision,
  build: { command: 'npm run build', exitCode: 0, finishedAt: builtAt, artifacts },
  browser: {
    command: 'node scripts/run-playwright.mjs test --config playwright.candidate.config.ts',
    exitCode: 0,
    finishedAt: new Date().toISOString(),
    checks: checks.map((check) => check.title),
    evidence: [relative(root, summaryPath).replaceAll('\\', '/')],
  },
});
await writeJson(manifest, candidate);
console.log(`候选验证通过：${relative(root, manifest)}`);
