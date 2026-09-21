# 统一实体创建、控制与属性模型：版本排期

- 所属版本：`draft-2026-09-21-b5fbefbd-c4c9-460e-935d-`
- 阶段：版本排期（`version-planning`）
- 日期：2026-09-21
- 执行策略：完整执行
- 策略依据：版本基线；后续仅可在保留固定门禁的前提下追加策略修订。
- 输入：[版本策划](./charter-draft.md)、[模块详细策划](./module-design.md)、[主策审核](./design-review.md)、[任务拆分](./task-breakdown.md)、[机器清单](./task-breakdown.json)

## 公开结论

**范围已冻结，准许 notice guard 核验本报告与任务清单后进入开发。** 本版本容量固定为 11 个工作项：1 项不可逆合同、3 项连续无头核心、2 项 DSL/玩家入口迁移、2 项战斗与持久化接入、1 项交互反馈、1 项长期文档与 1 项跨层集成。它只实现统一弹体创建、以属性 binding 驱动的三参数实体控制、`write`/`maintain` 时间语义、关系与抗性双资源定价、兼容迁移及玩家反馈。

排期不新增开发、测试或 QA 通过证据，也不手工推进版本节点。普通缺陷由后续版本测试集中登记、修复和复验；只有 ADR 合同无法收束、实现偏离已采纳语义、状态失真、外部访问阻塞或需要制作人决定的产品冲突才暂停。本版本不接收 ECS、实体原型、伤害类型、随机控制、冷却、敏感资源属性控制或工作流控制面改动。

## 排期与依赖

| 波次 | 工作项                     | 责任                | 前置条件                                                                                                                                                           | 排期理由与完成出口                                                                                          |
| ---- | -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 1    | `adr-control-model`        | 架构 Agent          | 无                                                                                                                                                                 | 先采纳逻辑属性/binding、commit/overlay/maintain、周期结算、价格、AST 迁移和回退合同；它是所有实现的硬前置。 |
| 2    | `core-property-bindings`   | 核心 Feature PM     | `adr-control-model`                                                                                                                                                | 在无头核心建立稳定属性键、效果域与能力拒绝，使后续实现不能按实体种类分派。                                  |
| 3    | `core-control-records`     | 核心 Feature PM     | `core-property-bindings`                                                                                                                                           | 固定覆写和维持会话的记录、合并、替换与原子清理，先消除无限时间的生命周期歧义。                              |
| 4    | `core-period-budget`       | 核心 Feature PM     | `adr-control-model`、`core-property-bindings`、`core-control-records`                                                                                              | 让关系门槛、抗性、效果和时间共同进入法力/tick，并把周期实扣和执行债务置于核心。                             |
| 5    | `dsl-compat-migration`     | DSL 迁移 Feature PM | `adr-control-model`、`core-property-bindings`、`core-period-budget`                                                                                                | 在共享价格与属性合同已稳定后，规范化新入口和旧调用，保护 AST 唯一 IR 与无损诊断边界。                       |
| 6    | `meta-unified-controls`    | 核心 Feature PM     | `core-property-bindings`、`core-control-records`、`core-period-budget`、`dsl-compat-migration`                                                                     | 迁移玩家可见的创建和具名控制节点，使所有公开控制只经 `applyEntityControl` 与 binding 分派。                 |
| 7A   | `battle-control-bridge`    | 战斗 Feature PM     | `core-control-records`、`core-period-budget`、`meta-unified-controls`                                                                                              | 将核心控制会话接入共享法力、时钟与施法结束；不在战斗/UI 复制资源或清理语义。                                |
| 7B   | `spellbook-persistence`    | DSL 迁移 Feature PM | `dsl-compat-migration`、`meta-unified-controls`                                                                                                                    | 迁移默认法术和存档边界；与 7A 路径和状态所有权不重叠，允许唯一的并行窗口。                                  |
| 8    | `ui-control-feedback`      | 交互 Feature PM     | `core-period-budget`、`meta-unified-controls`、`battle-control-bridge`、`spellbook-persistence`                                                                    | 两条接入路径均完成后，统一展示能力、无限时间、成本和停止原因，避免 UI 猜测尚未落定的运行状态。              |
| 9    | `reference-update`         | 文档 Agent          | `adr-control-model`、`meta-unified-controls`、`spellbook-persistence`、`ui-control-feedback`                                                                       | 从最终注册入口和已验证反馈生成玩家参考，同步长期架构说明与状态页。                                          |
| 10   | `entity-model-integration` | 测试 Agent          | `core-period-budget`、`dsl-compat-migration`、`meta-unified-controls`、`battle-control-bridge`、`spellbook-persistence`、`ui-control-feedback`、`reference-update` | 在真实 AST、VM、Battle、持久化与界面路径回归统一语义，并把普通问题交给版本测试闭环。                        |

