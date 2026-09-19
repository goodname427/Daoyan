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

制作人只需要向常驻秘书描述产品方向或体验问题，不需要判断复杂度、拆分任务、选择模型或管理 Git。秘书跨版本维护现状、排期和简短通知，内部 Feature PM 负责实际交付。notice guard 空闲时不调用模型，只有新消息、任务进度、PM 退出或恢复时间到达时才唤醒。

启动常驻秘书并提交想法：

```bash
npm run secretary:start
npm run secretary -- "增加法术单步推演和变量观察"
npm run secretary:status
```

后续无论是提出方向、询问进度、回答秘书还是要求继续，都使用同一个自然语言入口。消息会自动启动尚未运行的 notice guard；制作人不需要使用底层 `producer*` 命令。

唯一工作范式和汇报节奏见 [`docs/agent-workflow.md`](./docs/agent-workflow.md)；Feature PM 的低频恢复与诊断入口见 [`docs/operations/feature-pm.md`](./docs/operations/feature-pm.md)。

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
