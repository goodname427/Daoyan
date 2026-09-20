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

用户环境变量避免了聊天记录、代码仓库和命令历史泄露，但不是硬件密钥库：当前 Windows 用户及其运行的进程仍可读取。这个内部应用即使没有资金资产，Secret 仍代表应用身份；泄露者可以在已授权范围内冒充机器人，未来新增权限时旧泄露也会扩大影响。怀疑泄露时在钉钉后台轮换 Secret，再重新运行向导即可。

机器人收到文本后使用平台消息 ID 生成稳定收件 ID，平台重投与守卫重启不会重复排期。即时答复优先回到原会话，任务完成、待办和阻塞等异步事件通过机器人单聊接口发送。Stream 长连接只负责事件唤醒，空闲时不调用模型，也不要求本机暴露公网端口。

所有外部通知先写入 `notice-outbox/`；某个通道失败时只重试该通道，已经成功的通道不会重复发送。原会话回调失效或返回错误时会降级到主动单聊。通知是至少一次交付，进程在平台已接收但本机尚未来得及确认时崩溃，恢复后可能重复一条简报，但不会静默丢失。

若钉钉配置缺失、连接失败或发送失败，notice guard 会记录错误并继续运行本机秘书、HTTP 与其他通道。使用 `npm run secretary:status` 检查当前终端是否具备完整配置，使用 `.daoyan-agent/secretary/notice-guard.log` 查看连接诊断。

`DAOYAN_SECRETARY_LOCAL_ONLY=1` 会禁用新消息的语义查重，仅使用本地保守规则；空闲模式无论如何都不会调用模型。

## 当前限制

- PM 仍按依赖顺序编辑同一工作区，暂不并行写入。
- CLI 没有单次调用硬 token 上限，当前依靠聚焦输入、模型分层、超时和事后记录控制成本。
- notice guard 是本机进程，系统重启后需要登录启动项、进程管理器或 `npm run secretary:start` 拉起。
- 仓库提供平台无关的通道边界与钉钉 Stream 适配，但不保存聊天平台凭据。
