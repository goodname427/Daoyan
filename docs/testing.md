# 测试策略

## 分层

| 层级       | 命令               | 主要职责                                                      |
| ---------- | ------------------ | ------------------------------------------------------------- |
| 单元与集成 | `npm test`         | 核心语义、资源上界、编译、VM、战斗状态和 jsdom 渲染。         |
| 覆盖率     | `npm run coverage` | `src/core/` 的语句、分支、函数和行覆盖率门槛。                |
| 沙盒       | `npm run sandbox`  | 用固定场景验证资源模型的代表性结果。                          |
| E2E        | `npm run test:e2e` | 真实浏览器加载、主要工作流、Canvas、React Flow 和未捕获错误。 |
| 构建       | `npm run build`    | 确认生产构建可生成。                                          |

## 门禁

- `npm run verify`：开发与提交前的快速门禁，包含类型、lint、格式、文档和单元测试。
- `npm run verify:full`：推送、交付和 CI 门禁，在快速门禁基础上增加覆盖率、沙盒、E2E 和生产构建。覆盖率命令为每次调用隔离临时报告目录，避免并发门禁互相删除 Vitest 的 worker 载荷。
- `npm run verify:ci`：CI 对完整门禁的稳定别名，必须与 `verify:full` 等价。
- `npm run test:e2e` 会在启动 Playwright 前移除外部 `NO_COLOR`：Playwright 对其 WebServer 与 worker 固定启用 `FORCE_COLOR`，两者同时存在会让 Node 为每个子进程输出无关警告。

## 新改动如何选测试

- 纯函数或核心规则：单元测试，包含失败边界。
- 跨模块状态或战斗行为：集成测试。
- 用户可见流程、浏览器 API、Canvas 或 React Flow：E2E。
- 布局变化：至少检查目标桌面视口和一个窄屏断点；稳定页面再加入视觉快照。
- App 渲染测试在每例开始前和卸载后清空本地存档，并恢复 console spy，避免迁移存档或错误监听污染后续默认场景。DSL 调用的参数个数通过 AST/编译指令校验，不用无法处理嵌套调用的正则；控制效果断言使用当前控制记录与实际属性，不依赖旧 modifier 存储。
- 槽位选择按可访问名称定位，不依赖整个页面下拉框的排列；探查用例先建立授权、距离与开战状态，区分 `unavailable` 和真实零值。v1 迁移后的自动保存核对原件不变及 v2 增量槽内容，不再要求覆盖旧槽。
- 浏览器回归不依赖默认法术书恰好含有某种 AST：列表类型往返使用显式 `query<entities>` / `list<entity, 8>` 夹具，拖线删除使用小图并先 Fit View、确认端口位于视口内。存档编辑先断言原调用存在，再核对导出与刷新后的语义值；同书导入从付费获准的 Battle 快照读属性，并用持续法术核对指定槽位的实际施放，避免瞬时卡片在 HUD 刷新间隔内消失。目录分组与起手动态价格分别断言，同时保留基础价格数值检查。
- VM 时间回归比较整帧与分帧的工作、付款和结束状态：每笔 tick 债务还清后继续消费本帧剩余预算，债务未清不能执行后续效果。战斗回归隔离自然回蓝和敌方打断，避免把净余额或固定秒数误当成施法工作量。
- 跨进程秘书：以 `/api/dashboard` 的成功 HTTP 响应作为 guard 就绪信号；启动观察器必须同时监听子进程退出并附带最近输出，不能用固定 sleep 或静默的 8 秒窗口掩盖启动失败。收件则等待每条请求落盘的 `responses/<request-id>.json`，再读取看板状态；HTTP `202` 只表示已入箱，不能证明事件已处理完成。
- 秘书测试子进程使用 `DAOYAN_SECRETARY_LOCAL_ONLY=1` 时，通讯层必须配置零个外部通道，即使父进程带有真实钉钉或 webhook 凭据也不得连接或发送。浏览器测试在对话和待办操作前核对 `channels.json` 的 `configuredChannelIds` 为空，防止测试版本的消息误发给制作人。
- 秘书恢复事件回归必须隔离脚本根及其 `.daoyan-agent`，仅设置状态目录环境变量不会隔离历史运行扫描和递归 watcher。恢复快照在夹具的 `runs/` 下原子发布，直接等待对账结果，不借助真实项目事件或额外问答唤醒；终态与写进程占用分别断言，worker 存活期间继续阻止重派，退出后才释放。

## 体验验收

自动测试之后仍需启动应用，按功能规格中的路径实际操作。交付说明必须写明体验的视口、路径和结果；不能只写“测试通过”。

## Agent 调度器

- `test/agent-routing.test.ts` 无模型调用地验证策略、依赖排序、循环拒绝、升级和提交信息。
- `npm run producer -- --help` 验证本地命令入口。
- `npm run producer:doctor` 在不调用模型的情况下验证 Windows Codex/npm shim 与真实子进程入口。
- `npm run producer:plan -- "方向"` 是零-token、只读集成冒烟；增加 `--deep-plan` 才会真实调用配置中的规划模型并校验 JSON Schema。
- `npm run producer:resume -- "<运行目录>"` 只在工作区指纹与 `recovery.json` 一致时续跑，避免跳过实现或混入外部改动。
- `npm run producer:batch:plan -- "批次目标"` 从 `status.md` 冻结有界 Feature 队列；`producer:batch:resume` 跳过已交付轮次，并复用各 Feature 的 `recovery.json`。该命令只用于正式版本的开发阶段。
- Feature PM 在最终代码树执行一次 `verify:full` 并保存 Feature scope 证据；版本阶段只校验该证据仍匹配候选修订，再执行独立的集成、迁移、打包和候选验证，不重复运行同一完整门禁。
- 完整调度仍必须通过固定的 `verify:full`，计划中的文本验证建议不会被当作 shell 命令直接执行。
