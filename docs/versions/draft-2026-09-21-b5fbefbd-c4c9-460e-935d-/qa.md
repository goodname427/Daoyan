# 统一实体创建、控制与属性模型：独立版本 QA

- 版本：`draft-2026-09-21-b5fbefbd-c4c9-460e-935d-`
- 日期：2026-09-23
- 候选代码修订：`598788d8663c30b71dcc416c128dbf6f2c12a4c2`；测试开始前工作区干净
- 结论：**failed**。已执行的核心断言通过，但标准 Vitest、浏览器主线和生产构建被测试宿主的 `spawn EPERM` 阻断；实际应用体验与打包结果没有证据，不能进入候选验收。机器清单见 [qa.json](./qa.json)。

## 范围与验收

本阶段独立检验当前正式版本的统一创建、三参数属性控制、能力拒绝、旧 DSL/存档迁移、双资源定价、无限维持停止，以及推演台和演武场主线。使用冻结的版本策划、ADR 0017 和 `entity-model-integration` 工作项作为标准。不修改产品实现、测试文件、运行状态或版本节点，也不重复 Feature PM 的 `verify:full`。

## 实际结果

| 套件 | 证据                                                                                                                                                       | 结果                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 验收 | 无配置、进程内 TypeScript 转换的 Vitest 运行现有 `entity-vnext`、`dsl-migration` 和 `core` 断言；独立 Node 场景检验公开入口、迁移、VM 拒绝、定价和法力耗尽 | 已运行断言通过；标准命令启动失败            |
| 集成 | 同一 Vitest 运行 `combat`、`persistence`、`render`，覆盖 VM/Battle、存档和 jsdom 界面                                                                      | 已运行断言通过；浏览器集成未执行            |
| 回归 | 上述 6 文件共 **110 条通过**；`npm run typecheck` 通过                                                                                                     | Playwright 主线与生产构建未执行，回归不完整 |

`node C:\Users\30595\AppData\Local\Temp\daoyan-version-vitest-20260923.cjs test/entity-vnext.test.ts test/dsl-migration.test.ts test/core.test.ts test/combat.test.ts test/persistence.test.ts test/render.test.tsx` 退出 0。临时运行器使用 `startVitest`、`configFile: false`、`esbuild: false` 和 `typescript.transpileModule`，保留原测试断言；它不能代表仓库标准 Vite 配置或 Playwright。`node C:\Users\30595\AppData\Local\Temp\daoyan-version-qa-20260923.cjs` 退出 0，五个独立无头场景通过。临时运行器位于系统临时目录，报告保留了运行方式和结果，不把它当作可复用的正式门禁产物。

标准命令的原始结论：

- `npm test -- test/entity-vnext.test.ts test/dsl-migration.test.ts test/core.test.ts test/combat.test.ts test/persistence.test.ts test/render.test.tsx`：退出 1；加载 `vite.config.ts` 时 `esbuild spawn EPERM`，**0 条断言执行**。
- `npm run test:e2e -- e2e/smoke.spec.ts`：退出 1；`spawn EPERM`，**未打开浏览器**。
- `npm run build`：退出 1；加载 `vite.config.ts` 时 `esbuild spawn EPERM`，**没有构建产物**。
- `npm run typecheck`：退出 0。`node scripts/check-docs.mjs`：退出 0。

## 缺陷与后续复验

本次已执行的断言没有确认产品行为缺陷，结构化缺陷清单为空。`spawn EPERM` 属于当前测试宿主的执行限制，记录在失败命令与覆盖缺口中，不作为版本缺陷。QA 仍为 **failed**，因为标准测试、浏览器主线、实际体验和构建尚未完成。

须在允许启动 Vite/esbuild 和 Playwright 的阶段环境中重跑上述失败命令，实际操作推演台创建/控制、演武场无限维持和停止、旧存档导入及页签往返，并核验生产构建。若出现产品缺陷，应沿同一正式版本登记和修复后复验。本报告只给出测试结论，不手工推进阶段。
