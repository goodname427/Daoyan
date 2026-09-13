# 道衍协作入口

本文件是 AI 与新协作者进入仓库时的第一入口。若说明冲突，优先级为：代码与测试事实 → 已采纳 ADR → 架构不变量 → 产品文档 → 当前状态 → 开发日志。

## 开工前

按顺序阅读：

1. [`docs/status.md`](./docs/status.md)：当前能力、近期目标和已知债务。
2. [`docs/workflow.md`](./docs/workflow.md)：需求、实现、验证、体验和交付流程。
3. 与任务相关的 [`docs/product/`](./docs/product/) 和 [`docs/architecture/`](./docs/architecture/)。
4. 相关 [`docs/adr/`](./docs/adr/)；需要追溯时再读最近的 [`docs/dev/`](./docs/dev/)。

## 不可破坏的约束

- `src/core/` 不依赖浏览器、渲染或 UI 框架，必须可在 Node 中无头运行。
- AST 是 DSL、蓝图、分析器、编译器和 VM 共享的唯一 IR。
- 神识表示状态成本，法力表示世界 I/O 成本，耗时表示执行成本。
- 默认禁止递归；列表容量参与静态预算；静态资源上界不得小于实测消耗。
- 玩家与妖兽使用同一个 Actor 和施法管线；核心层不反向依赖战斗表现层。
- 推演台负责法术编写与测试；演武场只负责属性、绑定与实战；两者共享同一份法术书。

完整解释见 [`docs/architecture/invariants.md`](./docs/architecture/invariants.md)。

## 每次改动

1. 先写清问题、范围、非目标和验收标准；较大功能使用 [`docs/specs/template.md`](./docs/specs/template.md)。
2. 难以撤销的架构决策先写 ADR；普通实现选择记录在规格或开发日志中。
3. 保持改动聚焦，不覆盖工作区中与任务无关的未提交内容。
4. 新行为必须有与风险相称的单元、集成或 E2E 覆盖。
5. 开发中运行 `npm run verify`；交付前运行 `npm run verify:full` 并实际体验受影响路径。
6. 同步长期文档和 `docs/status.md`；过程、结论与踩坑记入 `docs/dev/`。
7. Git 是 AI 的默认版本管理工具：达到完整验证、文档同步且可独立回滚的逻辑节点后，主动形成 Conventional Commit 并决定是否推送；由 AI 按版本节点决定是否打 tag。大版本发布必须由用户明确决定。

## 完成标准

只有满足 [`docs/workflow.md`](./docs/workflow.md) 中的 Definition of Done，才能称为完成。测试通过不等于体验完成，文档写过也不等于自动化已经执行。
