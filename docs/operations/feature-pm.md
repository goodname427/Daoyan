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

出站通知通过 `DAOYAN_SECRETARY_WEBHOOK_URL` 配置，`DAOYAN_SECRETARY_WEBHOOK_KIND` 支持 `generic`、`feishu`、`wecom`、`discord`。凭据只放环境变量。

`DAOYAN_SECRETARY_LOCAL_ONLY=1` 会禁用新消息的语义查重，仅使用本地保守规则；空闲模式无论如何都不会调用模型。

## 当前限制

- PM 仍按依赖顺序编辑同一工作区，暂不并行写入。
- CLI 没有单次调用硬 token 上限，当前依靠聚焦输入、模型分层、超时和事后记录控制成本。
- notice guard 是本机进程，系统重启后需要登录启动项、进程管理器或 `npm run secretary:start` 拉起。
- 仓库只提供平台无关的 HTTP/webhook 边界，不保存聊天平台凭据。
