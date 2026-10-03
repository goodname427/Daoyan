# Feature PM 运维参考

本页供维护 Agent 和故障诊断使用，不是制作人的日常入口。制作人的唯一工作范式见 [`../agent-workflow.md`](../agent-workflow.md)。

## 内部入口

单个 Feature 的完整交付：

```bash
npm run producer -- "增加法术单步推演和变量观察"
```

只读查看本地路由，不修改代码、不调用模型：

```bash
npm run producer:plan -- "增加法术单步推演和变量观察"
```

只有确实需要第二意见时才启用低成本语义规划：

```bash
npm run producer:plan -- --deep-plan "重新考虑实体与资源架构"
```

正式版本开发阶段可以冻结一个有上限的 Feature 批次，每项仍独立执行完整交付闭环：

```bash
npm run producer:batch -- "交付已批准的开发批次"
npm run producer:batch:plan -- "交付已批准的开发批次"
```

Feature PM 负责形成任务合同、选择模型、执行、完整门禁、独立审查、自动修复、文档和 Git 收束。执行 Agent 不提交代码；完整验证只由 PM 统一运行。

## 恢复与接管

恢复单个 Feature：

```bash
npm run producer:resume -- ".daoyan-agent/runs/<运行目录>"
```

恢复开发批次：

```bash
npm run producer:batch:resume -- ".daoyan-agent/versions/<运行目录>"
```

产品决定应回填原恢复点，不创建重复任务：

```bash
npm run producer:batch:resume -- ".daoyan-agent/versions/<运行目录>" "采用方案 A"
```

恢复会核对基线提交和工作区指纹。当前现场确实属于该运行，但指纹已经变化时才使用强制接管：

```bash
npm run producer:resume -- --takeover ".daoyan-agent/runs/<运行目录>"
npm run producer -- --takeover "继续完成遗留工作"
```

`--takeover` 会写入现场清单并重新执行完整任务合同。不得为了绕过来源不明的工作区改动而使用。

网络暂不可用但需要完成本地提交时可加 `--no-push`。环境诊断不调用模型：

```bash
npm run producer:doctor
```

## 自动恢复规则

- 容量、网络和超时先按同一路由重试，再按策略升级或切换备用模型。
- 执行和审查修复按 economy、standard、advanced、critical 分别最多运行 12、25、40、60 分钟；20 秒心跳、进程身份与存活检查持续写入 `progress.json`。规划、独立审查和交付验证使用各自的 8、8/12/20/30、20 分钟时限，不能以旧的固定短时限中断仍健康的执行任务。
- Feature 或版本失败后保留恢复点；notice guard 在登记时间到达后接管，不要求制作人重述需求。
- 自动恢复次数耗尽、无法验证旧进程归属或工作区来源不明时，才进入需要人工判断的状态。
- 账号额度和鉴权阻塞会暂停当前工作并通知制作人；条件恢复后，制作人通过自然语言回复秘书即可从原点继续。
- 版本到达 `review-ready` 后发送 Review 摘要；常驻秘书继续队列，只有大版本发布需要制作人明确决定。

## 运行记录

单 Feature 位于 `.daoyan-agent/runs/<运行目录>/`：

- `plan.validated.json`：任务合同；
- `recovery.json`：阶段、任务结果、进程身份、指纹和恢复状态；
- `progress.json`：当前长阶段心跳；
- `verify-*.log`、`review-*.json`：门禁与独立审查；
- `report.json`、`report.md`：最终报告。

版本位于 `.daoyan-agent/versions/<运行目录>/`：

- `version.json`：冻结队列和每个 Feature 状态；
- `feature-*.log`：各轮输出；
- `verify-full.log`：跨 Feature 最终门禁；
- `report.md`：制作人 Review 入口。

常驻秘书位于 `.daoyan-agent/secretary/`：

- `state.json`：队列、当前工作和已汇报任务节点；
- `events.jsonl`：结构化通知历史；
- `inbox/`、`responses/`：可靠收件协议；
- `notice-outbox/`：尚未被全部目标通道确认的持久通知，发送失败后由恢复定时器重试；
- `channels.json`：当前 notice guard 实际加载的通道，不包含凭据；
- `notice-guard.log` 和各项任务日志：诊断信息。

## 通讯接入

本机 HTTP 收件口：

```powershell
$env:DAOYAN_SECRETARY_HTTP_PORT = "17321"
$env:DAOYAN_SECRETARY_TOKEN = "<local-secret>"
npm run secretary:start
```

`POST /intake` 接受：

```json
{ "idea": "增加持续护盾法术" }
```

网关只转发自然语言，不分类消息。问题、新方向、上下文回复和继续工作都由秘书结合持久状态识别。

使用 `Authorization: Bearer <local-secret>`。`GET /status` 返回脱敏状态。服务默认绑定 `127.0.0.1`；非本机地址强制要求 token，公网认证和 TLS 由外部网关负责。

出站通知通过 `DAOYAN_SECRETARY_WEBHOOK_URL` 配置，`DAOYAN_SECRETARY_WEBHOOK_KIND` 支持 `generic`、`feishu`、`wecom`、`discord`、`dingtalk`。凭据只放环境变量。

### 钉钉 Stream 秘书

钉钉是现有秘书内核的通讯通道，不维护第二份任务、版本或对话状态。使用企业内部应用的机器人并启用 Stream 模式后，在部署电脑运行一次本地配置向导：

```powershell
npm run secretary:dingtalk:setup
```

