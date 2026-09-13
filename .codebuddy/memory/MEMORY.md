# 道衍长期记忆索引

本文件帮助新会话快速恢复上下文，不复制完整产品或架构文档。发生冲突时，按 [`../../AGENTS.md`](../../AGENTS.md) 规定的优先级处理。

## 必读顺序

1. [`../../AGENTS.md`](../../AGENTS.md)
2. [`../../docs/status.md`](../../docs/status.md)
3. [`../../docs/workflow.md`](../../docs/workflow.md)
4. 与任务相关的 [`../../docs/product/`](../../docs/product/) 和 [`../../docs/architecture/`](../../docs/architecture/)
5. 涉及法术、元法术或实体时阅读 [`../../docs/reference/`](../../docs/reference/README.md)
6. 相关 ADR、提案、功能规格和最近开发日志

## 项目定位

道衍是修仙编程 Roguelike。玩家编写法术程序，用有限的神识、法力与施法时间换取能力，并在推演台和演武场之间反复验证。完整定义见 [`../../docs/product/vision.md`](../../docs/product/vision.md) 与 [`../../docs/product/core-loop.md`](../../docs/product/core-loop.md)。

## 长期约束

- `src/core/` 必须保持无头、UI 无关。
- AST 是 DSL、蓝图、分析、编译和 VM 的唯一 IR。
- 神识是状态成本，法力是世界 I/O 成本，耗时是执行成本。
- 自定义法术的成本来自其调用的元法术；列表容量参与静态预算。
- 默认禁止递归，静态上界必须不小于实测消耗。
- 玩家和妖兽同构，核心层不依赖表现层。
- 推演台负责编写与测试；演武场只负责属性、绑定和实战；两者共享法术书。
- 不同槽位可以并发施法；各 VM 独立推进，但实时共享 Actor 的法力与神识账户。

详细规则和修改程序见 [`../../docs/architecture/invariants.md`](../../docs/architecture/invariants.md)。

## 协作与验证

- 开发中：`npm run verify`
- 交付、推送和 CI：`npm run verify:full`
- 实质性功能先明确目标、非目标、用户流程和验收标准；跨模块功能使用 [`../../docs/specs/template.md`](../../docs/specs/template.md)。
- 不可逆架构决策先写 ADR；过程和踩坑写开发日志；当前事实更新 `docs/status.md`。

## 环境注意事项

- Node.js 20，版本见 `.nvmrc`。
- Electron Windows 打包保留 `signAndEditExecutable: false`，除非签名环境已经明确准备好。
- `import.meta.glob` 只在 Vite 环境可用；元法术加载必须保留 Node 兜底路径。
- 不修改全局 Git 代理。当前环境若需要访问 GitHub，可临时使用 `http://127.0.0.1:7897`，但应先确认代理可用。
- React Flow 节点数据使用非泛型 `Node` 加显式收窄，避免 v12 泛型索引签名问题。
- 用户不直接参与日常开发；Git 提交、推送和 tag 由 AI 在逻辑版本完成并验证后自行管理，只有大版本发布需要用户决定。
- 用户是项目制作人，只提供方向与体验反馈；主 Agent 必须作为秘书自动判断复杂度、拆分、选择模型、验证和汇报，不得把工程管理转交给用户。可使用 `npm run producer` 调用仓库级异构模型调度器，细节见 `docs/agent-workflow.md`。

## 当前状态

不要在这里维护功能清单。以 [`../../docs/status.md`](../../docs/status.md) 为唯一当前状态入口，以 [`../../docs/roadmap.md`](../../docs/roadmap.md) 为中期方向。

元法术分类、动态消耗、统一实体和移除冷却目前只是 [`../../docs/proposals/meta-spell-and-entity-model-vnext.md`](../../docs/proposals/meta-spell-and-entity-model-vnext.md) 中的讨论稿，不得当作已实现规则。
