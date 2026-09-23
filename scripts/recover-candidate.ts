import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readFormalVersion,
  recordValidationEvidence,
  reopenCandidateForQa,
  writeFormalVersion,
} from './version-lifecycle';
import {
  currentValidationConfigFingerprint,
  currentValidationTreeFingerprint,
} from './secretary-notice-guard';
import { isOwnedProcessAlive } from './process-identity';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [versionId, bugId, evidence] = process.argv.slice(2);

async function main(): Promise<void> {
  if (!versionId || !/^[a-z0-9._-]+$/i.test(versionId) || !bugId || !evidence) {
    throw new Error(
      '用法：tsx scripts/recover-candidate.ts <版本 ID> <缺陷 ID> <候选报告相对路径>',
    );
  }
  const report = resolve(root, evidence);
  const versionDocs = resolve(root, 'docs/versions', versionId);
  if (!report.startsWith(`${versionDocs}${sep}`) || !existsSync(report)) {
    throw new Error('必须引用当前版本已有的候选报告');
  }
  const guardStatePath = resolve(root, '.daoyan-agent/secretary/state.json');
  const guardState = JSON.parse(readFileSync(guardStatePath, 'utf8')) as {
    pid?: number;
    processIdentity?: string;
  };
  if (isOwnedProcessAlive(guardState.pid ?? 0, guardState.processIdentity ?? '')) {
    throw new Error('请先使用 secretary:stop 暂停 notice guard，再执行候选恢复');
  }
  const dirtyProduct = execFileSync('git', ['status', '--porcelain', '--', 'src', 'test', 'e2e'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (dirtyProduct) throw new Error('产品与测试工作区必须先提交，不能以未提交代码复验');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const tree = currentValidationTreeFingerprint(root);
  const config = currentValidationConfigFingerprint(root);
  const runs = resolve(root, '.daoyan-agent/runs');
  if (!existsSync(runs)) throw new Error('缺少完整门禁运行目录');
  const gate = readdirSync(runs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(runs, entry.name, 'full-gate-evidence.json'))
    .filter(existsSync)
    .flatMap((path) => {
      try {
        return [{ path, value: JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> }];
      } catch {
        return [];
      }
    })
    .find(
      ({ value }) =>
        value.schemaVersion === 1 &&
        value.exitCode === 0 &&
        value.command === 'npm run verify:full' &&
        value.workspaceFingerprint === tree &&
        value.configFingerprint === config,
    );
  if (!gate) throw new Error('缺少与当前代码树匹配的完整门禁成功证据');
  const version = await readFormalVersion(root);
  if (!version || version.id !== versionId) throw new Error('目标不是当前正式版本');
  const previous = version.orchestration?.qaRuns.at(-1)?.codeRevision;
  if (!previous) throw new Error('当前版本没有可比较的独立 QA 基线');
  const changed = execFileSync(
    'git',
    ['diff', '--name-only', previous, revision, '--', 'src', 'test', 'e2e'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  ).trim();
  if (!changed) throw new Error('当前修订相对已测版本没有产品或测试改动');
  reopenCandidateForQa(version, {
    bugId,
    title: '候选体验发现法力账户微单位差异',
    expected: '逐帧法力账户精确守恒',
    actual: '旧候选减速预设出现 1 微单位对账差异',
    evidence: `${evidence}; 修复修订 ${revision}; 完整门禁 ${gate.path}`,
    fixCodeRevision: revision,
  });
  recordValidationEvidence(version, {
    scope: 'feature',
    ownerId: `main-agent:${bugId}`,
    status: 'passed',
    gitTree: tree,
    codeRevision: revision,
    commandFingerprint: String(gate.value.commandFingerprint),
    configFingerprint: config,
    affectedPaths: changed.split(/\r?\n/),
    inputEvidenceIds: [],
    outputFingerprint: tree,
    executionRound: Number(gate.value.executionRound),
    commands: [{ command: 'npm run verify:full', exitCode: 0 }],
    evidence: [evidence, gate.path],
  });
  await writeFormalVersion(root, version);
  console.log(`[候选退回复验] ${version.id} 已回到独立 QA；缺陷 ${bugId} 待复验，修订 ${revision}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
