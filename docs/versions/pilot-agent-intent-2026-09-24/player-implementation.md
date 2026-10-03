# 首批三行为玩家闭环交接（dev-player-a3）

## 问题、范围与验收

前驱已有 J1、D1、B1→B4 的真实 World/VM 合同，但玩家原先只能在旧推演沙盒和旧战斗原型之间往返，看不到同书程序的有限世界来源、付款、容量和作用余态。本任务把三术加入同一法术书，给推演台显示静态预算与规范 AST/hash，在演武场绑定后建立独立的有限世界现场，观察成功、拒绝和已提交事实，再返书改写并使旧现场报价失效。

本轮不改变核心合同，不把旧战斗的固定寿命、自动回蓝或固定伤害解释成新规则，不创建敌方修士新行为。有限场景使用真实 `World`、`VM`、`compileProgram` 和逐体程序安装；场景每次重新建账，绑定仅指定程序，不赠与来源或授权。界面显示的是该有限场景的结果，不是正在运行的旧波次战斗的效果。

## 实现边界

- `src/game/finiteProgram.ts` 从所选入口遍历全部同书调用及嵌套语句，按可达依赖闭包编译规范 AST/hash；未调用的其他法术不计入本术程序页。静态预算仍由完整法术书分析，包含被调用辅助术的成本。推演台身份展示与两个演武场入口使用同一闭包编译，避免合法辅助调用在渲染或执行时缺少被调用者。
- `src/game/firstBatch.ts` 为 J1、D1 建立具名势能、能量容器、热汇、锚、独立付款方、逐读与作用 grant、执行体容量和会话；由 `VM.run` 执行同书依赖闭包。成功要求作用事实和全序 POST 原读同时成立。
- `src/game/firstBatchB4.ts` 在同一 `World` 中先提交 B1 自然首撞的 C→N→X 与材料变化，再注册 B4 审计、容量和作用计划，运行同书规范程序。容量未知与实满在准入前安全拒绝；同 lot 竞争、撤读权、无源和 POST 失证各保留已经提交的自然、付款、作用事实。域外关键回路修复请求在游戏入口预检拒绝，未进入 VM。
- 再撞先提交第二条真实自然接触并撤销首撞报价。获准容量分支通过 `World.senseQuote` 和正价实扣后重新读取本人 `shenshiUsed/shenshiMax`，与已安装程序、同版身体及桥接层登记的一位本体 FIFO 在途意图共同判定 `sufficient` 或 `queueFull`；未获准读取判 `capacityUnknown`。`queueFull` 场景先把同一已提交接触上的独立前序意图实际放入桥接层本体 FIFO，再判后封。这里的 FIFO 是游戏桥接层管理的响应位，不是 World 的全局事件队列；核心目前不提供读取动态本体 FIFO 占用的接口。三种分支都缺少新 B4 审计和报价，因此不执行第二次修壳 VM，也不把首次成功延续到再撞。
- 鼠标、键盘、手柄、妖兽 AI、实体事件、敌方修士只作为请求来源标签接入同一有限场景函数；妖兽和敌方修士使用自己的 Actor、来源、付款方和 grant。`test/first-batch-player.test.ts` 固定相同世界输入验证结果等价及公开结果裁剪。这里没有新增硬件手柄输入或敌方 AI 行为。
- `src/app/LabView.tsx` 加入三术、预算和 hash；普通沙盒明确指出缺少有限世界证书。`src/app/CombatView.tsx` 在绑定槽旁提供有限场景观察，按作用事实与全链证据分别呈现余态；改绑定或返书会清除旧观察结果，`src/app/App.tsx` 保留返书选择。旧 `Battle` 的槽触发若遇这三术，会拒绝在缺证旧场景中运行。
- `src/app/persistence.ts` 对 v0/v1 同名有限法术存档给出行号及缺失合同信息，保留原存储槽；安全旧法术仍走现有迁移。加入新有限术前也先检查原书 DSL/蓝图迁移与同名冲突，无法证明时保留原文。旧活动队列、grant、余额和增益运行态不凭存档补造。

## 真实测量与余态

