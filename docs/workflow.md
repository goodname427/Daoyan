# 协作工作流

一次改动的完整闭环，五步。每一步都有对应的命令，不需要口头交代。

```
① 提想法  →  ② 实现  →  ③ 验证  →  ④ 体验  →  ⑤ 反馈
   你/我       我        自动        你         你
```

---

## ① 提想法

你描述想要什么（或我提出方案）。

- 涉及架构取舍的，先产出一份 ADR 到 `docs/adr/`，你确认后再动手
- 不涉及的直接开工

## ② 实现

我在工作区改代码。约定：

- **核心逻辑必须可无头运行**（`src/core/` 不依赖浏览器 / 不依赖 UI 框架）
- 每个新能力都要有对应单测，放在 `test/`
- 数值平衡相关内容集中放，便于整体调参

## ③ 验证（自动，我必须跑通才能交付）

```bash
npm run verify     # = typecheck + lint + format:check + test
```

单项：

```bash
npm run typecheck  # 类型
npm run lint       # 静态检查
npm run coverage   # 覆盖率（core 有阈值门禁）
npm run sandbox    # 无头沙盒：打印资源消耗对比表
```

- `git commit` 时 `pre-commit` 钩子会自动跑一遍 `verify`，跑不过不让提交
- CI（`.github/workflows/ci.yml`）在推送时再跑一遍

## ④ 体验（你）

```bash
npm start          # 一键启动，自动打开浏览器
npm run desktop    # 启动桌面窗口（需要 electron）
```

看到新版本后直接反馈。想打包成 exe 分享给别人：

```bash
npm run dist       # 产物在 release/
```

## ⑤ 反馈

你给意见，回到 ①。

---

## 留痕

| 类型     | 位置                             | 时机                       |
| -------- | -------------------------------- | -------------------------- |
| 架构决策 | `docs/adr/NNNN-*.md`             | 做出不可逆选择时           |
| 开发日志 | `docs/dev/YYYY-MM-DD.md`         | 每次完成实质性工作后       |
| 代码变更 | git 提交（Conventional Commits） | 每个逻辑单元               |
| 版本变更 | `CHANGELOG.md`                   | `npm run release` 自动生成 |

### 提交信息规范

```
<type>(<scope>): <subject>

type: feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert
scope: core | vm | compiler | analyzer | dsl | app | electron | docs | ci
```

示例：

```
feat(core): 新增识海常驻变量
fix(vm): 修正 for 循环的栈残留
docs(adr): 记录桌面打包方案决策
```

`commit-msg` 钩子会校验格式。

### 分支

- `main` —— 始终可运行、可打包
- `feat/xxx`、`fix/xxx` —— 短期分支，合并后删除

当前规模小，日常可直接在 `main` 上提交；一旦开始并行开发再切分支。

---

## 常用命令速查

```bash
npm start          # 一键体验
npm run verify     # 一键验证
npm run dist       # 打包 exe
npm run format     # 统一格式
npm run release -- patch --dry   # 预览下个版本的 CHANGELOG
npm run hooks      # 启用 git 钩子（克隆仓库后执行一次）
```
