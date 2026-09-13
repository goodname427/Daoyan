# Agent 调度配置

这里保存制作人工作流的机器可读合同：

- [`policy.json`](./policy.json)：秘书、执行者、审查者的模型与推理等级，升级次数、交付门禁和 Git 策略。
- [`plan.schema.json`](./plan.schema.json)：秘书输出的任务计划格式。
- [`review.schema.json`](./review.schema.json)：独立审查输出格式。

模型名称集中在 `policy.json`，Codex 可用模型变化时只修改这一处。模型层级表达风险而不是人员身份：

| 层级       | 当前模型        | 典型工作                      |
| ---------- | --------------- | ----------------------------- |
| `economy`  | `gpt-5.6-luna`  | 检索、文档、机械修改          |
| `standard` | `gpt-5.6-terra` | 常规 UI、功能与测试           |
| `advanced` | `gpt-5.6-sol`   | Core、DSL、VM、并发与困难调试 |
| `critical` | `gpt-6-astra`   | ADR、不可逆架构与重大迁移     |

调度器不直接执行计划中生成的 shell 命令。所有任务最终使用仓库固定的 `npm run verify:full` 门禁，避免让模型输出成为命令注入入口。独立审查也按计划的最高风险选择模型，纯文档不会固定占用 Sol。

秘书默认使用零-token 本地路由，根据方向中的文档、界面、核心和架构风险信号建立最小计划。只有显式使用 `--deep-plan` 时才调用 Luna low，并只向它提供本地生成的压缩项目摘要。同一层级的线性任务会在本地合并，避免多个 Agent 重复读取相同上下文。执行失败最多自动升级一次，随后保留报告并停止。