向导会依次询问应用 Client ID、应用 Client Secret、制作人 `staffId/userId` 和异步通知用户。Secret 使用隐藏输入，不进入聊天、终端命令历史或项目文件；向导保存当前 Windows 用户环境后自动重启 notice guard 并显示通道状态。

若需要无交互部署，才直接在启动 notice guard 的同一用户环境中配置：

```powershell
$env:DAOYAN_DINGTALK_CLIENT_ID = "<应用 Client ID>"
$env:DAOYAN_DINGTALK_CLIENT_SECRET = "<应用 Client Secret>"
$env:DAOYAN_DINGTALK_ALLOWED_SENDER_IDS = "<制作人 staffId>"
$env:DAOYAN_DINGTALK_NOTIFY_USER_ID = "<接收异步通知的 staffId>"
npm run secretary:stop
npm run secretary:start
```

`DAOYAN_DINGTALK_ALLOWED_SENDER_IDS` 可用英文逗号配置多个授权人；未配置白名单时通道拒绝启动。`DAOYAN_DINGTALK_NOTIFY_USER_ID` 默认使用白名单第一人，`DAOYAN_DINGTALK_ROBOT_CODE` 默认使用 Client ID。不要把 Client Secret 写入仓库、日志或聊天消息；SDK 调试输出被固定关闭，因为其原始调试信息可能包含连接配置。

Windows 启动器会在当前进程缺少这些配置时，从当前用户环境刷新钉钉配置。这保证配置向导完成后，即使从较早启动的桌面进程重启秘书，也不会丢失已经保存的通道配置；刷新值只传给 notice guard，仍会从浏览器和 Feature PM 子进程环境中剔除。

用户环境变量避免了聊天记录、代码仓库和命令历史泄露，但不是硬件密钥库：当前 Windows 用户及其运行的进程仍可读取。这个内部应用即使没有资金资产，Secret 仍代表应用身份；泄露者可以在已授权范围内冒充机器人，未来新增权限时旧泄露也会扩大影响。怀疑泄露时在钉钉后台轮换 Secret，再重新运行向导即可。

机器人收到文本后使用平台消息 ID 生成稳定收件 ID，平台重投与守卫重启不会重复排期。即时答复优先回到原会话，任务完成、待办和阻塞等异步事件通过机器人单聊接口发送。Stream 长连接只负责事件唤醒，空闲时不调用模型，也不要求本机暴露公网端口。

所有外部通知先写入 `notice-outbox/`；某个通道失败时只重试该通道，已经成功的通道不会重复发送。原会话回调失效或返回错误时会降级到主动单聊。通知是至少一次交付，进程在平台已接收但本机尚未来得及确认时崩溃，恢复后可能重复一条简报，但不会静默丢失。

若钉钉配置缺失、连接失败或发送失败，notice guard 会记录错误并继续运行本机秘书、HTTP 与其他通道。使用 `npm run secretary:status` 检查当前终端是否具备完整配置，使用 `.daoyan-agent/secretary/notice-guard.log` 查看连接诊断。

`DAOYAN_SECRETARY_LOCAL_ONLY=1` 会禁用新消息的语义查重，仅使用本地保守规则；空闲模式无论如何都不会调用模型。

## 当前限制

### 后台应用许可

执行合同明确要求 Electron、Computer Use 或实际玩家操作时，调度器自动使用 `scripts/codex-worker-host.ts` 承接官方 App Server stdio 协议；原执行会话直接 `thread/resume`，不派新角色。旧合同可由主 Agent 内部使用 `--interactive-task <task-id>` 指定原计划中的任务，配置随恢复点保留。普通文档、规划和独立审查仍使用现有批处理链路。

许可通过工具实际提出的 `mcpServer/elicitation/request` 转发，宿主严格核对 thread、turn、node_repl、computer-use 元数据、electron/electron.exe 身份和空应用许可 schema。前台由主 Agent 展示实时 `[审批待处理]` 链接。正式后台由 guard 启动每个 PM 的私有管道，直接向已配置制作人通道投递实际链接；看板、事件及日志只写无链接摘要。管道和秘密不传给模型进程，没有通道或投递失败会中止该请求；不能把 stdout 重定向到文件当成审批已展示。短期许可通知不进工作区持久 outbox；其他通知仍沿用原可靠投递。管道等待为 30 秒，覆盖默认 20 秒通道发送与状态落盘，发送方断开后不发布成功待办。

后台执行 Agent 必须等待，不访问该页面或自行提交。`application-approval.json` 只记录请求状态与作用域，`application-approval-audit.jsonl` 记录原请求和实际选择，均不含审批 URL。当前只支持本次允许，不生成“始终允许”或改变 Codex 配置；未覆盖的 Edge 策略错误保持独立问题。

拒绝、取消、四分钟超时及不支持的请求中断当前 turn，并输出 `[工作流工具审批阻断]`；调度器据此停止恢复重试和模型升级。主 Agent 先核对原恢复点和草稿，再处理展示端或外部访问阻断，不能让制作人切换主对话权限来掩盖后台接收端缺失。此链路依据 [官方 App Server 协议](https://learn.chatgpt.com/docs/app-server)，没有调用原生 helper 私有协议。完整代码门禁、审批等待和只读窗口诊断不构成游戏实玩验收。

- PM 仍按依赖顺序编辑同一工作区，暂不并行写入。
- CLI 没有单次调用硬 token 上限，当前依靠聚焦输入、模型分层、超时和事后记录控制成本。
- notice guard 是本机进程，系统重启后需要登录启动项、进程管理器或 `npm run secretary:start` 拉起。
- 仓库提供平台无关的通道边界与钉钉 Stream 适配，但不保存聊天平台凭据。
