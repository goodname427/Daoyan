import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addVersionTodo,
  advanceVersion,
  createFormalVersion,
  publicVersionState,
  readFormalVersion,
  recordApproval,
  setNodeEvidence,
  writeFormalVersion,
  type VersionStage,
  type VersionWorkItem,
} from './version-lifecycle';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(): never {
  console.log(`正式版本状态工具（供常驻秘书和 Version PM 内部调用）

  tsx scripts/version-manager.ts init <id> <title> <direction> <docs-directory>
  tsx scripts/version-manager.ts bootstrap-workflow
  tsx scripts/version-manager.ts advance <stage>
  tsx scripts/version-manager.ts work <work-item-id> <pending|active|blocked|completed|skipped>
  tsx scripts/version-manager.ts evidence <stage> <artifact> <summary>
  tsx scripts/version-manager.ts approve <stage> <producer|lead-designer> <comment>
  tsx scripts/version-manager.ts reject <stage> <producer|lead-designer> <comment>
  tsx scripts/version-manager.ts status`);
  process.exit(0);
}

async function requireVersion() {
  const version = await readFormalVersion(root);
  if (!version) throw new Error('当前没有正式版本');
  return version;
}

async function bootstrapWorkflow(): Promise<void> {
  const timestamp = new Date().toISOString();
  const version = createFormalVersion({
    id: 'workflow-foundation-2026-09-20',
    title: 'Agent 工作流基础版本',
    direction: '建立真正的版本生产流程，并提供可查看节点、制作人待办和秘书对话的项目中枢。',
    documentRoot: 'docs/versions/workflow-foundation-2026-09-20',
    currentStage: 'charter-review',
    now: timestamp,
  });
  version.charterRevision = '1';
  version.scopeFrozen = true;
  recordApproval(version, {
    stage: 'charter-review',
    reviewer: 'producer',
    decision: 'approved',
    documentRevision: '1',
    comment: '总体方案通过，正式推进开发，并将状态可视化纳入本版本。',
    now: timestamp,
  });
  for (const stage of [
    'module-design',
    'design-review',
    'task-breakdown',
    'version-planning',
    'development',
  ] as VersionStage[]) {
    advanceVersion(version, stage, timestamp);
  }
  const evidence: Array<[VersionStage, string, string]> = [
    [
      'direction',
      '制作人明确了正式版本流程和可视化秘书方向。',
      'docs/versions/workflow-foundation-2026-09-20/charter.md',
    ],
    [
      'charter-draft',
      '主策已整理版本目标、范围、非目标和验收标准。',
      'docs/versions/workflow-foundation-2026-09-20/charter.md',
    ],
    [
      'charter-review',
      '制作人已批准总体方案并要求开始开发。',
      'docs/versions/workflow-foundation-2026-09-20/charter.md',
    ],
    [
      'module-design',
      '生命周期、状态页和秘书对话已形成详细规格。',
      'docs/specs/2026-09-20-formal-version-and-secretary-dashboard.md',
    ],
    [
      'design-review',
      '主策确认沿用事件驱动秘书，不引入常驻模型。',
      'docs/adr/0013-正式版本生命周期与可视化秘书.md',
    ],
    [
      'task-breakdown',
      '工作拆为状态核心、API、看板、验证和文档五项。',
      'docs/versions/workflow-foundation-2026-09-20/plan.md',
    ],
    [
      'version-planning',
      '范围已冻结，游戏功能不进入本版本。',
      'docs/versions/workflow-foundation-2026-09-20/plan.md',
    ],
    [
      'development',
      '正在实现正式版本状态机与可视化秘书。',
      'docs/specs/2026-09-20-formal-version-and-secretary-dashboard.md',
    ],
    [
      'qa',
      '将执行新增能力测试和项目主线回归。',
      'docs/versions/workflow-foundation-2026-09-20/qa-plan.md',
    ],
  ];
  for (const [stage, summary, artifact] of evidence)
    setNodeEvidence(version, stage, { summary, artifact });
  const workItems: VersionWorkItem[] = [
    {
      id: 'lifecycle',
      title: '正式版本状态模型',
      owner: 'Feature PM',
      status: 'active',
      dependsOn: [],
      summary: '阶段、审批、待办、任务与缺陷结构。',
      evidence: 'scripts/version-lifecycle.ts',
    },
    {
      id: 'guard-api',
      title: '秘书状态与对话 API',
      owner: 'Feature PM',
      status: 'active',
      dependsOn: ['lifecycle'],
      summary: '由 notice guard 提供本机安全接口。',
      evidence: 'scripts/secretary-notice-guard.ts',
    },
    {
      id: 'dashboard',
      title: '可视化秘书',
      owner: 'Feature PM',
      status: 'active',
      dependsOn: ['guard-api'],
      summary: '版本流程、节点详情、待办、任务、Bug 和对话。',
      evidence: 'secretary-dashboard/',
    },
    {
      id: 'quality',
      title: '版本验证与回归',
      owner: '测试',
      status: 'pending',
      dependsOn: ['dashboard'],
      summary: '单元、接口、视觉体验与完整门禁。',
      evidence: 'docs/versions/workflow-foundation-2026-09-20/qa-plan.md',
    },
  ];
  version.workItems.push(...workItems);
  await writeFormalVersion(root, version);
  console.log(`已建立正式版本：${version.title}`);
}

const [command, ...args] = process.argv.slice(2);
if (!command || command === '--help' || command === '-h') usage();

if (command === 'init') {
  if (args.length < 4) usage();
  const [id, title, direction, documentRoot] = args;
  await writeFormalVersion(root, createFormalVersion({ id, title, direction, documentRoot }));
} else if (command === 'bootstrap-workflow') {
  await bootstrapWorkflow();
} else if (command === 'advance') {
  const version = await requireVersion();
  advanceVersion(version, args[0] as VersionStage);
  await writeFormalVersion(root, version);
} else if (command === 'work') {
  const version = await requireVersion();
  const item = version.workItems.find((candidate) => candidate.id === args[0]);
  if (!item) throw new Error(`找不到版本任务：${args[0]}`);
  if (!['pending', 'active', 'blocked', 'completed', 'skipped'].includes(args[1])) {
    throw new Error('版本任务状态无效');
  }
  item.status = args[1] as VersionWorkItem['status'];
  version.updatedAt = new Date().toISOString();
  await writeFormalVersion(root, version);
} else if (command === 'evidence') {
  const version = await requireVersion();
  const [stage, artifact, ...summary] = args;
  setNodeEvidence(version, stage as VersionStage, {
    artifact,
    summary: summary.join(' '),
  });
  await writeFormalVersion(root, version);
} else if (command === 'approve' || command === 'reject') {
  const version = await requireVersion();
  const [stage, reviewer, ...comment] = args;
  recordApproval(version, {
    stage: stage as VersionStage,
    reviewer: reviewer as 'producer' | 'lead-designer',
    decision: command === 'approve' ? 'approved' : 'changes-requested',
    documentRevision: version.charterRevision,
    comment: comment.join(' '),
  });
  await writeFormalVersion(root, version);
} else if (command === 'todo') {
  const version = await requireVersion();
  addVersionTodo(version, {
    title: args[0] ?? '待处理事项',
    detail: args.slice(1).join(' '),
    stage: version.currentStage,
    assignee: 'producer',
  });
  await writeFormalVersion(root, version);
} else if (command === 'status') {
  const version = await requireVersion();
  console.log(JSON.stringify(publicVersionState(version), null, 2));
} else usage();
