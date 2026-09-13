# 测试策略

## 分层

| 层级       | 命令               | 主要职责                                                      |
| ---------- | ------------------ | ------------------------------------------------------------- |
| 单元与集成 | `npm test`         | 核心语义、资源上界、编译、VM、战斗状态和 jsdom 渲染。         |
| 覆盖率     | `npm run coverage` | `src/core/` 的语句、分支、函数和行覆盖率门槛。                |
| 沙盒       | `npm run sandbox`  | 用固定场景验证资源模型的代表性结果。                          |
| E2E        | `npm run test:e2e` | 真实浏览器加载、主要工作流、Canvas、React Flow 和未捕获错误。 |
| 构建       | `npm run build`    | 确认生产构建可生成。                                          |

## 门禁

- `npm run verify`：开发与提交前的快速门禁，包含类型、lint、格式、文档和单元测试。
- `npm run verify:full`：推送、交付和 CI 门禁，在快速门禁基础上增加覆盖率、沙盒、E2E 和生产构建。
- `npm run verify:ci`：CI 对完整门禁的稳定别名，必须与 `verify:full` 等价。

## 新改动如何选测试

- 纯函数或核心规则：单元测试，包含失败边界。
- 跨模块状态或战斗行为：集成测试。
- 用户可见流程、浏览器 API、Canvas 或 React Flow：E2E。
- 布局变化：至少检查目标桌面视口和一个窄屏断点；稳定页面再加入视觉快照。

## 体验验收

自动测试之后仍需启动应用，按功能规格中的路径实际操作。交付说明必须写明体验的视口、路径和结果；不能只写“测试通过”。

## Agent 调度器

- `test/agent-routing.test.ts` 无模型调用地验证策略、依赖排序、循环拒绝、升级和提交信息。
- `npm run producer -- --help` 验证本地命令入口。
- `npm run producer:doctor` 在不调用模型的情况下验证 Windows Codex/npm shim 与真实子进程入口。
- `npm run producer:plan -- "方向"` 是零-token、只读集成冒烟；增加 `--deep-plan` 才会真实调用配置中的规划模型并校验 JSON Schema。
- 完整调度仍必须通过固定的 `verify:full`，计划中的文本验证建议不会被当作 shell 命令直接执行。
