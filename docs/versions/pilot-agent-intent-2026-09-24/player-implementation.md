# 首批三行为玩家闭环交接（dev-player-a3）

## 问题、范围与验收

前驱已有 J1、D1、B1→B4 的真实 World/VM 合同，但玩家原先只能在旧推演沙盒和旧战斗原型之间往返，看不到同书程序的有限世界来源、付款、容量和作用余态。本任务把三术加入同一法术书，给推演台显示静态预算与规范 AST/hash，在演武场绑定后建立独立的有限世界现场，观察成功、拒绝和已提交事实，再返书改写并使旧现场报价失效。

本轮不改变核心合同，不把旧战斗的固定寿命、自动回蓝或固定伤害解释成新规则，不创建敌方修士新行为。有限场景使用真实 `World`、`VM`、`compileProgram` 和逐体程序安装；场景每次重新建账，绑定仅指定程序，不赠与来源或授权。界面显示的是该有限场景的结果，不是正在运行的旧波次战斗的效果。

## 实现边界

- `src/game/firstBatch.ts` 为 J1、D1 建立具名势能、能量容器、热汇、锚、独立付款方、逐读与作用 grant、执行体容量和会话；编译所选同书法术并由 `VM.run` 执行。成功要求作用事实和全序 POST 原读同时成立。
- `src/game/firstBatchB4.ts` 在同一 `World` 中先提交 B1 自然首撞的 C→N→X 与材料变化，再注册 B4 审计、容量和作用计划，运行同书规范程序。容量未知与实满在准入前安全拒绝；同 lot 竞争、撤读权、无源和 POST 失证各保留已经提交的自然、付款、作用事实。域外关键回路修复请求在游戏入口预检拒绝，未进入 VM。
- 鼠标、键盘、手柄、妖兽 AI、实体事件、敌方修士只作为请求来源标签接入同一有限场景函数；妖兽和敌方修士使用自己的 Actor、来源、付款方和 grant。`test/first-batch-player.test.ts` 固定相同世界输入验证结果等价及公开结果裁剪。这里没有新增硬件手柄输入或敌方 AI 行为。
- `src/app/LabView.tsx` 加入三术、预算和 hash；普通沙盒明确指出缺少有限世界证书。`src/app/CombatView.tsx` 在绑定槽旁提供有限场景观察，按作用事实与全链证据分别呈现余态；改绑定或返书会清除旧观察结果，`src/app/App.tsx` 保留返书选择。旧 `Battle` 的槽触发若遇这三术，会拒绝在缺证旧场景中运行。
- `src/app/persistence.ts` 对 v0/v1 同名有限法术存档给出行号及缺失合同信息，保留原存储槽；安全旧法术仍走现有迁移。加入新有限术前也先检查原书 DSL/蓝图迁移与同名冲突，无法证明时保留原文。旧活动队列、grant、余额和增益运行态不凭存档补造。

## 真实测量与余态

| 场景          | 原读与本人付款                       | 安装峰 | 已提交结果                                                |
| ------------- | ------------------------------------ | ------ | --------------------------------------------------------- |
| J1 有源杆推   | 15 笔；32 M，VM 187 tick             | 38 S   | 一次作用，冲量 1；P0/P2 独立付款不进入本人余额视图        |
| D1 有源起步   | 14 笔；26 M，VM 174 tick             | 37 S   | 一次作用，冲量 1                                          |
| B1→B4         | B4 19 笔；44 M，VM 302 tick          | 559 S  | B1 自然壳 3→2、碎片 0→1；B4 壳 2→3、废料 0→1              |
| B4 后获准空读 | B4 后第 20 笔；本人额外 2 M、21 tick | 不重装 | `World.vmB4Read` 直接扫描给出空结果收据；不产生第二次修壳 |

静态预算取当前所选程序的分析值，仅作为静态上界；安装容量取本体同版证书的真实登记结果。界面只显示执行者本人实付与余额、已获准原读数、规范 hash、可公开的自然/作用摘要，不公开其他付款方余额、隐藏目标或私有 grant 字段。旧战斗的目标下拉框也只列出当前由 `World.senseQuote` 允许读取位置的敌人；无权或越距时不暴露目标编号。获准空读与无权或未知有不同的收据和文案。POST 失证时壳修作用仍显示已提交，同时全链标为未证成。

## 可复核玩家体验

Chromium 候选路径见 `e2e/candidate.spec.ts` 的 `candidate-first-batch-same-book`，与 `e2e/smoke.spec.ts` 的双主视图烟测同跑。实际操作及观察：

1. 清空浏览器本地存档，推演台依次加入 J1、D1、B4；选 J1 读取规范 hash 和静态预算。
2. 切换演武场，在槽位绑定 J1：有源场景出现 15 笔读及本人 32 M；无源场景无作用。换绑 D1：有源场景 14 笔读。
3. 换绑 B4：B1 首撞后修壳场景有 19 笔读，壳 3、废料 1；获准空读本人合计 46 M，并显示空结果收据。同 lot 竞争无作用；POST 失证显示作用已提交而全链未证成；容量未知、FIFO 实满与域外请求分别显示未准入或未付款；再撞显示第二条自然接触。
4. 返回推演台，把 J1 最后一读从 `14` 改为 `13`：规范 hash 改变；再次进入演武场旧观察收据消失。此修改刻意破坏原读序，定向游戏测试确认不能把旧成功报价沿用。窄屏 390×780 下加入入口可见，无横向溢出，浏览器没有新增控制台错误。

本轮在当前工作树重跑了 Chromium 同书路径并启用 Playwright trace：`test-results/candidate-candidate-first-batch-same-book-chromium/trace.zip`。trace 可逐步查看浏览器操作、页面快照和断言；`playwright-report/index.html`、`test-results/.last-run.json` 是同次单路径的报告与结果。另一次三路径运行验证了同书、窄屏和双主视图，共 3 条通过。上述为真实浏览器中的自动化玩家操作；尚未完成独立策划黑盒体验和活动战斗实体证书验收。

定向入口：

```powershell
node --no-warnings --experimental-transform-types --loader $pilotLoader src/demo/firstBatchSmoke.ts
npx vitest run test/first-batch-player.test.ts test/combat.test.ts test/render.test.tsx test/persistence.test.ts
npm run test:e2e -- e2e/candidate.spec.ts e2e/smoke.spec.ts -g 'candidate-first-batch-same-book|candidate-narrow|uses two main views and an embedded blueprint mode'
```

第一条的 `$pilotLoader` 是前驱留下的仓库外临时 TypeScript loader URI；不应把该 loader 当作产品依赖。完整实测命令、结果与产物路径见 `tasks/development-dev-player-a3.json`。Feature PM 负责在汇总最终代码树运行统一门禁、同步全局状态并完成版本后续验收。

## 兼容状态与待集成边界

旧 `Battle` 仍运行旧法术原型；有限世界观察是演武场内的独立真实 World，不修改活动波次的旧 `Battle.world`。键鼠或手柄在旧 canvas 上触发这三术会得到缺证拒绝，尚无从活动战斗实体、目标和环境采集有限世界证书的桥。当前同刻竞争只覆盖材料 lot；容量三分判覆盖未知与实满，再撞只记录第二次自然事实并提示旧报价撤证重读，尚未执行第二次 B4 重报价。授权空读在 B4 VM 成功后使用同一 World 的直接读入口，额外 tick 不计入首次 `VM.run` 返回值。域外请求是入口裁剪而非核心内的通用域证明。以上均不得宣传为活动战斗中的三行为或通用自然世界已经可玩；若候选要求这些路径，应先补齐权威合同和战斗实体证书，再做集成验收。
