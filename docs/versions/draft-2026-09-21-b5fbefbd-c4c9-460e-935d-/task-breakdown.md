# 统一实体创建、控制与属性模型：任务拆分

- 版本 ID：`draft-2026-09-21-b5fbefbd-c4c9-460e-935d-`
- 阶段：任务拆分
- 策略：完整执行；后续只能追加策略修订，不能移除固定门禁。
- 范围冻结输入：版本策划、模块详细策划与 `approved` 主策审核。

## 结论

本清单把已批准范围拆为 11 个可验证工作项。`adr-control-model` 是所有实现的硬前置：在逻辑属性/binding、控制会话、周期预算和旧调用迁移合同被采纳前，核心、DSL、元法术和 UI 不得并行落地。此后先建立无头核心，再迁移 DSL 与玩家入口，随后接入战斗、存档和体验，最后以跨层回归收束。

工作项的稳定 ID、依赖、受影响路径和直接验收命令以 [task-breakdown.json](./task-breakdown.json) 为机器可读来源。命令是后续责任人的验收建议，不是本阶段已经通过的开发或门禁证据。

## 依赖与验收边界

```text
adr-control-model
  └─ core-property-bindings ─┬─ core-control-records ── core-period-budget
                             │                             ├─ dsl-compat-migration ── meta-unified-controls
                             │                             │                              ├─ battle-control-bridge
                             │                             │                              └─ spellbook-persistence
                             │                             └─ ui-control-feedback ── reference-update
                             └──────────────────────────────────────────────────────── entity-model-integration
```

`entity-model-integration` 还依赖 DSL、元法术、战斗、持久化、UI 和参考更新的全部直接链路；JSON 中保留完整依赖而不以图示代替。版本排期只能消费已核验的这些工作项，并据此定义波次、容量和冻结范围。

## 工作项摘要

| ID                         | 工作项         | 交付边界                                     |
| -------------------------- | -------------- | -------------------------------------------- |
| `adr-control-model`        | ADR 合同       | 采纳不可逆语义与迁移/回退边界。              |
| `core-property-bindings`   | 属性与 binding | 同一稳定属性跨实体分派，缺能力确定性拒绝。   |
| `core-control-records`     | 覆写与会话     | commit/overlay/maintain 的记录、合并与清理。 |
| `core-period-budget`       | 定价与预算     | 双资源公式、无限维持周期实扣和动态预算。     |
| `dsl-compat-migration`     | AST 规范化     | 只无损迁移旧调用，其他情况给诊断。           |
| `meta-unified-controls`    | 玩家元法术     | 新创建入口及统一三参数属性控制。             |
| `battle-control-bridge`    | 战斗桥接       | 将资源、时钟、取消和打断接到核心会话。       |
| `spellbook-persistence`    | 默认法术与存档 | 迁移默认内容并保护最后可运行 AST。           |
| `ui-control-feedback`      | 推演/演武反馈  | 显示能力、时间、成本和停止原因。             |
| `reference-update`         | 参考与长期文档 | 自动生成参考与玩家语义同步。                 |
| `entity-model-integration` | 跨层回归       | 覆盖真实路径并把普通缺陷送版本测试闭环。     |

## 范围与非目标核对

- 只覆盖已批准的统一创建、属性控制、无限时间、关系/抗性定价、兼容迁移与玩家反馈。
- 不引入完整 ECS、额外实体原型、伤害类型、随机控制、冷却、敏感资源属性控制或第二套 AST IR。
- 不包含 `.daoyan-agent`、notice guard、调度器或其他工作流控制面改动。
- 本阶段只验证清单结构与文档；不宣称任何计划验收命令、Feature 门禁或版本 QA 已通过，也不手工推进版本节点。

## 阶段验证

- `task-breakdown.json` 将由 JSON 解析和稳定 ID、依赖、路径、命令检查验证。
- Markdown 由 Prettier 与文档检查验证。
- 按规划/纯文档 Profile，本阶段不运行 `npm run verify`、`npm run verify:full`、E2E 或构建。