| 场景            | 原读与本人付款                       | 安装峰 | 已提交结果                                                                           |
| --------------- | ------------------------------------ | ------ | ------------------------------------------------------------------------------------ |
| J1 有源杆推     | 15 笔；32 M，VM 187 tick             | 38 S   | 一次作用，冲量 1；P0/P2 独立付款不进入本人余额视图                                   |
| D1 有源起步     | 14 笔；26 M，VM 174 tick             | 37 S   | 一次作用，冲量 1                                                                     |
| B1→B4           | B4 19 笔；44 M，VM 302 tick          | 559 S  | B1 自然壳 3→2、碎片 0→1；B4 壳 2→3、废料 0→1                                         |
| B4 后获准空读   | B4 后第 20 笔；本人额外 2 M、21 tick | 不重装 | `World.vmB4Read` 直接扫描给出空结果收据；不产生第二次修壳                            |
| B4 再撞容量新读 | 本人 2 笔；额外 4 M，合计 48 M       | 不重装 | 新神识占用和总量获准实读；空 FIFO 足额或一位 FIFO 被前序意图占满，均不产生第二次修壳 |

静态预算取当前所选程序的分析值，仅作为静态上界；安装容量取本体同版证书的真实登记结果。界面只显示执行者本人实付与余额、已获准原读数、规范 hash、可公开的自然/作用摘要，不公开其他付款方余额、隐藏目标或私有 grant 字段。旧战斗的目标下拉框也只列出当前由 `World.senseQuote` 允许读取位置的敌人；无权或越距时不暴露目标编号。获准空读与无权或未知有不同的收据和文案。POST 失证时壳修作用仍显示已提交，同时全链标为未证成。

## 可复核玩家体验

### 最新结论：采纳制作人一次性授权的真实补证

2026-10-02，本任务执行 Agent 按制作人本轮明确授权采纳主 Agent 的一次性页面操作，不再沿用“主 Agent 不代验”的旧拒收理由。本次仅核对证据，不重新运行实现、94 项定向断言或整套体验。结论是：**本轮定向验证与推演台—演武场—返书实玩证据已补齐；正式版本、活动 Battle 接入及独立策划/QA 尚未据此验收。** Git 交付由 Feature PM 处理，本执行会话没有提交或推送。

证据包：[说明](../../../.daoyan-agent/runs/secretary-formal-pilot-agent-intent-2026-09-24-13-development-9/main-one-time-play-evidence/README.md)、[41 条公开浏览器调用](../../../.daoyan-agent/runs/secretary-formal-pilot-agent-intent-2026-09-24-13-development-9/main-one-time-play-evidence/browser-calls.json)、[来源与指纹](../../../.daoyan-agent/runs/secretary-formal-pilot-agent-intent-2026-09-24-13-development-9/main-one-time-play-evidence/provenance.json)、[服务器与代码树记录](../../../.daoyan-agent/runs/secretary-formal-pilot-agent-intent-2026-09-24-13-development-9/main-one-time-play-evidence/server-and-tree-records.json)。原公开会话 `01a0ced9-bb00-78b3-ace8-5ed06a81d612` 在 05:49–05:54 UTC 操作 `http://localhost:5173/` 的仓库 Vite 页面，产品基线 `85c8cf4`。当前 HEAD `105189d5c92de327fe48e26bfb7152f362f4bade` 对该基线的 `src/`、`electron/`、`scripts/desktop.mjs`、`vite.config.ts` 和 lockfile 无差异；package.json 只改统一门禁去重，未改启动、依赖或本任务定向脚本。五份测试 SHA256 仍匹配既有记录。两张截图的实文件 SHA256 与调用元数据相符，均已目视核对。服务器原命令 `npm run desktop` 虽报告 Vite 就绪，最终退出码仍为 **1**；它是页面来源记录，不是成功检查或完整门禁。

下表编号为 `browser-calls.json` 的 1 起始数组序号；精确 callId、时间、参数及返回值保留在任务 JSON 的 `oneTimePlayAdoption`。41 条记录包含环境枚举、文档查询和读取，不能写成“41 项测试通过”。

