import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    !/^(?:qa|bugfix|bugfix-reverification|candidate|producer-acceptance|archived)\.(?:json|md)$/.test(
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

export function configFingerprint(workspaceRoot = root) {
  const hash = createHash('sha256');
  for (const path of [
    'package.json',
    'package-lock.json',
    'agents/policy.json',
    'vite.config.ts',
  ]) {
    hash.update(path);
    hash.update(
      existsSync(resolve(workspaceRoot, path))
        ? readFileSync(resolve(workspaceRoot, path))
        : '[missing]',
    );
  }
  return hash.digest('hex');
}

function reusableEvidence(workspace, config, workspaceRoot = root) {
  const runsRoot = resolve(workspaceRoot, '.daoyan-agent/runs');
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

export function recordFullGateEvidence(workspace, config, workspaceRoot = root) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = resolve(workspaceRoot, '.daoyan-agent/runs', `pre-push-${stamp}`);
  const path = resolve(directory, 'full-gate-evidence.json');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        workspaceFingerprint: workspace,
        configFingerprint: config,
        command: fullCommand,
        commandFingerprint: createHash('sha256').update(fullCommand).digest('hex'),
        executionRound: 1,
        log: '',
        exitCode: 0,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

export function npmInvocation(environment = process.env) {
  const configured = environment.npm_execpath;
  const bundled = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const cli =
    configured && existsSync(configured) ? configured : existsSync(bundled) ? bundled : '';
  if (cli) return { command: process.execPath, args: [cli, 'run', 'verify:full'] };
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['run', 'verify:full'],
  };
}

function main() {
  let workspace = '';
  let config = '';
  let evidence = null;
  try {
    workspace = treeFingerprint();
    config = configFingerprint();
    evidence = reusableEvidence(workspace, config);
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
  const invocation = npmInvocation();
  const result = spawnSync(invocation.command, invocation.args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(`pre-push: could not start verification: ${result.error.message}`);
    return 1;
  }
  const exitCode = result.status ?? 1;
  if (exitCode !== 0) return exitCode;
  const finalWorkspace = treeFingerprint();
  const finalConfig = configFingerprint();
  if (finalWorkspace !== workspace || finalConfig !== config) {
    console.error(
      'pre-push: verification changed the tracked validation tree; commit those changes and rerun',
    );
    return 1;
  }
  const recorded = recordFullGateEvidence(finalWorkspace, finalConfig);
  console.log(`✔ pre-push: recorded ${recorded}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
