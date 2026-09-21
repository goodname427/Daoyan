# 自适应项目中枢版本排期

- 所属版本：`adaptive-project-office-2026-09-21`
- 阶段：版本排期（`version-planning`）
- 日期：2026-09-21
- 执行策略：完整执行
- 策略依据：`legacy-unknown`
- 输入：[任务拆分](./task-breakdown.md)、[主策审核](./design-review.md)、[ADR-0016](../../adr/0016-自适应版本编排与兼容迁移边界.md)

## 公开结论

**范围修订 3 已冻结，准许按下列依赖序列进入开发。** 审计澄清属于既有 Agent 工作流效率承诺的缺陷收束，不另开版本、Feature 或制作人审批。旧状态仍没有可证明的缩减阶段策略，故继续以 `legacy-unknown` 保守完整执行。版本容量仍为清单中的 7 个工作项、3 个连续收束门槛（Feature 汇总、Version QA、迁移演练）；不接收额外功能、游戏玩法、通讯协议或生产运行状态迁移范围。

本排期只冻结执行顺序、并行边界与容量，不生成开发、QA、迁移或候选通过证据。notice guard 应在核验本报告、`task-breakdown.json` 和当前 Git 修订后原子登记阶段证据；本文件不手工推进正式版本节点。

交付门禁审计所见的等待快照回复断言与 Windows 临时夹具清理竞态，按既有 `selective-recovery` / `feature-quality-loop` 测试范围修复：失败断言后的守卫也必须先退出，再删除带 `node_modules` junction 的夹具；等待中的普通制作人决定即使被语义分流，也必须保留为原快照的 `retry-wait` 确认，只有明确承诺变化才能转为新方向。该修复不改变七项容量、责任划分、恢复资格或版本节点。

## 排期与依赖

| 波次 | 工作项                 | 责任       | 前置条件                                 | 排期理由与完成出口                                                                                                            |
| ---- | ---------------------- | ---------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1    | `evidence-contract`    | Feature PM | 无                                       | 先建立 Task/Feature/Version 证据的共同输入、输出、Git tree、路径、命令和配置指纹及执行轮次/修订，才可判断恢复、失效和复用。   |
| 2A   | `task-profile`         | Feature PM | `evidence-contract`                      | 固定执行 Agent 的轻量 Profile 与 Task 直接检查边界。                                                                          |
| 2B   | `public-timing`        | Feature PM | `evidence-contract`                      | 可与 2A 并行；公开事件轮次/修订和六类耗时依赖同一证据合同，但不依赖路由实现。                                                 |
| 3    | `selective-recovery`   | Feature PM | `evidence-contract`、`task-profile`      | 只为进程异常、守卫/主机重启、外部阻塞或持久证据损坏恢复；启动宽限与 PM/dispatcher/worker 分离对账后，只重排失效项及下游。     |
| 4    | `feature-quality-loop` | Feature PM | 波次 1–3 全部完成                        | 汇总有效 Task 后运行一次快速门禁和独立审查；普通失败在同一 PM 按未关闭 finding 增量闭环，最终树仅生成一份可复用完整门禁证据。 |
| 5    | `version-qa-reuse`     | Version QA | `feature-quality-loop`                   | 只消费匹配代码树/命令/配置指纹的 Feature 完整门禁，独立完成跨 Feature 集成、主线回归、打包和候选约束。                        |
| 6    | `migration-drill`      | Version QA | `selective-recovery`、`version-qa-reuse` | 以已验证的选择性恢复和 Version 证据复用为前提，在隔离副本完成迁移/保留增量降级演练。                                          |

关键路径为 `evidence-contract → task-profile → selective-recovery → feature-quality-loop → version-qa-reuse → migration-drill`。波次 2 只允许 `task-profile` 与 `public-timing` 并行；从 Feature 汇总开始收束为单一路径，避免多份快速或完整门禁证据竞争。所有依赖均来自同一份 `task-breakdown.json`，无外部工作项、缺失依赖或循环依赖。

## 容量与范围冻结

| 容量维度 | 冻结结论                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作项   | 7 项：4 项证据/Task/异常恢复/统计基础能力，1 项 Feature 质量收束，2 项 Version 验证与迁移收束；审计澄清不增项。                                                                 |
| 并行度   | 基础层最多 2 项并行；Feature 汇总及之后严格串行。每个时点只保留一个最终代码树的 Feature 完整门禁所有者。                                                                        |
| 角色责任 | 执行 Agent 只产生 Task 直接检查；Feature PM 产生一次快速门禁、独立审查和唯一完整门禁；Version QA 复用匹配事实并产生 Version 范围结论。                                          |
| 范围边界 | 仅 `scripts/` 编排、秘书状态/守卫、公开工作日志/看板投影及直接测试；不改 `src/core/`、游戏玩法、DSL、存档、战斗、钉钉协议或生产 `.daoyan-agent`。                               |
| 证据失效 | 无关 Git tree 变化保留有效事实；路径、命令、配置、输入输出或上游依赖相交时，仅失效该项及下游。pre-push 复用匹配最终树和配置指纹的完整门禁；候选修订漂移才回到 Feature PM 重建。 |

冻结后的新增方向不得插入本版本开发队列：未改变既有承诺的澄清按现有范围记录；改变承诺的增量按冻结规则进入 `scope-review` 或下一版本候选。生产迁移/降级演练仅在隔离副本进行，不能借本排期读写或替代 `.daoyan-agent` 生产现场。

## 风险与门槛

- 证据模型是后续复用、恢复和候选门禁的共同前提；其合同或测试失败时，停止后续波次并只回退受影响下游。
- Feature 完整门禁必须在 `feature-quality-loop` 的最终代码树由 Feature PM 运行一次；Version QA 不重复 `npm run verify:full`。
- 普通测试/格式失败、审查 finding 与局部修复不得转入恢复：同一 PM 从失败命令或未关闭 finding 迭代，只有无进展重复、真实外部阻塞或进程异常才形成恢复点。worker 或 `tsx` 包装进程退出时，先等待并重读终态快照，不能据此将仍在运行的 PM 标成 `retry-wait`。
- `runDirectory` 已登记而恢复快照尚未创建时属于 `bootstrapping` 短暂宽限，不能记录为 `missing`；公开状态分别计真实启动、异常恢复与局部修复轮次，并在交付后清理陈旧摘要。
- `migration-drill` 是版本容量内的最后一项高风险收束，必须先完成原始字节备份、停写、隔离预览和整组校验，仍不得触及生产运行状态。
- 当前环境如继续阻止 Vitest/esbuild 子进程，应记录为技术验证阻塞并保留恢复点；这不是制作人决策项，恢复后仅重验受影响命令与下游证据。

## 排期核对

- [x] 7 个稳定 ID 唯一，依赖均指向同一清单。
- [x] 依赖闭合、无自依赖、无循环；关键路径与唯一完整门禁责任一致。
- [x] 容量限制为一个基础层并行窗口和一个后续收束路径；没有隐含的额外 Feature。
- [x] `legacy-unknown` 保守完整执行、生产状态隔离和固定制作人门禁均未被排期改变；审计澄清已收束到既有 7 项，`version-qa-reuse.owner` 为 Version QA。
