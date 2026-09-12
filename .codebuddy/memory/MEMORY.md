# 道衍 · 长期记忆

## 项目定位

Noita-like 修仙编程 roguelike。玩家自由编写功法/法术，
用**有限资源**约束创造力，鼓励更优雅的实现（像快排优于插排）。

## 核心设计（不可违背）

- **三资源模型**：神识 = 持有状态的成本（内存）；法力 = 与外界交互的成本（I/O）；
  耗时 = 执行步数（时间）
- **关键规则**：神识内运算几乎不要法力；读写世界的操作收高额法力
  → 自然涌现「批量 I/O vs 逐个 I/O」的权衡
- **默认禁止递归**（DAG），保证消耗可静态精确分析；后期「轮回术」解锁递归 + fuel
- **AST 是唯一真相且可 JSON 序列化** → DSL 与未来节点图产出同一份结构；AST 即秘籍分享码
- **列表定容**，静态上界按容量算、实测按真实长度算，差距刻意保留为可优化空间
- **静态上界必须 >= 实测**（有单测守卫），否则玩家不信任消耗面板

## 架构约定

- `src/core/` 严禁依赖浏览器 API 或 UI 框架，必须能在 Node 下无头运行与测试
- 分析器在 AST 上做（不在字节码上）
- 战斗层通过 `world.onDamage` 钩子扩展，核心层不反向依赖战斗层
- 元函数定价表 `src/core/builtins.ts` 是全局平衡核心，改价要谨慎

## 协作工作流（用户指定）

提想法 → 我实现 → `npm run verify` → `npm start` / `npm run dist` → 用户反馈。

- `npm start` = `vite --open`（一键体验，浏览器）
- `npm run verify` = typecheck + lint + format:check + test
- `npm run sandbox` = 无头 CLI 沙盒
- `npm run dist` = 打包 exe（electron-builder）
- 提交规范：Conventional Commits；`.githooks` 自动跑 verify
- 决策记 `docs/adr/`，过程记 `docs/dev/YYYY-MM-DD.md`

## 环境限制（Windows 本机）

- Electron 打包必须 `signAndEditExecutable: false`，
  否则 winCodeSign 解压需创建符号链接会失败
- npm 的 install scripts 被 allow-scripts 拦截，但 esbuild / electron 二进制实际可用
