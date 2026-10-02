import fs from 'node:fs';
import crypto from 'node:crypto';

const base = 'docs/versions/pilot-agent-intent-2026-09-24/';
const out = `${base}tasks/design-acceptance-da-a-flow/`;
const run = '.daoyan-agent/runs/secretary-formal-pilot-agent-intent-2026-09-24-13-development-11/';
const play =
  '.daoyan-agent/runs/secretary-formal-pilot-agent-intent-2026-09-24-13-development-9/main-one-time-play-evidence/';
const gate = '.daoyan-agent/runs/pre-push-2026-10-02T11-22-19-873Z/full-gate-evidence.json';
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sources = [
  'AGENTS.md',
  'docs/workflow.md',
  'docs/adr/0023-策划黑盒体验验收.md',
  'docs/adr/0024-自然接触与旧运动命中语义覆盖.md',
  `${base}design-acceptance-tasks.json`,
  `${base}development-tasks.json`,
  `${base}design-review.json`,
  `${base}design-review.md`,
  `${base}module-design.md`,
  `${base}player-bridge-design.md`,
  `${base}development.json`,
  `${base}development.md`,
  `${base}player-implementation.md`,
  `${base}core-implementation.md`,
  `${base}tasks/development-dev-world-a3.json`,
  `${base}tasks/development-dev-player-a3.json`,
  `${run}report.json`,
  `${run}recovery.json`,
  gate,
  `${play}README.md`,
  `${play}provenance.json`,
  `${play}browser-calls.json`,
  `${play}server-and-tree-records.json`,
  '.daoyan-agent/releases/versions/pilot-agent-intent-2026-09-24.json',
  'package.json',
  'package-lock.json',
  'agents/policy.json',
  'vite.config.ts',
  'e2e/candidate.spec.ts',
];
const state = read(sources[23]);
const d = read(`${base}development.json`);
const g = read(gate);
const files = [];
function walk(p) {
  if (!fs.existsSync(p)) return;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const child = `${p}/${e.name}`;
    if (e.isDirectory()) walk(child);
    else
      files.push({
        path: child,
        sha256: hash(child),
        mtime: fs.statSync(child).mtime.toISOString(),
      });
  }
}
walk('dist');
const evidence = {
  recordedAt: new Date().toISOString(),
  baseline: {
    head: 'ea1fa0f88376970df22575b473f1fbe3c4db610f',
    gitTree: 'a83314ea7b4f6f6eacffc64605d7de13a82cf960',
    initialStatus: [],
    branch: 'codex/version-pilot-agent-intent-2026-09-24',
  },
  validation: {
    workspaceFingerprint: '5ccf6bdc034347b5b8dc42788e3156d1b9ce30d92e6375c1a0abece3336ea32c',
    configFingerprint: 'aa6cbb18e344300381c98f482fa7934538be90473e18883de0214bc470f09d55',
    gateSource: gate,
    receipt: g,
    treeMatch: true,
    configMatch: true,
    method:
      '写入验收证据前，PowerShell git ls-files 管道交由现有 fingerprintPaths/isValidationTreePath 只读函数计算；初始工作区干净。没有运行 pre-push main 或任何门禁。',
    postEvidenceTreePolicy:
      '这些指纹绑定写证据前的受验树；验收目录新增文件可能被当前指纹函数纳入，不将新的原始指纹误称产品代码变化或重新签门禁。',
  },
  approval: {
    currentStage: state.currentStage,
    scopeRevisions: state.orchestration.scopeRevisions
      .slice(-2)
      .map((x) => ({ revision: x.revision, status: x.status })),
    gates: state.orchestration.decisionGates.filter((x) => x.status === 'approved'),
    drb9: read(`${base}design-review.json`),
  },
  development: {
    scopeRevision: d.scopeRevision,
    firstBatch: d.firstBatch,
    workItems: d.workItems.map((x) => ({
      id: x.id,
      commit: x.commit,
      status: x.status,
      source: x.source,
    })),
    completeGate: d.versionValidation.completeGate,
    reportExtra: read(`${run}report.json`).extra,
    recoveryStatus: read(`${run}recovery.json`).status,
  },
  reuse: {
    productBaseline: '85c8cf4',
    productDiffPaths: [],
    comparedPaths: [
      'src',
      'electron',
      'scripts/desktop.mjs',
      'vite.config.ts',
      'package-lock.json',
    ],
    purpose: '仅来源和操作线索，不替独立验收；未重复开发检查',
    priorBrowserCount: read(`${play}provenance.json`).browserRecordCount,
    priorMissing: [
      '返书后重执行',
      '可编辑辅助术组合',
      '独立策划实玩',
      '活动 Battle 证书与硬件接入',
    ],
    configuration: '历史 Vite 页面配置；当前配置哈希匹配，当前运行实例未验证',
  },
  build: {
    files,
    source:
      '现存 dist 文件；时间与收据邻近只能作线索。未取得构建文件到本轮玩家服务的绑定，未启动/重建应用。',
  },
  runtime: {
    requestedUrl: 'http://localhost:5173/',
    currentServer: 'not-verified',
    viewport: null,
    consoleQuery: 'not-run',
    isolatedSave: 'not-created',
    playerOperations: 0,
    screenshots: [],
    reason: '访问权限被拒，在页面到达前停止；未读写真实用户存档。',
  },
  sources: sources.map((path) => ({ path, sha256: hash(path) })),
};
fs.writeFileSync(`${out}source-evidence.json`, JSON.stringify(evidence, null, 2) + '\n');
console.log(
  JSON.stringify({
    sources: evidence.sources.length,
    distFiles: files.length,
    gateExitCode: g.exitCode,
    receiptTree: g.workspaceFingerprint,
    receiptConfig: g.configFingerprint,
    playerOperations: 0,
  }),
);
