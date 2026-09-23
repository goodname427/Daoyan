import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCandidateEvidence, verifyCandidateFiles } from './candidate-evidence';
import { isOwnedProcessAlive } from './process-identity';
import { productImplementationChanges } from './secretary-notice-guard';
import {
  advanceVersion,
  readFormalVersion,
  recordValidationEvidence,
  setNodeEvidence,
  writeFormalVersion,
} from './version-lifecycle';
import {
  currentValidationConfigFingerprint,
  currentValidationTreeFingerprint,
} from './secretary-notice-guard';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const versionId = process.argv[2] ?? '';
const checkOnly = process.argv.includes('--check');
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(versionId)) throw new Error('请提供正式版本 id');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function main(): Promise<void> {
  const statePath = resolve(root, '.daoyan-agent/secretary/state.json');
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      pid?: number;
      processIdentity?: string;
    };
    if (isOwnedProcessAlive(state.pid ?? 0, state.processIdentity ?? '')) {
      throw new Error('请先暂停 notice guard，再接纳本机候选补验');
    }
  }
  if (git(['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('候选证据和控制面代码必须先提交，不能接纳脏工作区');
  }
  const version = await readFormalVersion(root);
  if (!version || version.id !== versionId || version.currentStage !== 'candidate') {
    throw new Error('目标不是当前候选阶段的正式版本');
  }
  const startedAt = Date.parse(
    version.nodes.find((node) => node.id === 'candidate')?.startedAt ?? '',
  );
  const qa = version.orchestration?.qaRuns.at(-1);
  if (!Number.isFinite(startedAt) || qa?.status !== 'passed' || !qa.codeRevision) {
    throw new Error('候选缺少当前阶段时间或独立 QA 通过基线');
  }
  if (version.bugs.some((bug) => !['closed', 'deferred'].includes(bug.status))) {
    throw new Error('候选仍有未关闭缺陷');
  }
  const manifestPath = `docs/versions/${versionId}/candidate.json`;
  const manifest = parseCandidateEvidence(
    JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8')),
  );
  if (manifest.status !== 'passed') throw new Error(`候选仍受阻：${manifest.blocker}`);
  if (
    Date.parse(manifest.build.finishedAt) < startedAt ||
    Date.parse(manifest.browser.finishedAt) < startedAt
  ) {
    throw new Error('候选证据早于当前候选节点');
  }
  const revision = git(['rev-parse', 'HEAD']);
  for (const baseline of [qa.codeRevision, manifest.sourceRevision]) {
    const changed = git(['diff', '--name-only', baseline, revision]).split(/\r?\n/).filter(Boolean);
    const product = productImplementationChanges(changed);
    if (product.length > 0) throw new Error(`候选与已测产品代码不一致：${product.join('、')}`);
  }
  await verifyCandidateFiles(root, manifest);
  const tracked = git(['ls-files', '--', manifestPath, ...manifest.browser.evidence]).split(
    /\r?\n/,
  );
  if (![manifestPath, ...manifest.browser.evidence].every((path) => tracked.includes(path))) {
    throw new Error('候选结构化证据必须已提交到 Git');
  }
  if (checkOnly) {
    console.log(`候选接纳预检通过：${version.id}；正式状态未改变`);
    return;
  }
  const tree = currentValidationTreeFingerprint(root);
  const commands = [manifest.build.command, manifest.browser.command];
  recordValidationEvidence(version, {
    scope: 'version',
    ownerId: 'main-agent:host-candidate',
    status: 'passed',
    gitTree: tree,
    codeRevision: manifest.sourceRevision,
    commandFingerprint: createHash('sha256').update(commands.join('\n')).digest('hex'),
    configFingerprint: currentValidationConfigFingerprint(root),
    affectedPaths: [manifestPath, ...manifest.browser.evidence],
    inputEvidenceIds: [],
    outputFingerprint: createHash('sha256')
      .update(manifest.build.artifacts.map((artifact) => artifact.sha256).join('\n'))
      .digest('hex'),
    executionRound: 1,
    commands: commands.map((command) => ({ command, exitCode: 0 })),
    evidence: [manifestPath, ...manifest.browser.evidence],
  });
  setNodeEvidence(version, 'candidate', {
    artifact: `docs/versions/${versionId}/candidate.md`,
    summary: `同源码本机生产构建和三个候选浏览器流程通过；证据：${manifestPath}。`,
  });
  advanceVersion(version, 'producer-acceptance');
  await writeFormalVersion(root, version);
  console.log(`候选补验已接纳：${version.id} -> ${version.currentStage}；未代替制作人验收或发布`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
