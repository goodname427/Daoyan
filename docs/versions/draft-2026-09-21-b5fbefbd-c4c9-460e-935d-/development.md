# 统一实体创建、控制与属性模型：开发阶段证据

- 版本：`draft-2026-09-21-b5fbefbd-c4c9-460e-935d-`
- 范围：按 [正式任务清单](./task-breakdown.md) 的依赖顺序汇总 11 个工作项，机器清单见 [development.json](./development.json)。
- 证据来源：Feature PM 的 `.daoyan-agent/runs/secretary-formal-draft-2026-09-21-b5fbefbd-c4c9-460e-935d--1-development-4/` 中各工作项 `*-attempt-1.md` 输出；必要的实际命令由同目录执行日志核对。

## 公开结论

11 项均已有实现或文档输出，并依赖顺序登记。**开发阶段尚不能判定通过。** 多数标准定向 Vitest 在加载配置时因 `esbuild spawn EPERM` 退出，测试断言未执行；跨层 Playwright 也因子进程创建失败未执行。独立无头检查只作为各 Task 的辅助事实，不能代替标准定向测试。`dsl-compat-migration` 明确留下四步弹道链的失败路径等价性验收缺口；参考生成命令同样被 `spawn EPERM` 阻断，生成结果与注册入口的一致性仍需复核。

本报告只登记执行 Agent 的直接检查及失败事实。快速门禁、独立审查、`verify:full`、真实体验和版本测试均未作为 Task 证据登记，后续由 Feature PM 和 Version QA 按各自作用域执行。此处不手工推进版本节点。

## 逐工作项结果

| 顺序 | 工作项                     | 直接结果与待复核事项                                                                          |
| ---- | -------------------------- | --------------------------------------------------------------------------------------------- |
| 1    | `adr-control-model`        | ADR 0017、架构不变量和模块设计已更新；类型、定向格式及文档检查通过。                          |
| 2    | `core-property-bindings`   | 七类属性 descriptor 与 Actor/Projectile binding 已实现；类型和无头直测通过；Vitest 启动失败。 |
| 3    | `core-control-records`     | 覆写记录和核心控制会话已接入；类型、无头冒烟通过；Vitest 启动失败。                           |
| 4    | `core-period-budget`       | 关系/抗性价格、周期预算和 VM 实扣已接入；类型、无头检查通过；Vitest 启动失败。                |
| 5    | `dsl-compat-migration`     | AST 迁移及定位诊断已实现，类型和 Node 检查通过；Vitest 启动失败，四步链折叠验收未完成。       |
| 6    | `meta-unified-controls`    | 即时创建及七项三参数控制已实现；类型、无头断言通过；Vitest 启动失败。                         |
| 7A   | `battle-control-bridge`    | Battle 与核心会话、共享法力及时间边界已接线；类型、无头断言通过；Vitest 启动失败。            |
| 7B   | `spellbook-persistence`    | 默认/示例法术与存档保护已更新；类型、临时无头检查通过；Vitest 启动失败。                      |
| 8    | `ui-control-feedback`      | 推演台和演武场控制反馈已更新；类型及定向静态检查通过；渲染 Vitest 启动失败。                  |
| 9    | `reference-update`         | 玩家参考及生成器源码已更新；类型、Markdown/链接检查通过；生成器与 `docs:check` 启动失败。     |
| 10   | `entity-model-integration` | 跨层测试与 E2E 断言已增补；类型、静态检查通过；Vitest 和 Playwright 均未运行断言。            |

`development.json` 只列出可核实的 Task 直接命令及退出码。格式、ESLint、`git diff --check` 和临时无头检查若前序输出未提供可还原的完整命令，保留在叙述中而不伪造机器命令；E2E 属于后续集成/版本作用域，不进入 Task 命令清单。清单中的 `status: completed` 表示执行 Agent 已交付输出；`targetedTests: failed` 保留未通过的验收事实，阶段消费方应据此拒绝通过。

## 后续闭环

Feature PM 需在可启动子进程的环境复跑失败的定向 Vitest、参考生成与检查，并解决四步弹道链的等价性验收；随后核实跨层 E2E，执行快速门禁、审查与最终树完整门禁。版本测试和候选体验仍由后续阶段负责。本次未修改产品实现，也未进行 Git 交付。
