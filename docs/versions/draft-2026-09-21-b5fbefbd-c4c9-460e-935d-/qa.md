# 统一实体创建、控制与属性模型：独立版本 QA

- 版本：`draft-2026-09-21-b5fbefbd-c4c9-460e-935d-`
- 日期：2026-09-23
- 候选代码修订：`85a1759`（相对开发修订仅有文档和 QA 报告变化）
- 结论：**passed**。首次独立 QA 在 Agent 沙盒中被 `spawn EPERM` 阻断；主 Agent 独立于 Feature 开发者，在可运行宿主上补齐标准定向测试、浏览器回归和构建，完整门禁也通过。首次失败报告仍保留在 `85a1759` 和 QA-1 运行记录中。机器清单见 [qa.json](./qa.json)。

## 范围与验收

本阶段独立检验当前正式版本的统一创建、三参数属性控制、能力拒绝、旧 DSL/存档迁移、双资源定价、无限维持停止，以及推演台和演武场主线。使用冻结的版本策划、ADR 0017 和 `entity-model-integration` 工作项作为标准。不修改产品实现、测试文件、运行状态或版本节点。

## 实际结果

| 套件 | 证据                                                                                        | 结果 |
| ---- | ------------------------------------------------------------------------------------------- | ---- |
| 验收 | 原独立 QA 的五个无头场景；主 Agent 标准 Vitest 检验 `entity-vnext`、`dsl-migration`、`core` | 通过 |
| 集成 | 标准 Vitest 检验 `combat`、`persistence`、`render`，覆盖 VM/Battle、存档和界面              | 通过 |
| 回归 | 6 文件 **110 条通过**；游戏浏览器 Playwright **18 条通过**；生产构建通过                    | 通过 |

首次独立 QA 的进程内转换 Vitest 运行现有 6 文件 110 条断言通过，五个独立无头场景也通过；标准命令因隔离宿主拒绝子进程启动而没有执行断言。该轮失败命令和环境说明保留在 `85a1759` 的报告与 QA-1 恢复目录中，不能追记为当时通过。

主 Agent 在可启动子进程的工作区重新执行：

- `npm test -- test/entity-vnext.test.ts test/dsl-migration.test.ts test/core.test.ts test/combat.test.ts test/persistence.test.ts test/render.test.tsx`：退出 0，110 条通过。
- `npm run test:e2e -- e2e/smoke.spec.ts`：退出 0，18 条实际浏览器流程通过。
- `npm run build`：退出 0，生产构建产物生成。

完整门禁是单独的 Feature 范围支撑证据，不计入 QA 命令：`node scripts/pre-push-verify.mjs` 实际执行 `npm run verify:full` 并退出 0，340 条单测、覆盖率、沙盒、19 条浏览器 E2E 和构建通过；机器证据为 `.daoyan-agent/runs/pre-push-2026-09-23T04-15-44-680Z/full-gate-evidence.json`。当前树还经过后续同等门禁复核，正式接纳时以匹配的最新机器证据为准。

## 缺陷与后续复验

没有确认的产品缺陷。原 Agent 沙盒限制是执行环境问题，已通过独立宿主的实际复验闭环，不登记为产品 bug。

版本节点仍由 notice guard 根据报告和同树门禁证据推进；此报告不等同制作人候选体验或大版本发布。
