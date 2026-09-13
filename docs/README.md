# 文档入口

文档按“当前事实、长期规则、过程记录”分层。不要用开发日志替代当前状态，也不要在多个文件复制同一份规则。

## 首次阅读

1. [`../AGENTS.md`](../AGENTS.md)：协作入口与不可破坏的约束。
2. [`status.md`](./status.md)：当前能力、近期目标和已知债务。
3. [`product/vision.md`](./product/vision.md) 与 [`product/core-loop.md`](./product/core-loop.md)：产品方向和体验循环。
4. [`reference/spell-authoring.md`](./reference/spell-authoring.md)：从零编写和调试一个法术。
5. [`reference/meta-spells.md`](./reference/meta-spells.md)：由代码生成的全部元法术签名与价格。
6. [`reference/entities-and-attributes.md`](./reference/entities-and-attributes.md)：当前实体、弹道和属性模型。
7. [`architecture/overview.md`](./architecture/overview.md) 与 [`architecture/invariants.md`](./architecture/invariants.md)：模块边界和核心不变量。
8. [`workflow.md`](./workflow.md) 与 [`testing.md`](./testing.md)：开发和验证方式。

## 文档职责

| 位置                                  | 职责                               | 更新时机         |
| ------------------------------------- | ---------------------------------- | ---------------- |
| [`status.md`](./status.md)            | 当前能力、进行中、下一步、债务     | 每个实质迭代结束 |
| [`product/`](./product/)              | 产品愿景、核心循环、术语和稳定规则 | 产品规则变化     |
| [`reference/`](./reference/README.md) | 玩家可用语法、元法术和当前数据模型 | 对应实现变化     |
| [`proposals/`](./proposals/README.md) | 尚未采纳的方向、选项和开放问题     | 讨论与决策期间   |
| [`architecture/`](./architecture/)    | 架构总览、边界和不变量             | 架构演进         |
| [`adr/`](./adr/)                      | 难以撤销决策的背景、选择和后果     | 决策实施前       |
| [`specs/`](./specs/)                  | 较大功能的目标、非目标和验收标准   | 开发前到验收后   |
| [`dev/`](./dev/)                      | 实施过程、验证结果和踩坑           | 开发过程中       |
| [`testing.md`](./testing.md)          | 测试分层与门禁                     | 测试策略变化     |
| [`roadmap.md`](./roadmap.md)          | 中期方向，不承担当前任务追踪       | 方向调整         |
| [`../CHANGELOG.md`](../CHANGELOG.md)  | 已交付的玩家可见版本变化           | 发布时自动生成   |

运行 `npm run docs:generate` 从代码更新元法术参考；运行 `npm run docs:check` 检查生成结果、必需文档、相对链接和版本一致性。
