# design-review 本轮任务：首批 A 统一世界方案复核

**问题。** 上一节点的七项模块任务已交付，但最新[模块总览](./module-design.md)未签跨模块闭合：B4 十六读缺逐 `readId` 的端点、投影、授权和版本覆盖，`34 M/16 M` 等仍是有条件的纸面数值。此前的完整方案批准与首批 A 范围保持有效，不能替代本轮新合同的复核。

**成果。** 只设 `drb3-world-closure-review` 一项主策独立复核。先检查原权威模块是否补齐 B4 读证与逐读价格，再按同一事实键核物理、法力、程序、生命、唯一理论和玩家桥接；用首批 J1、D1、B1→B4 及未列举的实体/事件反例判断规则是否闭合。结论写入[审核发现](./design-review-findings.md)，任务证据另存于 `tasks/design-review-drb3-world-closure-review.json`。同节点无前驱，两个写入文件由该任务独占。

**验收边界。** 若逐读证仍缺，明确维持 `unknownPrice`、退回的权威归属和通过条件；若已补齐，再复核价格、容量、失败余态、旧 ADR 覆盖与现有 World/VM 接入。真正新增的产品或不可逆取舍才给制作人通俗比较和推荐。未来法球付费响应、更多预设与敌方修士只作扩展性反例。本任务不改游戏、模块策划或 ADR，不预拆开发、QA、候选节点，也不把纸面账当作实测。共享 `design-review.md`、`design-review.json` 和 `docs/status.md` 留给 Version PM 收束。

机器合同见 [design-review-tasks.json](./design-review-tasks.json)。
