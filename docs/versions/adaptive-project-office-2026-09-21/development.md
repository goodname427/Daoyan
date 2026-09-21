# 自适应项目中枢版本：开发执行结论

- 所属版本：`adaptive-project-office-2026-09-21`
- 阶段：开发执行（`development`）
- 执行策略：完整执行
- 策略依据：`legacy-unknown`
- 日期：2026-09-21
- 结构化清单：[development.json](./development.json)

## 公开结论

任务拆分中的八项工作均已完成实现和直接验证。正式版本状态信封继续使用 v1；新增证据、候选关闭关系和执行统计均为可选兼容扩展，旧记录缺字段时保守迁移，显式损坏时停止写入和派发。本阶段没有直接编辑 `.daoyan-agent`、没有手工推进版本节点，也没有 commit、push、tag 或发布。

Task、Feature、Version 现在分别拥有可验证证据：Task 只登记执行 Agent 实际报告的直接检查命令和退出码，计划 `acceptanceCommands` 不再被推定为成功，`verify`、`verify:full`、E2E 与 build 也不会投影为 Task 事实；Feature PM 汇总后运行快速门禁、按未关闭 finding 在同一进程迭代，并为最终树保存唯一成功的完整门禁证据；Version QA 以接纳时实时计算的 Git tree、代码修订、完整门禁命令和配置指纹匹配 Feature 证据，且命令明细必须确实含有成功 `npm run verify:full`，再负责版本级集成、回归、迁移、打包和候选验证。恢复按 Task 输出、命令、配置和依赖图保留有效完成项，不再因整个工作区指纹变化清空进度。

notice guard 会把首次快照前的短窗口公开为 `bootstrapping`，分别观察 PM、dispatcher 与 worker；附着监听和主 `launch()` 子进程 close 路径都携带实际退出进程的 PID/identity，先等待原子终态落盘并重新读取，再与快照中的当前 PM 身份及存活状态核对。tsx/dispatcher 包装进程退出而当前 PM 仍存活时保持 `tracking`，不进入 `retry-wait`。普通类型、测试、格式和审查 finding 留在原 PM 闭环；只有无进展重复、外部阻塞、进程异常或持久证据损坏才进入恢复。公开事件构造拒绝缺失轮次或 `unknown` 修订，模型调用、门禁命令、制作人/额度等待、恢复和空闲状态边界分别写入实测耗时；真实启动、异常恢复、局部修复轮次独立投影，交付终态清除旧阻塞摘要。

快速门禁复核发现，无 `.git` 元数据的隔离守卫夹具会在写第一条公开事件时错误退出。公开事件现在优先使用 Git 修订；仅当运行副本没有仓库元数据时，使用 `package.json` 与 `scripts/` 内容生成确定性 `source-<sha256>` 修订，源码变化会生成不同标识。正式版本阶段交付仍调用严格 Git 修订读取，源码快照不能替代版本交付门禁。

后续快速门禁复核确认，`agent-dispatcher-recovery` 是会复制真实脚本、初始化 Git 并启动 `tsx` dispatcher 的进程集成测试，但此前外层仍沿用 Vitest 默认 5 秒预算，短于该测试已经声明的 20 秒子进程上限。该用例现在显式使用 30 秒外层预算，子进程仍在 20 秒时强制失败；正常 Windows fixture 开销不会被误报为恢复缺陷，真正挂起仍有确定边界。

秘书状态 normalizer 通过稳定 `itemResolutions` 反向闭合候选：手机 Sites/手机优先项目中枢候选标记为 `superseded`，理由为移动入口已由钉钉替代；桌面项目中枢工作台增强标记为 `delivered`，关联交付记录与提交 `fddcdcb`。取消、替代、合并和交付都能沿稳定关系闭合原候选，`merged` 为明确终态。排期事实和问答先过滤终态、按稳定关系去重；主动更正通知带持久 correlation ID，发送后立即原子保存 `correctionSentAt`，不再依赖后续对账产生其他变化。该迁移只在正常原子状态保存路径发生，不手改生产状态。

