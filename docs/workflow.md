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

测试分三层，各自挡不同类别的 bug：

| 层   | 命令                  | 覆盖                                             | 速度      |
| ---- | --------------------- | ------------------------------------------------ | --------- |
| 单元 | `npm test`            | VM / 分析器 / 编译器 / 战斗逻辑 / jsdom 渲染冒烟 | 快（~1s） |
| E2E  | `npm run test:e2e`    | 真浏览器加载页面、切页签、推演、编译、按键施法   | 中（~6s） |
| 全量 | `npm run verify:full` | 单元 + E2E + 类型 + lint + 格式                  | ~15s      |

常用：

```bash
npm run verify        # 类型 + lint + 格式 + 单元（pre-commit 跑这个，快）
npm run verify:full   # 上面 + E2E（开发完成 / 推送前跑这个）
npm run test:e2e      # 只跑 E2E（自动拉起 vite）
npm run sandbox       # 无头沙盒：打印资源消耗对比表
```

**关键**：E2E 用 `pageerror` + `console.error` 抓「页面未捕获异常」，
正是 jsdom 抓不到的 React Flow 测量 / Canvas / 真实布局路径——
这类 bug（页面加载即崩）会被 E2E 挡下，不会再漏到你这。

- `git commit` 时 `pre-commit` 钩子自动跑 `verify`（快）
- 推送前 / CI 跑 `verify:full`（含 E2E）

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
