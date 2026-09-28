# design-review 本轮任务：首批 A 接触与壳损闭合复核

**问题。** 上轮 `drb1` 已确认 B1 自然壳损缺少材料阈值与接触精度的可判证据，旧 `damage` 池不能代证；随后重复制作人升级已撤回。首批 A 和完整策划批准事实仍有效，撤回升级并未让 B1→B4 自动成立。

**范围与成果。** 只设 `drb2-contact-closure-review` 一项主策复核成果。对[唯一理论](./world-theory-draft.md)、[物理材料](./physics-material-design.md)、其余模块同键消费者、[上轮审核](./design-review-findings.md)和 [ADR 0018](../../adr/0018-运动供能与命中守恒.md)逐项核对有限接触、自然损伤、普通 `k0` 修壳、资源与失败余态。主策在 `design-review-findings.md` 追加有证据的闭合、退回或升级结论，并写独立任务证据。若仍缺有限模型或正例，明确退回物理等权威模块及判准，不用虚构阈值签通过。

**非目标。** 不重新立项、不重选首批 A、不改游戏实现、模块正文或已采纳 ADR；不预拆后续开发、QA 或候选任务。真实 World/VM 原读、资源实扣和玩家实玩属于获准开发后的验收。未来再撞付费响应、预设和敌方修士仅作扩展反例。

**验收与写入。** 对首撞可损与不可损、缺证、擦边/无碰撞、再撞、同刻双接触及未列举实体逐一判自然事实、付费作用和保留余态；核 ADR 拟议覆盖与现有核心接入，只有真正新增产品取舍才形成制作人比较材料。机器合同见 [design-review-tasks.json](./design-review-tasks.json)。单任务无同节点依赖或写入冲突；共享 `design-review.md`、`design-review.json` 和 `docs/status.md` 由 Version PM 收束。
