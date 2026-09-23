import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOwnedProcessAlive } from './process-identity';
import { evidenceAfterStageStart } from './secretary-notice-guard';
import {
  readFormalVersion,
  rollbackStaleQaAcceptance,
  writeFormalVersion,
} from './version-lifecycle';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [versionId, qaRunId, reportPath] = process.argv.slice(2);

async function main(): Promise<void> {
  if (!versionId || !qaRunId || !reportPath) {
    throw new Error(
      '用法：tsx scripts/rollback-stale-qa.ts <版本 ID> <QA 记录 ID> <旧报告相对路径>',
    );
  }
  const state = JSON.parse(
    readFileSync(resolve(root, '.daoyan-agent/secretary/state.json'), 'utf8'),
  ) as { pid?: number; processIdentity?: string };
  if (isOwnedProcessAlive(state.pid ?? 0, state.processIdentity ?? '')) {
    throw new Error('须先停止 notice guard 才能撤销过期 QA');
  }
  const version = await readFormalVersion(root);
  if (!version || version.id !== versionId) throw new Error('目标不是当前正式版本');
  const qa = version.orchestration?.qaRuns.at(-1);
  if (!qa || qa.id !== qaRunId || !qa.evidence.includes(reportPath.replaceAll('\\', '/'))) {
    throw new Error('旧报告未关联到最新 QA 记录');
  }
  const report = resolve(root, reportPath);
  const runRoot = resolve(root, '.daoyan-agent/runs');
  if (!report.startsWith(`${runRoot}${sep}`)) throw new Error('报告路径不在运行记录目录');
  const value = JSON.parse(readFileSync(report, 'utf8')) as { finishedAt?: string };
  const startedAt = version.nodes.find((node) => node.id === 'qa')?.startedAt ?? '';
  if (evidenceAfterStageStart(startedAt, value.finishedAt ?? '')) {
    throw new Error('该报告不早于本轮 QA，不能按过期证据撤销');
  }
  rollbackStaleQaAcceptance(version, qaRunId, `报告 ${reportPath} 早于 QA 本轮启动 ${startedAt}`);
  await writeFormalVersion(root, version);
  console.log(`[QA 误接纳撤销] ${version.id} 已退回独立 QA；旧记录 ${qaRunId} 保留但失效`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
