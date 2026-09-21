# 自适应项目中枢任务拆分

- 所属版本：`adaptive-project-office-2026-09-21`
- 阶段：任务拆分（`task-breakdown`）
- 执行策略：完整执行
- 策略依据：`legacy-unknown`
- 日期：2026-09-21
- 输入：[模块详细策划](./module-design.md)、[主策审核](./design-review.md)、[ADR-0016](../../adr/0016-自适应版本编排与兼容迁移边界.md)

## 结论

旧状态缺少阶段策略，范围修订 3 继续采用 `legacy-unknown` 的保守完整执行。已批准的审计澄清收束为既有工作项的验收细化，不增加版本范围、工作项或制作人门禁。本清单只拆分审核后仍需实现或演练的工作；不以已存在的纵向切片、策划文档或后续 QA 结论制造占位任务。

每项的范围和可观察验收写入机器可读的 [task-breakdown.json](./task-breakdown.json)。依赖只指向同一清单的稳定 ID，形成从证据合同到 Task 边界、选择性恢复、Feature 汇总、Version QA 和迁移演练的可验证链路。

## 工作项与依赖

| ID                     | 责任者     | 依赖                                     | 受影响路径                                                                                                                             | 验收命令 / 检查                                                                                                                                                           |
| ---------------------- | ---------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidence-contract`    | Feature PM | 无                                       | `scripts/version-lifecycle.ts`、`scripts/secretary-notice-guard.ts`；对应 lifecycle/guard 测试                                         | `npm run typecheck`；`npm test -- test/version-lifecycle.test.ts test/secretary-notice-guard.test.ts`                                                                     |
| `task-profile`         | Feature PM | `evidence-contract`                      | `scripts/agent-routing.ts`、`scripts/agent-dispatcher.ts`、`scripts/version-dispatcher.ts`；`test/agent-routing.test.ts`               | `npm run typecheck`；`npm test -- test/agent-routing.test.ts`                                                                                                             |
| `selective-recovery`   | Feature PM | `evidence-contract`、`task-profile`      | `scripts/secretary-state.ts`、`scripts/secretary-notice-guard.ts`、`scripts/version-lifecycle.ts`；对应三组测试                        | `npm run typecheck`；`npm test -- test/secretary-state.test.ts test/secretary-notice-guard.test.ts test/version-lifecycle.test.ts`                                        |
| `public-timing`        | Feature PM | `evidence-contract`                      | `scripts/public-work-log.ts`、`scripts/secretary-state.ts`、`scripts/secretary-notice-guard.ts`（`/api/dashboard` 投影）；对应三组测试 | `npm run typecheck`；`npm test -- test/public-work-log.test.ts test/secretary-state.test.ts test/secretary-dashboard.test.ts`                                             |
| `feature-quality-loop` | Feature PM | 前四项                                   | `scripts/agent-dispatcher.ts`、`scripts/agent-routing.ts`、生命周期/guard；对应三组测试                                                | `npm run typecheck`；`npm test -- test/agent-routing.test.ts test/version-lifecycle.test.ts test/secretary-notice-guard.test.ts`；`npm run verify`；`npm run verify:full` |
| `version-qa-reuse`     | Version QA | `feature-quality-loop`                   | `scripts/version-lifecycle.ts`、`scripts/secretary-notice-guard.ts`；对应测试                                                          | `npm run typecheck`；`npm test -- test/version-lifecycle.test.ts test/secretary-notice-guard.test.ts`；`npm run test:e2e`；`npm run build`                                |
| `migration-drill`      | Version QA | `selective-recovery`、`version-qa-reuse` | lifecycle、secretary state/guard 及对应三组测试                                                                                        | `npm run typecheck`；`npm test -- test/version-lifecycle.test.ts test/secretary-state.test.ts test/secretary-notice-guard.test.ts`；`npm run build`                       |

## 范围与非目标

- 范围：`scripts/` 中的 Agent 路由、正式版本生命周期、秘书状态/守卫、公开工作日志与看板投影，以及它们的直接测试；生产迁移工具和演练由最后一个工作项在隔离副本中完成。
- 非目标：不改游戏核心、DSL、存档、战斗或钉钉协议；不直接编辑 `.daoyan-agent`，不预造 `development.json`、`qa.json`、缺陷复验或候选通过证据，不发布版本。
- 责任边界：执行 Agent 不运行统一 `npm run verify`；Feature PM 负责一次快速门禁、独立审查和唯一 Feature 完整门禁；Version QA 复用匹配事实并负责跨 Feature 回归、迁移、打包与候选验证。

## 验收与验证计划

上表和 JSON 的 `affectedPaths`、`acceptanceCommands` 是逐项范围、直接检查与证据复用/失效边界的唯一清单；实现时先扩展其中直接相关的测试，再运行列出的检查。`feature-quality-loop` 的最终代码树才产生唯一的 `npm run verify:full` Feature 证据；`version-qa-reuse` 不重复该命令。

任务拆分阶段本身采用轻量文档验证：解析 JSON、核对唯一 ID、逐项非空路径/验收命令与依赖闭包，并运行文档检查；不运行统一 `npm run verify` 或任何 Feature 快速门禁。notice guard 应在核验该清单、阶段报告和当前 Git 修订后原子登记证据；本文件不手工推进版本节点。

## 审计澄清的验收归属

- `selective-recovery` 只处理进程崩溃、主机/守卫重启、外部服务或额度阻塞、持久证据损坏；启动中的 `bootstrapping` 宽限不能标为 `missing`，并分别追踪 PM、dispatcher 与 worker，退出后先等待并重读终态快照。
- `feature-quality-loop` 在同一 PM 运行内从未关闭 finding 或失败命令增量修复；普通测试/格式失败和审查 finding 不进入恢复，只有无进展重复、真实外部阻塞或进程异常才恢复。完整门禁在每个 Feature 最终树仅执行一次，pre-push 复用匹配代码树与配置指纹的该证据。
- `public-timing` 公开真实启动、异常恢复和局部修复轮次，并在交付后清理陈旧摘要；事件 ID 继续绑定执行轮次和代码修订。上述回归覆盖启动快照竞态、PM/worker 退出竞态、第二轮新 finding 原进程闭环、格式失败不恢复和 pre-push 证据复用。