| 真实操作                                   | 实际观察                                                                                                                                                                                                         | 证据编号     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 推演台加入三术，进入演武场绑定槽 1/2/3     | J1、D1、B4 分别沿用同书 hash；界面明确静态预算是上界、有限观察独立于旧波次，绑定不赠来源或授权                                                                                                                   | 3–10、14、19 |
| J1 成功、无源、撤读权                      | 成功 15 笔/32 M/187 tick/安装 38 S/作用 1；两反例 1 笔/9 M/24 tick/作用 0，分别提示无源和读权撤销                                                                                                                | 11–13        |
| D1 成功、无源、撤读权                      | 成功 14 笔/26 M/174 tick/安装 37 S/作用 1；两反例 1 笔/1 M/12 tick/作用 0                                                                                                                                        | 16–18        |
| B1 首撞后 B4 修壳                          | 自然壳 2、碎片 1 先提交；B4 19 笔/44 M/余 6 M/302 tick/安装 559 S，壳 3、废料 1，全链证据齐                                                                                                                      | 20、35       |
| B4 获准空读、无源、竞争、POST 失证、撤读权 | 空读额外 2 M/21 tick、总 20 笔、作用仍 1；无源 4 笔/6 M/作用 0；竞争 3 笔/4 M/作用 0；POST 失证 16 笔/39 M/作用 1、全链未证成；撤权 0 M/0 笔/作用 0，保留自然事实                                                | 21–25        |
| 容量未知、FIFO 实满、域外                  | 依次显示 capacityUnknown、queueFull、域外拒绝；VM 未准入，本人 0 M，未把隐藏容量显示成已知值                                                                                                                     | 26–28        |
| 再撞三分判                                 | 三支均自然接触 2、首修作用保留、旧报价及读覆盖撤证、第二 VM 未执行、未获准壳值未知；未知新读 0/新付 0 M；足额与实满新读 2/新付 4 M，总付 48 M，分别 sufficient/queueFull                                         | 29–31        |
| 窄屏和控制台                               | 390×844；文档/body 宽 390、观察区域 clientWidth/scrollWidth 均 328，未观察到水平溢出；两张截图显示纵向滚动区域与可达场景按钮；error/warn 查询 limit 25 返回空数组                                                | 33–35        |
| 返回原书 B4 重复首读一次                   | hash `a18acdcb5522dcbdd53fcd1f4f84243d305b6a835306342506ec3b2a19e07f1a` → `0613fc3d8e2415272f6baac5672e0081d414552ce1da9b24cb10bd713cd8ae81`，预算 53 M/451 tick → 55 M/473 tick；页面显示旧报价撤销、需重新实测 | 36–37        |

截图：[再撞 FIFO 实满](../../../.daoyan-agent/runs/secretary-formal-pilot-agent-intent-2026-09-24-13-development-9/main-one-time-play-evidence/call_t1CS5NdXzYPDH1JomJXipZhC-1.jpg)、[首撞后修壳](../../../.daoyan-agent/runs/secretary-formal-pilot-agent-intent-2026-09-24-13-development-9/main-one-time-play-evidence/call_753tZlynG7yxWgnYx7DFtCW6-1.jpg)。控制台结论只覆盖第 34 条查询时段与参数；未测 390×780，也不声明所有尺寸或后续运行均无错误。公开有限结果只显示执行者本人账及获准摘要；私有余额、目标/grant 字段裁剪的等价合同仍依据已匹配的定向测试，不以截图替代自动化覆盖。

**合同内判断与未证明事项。** 当前任务要求的实玩链止于返书改写产生新身份并撤旧报价；第 36–37 条已有真实操作，旧观察结果清除另由既有 React DOM 往返断言及界面卸载/重挂逻辑证明。因此本轮不要求重复整套页面路径。返书后再次执行和两层辅助术改写只保留既有自动化通过事实，未写成浏览器实玩；它们没有在本轮合同中新增独立实玩交付要求。活动 Battle 实体证书及硬件手柄也没有实际体验证明，活动旧画布缺证拒绝与意图来源等价测试继续有效，不把独立有限 World 宣称为活动波次的新玩法。这些记录边界不构成本任务新的候选范围或复审门槛；后续独立策划/QA 仍须按各自职责体验。