交付前审查指出五处“合同已声明但生产链路未消费”的缺口，本轮已收口：dispatcher 用计划中最高有效 Profile 选择实际步骤，`light` 只保留直接检查，`task/feature` 进入 Feature 三段门禁，`version` 只运行版本任务和报告复核；轻量与 Version 阶段推送不会由 pre-push 反向补跑 Feature 完整门禁。notice guard 接纳开发报告时把每个正式工作项及唯一完整门禁写入 Task/Feature `validationEvidence`，接纳 QA 或缺陷复验时先校验并传入复用证据的 Git tree、代码修订、命令和配置指纹，再写 Version 证据。两条历史候选的一次性迁移改为绑定现有稳定 ID，未来同主题候选保留原状态。pre-push 与 dispatcher 都把已删除受控文件记为 `[deleted]`。快速门禁失败从解析出的失败 npm 子命令继续，独立审查修复前保存文件边界，后续只生成未关闭 finding 的 before/after 增量输入。

最终审查的四项增量也已闭环：worker 退出后会再次读取运行快照并单独复核 PM 身份，存活 PM 继续保持 `tracking`，进程引用重新绑定到 PM，不会进入 `retry-wait`；多条排期更正每成功发布一条就立即原子保存，后续发布失败或进程重启只重试未发送部分；Task 恢复证据把建议路径保存为输入指纹，把实际 `changedFiles` 保存为输出指纹，路径外直接依赖变化会使该 Task 及下游失效；公开修订无法读取时的中文错误文本已有精确断言，防止编码乱码回归。

本次交付前证据复审的三项高优先级问题已闭环：主启动 child 的退出身份会传入对账，不能再以 `source='pm'` 无条件结束快照中的存活 PM；QA 与缺陷复验的生产接线改为使用当前候选树、当前验证配置和固定完整门禁命令指纹查找证据；开发清单逐项新增 `commands`，接纳时直接登记实际退出码并拒绝 Task scope 中的 Feature/Version 门禁命令。结构化清单仍逐项保留八个实际工作项，没有用聚合结论代替。

最新独立审查的三个阻断问题也已闭环。Feature 门禁、notice guard 实时匹配和 pre-push 现在共享同一验证树范围：代码、测试和验证配置保持受控，正式流程后写入的 QA、复验与候选报告不参与指纹，因此开发证据不会被自身阶段产物阻断，任何实现或测试变化仍会失效。Task 运行完成时会从建议路径和实际改动文件解析相对模块引用，把路径外未修改的直接依赖作为 `inputPaths` 持久化；选择性恢复按该清单重算输入指纹，依赖变化会失效当前 Task 及下游，而无关路径仍可复用。排期事实先沿 `secretary:<id>` 解析关系根；普通入口创建、没有源自引用的 backlog 与指向它的 active/tracking 后继现在只计活动事实一次。

本次交付前审查的三项工作流缺陷已闭环。dispatcher 在恢复点新增快速门禁和独立审查阶段进度，二者都绑定候选验证树和配置指纹；若运行在完整门禁成功后异常退出，匹配证据会直接跳过快速门禁、独立审查和完整门禁，不再清空已通过审查。快速门禁从 `package.json` 的 `verify` 链解析子命令，中段失败时持久保存已完成项和从失败点开始的待执行队列；失败命令修复通过后仍继续 format、docs、test 等原先未执行项。排期事实没有显式 `secretary:<id>` 边时使用事项自身 ID，两个同文案或同一规范化前缀的独立事项分别计数；只有显式关系图可以合并。

最新四项审查问题已经闭环。候选验证树不再笼统排除 `docs/versions/**`，而是只排除开发门禁后生成的七类 Markdown/JSON 报告；`charter`、版本/模块规划、设计审核和 `task-breakdown` 等输入变化会使旧 Feature、Version QA 与 pre-push 证据失效。`development.json` 的工作项可任意排列，接纳时按经校验的依赖图拓扑排序，因此下游 Task 始终关联本轮上游证据并随其失效。dispatcher 从遗留 `active` 快照恢复时同时增加真实启动与异常恢复次数，等待制作人的正常恢复不增加异常计数。公开修订失败路径使用完整“无法读取当前代码修订”文本，精确错误断言已实际通过。

## 验证

