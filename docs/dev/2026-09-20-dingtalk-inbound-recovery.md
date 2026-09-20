# 钉钉入站消息恢复

## 问题

钉钉主动通知成功后，制作人的首条回复已经通过 Stream 写入秘书收件箱，但 notice guard 在启动语义判断 Agent 时触发 Windows `spawn EINVAL`。未捕获的启动异常终止了守卫，导致消息已可靠落盘却没有答复。

## 修复

- Windows 下发现 `codex.cmd` 时，优先解析到同目录 npm 包中的真实 `codex.js`，由当前 Node 进程启动，避免直接 spawn 批处理 shim。
- 同时保留 `.exe` 优先级和 `CODEX_BIN` 覆盖能力。
- 子进程同步启动异常、异步 error、stdin 错误和超时统一收束为语义判断失败。
- 收件处理对语义 Agent 增加故障隔离；外部判断不可用时降级到本地意图和项目事实，notice guard 不再退出。
- 守卫重启后继续处理已经落盘的钉钉收件，不要求制作人重发。

## 验收

- 单元测试覆盖 Windows `codex.cmd` 到 Node 入口的解析。
- 聚焦秘书测试通过；守卫重启后自动处理崩溃前已落盘的真实钉钉消息，生成答复并清空通知 outbox。
- `npm run verify:full` 通过，包含 125 项 Vitest、覆盖率、资源沙盒、19 项 Playwright E2E 和生产构建。
