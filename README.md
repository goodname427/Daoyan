# 道衍

道衍是一款修仙编程 Roguelike。玩家通过 DSL 或蓝图编写法术，用有限的神识、法力与施法时间组合感知、运算和行动，再到实战中验证自己的程序。

当前处于 **0.2 可玩原型持续迭代阶段**。

## 核心循环

```text
推演台编写法术
→ 查看静态消耗并单次测试
→ 演武场设置属性与法术绑定
→ 开始或暂停实战观察效果
→ 返回推演台继续修改
```

- 推演台负责自定义法术的新建、删除、DSL/蓝图编辑、元法术查看和推演。
- 演武场只负责基础属性、法术绑定和实战，不提供编辑能力。
- 两个场景共享同一份法术书，演武配置在本次会话的页签往返中保留。

完整定义见 [`docs/product/core-loop.md`](./docs/product/core-loop.md)。

第一次编写法术请从 [`docs/reference/spell-authoring.md`](./docs/reference/spell-authoring.md) 开始；全部元法术签名和当前价格见 [`docs/reference/meta-spells.md`](./docs/reference/meta-spells.md)。

## 快速开始

需要 Node.js 20。

```bash
npm ci
npm start
```

桌面窗口与打包：

```bash
npm run desktop
npm run dist
```

演武场操作：WASD/方向键移动，鼠标控制准星，左键或数字键施放绑定法术，`P` 暂停或继续。

## 开发验证

```bash
npm run verify       # 类型、lint、格式、文档和单元测试
npm run verify:full  # 再加覆盖率、沙盒、E2E 和生产构建
```

首次克隆后运行 `npm run hooks` 启用仓库内 Git hooks。完整协作方式见 [`CONTRIBUTING.md`](./CONTRIBUTING.md) 和 [`docs/workflow.md`](./docs/workflow.md)。

## 制作人工作流

制作人只需要在 Codex 主任务中描述产品方向或体验问题，不需要判断复杂度、拆分任务或选择模型。主 Agent 默认作为秘书，负责分派、实现、验证、Git 和最终汇报。

只预览自动拆分结果：

```bash
npm run producer:plan -- "增加法术单步推演和变量观察"
```

完整的仓库级自动交付入口：

```bash
npm run producer -- "增加法术单步推演和变量观察"
```

详细职责、自动升级和恢复方式见 [`docs/agent-workflow.md`](./docs/agent-workflow.md)。

## 架构

```text
DSL ─┐
     ├→ AST（唯一 IR）→ 静态分析器
蓝图 ┘              └→ 编译器 → VM → World → 战斗表现
```

- `src/core/`：无头核心，不依赖浏览器与 UI。
- `src/game/`：战斗运行时、默认法术、表现资源与扩展加载。
- `src/app/`：推演台、演武场、编辑器和渲染。
- `test/`：单元与集成测试。
- `e2e/`：真实浏览器产品工作流。

架构总览见 [`docs/architecture/overview.md`](./docs/architecture/overview.md)，核心规则见 [`docs/architecture/invariants.md`](./docs/architecture/invariants.md)，关键取舍见 [`docs/adr/`](./docs/adr/)。

## 项目状态

当前能力、近期目标和已知债务统一维护在 [`docs/status.md`](./docs/status.md)。中期方向见 [`docs/roadmap.md`](./docs/roadmap.md)。
