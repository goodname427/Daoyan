# 钉钉秘书本地配置向导

## 问题

钉钉 Stream 通道已经完成，但原部署步骤要求手工设置环境变量。制作人若把 Client Secret 发到聊天中，凭据会进入聊天同步、历史和备份；直接写命令也会进入终端历史，部署体验与安全边界都不够清楚。

## 范围

- 新增 `npm run secretary:dingtalk:setup`，在本地依次收集应用 Client ID、隐藏输入的 Client Secret、制作人白名单和异步通知用户。
- 将配置保存到当前 Windows 用户环境，注入当前向导进程后自动重启 notice guard，并打印脱敏状态。
- 文档明确用户环境变量不是硬件密钥库：同一 Windows 用户下的进程仍可读取；怀疑泄露时应在钉钉后台轮换 Secret。

## 非目标

- 不把凭据写入仓库、`.env`、秘书状态或日志。
- 不引入独立凭据服务、Windows Credential Manager 适配或跨平台安装器。
- 不改变秘书内核、任务队列或钉钉 Channel/View 边界。

## 验收

- PowerShell 脚本可通过语法解析，Secret 输入不回显。
- 向导不会输出 Secret，并能在配置后停止、启动和检查常驻秘书。
- PowerShell 语法解析通过；首次交互启动发现 Windows PowerShell 5 会把无 BOM 的 UTF-8 中文脚本按本地编码读取，已将向导固定为带 BOM 的 UTF-8，并使用 `powershell.exe` 复验。
- `npm run verify:full` 通过，包含 124 项 Vitest、覆盖率、资源沙盒、19 项 Playwright E2E 和生产构建。
