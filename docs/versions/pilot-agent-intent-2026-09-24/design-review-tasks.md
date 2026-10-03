# design-review 本轮任务：首批 A 的 World/VM 接入复核

**问题与范围。** 原 `formal-pilot-agent-intent-2026-09-24-13-development-5` 在开发审查后停滞。范围修订 13、首批 A 和 `drb8` 纸面联签不在此重做；本轮只核 B1 自然壳损与 ADR 0018、已采纳 ADR-0024 的覆盖关系，并明确 J1、D1、B1→B4 如何进入现有 World/VM。非目标是开发、重审无关模块、扩充法球付费响应或敌方修士玩法。验收是可执行的窄合同、逐条旧条款裁定和正反例，不把独立 PilotWorld 或纸面账当作运行成功。

**唯一成果。** `drb9-world-vm-reentry-review` 由主策完成，独占追加[审核发现](./design-review-findings.md)，并写入 `tasks/design-review-drb9-world-vm-reentry-review.json`。同节点无前驱，不把调研、编码、测试拆成多个成果。旧任务 ID 和证据保留；本轮选 `fresh`，因为职责已从纸面联签转为停滞开发的接入复核，仍以旧文件、审查及恢复记录为证据。

**裁决边界。** ADR-0024 仅在明确覆盖处取代 ADR 0018；已采纳设计不等于旧 `hitProjectile/damage`、自动 `Wm` 或固定寿命运行态已迁移。主策须区分自然 C→N→X 和 B4 付费作用的来源、付款、失败余态及待测证书。新增已批准范围外的玩家规则或不可逆取舍才走制作人门禁。共享 `design-review.md`、`design-review.json` 和 `docs/status.md` 留 Version PM 收束；本轮只做轻量文档检查。机器合同见 [design-review-tasks.json](./design-review-tasks.json)。
