# 属性驱动统一实体与资源守恒法术：任务拆分

- 版本：`draft-2026-09-23-7af7515c-4ac5-47fe-9063-`
- 阶段：任务拆分。机器可读清单见 [task-breakdown.json](./task-breakdown.json)。
- 输入：[未冻结章程](./charter-draft.md)、[模块详细策划](./module-design.md)和[主策审核](./design-review.md)。三轮范围修订与上一版同主题候选反馈已在同一草案去重。
- 公开结论：形成 16 项稳定 ID、依赖、路径和直接验收检查，覆盖三期纵向闭环。**章程仍待制作人评审；本清单不表示立项批准、范围冻结、ADR 采纳、能力实现或候选验收。** 后续排期必须遵守固定制作人门禁。

## 问题、范围和非目标

把已审核的详细策划转成可分派且可核验的工作，而不把统一实体框架缩减为六个属性入口。范围包含实体审计、权限与感知、运动和资源守恒、六属性、事件、两种蓄力、发现与预设、迁移及实际体验。工作流控制面、第二套 IR、完整 ECS 和无条件透视不在本版产品范围；不恢复冷却，不给 Projectile 自动回蓝或免费意识。

架构议题必须先形成已采纳 ADR，才允许修改对应运行语义。审核文档所说“任务拆分前先论证”在本清单中转为显式前置任务；本阶段没有权限通过拆分文件暗中采纳 ADR。若 ADR 论证发现需要改变已承诺产品体验或只能丢失用户数据，保存取舍和回退证据交制作人裁决。

## 工作项与依赖

| ID                       | 验收边界                                               | 直接依赖                                                            |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------- |
| `adr-motion-energy`      | 运动/供能/命中守恒与旧弹道兼容决策                     | 无                                                                  |
| `adr-attributes-ledger`  | 属性/探查/账本和静动态预算决策                         | `adr-motion-energy`                                                 |
| `adr-events-context`     | 多订阅、账户授权、生命周期与旧槽位决策                 | `adr-motion-energy`, `adr-attributes-ledger`                        |
| `entity-state`           | 跨 Actor、Projectile、组合实体的有界审计状态与能力拒绝 | 前两项 ADR                                                          |
| `motion-effects`         | 有源移动、惯性、speedMax 与独立传送                    | `entity-state`, 运动 ADR                                            |
| `sense-permissions`      | 自身私有正价读取、他方探查和旧读取旁路封闭             | `entity-state`, 属性 ADR                                            |
| `slice-one-experience`   | 推演价格、演武惯性/减速、权限面板与往返                | `motion-effects`, `sense-permissions`                               |
| `resource-ledger`        | 付款、分池储能、损耗/退款、法力/tick/神识预算对账      | `entity-state`, 前两项 ADR                                          |
| `projectile-energy`      | 冲量、持续推进、追踪及守恒命中                         | `motion-effects`, `resource-ledger`                                 |
| `six-attributes`         | 六属性时限/抗性/价格与自增益防套利                     | `resource-ledger`, `sense-permissions`                              |
| `legacy-migration`       | 旧 AST、旧存档隔离迁移与诊断/保原件                    | `projectile-energy`, `six-attributes`, 事件 ADR                     |
| `slice-two-experience`   | 三种法球、预算解释、减速/破防选择导入及两页往返        | `projectile-energy`, `six-attributes`, `legacy-migration`, 首期体验 |
| `passive-events`         | 四类离散事件、同事件多法术、有界重入和归属             | 事件 ADR、`resource-ledger`, `entity-state`                         |
| `active-monitor`         | 显式开启、持续付费及终止后零扫描                       | `passive-events`, `sense-permissions`, `resource-ledger`            |
| `charge-sessions`        | 两种蓄力、全部取消/中断/暂停路径与幂等结算             | `passive-events`, `projectile-energy`, `resource-ledger`            |
| `slice-three-experience` | 事件/蓄力实战与跨期兼容、空/失败/窄屏回归              | `active-monitor`, `charge-sessions`, 第二期体验、迁移               |

清单的 `affectedPaths` 是计划修改边界，具体新测试可在这些路径内新增；`acceptanceCommands` 是将来执行者应运行并记录退出码的定向检查，不是本阶段已通过的证据。每个切片还要留下核心无头断言、推演台预算/失败反馈、演武场实测和当期兼容证据。Version PM 据依赖安排波次与并行度；Feature PM 对汇总后的最终树负责完整门禁，Version QA 负责跨期浏览器主线、迁移、打包与候选验证。本清单不代替这些阶段的证据。

## 范围和验收覆盖核对

1. **实体、权限和运动**：`entity-state`、`motion-effects`、`sense-permissions`、`slice-one-experience` 同时覆盖 velocity 与 speedMax 分离、运动来源、基础功率、正价私有探查、面板防透视及旧入口；失败、空目标和页签往返须可见。
2. **能量和属性**：`resource-ledger`、`projectile-energy`、`six-attributes`、`slice-two-experience` 覆盖一次冲量后惯性、持续推进/追踪耗能停止、伤害能量上限、注能与退款、六属性的当前/上限资源语义、自回蓝/降耗/提速反套利，以及对手减速/破防可选择导入。旧法术书与旧存档由 `legacy-migration` 保护。
3. **事件和生命周期**：`passive-events`、`active-monitor`、`charge-sessions`、`slice-three-experience` 覆盖受击/碰撞/法力耗尽/实体消失、单事件双法术、付费主动监控、按下蓄时松开瞬发和持球注能松开发射，以及打断、取消、死亡、耗尽、暂停和重复终止。
4. **兼容和架构**：三项 ADR 明确覆盖旧 ADR 0006/0007/0009/0011/0017 的边界；`legacy-migration` 必须证明旧法术等价或保留原文、旧 AST 和存档并定位拒绝。旧运行会话不得凭空恢复账户、事件或能量历史。

三期属于**同一正式版本**，任一期只完成自己的闭环，不能提前宣称全版验收。容量不足时应公开重排与风险，保留全部核心目标并走制作人范围评审。普通缺陷留版本测试和修复阶段。notice guard 根据本阶段报告登记证据；本文件不修改运行状态或推进节点。
