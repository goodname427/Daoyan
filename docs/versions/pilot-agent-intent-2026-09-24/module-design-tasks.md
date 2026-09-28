# module-design 本轮任务：B1 普通壳首撞补证

最新 `drb2` 只退回首批 A 的 B1 普通 `k0` 壳首撞父先史。首批 A 与完整详细策划此前已获制作人批准；本轮无新增产品取舍，不将纸面样例当作实现。

| 模块任务                          | 独占成果                        | 相对上轮新增判断、反例与验收                                                                                                                      |
| --------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 物理 `mdag-physical-contact`      | `physics-material-design.md`    | 用有限形状、有效质量、部位、阈值和误差复算有证破壳且可接；同参数核不破、无撞、未知、再撞和双接触，签或撤 `C-B1-01→N-B1-impact-01→X-B1-shell-v1`。 |
| 架构 `mdag-architecture-coverage` | ADR 0018 覆盖提案               | 逐条处理双边接触、旧 `damage/Wm/lifetime`、接入、迁移与安全回退；实施前另过 ADR 采纳门禁。                                                        |
| 账本 `mdag-ledger-resign`         | `mana-ledger-design.md`         | 以新壳和读集重签 B4 逐 payer 价、收据、竞争与失败余态；J1 跨账户与 D1 独立账复核。                                                                |
| 程序 `mdag-program-resign`        | `programmable-spells-design.md` | 核 factId、同书 AST/hash 别名、B4 本体容量和双接触、再撞、壳损后旧证失效。                                                                        |
| 生命 `mdag-life-boundary`         | `life-identity-design.md`       | 核普通壳与关键回路、遗体、身份及死后权限，不把修壳推成复苏。                                                                                      |
| 理论 `mdag-theory-reconcile`      | `world-theory-draft.md`         | 按新 C/N/X 父先史复算因果和六类余态，逐事实键对照全部权威。                                                                                       |
| 桥接 `mdag-bridge-reconcile`      | `player-bridge-design.md`       | 重签推演台、演武场、返书改程序和六入口的成功、拒绝、空、未知、域外、竞争提示。                                                                    |

物理先行；账本据物理重签，程序和生命再消费账本；ADR 据物理另写；理论统一前述成果；桥接最后投影。旧轮次只读。共享 `module-design.md` 与 `docs/status.md` 由 Version PM 收束。

跨模块核对键：`S0-physical-v1/seed-physical-v1`、`C-B1-01→N-B1-impact-01→X-B1-shell-v1`、`B4-v1/slice-B4-01`、结构/接触/锚版、`sourceLotId/readId/receiptId/payerId/programIdentity/bookVersion`。物理主签 E0/12、q、±J、热和材料；账本主签逐付款方及跨账户；程序主签 AST/hash 与容量；生命主签身份；理论统一因果；桥接主签公开余态。任务按同键定向反查消费段，冲突列阻断，不以关键词代替来源结论。

策划交付只要求公理、初态、参数、逐步账目、反例和开发后可执行验收。真实原读、实扣、规范 AST/hash、本体旧占用、VM tick/S 及六入口实玩留开发与候选阶段。未来付费再撞、更多预设和敌方修士仅作扩展反例。若出现已批准范围外的玩家规则或不可逆数据损失，交主策判断是否升级。
