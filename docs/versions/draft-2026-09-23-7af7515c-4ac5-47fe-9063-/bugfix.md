# 属性驱动统一实体与资源守恒法术：缺陷独立复验

- 版本：`draft-2026-09-23-7af7515c-4ac5-47fe-9063-`
- 复验代码：`HEAD=9be8b5aa7656e0b252af7b7e008dc57c5c5c8725`；前次复验为 `46ab5ab1bfaf8b4dbe726060db774f4d59d07fc4`
- 结构化结果：[bugfix-reverification.json](./bugfix-reverification.json)
- 结论：`candidate-micro-mana` 的独立缺陷复验 **passed**；正式节点由 notice guard 对账，本报告不手工推进节点，也不代表候选体验或制作人验收通过。

## 问题、范围与验收

候选体验曾在法力不足的“对手减速”实战后显示“账目待核对”。原无头场景在 `0.016` 秒逐帧更新时出现 1 微单位收支差。此次只复验已修复的账本与其战斗集成，不修改产品实现、游戏测试或版本运行状态。验收要求是复现同一资源配置并确实触发余额不足反噬，逐帧核对法力微单位等式与世界能量账本，且受影响游戏源码、测试和配置保持在已修复修订。

精度修复实际来自 `f065d2cc940a12ec1482e2e608612caa74417029`：`src/core/ledger.ts` 将浮点投影误差范围内的微单位还原为整数后再按扣款方向取整，`test/combat.test.ts` 加入了 150 帧回归。任务策略所列 `707f812a51e4d36d70de2360e17076b85fee1f8b` 修改的是 `scripts/recover-candidate.ts`，并非产品修复。`git diff --quiet f065d2c -- src e2e test/combat.test.ts test/entity-vnext.test.ts test/review-regressions.test.ts package.json package-lock.json vite.config.ts electron` 退出 0；当前修订包含修复，相关产品与复验测试未漂移。

## 独立执行

在忽略的 `node_modules/.cache/` 中临时放置 TypeScript 进程内转译 loader 和无头场景脚本，不改变仓库产品代码。脚本读取 `src/game/spells.dy`，加入当前“对手减速”预设，创建 Battle，绑定鼠标槽位，将玩家法力上限设为 400、神识上限设为 80，敌人放在 120 距离并瞄准、按下槽位。随后以 `0.016` 秒推进 150 帧，每帧同时断言：

```text
opening + regen + externalIn + refunded
  = balance + paid + clampLoss + externalOut
manaAccountSnapshot.conserved = true
resourceLedger.snapshot().conserved = true
```

脚本还断言发生余额不足反噬，防止只测到成功施法路径。实际命令 `node --no-warnings --experimental-loader ./node_modules/.cache/daoyan-micro-mana-loader.mjs ./node_modules/.cache/daoyan-micro-mana-reverify.mjs` 退出 0。首次反噬在第 40 帧，总计 1 次；第 9 帧账户余额/累计付款为 `131272000/271800000` 微单位，第 40 帧为 `46775999/368200000`，第 150 帧为 `89015999/368200000`。全部帧的法力账户和世界能量账本均守恒。`npm run typecheck` 退出 0。

验收覆盖减速预设进入战斗、目标定位、槽位施放和失败结算；集成覆盖 Battle 与资源账本；回归覆盖原 `0.016` 秒高频更新及反噬后的 150 帧状态。四类套件的标记对应这些实际检查，并非宣称本轮运行了四个独立的标准测试命令。

标准 `npm test -- test/combat.test.ts test/entity-vnext.test.ts test/review-regressions.test.ts` 尝试退出 1：Vitest 在加载 `vite.config.ts` 时被宿主的 `esbuild spawn EPERM` 阻断，执行了零条测试。该失败保留为环境限制，不把它记成产品测试失败或成功。已有[同游戏源码 QA](./qa.md)记录 220 条定向测试与 20 条 Chromium 流程通过；任务给定的 `pre-push-2026-09-23T15-19-19-281Z/full-gate-evidence.json` 记录完整门禁退出 0。这些是回归背景，不是本轮独立命令。本轮没有浏览器候选交互或页面控制台的新观察；候选体验仍是后续阶段。

本轮只写阶段报告、当前状态和开发日志；没有编辑 `.daoyan-agent`，没有手工推进版本节点，也没有 commit、push、tag 或发布。

## 当前树再次独立复验（2026-09-24）

在 `HEAD=9be8b5aa7656e0b252af7b7e008dc57c5c5c8725` 的干净工作区重新核对缺陷。`git diff --quiet f065d2cc940a12ec1482e2e608612caa74417029 -- src e2e test/combat.test.ts test/entity-vnext.test.ts test/review-regressions.test.ts package.json package-lock.json vite.config.ts electron` 退出 0，受影响产品源码、测试及构建配置与账本修复修订相同。

重新执行上述进程内转译无头命令退出 0：150 帧均满足法力微单位等式、账户 `conserved=true` 与世界能量账本守恒，第 40 帧首次余额不足反噬且总计 1 次；第 9、40、150 帧余额和累计付款与上节记录一致。`npm run typecheck` 退出 0。标准 `npm test -- test/combat.test.ts test/entity-vnext.test.ts test/review-regressions.test.ts` 再次在加载 Vite 配置时因 `esbuild spawn EPERM` 退出 1，执行零条测试，因此不计作本轮标准测试通过。

缺陷 `candidate-micro-mana` 的当前树独立复验结论维持 **passed**；通过依据是实际执行的缺陷场景、逐帧账本断言及同源码差异核对。标准 Vitest 的宿主阻断和本轮未做候选页面交互仍分别保留为验证边界；既有 QA 与完整门禁仅作背景，不代替本轮执行。正式节点继续由 notice guard 对账。
