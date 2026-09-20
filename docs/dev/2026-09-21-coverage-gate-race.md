# 2026-09-21 覆盖率门禁并发清理修复

## 问题、范围与验收

独立审查在慢速或覆盖率环境发现 Vitest 偶发在写入 `coverage/.tmp/coverage-0.json` 时收到 `ENOENT`。根因是多个覆盖率门禁共用默认报告目录：每个实例启动都会清理其 `.tmp` 载荷目录。本次只隔离覆盖率运行的临时报告路径，不改变覆盖率范围、阈值或秘书看板的事件完成等待语义。验收为并发运行不会共享 `.tmp`，且每次退出都清理本轮报告临时目录。

## 实现

- `scripts/run-coverage.mjs` 为每次 Vitest 覆盖率调用创建含 PID 与随机 UUID 的报告目录，通过环境变量传给 Vite 配置，并在成功、失败或启动异常后删除该目录。
- 覆盖率配置继续生成原有 text、HTML 与 JSON summary 报告，但其载荷与输出均限制在本次调用目录，防止一个门禁的清理影响另一个门禁。
- 保留看板测试通过 `responses/<request-id>.json` 等待收件处理完成的策略；不以延长固定等待隐藏异步竞态。

## 审查修复

- 看板单测与 E2E 不再把进程已 spawn 当作 guard 已启动：它们以 `/api/dashboard` 的成功响应判定 HTTP 就绪，并在 20 秒启动预算内监听子进程的 `error`/`exit`。若 guard 提前退出，失败会立即带上退出码、信号和最后 8 KB 标准输出/错误；不会再由固定 8 秒 sleep/轮询掩盖 Windows 或覆盖率下的慢启动。
- `test/helpers/secretary-guard.test.ts` 同时覆盖服务暂时返回 `503` 后才就绪，以及提前退出携带诊断输出；前者确保测试不会把端口已监听或任意 HTTP 响应误判为服务已经可用。
- 看板 E2E 结束时会向隔离 guard 发出停止信号并等待其真实 `exit` 事件后才删除临时状态目录；不会让 Windows 子进程、文件句柄或异步清理进入后续复用 Vite 服务的 smoke 用例。
- 制作人体验门禁后的候选方向测试以 guard 在持久化状态后原子发布的 `responses/<request-id>.json` 作为完成信号；随后才读取看板并断言方向进入后续候选池、当前版本仍停在制作人体验。它不再依赖任意 sleep 或短轮询看板字段。
- 桌面工作台折叠面板时不再保留零宽 grid 轨道。被折叠的面板及其相邻分隔条会退出 grid 布局，保留面板占用连续轨道并贴齐工作台左右边界；窄屏依旧恢复为三个可横向导航的面板。
- 本环境拒绝 Vite/esbuild 和 Playwright worker 的子进程创建（`spawn EPERM`），因此 `npm run test -- test/secretary-dashboard.test.ts` 与定向 Playwright 无法实际启动；已完成 diff 空白检查，完整门禁需要在允许子进程的 CI 或本机环境复验。

## 独立审查后修复

- 审查复现的失败并非 HTTP 就绪等待不足：守卫已经接受 `/api/intake`，但随后只依赖 `fs.watch` 重新扫描 inbox。在慢速 Windows 或覆盖率进程压力下，该文件事件可能错过，导致已接受的请求永远不生成 `responses/<request-id>.json`。
- `enqueueIdea` 现在在原子写入成功后直接唤醒 `processInbox`；watcher 仍负责其他进程落盘的 inbox 文件。这样保留事件驱动和异步 202 收件语义，同时不把本守卫刚写入的本地或通道收件交给非保证送达的文件事件。
- 看板 E2E 的 finally 现在等待隔离 guard 的真实退出后再删除临时目录，避免停止信号与后续复用 Playwright Vite 服务的 smoke 用例并发。辅助单测覆盖该退出等待。
- 修复后已通过 `npm run typecheck`、`npm run lint`、`npm run format:check` 与 `npm run docs:check`。`npm run verify:full` 已尝试，但 Vitest 加载 Vite 配置时仍受受限环境的 `spawn EPERM` 阻塞，因而覆盖率、沙盒、E2E 与构建未能继续；待 CI 或允许创建子进程的 Windows 环境复验完整门禁。
