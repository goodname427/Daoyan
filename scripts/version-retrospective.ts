import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SecretaryItem } from './secretary-state';
import type { FormalVersion, VersionStage } from './version-lifecycle';
import { versionStageUsage, type VersionStageUsage } from './version-usage';

export interface VersionRetrospective {
  schemaVersion: 1;
  versionId: string;
  completedAt: string;
  totals: {
    observedCalls: number;
    knownTokensLowerBound: number | null;
    missingUsageCalls: number;
    unavailableRunDirectories: number;
    stageRuns: number;
    recoveryAttempts: number;
    designReturns: number;
    featureFullGateEvidence: number;
    repeatedFullGateTrees: number;
  };
  stages: Array<{ stage: VersionStage; runs: number; usage: VersionStageUsage }>;
  investigation: string[];
}

/** Read-only evidence summary. It does not infer the cause of token usage. */
export async function buildVersionRetrospective(
  version: FormalVersion,
  items: SecretaryItem[],
): Promise<VersionRetrospective> {
  const related = items.filter((item) => item.orchestration?.formalVersionId === version.id);
  const stages = await Promise.all(
    version.nodes.map(async (node) => ({
      stage: node.id,
      runs: related.filter((item) => item.orchestration?.formalStage === node.id).length,
      usage: await versionStageUsage(version.id, node.id, related),
    })),
  );
  const known = stages.filter((stage) => stage.usage.knownTokens !== null);
  const fullGateTrees = new Map<string, number>();
  for (const evidence of version.orchestration?.validationEvidence ?? []) {
    if (
      evidence.scope !== 'feature' ||
      evidence.status !== 'passed' ||
      !evidence.commands.some(
        (command) => /^npm run verify:full(?:\s|$)/.test(command.command) && command.exitCode === 0,
      )
    ) {
      continue;
    }
    fullGateTrees.set(evidence.gitTree, (fullGateTrees.get(evidence.gitTree) ?? 0) + 1);
  }
  const totals = {
    observedCalls: stages.reduce((sum, stage) => sum + stage.usage.observedCalls, 0),
    knownTokensLowerBound:
      known.length > 0
        ? known.reduce((sum, stage) => sum + (stage.usage.knownTokens ?? 0), 0)
        : null,
    missingUsageCalls: stages.reduce((sum, stage) => sum + stage.usage.missingUsageCalls, 0),
    unavailableRunDirectories: stages.reduce(
      (sum, stage) => sum + stage.usage.unavailableRunDirectories,
      0,
    ),
    stageRuns: related.length,
    recoveryAttempts: related.reduce((sum, item) => sum + item.recoveryAttempts, 0),
    designReturns: version.approvals.filter(
      (approval) =>
        ['charter-review', 'design-review', 'design-acceptance'].includes(approval.stage) &&
        approval.decision === 'changes-requested',
    ).length,
    featureFullGateEvidence: [...fullGateTrees.values()].reduce((sum, count) => sum + count, 0),
    repeatedFullGateTrees: [...fullGateTrees.values()].filter((count) => count > 1).length,
  };
  const investigation: string[] = [];
  if (totals.missingUsageCalls || totals.unavailableRunDirectories) {
    investigation.push('先补齐缺失的调用用量与运行目录证据；已知 token 只是下界。');
  }
  const costly = [...stages]
    .filter((stage) => stage.usage.knownTokens !== null)
    .sort((a, b) => (b.usage.knownTokens ?? 0) - (a.usage.knownTokens ?? 0))[0];
  if (costly && (costly.usage.knownTokens ?? 0) > 0) {
    investigation.push(
      `先抽查 ${costly.stage} 的重复读取、退回与恢复样本，再决定哪些固定检查适合改成脚本。`,
    );
  }
  if (totals.designReturns > 0) {
    investigation.push('逐项分析策划退回的真实原因；产品理解与取舍仍须由策划和制作人对齐。');
  }
  if (totals.repeatedFullGateTrees > 0) {
    investigation.push('核查同一 Git tree 的 Feature 完整门禁证据是否重复执行。');
  }
  return {
    schemaVersion: 1,
    versionId: version.id,
    completedAt: version.completedAt,
    totals,
    stages,
    investigation,
  };
}

export function renderVersionRetrospective(report: VersionRetrospective): string {
  const { totals } = report;
  const lines = [
    `# ${report.versionId} 流程复盘`,
    '',
    `- 版本完成：${report.completedAt || '未记录'}`,
    `- Agent 调用：${totals.observedCalls}；已知 token 下界：${totals.knownTokensLowerBound ?? '不可用'}；缺失用量调用：${totals.missingUsageCalls}；不可读运行目录：${totals.unavailableRunDirectories}`,
    `- 阶段运行：${totals.stageRuns}；恢复尝试：${totals.recoveryAttempts}；策划退回：${totals.designReturns}`,
    `- Feature 完整门禁成功证据：${totals.featureFullGateEvidence}；同树多条证据：${totals.repeatedFullGateTrees}（需核实是否真的重复执行）`,
    '',
    '## 阶段用量',
    '',
    '| 阶段 | 运行 | 调用 | 已知 token 下界 | 缺失用量 |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...report.stages.map(
      ({ stage, runs, usage }) =>
        `| ${stage} | ${runs} | ${usage.observedCalls} | ${usage.knownTokens ?? '不可用'} | ${usage.missingUsageCalls} |`,
    ),
    '',
    '## 下一版调查与试验',
    '',
    ...(report.investigation.length > 0
      ? report.investigation.map((item) => `- ${item}`)
      : ['- 暂无可从现有证据确认的高成本重复项。']),
    '',
    '重复、确定性的取数、合同校验和报告格式优先沉淀为脚本；需要判断的稳定操作顺序才考虑短 Skill。每项优化先比较下一版的总调用、已知 token、缺失用量、耗时、退回和验收质量；不凭这份报告自动降级模型或改变产品门禁。',
    '',
  ];
  return lines.join('\n');
}

/** Runtime evidence is outside Git, so archive branch delivery stays clean. */
export async function writeVersionRetrospective(
  root: string,
  version: FormalVersion,
  items: SecretaryItem[],
): Promise<string> {
  if (version.status !== 'archived' || !/^[a-zA-Z0-9_-]+$/.test(version.id)) {
    throw new Error('只能为有效 ID 的已归档版本生成流程复盘');
  }
  const directory = resolve(root, '.daoyan-agent', 'retrospectives');
  const reportPath = `.daoyan-agent/retrospectives/${version.id}.md`;
  if (
    await access(resolve(root, reportPath)).then(
      () => true,
      () => false,
    )
  )
    return reportPath;
  const report = await buildVersionRetrospective(version, items);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `${version.id}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(directory, `${version.id}.md`), renderVersionRetrospective(report));
  return reportPath;
}
