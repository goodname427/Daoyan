import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fullCommand = 'npm run verify:full';

function git(args, workspaceRoot = root) {
  return execFileSync('git', args, { cwd: workspaceRoot, encoding: 'utf8' });
}

export function fingerprintPaths(paths, workspaceRoot = root) {
  const hash = createHash('sha256');
  for (const path of [...new Set(paths)].sort()) {
    hash.update(path);
    hash.update('\0');
    hash.update(
      existsSync(resolve(workspaceRoot, path))
        ? readFileSync(resolve(workspaceRoot, path))
        : '[deleted]',
    );
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function isValidationTreePath(path) {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  const match = /^docs\/versions\/[^/]+\/(.+)$/.exec(normalized);
  return (
    !match ||
    !/^(?:development|qa|bugfix|bugfix-reverification|candidate|producer-acceptance|archived)\.(?:json|md)$/.test(
      match[1],
    )
  );
}

export function treeFingerprint(workspaceRoot = root) {
  const paths = [
    ...git(['-c', 'core.quotePath=false', 'ls-files', '-z'], workspaceRoot)
      .split('\0')
      .filter(Boolean),
    ...git(
      ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z'],
      workspaceRoot,
    )
      .split('\0')
      .filter(Boolean),
  ];
  return fingerprintPaths(paths.filter(isValidationTreePath), workspaceRoot);
}

function configFingerprint() {
  const hash = createHash('sha256');
  for (const path of [
    'package.json',
    'package-lock.json',
    'agents/policy.json',
    'vite.config.ts',
  ]) {
    hash.update(path);
    hash.update(existsSync(resolve(root, path)) ? readFileSync(resolve(root, path)) : '[missing]');
  }
  return hash.digest('hex');
}

function reusableEvidence(workspace, config) {
  const runsRoot = resolve(root, '.daoyan-agent/runs');
  if (!existsSync(runsRoot)) return null;
  for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = resolve(runsRoot, entry.name, 'full-gate-evidence.json');
    if (!existsSync(path)) continue;
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (
        value.schemaVersion === 1 &&
        value.exitCode === 0 &&
        value.workspaceFingerprint === workspace &&
        value.configFingerprint === config &&
        value.command === fullCommand
      ) {
        return path;
      }
    } catch {
      // Corrupt evidence is conservatively ignored and the full gate runs.
    }
  }
  return null;
}

function main() {
  let evidence = null;
  try {
    evidence = reusableEvidence(treeFingerprint(), configFingerprint());
  } catch (error) {
    console.warn(
      `pre-push: could not inspect reusable evidence; ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (evidence) {
    console.log(`✔ pre-push: reused ${evidence}`);
    return 0;
  }

  if (process.argv.includes('--check-only')) {
    console.error(
      'pre-push: no matching full-gate evidence for the current tree and configuration',
    );
    return 1;
  }

  console.log(`▶ pre-push: no matching evidence; running ${fullCommand}`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'verify:full'], { cwd: root, stdio: 'inherit' });
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
