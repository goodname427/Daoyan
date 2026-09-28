# module-design 本轮任务：B4 逐读覆盖与价版

最新 drb3 定向退回 B4 十六项前读的端点、获准投影、授权、碰后版本和逐读价；当前 n=unknown、Quote=unknownPrice。首批 A 与此前完整策划的批准仍有效。本轮只规划纸面补证和同键消费者重签，不新增玩家规则、实现或实际可玩验收。

| 模块任务 | 独占交付物 | 相对 mdag 新增判断、反例与验收 |
| --- | --- | --- |
| 物理材料 mdah-b4-reads | physics-material-design.md | 逐项签十六前读及三 POST 的有限端点、字段、投影、grant 与碰后版本；核有证、空读、越界、失权、再撞。已闭合 B1 接触只读。 |
| 法力账本 mdah-b4-prices | mana-ledger-design.md | 逐读正价及价版，判 n=0 或有限 n>0；按阶段复算 B4 本账户，核竞争、拒绝与 POST 失证。 |
| 程序载体 mdah-b4-program | programmable-spells-design.md | 重签 AST/hash 纸面别名、读索引和 M/tick/S 条件界；核双接触、壳损与球本体容量。 |
| 生命身份 mdah-b4-life | life-identity-design.md | 按新壳读与付款核惰性修壳、遗体身份和失败余态，不推成复苏。 |
| 唯一理论 mdah-theory | world-theory-draft.md | 按新事实/价版重放自然先序、逐账付款、程序与生命；核六类余态和 POST 失证。 |
| 玩家桥接 mdah-bridge | player-bridge-design.md | 六入口及同书往返消费现行五份权威，重签公开提示、私值裁剪与失败余额。 |

依赖：物理读证 → 账本价版 → 程序与生命 → 唯一理论 → 玩家桥接。每项独占一份模块正文；module-design.md、docs/status.md 与最终一致性由 Version PM 收束。ADR 0024、World/VM 接入和真实体验沿已有后续门禁，不在本节点重派。

同一事实用 S0-physical-v1/seed-physical-v1、C-B1-01→N-B1-impact-01→X-B1-shell-v1、B4-v1/slice-B4-01、readId/receiptId/payerId/priceVersion 及碰后结构/材料/接触/锚版核对。物理签端点与 E0/12、q；账本签逐账户 M；程序签 AST/hash 与容量；生命签身份；理论签因果；桥接签公开投影。消费方定向反查当前正文和唯一理论的同键段落，逐项对照现行来源结论；冲突或不能静态定价列阻断。纸面参数与账目不得称为现场原读、实扣或实玩。
