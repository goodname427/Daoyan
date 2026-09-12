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

## 测试分层（阶段七，E2E 门禁）

- **单元** `npm test`：VM / 分析器 / 编译器 / 战斗逻辑 + jsdom 渲染冒烟（`test/render.test.tsx`，`// @vitest-environment jsdom`）
- **E2E** `npm run test:e2e`：Playwright + chromium，自动拉起 vite（端口 5180，与 5173 隔离）
  - `e2e/helpers.ts` 的 `captureErrors` 抓 `pageerror` + 真错误级 `console.error`
    （跳过 React dev act 警告噪声），正是 jsdom 抓不到的真实浏览器路径
  - 覆盖：三页签加载/切换无未捕获异常、推演台推演出结果、蓝图编辑编译、演武场按键施法
- **门禁**：`verify`（pre-commit，快，单元）→ `verify:full`（开发完成/推送前/CI，含 E2E）
- CI（`.github/workflows/ci.yml`）push 时跑 `verify:full` 等价链路（含 `playwright install`）
- ESLint ignores 必须包含 `playwright-report/**` `test-results/**`（.gitignore 不影响 eslint）

## 环境限制（Windows 本机）

- Electron 打包必须 `signAndEditExecutable: false`，
  否则 winCodeSign 解压需创建符号链接会失败
- npm 的 install scripts 被 allow-scripts 拦截，但 esbuild / electron / playwright 浏览器实际可用
- `import.meta.glob` 只在 Vite 环境可用；tsx 跑无头沙盒时是 undefined，
  `src/core/metas/index.ts` 有显式兜底清单 —— 新增元法术文件需同步补一行
- **git 代理坑**：全局 git 代理 `socks5://127.0.0.1:7890` 已失效（端口无监听），
  直连 GitHub 会被 reset。实际可用的是 **7897** 端口（HTTP 混合代理）。
  推送命令：`git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push`
  （不修改全局 git config，每次临时覆盖）
- Playwright 浏览器下载需代理：`HTTPS_PROXY=http://127.0.0.1:7897 npx playwright install chromium`
- 远程：`origin = https://github.com/goodname427/Daoyan.git`，分支 `master`，已设 upstream

## 重要原则（用户反复强调）

- **只有元法术（基础术式，`src/core/metas/*.ts`）能定义消耗数值**（mana/ticks 是唯一出处）
- 自定义法术的消耗 = 它调用的元法术消耗叠加；法术体里不出现任何消耗数字
- 元法术的消耗未来可按输入参数动态计算（当前固定值）
- 主角与妖兽同构（同一 Actor + AttributeSet），区别只在数值与绑定的法术

## 按键状态系统（阶段五）

- `SpellMeta.keys: string[]` 声明虚拟按键；DSL `@keys=蓄力,辅助` / `@key=蓄力`
- `KeyState`（held / heldTime / 粘性 pressEdge / 粘性 releaseEdge）
- 按键类元法术：`按键按住/按下/松开/蓄力(索引)` + `结束施法()`
- 粘性边沿：发生一次保持 true 直到被读取清除，避免 duration 周期轮询漏掉松开
- 松开时保留 heldTime（不清零），让法术能在松开后轮询读到蓄力时长
- 多按键结构已支持，但 keys[0] 才接到触发槽位；多键绑定 UI 是下一步

## 节点编辑器与序列化（阶段六，roadmap 1.3）

- `serializeSpell`/`serializeBook`（`src/core/dsl.ts`）：AST→DSL 文本，也是秘籍分享码的落地
  - 注解顺序必须与解析器一致：`spell 名 @注解 (参数) -> 返回 { 体 }`，注解紧跟名字、在 `()` 之前
- `src/app/NodeEditor.tsx`：蓝图编辑器（图→AST→DSL→编译/分析），第三页签「蓝图编辑」
  - 节点：入口/调用(施法)/调用(取值)/常量/变量引用/声明/赋值/若/遍历/返回
  - 端口按类型着色，连线即数据流/控制流；类型不匹配拒绝连接
  - `if/for` 的体通过 `body` 端口 → 体首语句 → 沿 flow-out 链
  - 编译复用 analyzeBook + compileProgram，生成的 DSL 自动重新解析验证一致性
- React Flow v12：`Node<T>` 要求 T 有索引签名，故用非泛型 `Node` + `data as unknown as Nd` 访问
- 只读视图 `NodeGraph.tsx`（AST→图）与编辑器 `NodeEditor.tsx`（图→AST）互补共存

## 阶段四新增的关键结构（产品化）

- `src/core/metas/*.ts`：元法术按文件拆分，`import.meta.glob` 自动收录；
  外部扩展：Electron 主进程扫描 `metas/*.js`，渲染进程动态 import（`globalThis.DAOYAN` 注入 API）
- `src/core/spellMeta.ts`：法术生命周期 `instant / duration / channel`，
  DSL 用 `@kind=duration @period=1 @duration=6 @cooldown=12` 注解
- `src/core/attributes.ts`：`AttributeSet` + `Modifier`（加法/乘法、可限时，先加后乘）。
  属性同时影响效果与消耗（power×伤害 / manaCostMul×法力 / castSpeed×tick预算 / perception×感知半径 / armor 减伤）
- `src/game/sprites.ts`：程序化生成精灵图（无外部美术），动画状态机 idle/run/cast/hurt/death
- `src/game/audio.ts`：WebAudio 程序化音效
- `src/game/fx.ts`：粒子
- `src/app/renderer.ts`：消费 `world.fx` 事件 → 音效 + 粒子；核心层不反向依赖渲染
- `src/app/NodeGraph.tsx`：React Flow 蓝图视图，目前只读（AST→图），反向编辑是下一迭代