第 38–40 条填回 B4 原文后预算回到 53 M/451 tick，但完整源码字符串不相同、hash 为 `3b6c38e22314cbba88b2d31b1108ebbc10c7aed9993b1fd88f175d0dfb6f4040`。静态代码显示 `SpellEditor` 会 `serializeBook` 重写整书，AST 的 call 节点带全书行号，`canonicalSpellBook` 保留该字段；仅看到局部缩进不足以认定 hash 差异的唯一原因或证明语义等价。这次不修改核心身份合同，也不声称恢复旧 hash、恢复旧报价或完成规范化等价验证。当前合同要求改写后新身份及撤旧报价，没有要求编辑后恢复原文必回原 hash；已观测差异采取保守失效，未发现它把旧授权或报价授给新程序。此限制作为后续核对线索保留。

### 历史续接记录（阻断已由上述一次性补证更新）

### 2026-10-02 定向续接：实玩仍受阻

后续续接（当前 HEAD `e33c5e9f689847c43fbc0beaf36c629f20590a5a`）：核对本轮指定的 `player-a3-validation-gpt-6.1-sol-attempt-1.md`，对上一续接 HEAD 的定向比较退出 0，任务合同、AGENTS、工作流及游戏输入/配置无变化，两份测试草稿 SHA256 与 `resumedValidation.reuse.fingerprints` 相同。没有重跑既有通过项。本轮标准启动同命令仍退出 1（`esbuild spawn EPERM`）；CUA 枚举仍报告请求头策略加载失败，重试 Edge 初始化成功但没有取得游戏页面。上一轮本机 URL 的明确拒绝没有已恢复证据，本轮未重发被拒导航、未启动临时构建服务，也未改换浏览器入口。新增检查与失败事实见任务 JSON 的 `continuationValidation`；实玩、窄屏、控制台及本地提交仍未完成。Git 暂存失败沿用上一轮记录，本轮没有再次尝试暂存或提交。

本次执行 Agent 核对指定的 implementation/validation attempt-1 交付索引及任务合同，只补当前缺口。当前 HEAD 为 `b235cee9123bb50993566cd58706b62d0416d60c`；对 `85c8cf4` 的定向 Git 比较确认 `src/core`、`src/game`、`src/app`、`src/demo`、战斗/持久化/首批测试以及 Vite/Vitest/Playwright 配置未变化。`test/render.test.tsx` 与 `e2e/candidate.spec.ts` 的未提交差异就是上轮保留的往返断言，本轮未改动测试或产品代码。94 项定向断言、类型检查及 World/VM 冒烟沿用上轮记录，没有重跑，也不记为本轮新通过。

覆盖依据为当前代码：`test/first-batch-player.test.ts` 验证 J1/D1 成功、无源与撤读权、各意图来源等价、本人账与私有字段裁剪，以及 B1→B4 的自然事实、空读、竞争、POST 失证和准入拒绝；`test/combat.test.ts` 验证旧 Battle 缺证拒绝及再撞三分判；`test/persistence.test.ts` 验证等价迁移、定位拒绝、保原存档与不恢复活动会话；`test/render.test.tsx` 验证同书预算/hash 与返书撤旧收据。上述是既有自动化覆盖，不是本轮真实玩家操作。

本轮实际启动命令 `npm run dev -- --host 127.0.0.1 --port 5180 --strictPort` 退出码 **1**，Vite 配置加载时 `esbuild spawn EPERM`。随后仅启动前轮已经存在的临时静态体验服务器 `node (Join-Path $env:TEMP 'daoyan-a3-server.mjs')`；服务报告监听成功，未重新构建，也不据此确认产物与当前树完全一致。CUA 初次环境枚举报告请求头策略加载失败；重试 Edge 初始化成功，但 `cua.createBrowserTab('1', 'http://127.0.0.1:5180/', {sessionName: '🔎 首批往返验收'})` 被浏览器安全策略拒绝，明确原因为用户拒绝此 URL 的访问许可，并禁止换入口、间接执行或其他绕过。停止临时服务时进程退出码为 **1**（主动 Ctrl+C，非测试失败）。没有进行页面点击或改写，没有新截图/trace，没有窄屏或控制台检查；不宣称临时页面已经实玩。