- 本轮五项审查修复：`node node_modules/typescript/bin/tsc --noEmit`、修改范围 ESLint、Prettier 和 `git diff --check` 通过。标准四文件 Vitest 在加载 `vite.config.ts` 时因 `esbuild spawn EPERM` 未进入用例；将相同四个实际测试文件与依赖预编译到 `node_modules/.cache/daoyan-audit-fixes/`，用禁用项目配置/esbuild 的单线程 Vitest Node API 执行，4 文件 146 条全部通过（生命周期 54、秘书状态 33、守卫工具 30、Agent 路由 29）。覆盖 Profile 实际阶段选择、失败子命令识别、生产证据接线、稳定 ID 迁移反例、删除文件哨兵和既有恢复/证据合同。最终树执行 `npm run verify:full` 时，typecheck、全仓 lint、format:check、docs:check 通过，标准 Vitest 仍在 Vite 配置加载阶段受 `esbuild spawn EPERM` 阻断，后续 coverage、sandbox、E2E、build 未开始，未生成完整门禁通过证据。
- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- 修改范围 ESLint：通过，0 warning。
- 将 5 个真实测试文件与依赖预编译到忽略目录 `node_modules/.cache/daoyan-adaptive-development/`，使用禁用项目配置和 esbuild 的单线程 Vitest Node API 执行：5 文件、141 条通过。覆盖生命周期 54、秘书状态 31、守卫工具 26、Agent 路由 26、公开日志 4。
- 标准聚焦 Vitest：在加载 `vite.config.ts` 时因当前托管环境禁止 esbuild 子进程而报 `spawn EPERM`，没有进入用例；不记为失败用例，也不冒充标准命令通过。
- `npm run verify:full`：本轮独立审查修复后已尝试一次。typecheck、全仓 ESLint、Prettier 和 docs:check 全部通过（66 个元法术、102 个 Markdown 文件）；随后标准 Vitest 在加载 `vite.config.ts`、创建 esbuild 服务前因宿主 `spawn EPERM` 退出，测试用例未开始，因此完整门禁退出 1，coverage、sandbox、E2E 和 build 未执行，不能记为完整门禁通过，也没有写入可复用完整门禁证据。
- 执行 Agent 交叉复核：修正了审查提示仍声称“完整门禁已完成”、Version PM 与 Git hook 会重复运行 `verify:full`、陈旧候选迁移匹配过宽，以及活动项/候选项稳定关联去重统计四处问题；复核后重新执行 141 条无头回归并通过。这不是独立 Agent 审查证据。
- 独立审查五项修复增量：标准四文件 Vitest 在加载 `vite.config.ts` 时被 `esbuild spawn EPERM` 阻断；随后预编译相同四个真实测试文件并以禁用项目配置/esbuild 的单线程 Vitest Node API 执行，118 条全部通过（生命周期 54、秘书状态 32、守卫工具 28、公开日志 4）。覆盖主退出路径的延迟终态重读、定向证据拒绝、Git tree 失配、恢复轮次事件不碰撞、合并反向闭合和更正发送状态重启持久化。
- 本次快速门禁修复：`npm run typecheck`、修改范围 ESLint、Prettier、`npm run docs:check` 与 `git diff --check` 通过；预编译后的 `test/secretary-notice-guard.test.ts` 以禁用项目配置/esbuild 的单线程 Vitest Node API 执行 29 条通过。标准守卫/看板聚焦 Vitest 仍在 Vite 配置加载时受 `esbuild spawn EPERM` 阻断；预编译看板测试也因沙箱禁止创建守卫子进程而不能执行 HTTP 场景，因此不记作通过。
- dispatcher 恢复点超时修复：目标测试保留 20 秒子进程失败边界，并把外层集成用例预算显式设为 30 秒；当前修复沙箱禁止 Node 创建 `git`/`tsx` 子进程，且标准 Vitest 仍在加载 Vite 配置时受 `esbuild spawn EPERM` 阻断，因此本 Agent 只记录类型、lint、格式、文档与静态契约检查，目标进程用例由原 Feature PM 在可创建子进程的同一运行内重跑。
- 最终审查四项修复：`npm run typecheck`、相关文件 ESLint/Prettier 与 `git diff --check` 通过。标准两文件 Vitest 在加载 `vite.config.ts` 时受宿主 `esbuild spawn EPERM` 阻断、未进入用例；将相同的 `test/agent-routing.test.ts` 与 `test/secretary-notice-guard.test.ts` 及依赖预编译到忽略目录 `node_modules/.cache/daoyan-final-review-fixes/`，以禁用项目配置/esbuild 的单线程 Vitest Node API 执行，2 文件 63 条全部通过（Agent 路由 30、守卫工具 33）。覆盖 worker 退出但 PM 存活、第二条更正发布失败后的逐条持久化与重启续发、实际输出路径失效传播，以及公开修订错误文本。
- 本次三项证据/恢复修复：`npm run typecheck` 通过。标准 `npm test -- test/secretary-notice-guard.test.ts test/version-lifecycle.test.ts` 在 Vite 配置加载阶段受 `esbuild spawn EPERM` 阻断、未进入用例；随后将五个开发阶段无头测试预编译到忽略目录 `node_modules/.cache/daoyan-current-development/`，补入原样 `pre-push-verify.mjs` 依赖，并以禁用配置/esbuild 的单线程 Vitest Node API 执行，5 文件 155 条全部通过（生命周期 54、守卫 34、秘书状态 33、路由 30、公开日志 4）。新增回归覆盖包装进程退出但快照 PM 仍存活、QA 对实时树/配置失配的拒绝，以及开发报告实际 Task 命令接纳和跨 scope 命令拒绝。该替代运行不冒充标准 Vitest 或完整门禁。
- 最新三项阻断修复：`npm run typecheck` 通过；相关脚本与三组测试 ESLint 通过。标准 `npx vitest run test/agent-routing.test.ts test/secretary-state.test.ts test/secretary-notice-guard.test.ts --pool=forks --poolOptions.forks.singleFork=true` 在加载 `vite.config.ts` 时受宿主 `esbuild spawn EPERM` 阻断，未进入用例。将同三份真实测试及依赖预编译到忽略目录 `node_modules/.cache/daoyan-three-finding-fixes/`，补入原样 `pre-push-verify.mjs` 后，以禁用项目配置/esbuild 的单线程 Vitest Node API 执行，3 文件 99 条全部通过（守卫 35、秘书状态 33、Agent 路由 31）。新增回归覆盖开发门禁后写入 QA 阶段产物仍可复用、代码变化仍失效，只读路径外直接依赖仅经输入清单触发失效，以及不注入源自引用时的稳定关系去重。该替代运行不冒充标准 Vitest 或完整门禁。
- 本次三项工作流审查修复：`npm run typecheck`、相关脚本/测试 ESLint 和 Prettier 通过。标准 `npm test -- test/agent-routing.test.ts test/secretary-state.test.ts --pool=forks --poolOptions.forks.singleFork=true` 在加载 `vite.config.ts` 时受宿主 `esbuild spawn EPERM` 阻断、未进入用例；随后将同两份真实测试及依赖预编译到 `node_modules/.cache/daoyan-latest-audit-fixes/`，补入原样 `pre-push-verify.mjs`，以禁用项目配置/esbuild 的单线程 Vitest Node API 执行，2 文件 67 条全部通过（Agent 路由 33、秘书状态 34）。新增回归覆盖完整门禁证据跳过上游阶段、lint 中段失败保留后续命令，以及两个同文案无关联事项分别计数。该替代运行不冒充标准 Vitest 或完整门禁。
- 最新四项审查修复：`npm run typecheck`、相关文件 Prettier 与 `git diff --check` 通过。标准 `npm test -- test/agent-routing.test.ts test/secretary-notice-guard.test.ts` 在加载 `vite.config.ts` 时受宿主 `esbuild spawn EPERM` 阻断、未进入用例；随后把同两份真实测试及依赖预编译到忽略目录 `node_modules/.cache/daoyan-four-finding-fixes/`，补入原样 `pre-push-verify.mjs`，以禁用项目配置/esbuild 的单线程 Vitest Node API 执行，2 文件 70 条全部通过（Agent 路由 34、守卫工具 36）。新增回归覆盖前置任务拆分变化使验证树失效、后置 QA 报告不失效、无序开发结果拓扑归一、`active` 崩溃恢复计数，以及完整中文错误文本。该替代运行不冒充标准 Vitest 或完整门禁。

## 风险与后续边界

- 本阶段只完成隔离备份/降级投影演练，未操作生产 `.daoyan-agent`。生产停写、全状态根/种子/事务引用核验、故障注入和真实降级仍归 Version QA。
- 当前环境不能执行依赖子进程的标准 Vitest、HTTP 进程竞态和 Playwright；无头逻辑证据不能替代后续完整门禁。本轮完整门禁已真实尝试并在测试启动前受阻，notice guard 只能在允许创建 esbuild/worker 子进程的 Feature PM 环境重新生成最终树的唯一完整门禁证据。
- 本执行 Agent 按任务约束未创建独立 Agent；真正独立审查与 `verify:full` 证据由秘书统一收束，notice guard 只有在核验本报告和结构化清单后才可原子登记开发阶段。
