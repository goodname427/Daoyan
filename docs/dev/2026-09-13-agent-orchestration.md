# 制作人工作流与异构模型调度

## 背景

制作人指出，判断任务复杂度本身就是复杂工程工作。正确组织方式应是制作人只告诉秘书方向，由秘书负责拆分、承接、开发、测试和汇报。

## 实现

- 在 `AGENTS.md` 固化制作人、秘书和最终责任人的边界。
- 新增机器可读模型策略与规划/审查 JSON Schema。
- 新增 `producer` CLI：只读规划、依赖排序、模型路由、顺序执行、失败升级、完整门禁、独立审查、自动修复、提交和推送。
- 开始完整执行前拒绝脏工作区；所有本地计划和日志写入被 Git 忽略的运行目录。
- 调度器只运行固定门禁，不执行模型计划中的任意 shell 命令。
- 添加纯本地路由单测和制作人使用文档。

首次真实 `producer:plan` 虽成功输出计划，但 Terra medium 为一个文档方向读取了大量仓库内容并消耗 32,360 tokens，同时拆成三个相同层级的线性任务。改用 Luna low、压缩上下文且禁止工具后仍消耗 19,477 tokens，证明“先调用模型决定调用哪个模型”本身不经济。最终默认改为零-token 本地风险路由，只在显式 `--deep-plan` 时调用 Luna；同时增加跨 Core/UI 自动拆分、同层任务压缩、单次失败升级上限和每阶段 token 记录。

## 取舍

第一版不并行编辑。并行 worktree 会增加合并、状态所有权和测试协调成本，在积累实际任务数据前不值得用复杂度换速度。模型路由集中在 JSON 策略中，以便未来替换模型而不改变工作流合同。

## 验证

- `npm run typecheck`
- `npx vitest run test/agent-routing.test.ts`
- `npm run producer -- --help`
- `npm run producer:plan -- "整理道衍制作人工作流的使用说明，不修改产品代码"`
- `npm run verify:full`

最终验证结果：

- 零-token 文档方向路由到 Luna；Core 与推演台混合方向拆为 Sol → Terra。
- “发布大版本”在执行前以退出码 2 进入制作人决策状态。
- 脏工作区保护在调用模型前中止完整执行。
- `npm run verify:full` 通过：41 个 Vitest 测试、9 个 Playwright E2E、覆盖率、沙盒和生产构建全部成功。

## Windows CLI 修复

首次由普通 PowerShell 运行完整入口时，PATH 只暴露 npm 的无扩展名 `codex` shim 和 `codex.cmd`，调度器错误选择前者并以 `ENOENT` 中止。现在 Windows 解析顺序为 `.exe`、`.cmd`、`.bat`、其他；npm shim 不再直接 spawn，而是由当前 Node 执行对应的 Codex 或 npm JavaScript 入口。回归测试覆盖“只有无扩展名 shim 与 cmd shim”的终端环境。