本任务保留 **blocked / completed=false**。需要运行环境负责人恢复标准启动与已授权本机页面的浏览器访问后，由本任务执行 Agent 续接 J1、D1、B1→B4 成功/失败、返书改写、390×780 和控制台证据；不能由主 Agent 诊断或既有 DOM 回放代签。活动 Battle 缺实体证书的已知边界仍保留。本轮只写两份合同内证据文档，原有两份测试草稿保留；精确尝试、退出码、复用依据和文件指纹见任务 JSON 的 `resumedValidation`。

Chromium 候选路径见 `e2e/candidate.spec.ts` 的 `candidate-first-batch-same-book`、`candidate-first-batch-helper-edit`，以及 `e2e/smoke.spec.ts` 的双主视图烟测。下列保留此前的可复跑步骤与自动化断言；当时尚无浏览器实玩记录，最新真实覆盖以上述补证表为准：

1. 清空浏览器本地存档，推演台依次加入 J1、D1、B4；选 J1 读取规范 hash 和静态预算。
2. 切换演武场，在槽位绑定 J1：有源场景出现 15 笔读及本人 32 M；无源场景无作用。换绑 D1：有源场景 14 笔读。
3. 换绑 B4：B1 首撞后修壳场景有 19 笔读，壳 3、废料 1；获准空读本人合计 46 M，并显示空结果收据。同 lot 竞争无作用；POST 失证显示作用已提交而全链未证成；容量未知、FIFO 实满与域外请求分别显示未准入或未付款。再撞显示第二条自然接触，首次修壳和 44 M 已付保留；旧成功覆盖与报价撤销。选择未获准容量读得到 `capacityUnknown`，新读 0、本人仍付 44 M；选择容量足额或 FIFO 实满得到新神识容量读 2 笔、额外本人实付 4 M，分别为 `sufficient` 和 `queueFull`。三支都没有新 B4 读集和第二 VM，当前壳值显示未知。
4. 返回推演台，把 J1 最后一读从 `14` 改为 `13`：规范 hash 改变；再次进入演武场旧观察收据消失。重新执行取得 14 笔原读，作用事实已提交，但读序或 POST 证据不全，界面标为全链未证成且旧报价不继承。另以同书两层辅助术作为输入：J1、D1、B4 经真实 World/VM 成功；改写最深层辅助术后，三个可达程序的 hash 更新。界面及浏览器断言要求显示新预算和身份，J1 返书改写辅助术后清除旧收据，再运行取得新收据。窄屏 390×780 和控制台检查仍待当前树浏览器复跑。

2026-10-01 对实现提交 `85c8cf4` 的直接复核：`npm run typecheck`、真实 World/VM 冒烟通过；四个受影响 Vitest 文件在仓库外的进程内 TypeScript 转换入口运行，94 项断言通过，其中 `test/render.test.tsx` 的 18 项 React DOM 交互通过。标准 Vitest 命令在配置加载时遇到 `esbuild spawn EPERM`。当前源码的临时 Vite 构建已在仓库外成功生成并由本机 HTTP 服务提供，但 Microsoft Edge 计算机控制未获批准；转用 CUA 浏览器被自动审批以绕过已拒绝授权为由明确拒绝，故没有执行浏览器点击或取得当前树实玩 trace。旧 `playwright-report/index.html` 存在，旧 trace 与 `test-results/.last-run.json` 在本工作区不存在；任何旧报告都不能证明当前树。独立策划黑盒体验、浏览器候选路径和活动战斗实体证书仍待后续验收。

本轮在当前未提交工作树扩充并运行 `test/render.test.tsx` 的同书 DOM 往返。测试挂载真实 `App`，逐个点击推演台、演武场和返书控件；首批场景调用现有 `World/VM`，没有替换核心成功。记录的页面文本依次为：J1 有源 15 笔原读、本人 32 M，无源作用未提交；D1 有源 14 笔、本人 26 M；B1→B4 修壳 19 笔、普通壳 3/废料 1，获准空读有空结果收据，POST 失证全链未证成；再撞的未获准读、容量足额和 FIFO 实满分别为 `capacityUnknown`、`sufficient`、`queueFull`，后两支各有本人容量新读 2 笔、已付 4 M。返书把 J1 最后一读 `14→13` 后 hash 改变，旧 B4 收据消失；重新绑定执行 J1 显示 14 笔原读、作用已提交、全链未证成、旧报价不继承。该回放验证了 React 界面和真实有限 World/VM 的组合行为，不能代替浏览器视觉、窄屏或控制台实玩。浏览器候选断言已补上改写后的余态；`npx playwright test e2e/candidate.spec.ts e2e/smoke.spec.ts --list` 只确认两个文件的 24 条测试可发现，没有启动浏览器或执行断言。

