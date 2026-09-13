# 架构总览

```text
DSL 编辑器 ─┐
            ├→ Spell AST → 静态分析器
蓝图编辑器 ─┘           ├→ 编译器 → 字节码 → VM → World
                        └→ DSL 序列化

App 共享状态 → 推演台
             └→ 演武场 → BattleRuntime → Canvas / 音频 / 粒子
```

## 模块职责

- `src/core/`：类型、AST、元法术、分析、编译、VM 与世界；不依赖 UI。
- `src/game/`：默认法术、战斗运行时、表现资源与外部元法术加载。
- `src/app/`：React 工作区、编辑器、HUD、Canvas 渲染和用户交互。
- `test/`：核心逻辑、战斗逻辑和 jsdom 渲染测试。
- `e2e/`：真实浏览器中的产品工作流与错误捕获。

## 状态所有权

- 应用层拥有共享法术源码和演武配置。
- 推演台负责产生有效法术源码；演武场只消费源码。
- DSL 与蓝图都经由 AST、分析器和编译器验证，不建立第二套执行语义。

## 当前世界模型

- 玩家与妖兽统一为 `Actor`；Actor 与 Projectile 共用同一、不复用的 `entity` 句柄空间。
- 统一句柄不等于统一属性全集。Actor 和 Projectile 保持不同结构，操作通过 Identity、Transform、Vitality、Caster、Movement、Projectile 与 Modifiers 能力判定。
- Projectile 可由 DSL 创建为未激活对象，再由所有者配置、激活和探查；旧 `发射` 保留为兼容入口。
- 句柄、能力、属性和实际资源公式详见 [`../reference/entities-and-attributes.md`](../reference/entities-and-attributes.md)。

重要取舍见 [`../adr/`](../adr/)，不可破坏的规则见 [`invariants.md`](./invariants.md)。