关键路径为 `adr-control-model → core-property-bindings → core-control-records → core-period-budget → dsl-compat-migration → meta-unified-controls → battle-control-bridge → ui-control-feedback → reference-update → entity-model-integration`。`spellbook-persistence` 在波次 7 与 `battle-control-bridge` 并行，但二者都必须在波次 8 前完成；没有其他并行窗口。依赖均来自 `task-breakdown.json`，不存在外部工作项、缺失依赖、自依赖或循环。

## 容量与范围冻结

| 容量维度     | 冻结结论                                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作项       | 11 项，覆盖 ADR、核心、DSL、元法术、战斗、持久化、UI、参考和跨层集成；不得把任何一项拆为未审计的额外 Feature。                                                   |
| 并行度       | 仅波次 7 最多 2 项并行：战斗桥接与法术书/持久化。核心链、玩家入口、UI、文档和集成严格串行；同一时点只有一个共享核心合同写入者。                                  |
| 关键风险容量 | 先用 6 个连续工作项冻结不可逆语义、无头实现、双资源预算和兼容迁移；并行窗口后保留 UI、文档和集成三道收束，避免将体验与迁移问题挤到最终门禁。                     |
| 质量责任     | 执行 Agent 只记录每项直接检查；后续 Feature PM 在最终代码树运行一次快速门禁、独立审查和完整门禁。Version QA 只复用匹配事实，另行负责集成、迁移、打包和候选验证。 |
| 范围边界     | 可改 `src/core/`、`src/game/`、`src/app/`、DSL/AST、存档、玩家参考与其直接测试；不得改 `.daoyan-agent`、notice guard、调度器、工作流控制面或生产运行状态。       |
| 承诺变化     | 不改变既有承诺的澄清记录在当前工作项；改变创建、控制语义、资源模型、实体种类或范围的新增方向，在冻结后进入范围评审或下一版本候选。                               |

## 风险与固定门槛

- `adr-control-model` 未采纳或其合同不能覆盖属性 binding、时间覆写、控制会话、定价和迁移时，停止后续工作项，不以代码试错替代不可逆决定。
- 无头核心必须保持 UI 无关；公开元法术不得按 `Actor`、`Projectile`、`kind` 或 `ownedProjectile` 分叉。能力缺失、权限不足、非法效果和失效句柄均须原子拒绝。
- 无限 `write` 只按其 descriptor/binding 规则一次结算；无限 `maintain` 必须每 0.25 秒结算法力与 tick 执行债务，并在余额不足、主动结束、打断、目标或控制失效时释放。不能以实体类型制造例外。
- 兼容迁移只自动转换可证明等价的旧调用；句柄逃逸、重赋值或无法保序的链保留原文并给出定位诊断，不能静默改变伤害、方向、时长或资源。
- 普通实现、测试、格式或审查问题留在后续同一 Feature PM 的质量循环；完整门禁只能由 Feature PM 在最终代码树执行一次，Version QA 不重复 `npm run verify:full`。
- 当前规划阶段仅做文档与清单校验。若宿主环境阻断后续定向测试，记录恢复点并只复验受影响命令及下游事实；这不是制作人决策项。

## 排期核对

- [x] 11 个稳定 ID 唯一，且依赖全部指向同一机器清单。
- [x] 依赖闭合、无自依赖、无循环；关键路径与波次 7 的唯一并行窗口一致。
- [x] 容量限制为一条核心关键路径、一个最多两项的接入并行窗口和三道体验/集成收束；没有隐含 Feature。
- [x] 完整执行策略、固定制作人门禁和工作流控制面隔离均未被排期改变。
- [x] 计划验收命令未被登记为开发、快速门禁、完整门禁或 Version QA 成功证据。