本轮为补当前树实玩再次执行候选 Chromium 命令，命令在启动子进程时以 `spawn EPERM` 退出。随后以仓库外进程内 TypeScript 转换入口重新打包当前源码，Vite 247 个模块转换成功，临时页面在 `%TEMP%/daoyan-a3-current-build/index.html`，本地服务仅监听 `127.0.0.1:5180`。IAB 浏览器不可用；Edge 浏览器安全策略明确返回用户拒绝访问该本机 URL，并禁止换浏览器入口绕过，因此已停止服务，没有进行页面点击、390×780 窄屏检查、控制台观察或保存当前树 trace。这仍是未完成的体验证据，不视为代码缺陷或浏览器通过；等待明确授权后才可继续。

定向入口：

```powershell
node --no-warnings --experimental-transform-types --loader $pilotLoader src/demo/firstBatchSmoke.ts
npx vitest run test/first-batch-player.test.ts test/combat.test.ts test/render.test.tsx test/persistence.test.ts
npm run test:e2e -- e2e/candidate.spec.ts -g 'candidate-first-batch-same-book|candidate-first-batch-helper-edit'
```

第一条的 `$pilotLoader` 是前驱留下的仓库外临时 TypeScript loader URI；不应把该 loader 当作产品依赖。本轮已通过的 Vitest 命令使用仓库外 `$env:TEMP/daoyan-a3-inprocess-test.mjs` 调用 `startVitest`，不等于上列标准 Vitest 命令通过。完整实际命令、退出码与证据路径见 `tasks/development-dev-player-a3.json`。Feature PM 负责在汇总最终代码树运行统一门禁、同步全局状态并完成版本后续验收。

快速门禁退回的 `npm run test` 唯一报告失败是 `test/secretary-dashboard.test.ts` 的候选反馈路由用例 20 秒超时。该用例启动独立秘书进程，直接依赖 `test/helpers/secretary-guard.ts` 与工作流控制面脚本；已检查的直接导入未引用本任务四个改动文件，修正测试超时或秘书进程不属于本任务 writePaths。本机定向重跑命令在测试体前因 `esbuild spawn EPERM` 退出，尚不能确认调度器环境中的超时是否稳定复现。附带的 `.gitignore`、`docs/versions/pilot/review.md` 换行提示不属于测试断言失败，也不在本任务写入范围；交由控制面负责人在原运行中处理。

## 兼容状态与待集成边界

旧 `Battle` 仍运行旧法术原型；有限世界观察是演武场内的独立真实 World，不修改活动波次的旧 `Battle.world`。键鼠或手柄在旧 canvas 上触发这三术会得到缺证拒绝，尚无从活动战斗实体、目标和环境采集有限世界证书的桥。当前同刻竞争只覆盖材料 lot；再撞容量三分判覆盖足额、桥接 FIFO 实满与未获准新读的未知。再撞根据第二条已提交自然事实撤销首次读集与成功覆盖；只有新接触后获准且已付款的本体占用读及同版桥接队列实占才可报足额或实满，不借旧 FIFO 证报满，也不冒报当前壳值。第二次 B4 付费修补不在首批范围，未执行新的 B4 审计或报价。核心 World 尚无动态本体 FIFO 占用读取接口，此处实满由桥接层本体队列负责；活动战斗接入前仍需权威实体证书。授权空读在 B4 VM 成功后使用同一 World 的直接读入口，额外 tick 不计入首次 `VM.run` 返回值。域外请求是入口裁剪而非核心内的通用域证明。以上均不得宣传为活动战斗中的三行为或通用自然世界已经可玩；若候选要求这些路径，应先补齐权威合同和战斗实体证书，再做集成验收。
