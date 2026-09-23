# Agent 调度配置

这里保存制作人工作流的机器可读合同：

- [`policy.json`](./policy.json)：秘书、执行者、审查者的模型与推理等级，升级次数、交付门禁和 Git 策略。
- [`plan.schema.json`](./plan.schema.json)：秘书输出的任务计划格式。
- [`review.schema.json`](./review.schema.json)：独立审查输出格式。

Feature PM 模型名称集中在 `policy.json`；常驻秘书的短时语义路由单独配置于 `secretary.json`。模型层级表达风险而不是人员身份：

| 层级       | 当前模型      | 典型工作                      |
| ---------- | ------------- | ----------------------------- |
| `economy`  | `gpt-6-luna`  | 检索、文档、机械修改          |
| `standard` | `gpt-6-sol`   | 常规 UI、功能与测试           |
| `advanced` | `gpt-6-sol`   | Core、DSL、VM、并发与困难调试 |
| `critical` | `gpt-6-astra` | ADR、不可逆架构与重大迁移     |

常规任务使用 Sol medium，高风险核心任务使用 Sol high；Astra 保留给不可逆决策与最高风险审查。Luna 承担高频低风险任务。审查故障时按 `recovery.reviewerFallbacks` 顺序尝试兼容路由；模型升级不改变已冻结版本的范围或验收门禁。

调度器不直接执行计划中生成的 shell 命令。所有任务最终使用仓库固定的 `npm run verify:full` 门禁，避免让模型输出成为命令注入入口。独立审查也按计划的最高风险选择模型，纯文档不会固定占用 Sol；审查输入由父进程生成为差异包，避免审查者重复扫描仓库和运行门禁。

秘书默认使用零-token 本地路由，根据方向中的文档、界面、核心和架构风险信号建立最小计划。模糊的“继续”会先解析为 `docs/status.md` 中的首个后续任务。只有显式使用 `--deep-plan` 时才调用 Luna low；该模型不可用时自动回退到本地规划。同一层级的线性任务会在本地合并，避免多个 Agent 重复读取相同上下文。

`policy.json` 的 `recovery` 定义临时故障重试次数、退避时间和审查备用路由。执行者在原模型重试后按风险层级升级，审查者和修复者则依次转交备用模型。每个阶段将工作区指纹写入 `recovery.json`；进程最终中断后，`npm run producer:resume -- "<运行目录>"` 在指纹一致时跳过已完成任务，并继续验证、审查、修复或推送。若 Agent 在首个任务中异常退出并留下改动，秘书会清空旧跳过记录，审查遗留现场后重新执行，不要求制作人手工接管。

`policy.json` 同时定义心跳频率及规划、执行、审查、修复和完整门禁的时间上限。运行中的阶段会写入 `.daoyan-agent/runs/<运行>/progress.json`，终端每个心跳周期也会确认进程仍在工作；超时退出码固定为 124，便于报告和后续诊断区分一般失败。

`policy.json` 的 `versionCycle` 定义一次开发批次最多包含的 Feature 数和 Feature 级自动恢复次数。`npm run producer:batch` 只编排多个现有 `producer` 运行，不代表正式版本，也不绕过任何 Feature 的独立审查、Git 交付和最终跨 Feature 门禁。

显式现场接管使用 `npm run producer -- --takeover "方向"`，或使用 `npm run producer:resume -- --takeover ".daoyan-agent/runs/<运行目录>"`。秘书会在运行目录保存 `takeover.json`，清空旧任务跳过记录并重新审查当前工作区；强制模式是制作人交给秘书处理遗留现场的入口，不是绕过验证或 Git 审查的快捷方式。
