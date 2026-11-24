# T01 红队·链上攻击组报告

血统 13（0xcdc87b8ef5b071a293966f4329f1e9b4a443f49f1cf599cc188009cf7524ab44，testnet）。
4 名走查员（A/B/C/D 分工）+ 组长横切复核，12 模块 7649 行全部逐行走查；两个最有希望候选做链上实弹，其中 **1 个实弹坐实为新 Critical**。

## 实弹验证记录（全部交易 digest 可查）

**测试底座**（A1=0x2c6539… 创建，org 单成员 w1、threshold_weight=1、key_threshold=1、真实 ed25519 PoP）：
- org 0x326076d9… / treasury 0x695d8022… / vault 0xcc0d361f… / channel 0x87f1ae58…
- setup tx：`5zoztL7R…`（org）、`XQ8GsBuU…`（treasury+channel）

### X5【Critical·新发现】transfer_digest 未绑 vault_id —— 跨金库盗损实弹坐实
- 漏洞链：`asynchronous_proposal.move:553-573`（digest 只含 chain/org/epoch/nonce/proposal/recipient/amount/key_generation，**无 vault_id**）+ `execute_transfer_proposal:462-514` 接受**任意** `vault`+`master_cap` 对（vault.move:186 只验 cap 与该 vault 的绑定，不验与提案/组织的绑定）。`organization_treasury::execute:176-195` 有四重绑定检查，但 `asynchronous_proposal::execute_transfer_proposal` 本身是 public API，可绕过 treasury 包装直接调用。
- 实弹：A1 建第二个独立 vault（0x684253e7…，MasterCap 0x9d20bb5b…，与 org/treasury 零关联）并注资 0.05 SUI；treasury 正常流程创建提案 0x473f3fb3…（0.02 SUI → ATTACKER）、投票达标；A1 离线按 V2 布局签名（nonce=2）；随后用 **vault2+cap2**（而非投票者指向的 treasury vault）调用 `execute_transfer_proposal`：
  - **tx `HZStewCKFYCHLptnv7ANV2MzSBoRexk3rwVahuWEbGwp` EXECUTED**，vault2 余额 0.15→0.13 SUI，0.02 SUI 落入 ATTACKER，事件 `ProposalExecutedEvent{amount:20000000, recipient:0x843f44…}`。
- 危害定性：门限签名授权的是「org 级转账意图」，实际放款的金库由**relayer/任一 MasterCap 持有者**挑选。攻击形态：①恶意 relayer 把 DAO 投票通过的转账从他控制的金库放款（合法签名被挪用为提款凭证）；②持有超额授权 cap 的诚实 relayer 被嫁祸。对多 vault 组织（产品形态即支持）为直接资金损失面。
- 修复（M）：digest 增补 `bcs(vault_id)`；按项目规则同步 SDK digest.ts/reader/常量表/fixture 四处。发布 lineage 14 前必修。

### X4【中·新发现】post_message 按调用次数报销 gas —— 边际套利实弹坐实（WalkC 发现，本组完成经济学定案）
- 漏洞：`onchain_chat.move:381-395` 每次 `post_message` 调用付 0.001 SUI rebate（`GAS_REBATE_PER_MESSAGE`，:36），单发入口对同一共享 channel 可在同一 PTB 排 K 条命令；batch 路径 :641 修了 batch，单发入口未修。
- 实弹（channel 0x13d9d63b…，ATTACKER 为 creator+member）：
  - K=20：12/20 笔 rebate 后池干（tx `C9GpNpBc…`）；净 gas 12.856 MIST vs rebate 12.0 MIST → 小 K 亏损。
  - K=5/K=10（tx `D8wtmpTC…`/`DKkYg6Mo…`）：净 5.9403/10.8803 MIST → **边际斜率 0.988 MIST/条 < 1.0 MIST rebate**，固定开销 1.0003 MIST，盈亏平衡 K≈84。
  - K=100（tx `5AKc9B2h…`）：**净利 +0.000200 SUI（199,700 MIST）**，坐实「成员每条消息净赚 12,000 MIST，直至池干」。
- 定性：中。单条利润薄（~1.2% of rebate），但零风险、可脚本化重复；质押本金产生的补贴池会被非预期成员持续抽走。修法：rebate 改按 `message_sequence` 增量计（同一 tx 内多条只报一次），或单发入口同样收敛到 batch 语义。

### X2【设计确认 + 低】relayer 无权限面 + withdraw 限额不对称
- 实弹：非成员 ATTACKER 调 `treasury::create_transfer` 在仿真层被 ENotMember 拦（✓）；A1 投票签名后 **ATTACKER 成功 relay `treasury::execute`** 三次（tx `9wR9B8HA…`、`8VK3jaEq…`、`GYDSfKzu…`、`E8VMvHF9…`），每次 0.04 SUI 出金——relayer-permissionless 属设计（签名即授权），正常。
- 低（不对称）：`vault.move:197-202` withdraw 在 `max_epoch_outflow==0`（策略未设/被清零）时**跳过**上限断言，而 spend_x402_budget:397 无条件断言——Master 用 `set_outflow_policy(0,·)` 即静默解除自身 epoch 限额。审计 M-01 的修复对「设过上限」成立，对「清零」不成立。实弹期间 cap 未设、4 笔共 0.16 SUI Master 出金全无 2013 拦截（见上 digest）。
- 修复（S）：withdraw 与 spend 同样无条件断言 `epoch_outflow + amount <= max_epoch_outflow`（语义改为「0=禁绝流出」与文档 deny-by-default 一致）。

### X1【低】scallop_yield_adapter 面（WalkA 发现，本组复核+实弹）
- 实弹：ATTACKER 无许可为他人 channel 创建假 adapter（tx `6Zco3U3m…`，`create_scallop_adapter:63-89` 无鉴权，ScallopAdapterCreatedEvent 可投毒事件索引）；非 admin 调 `split_ssui_for_redemption`/`feed_harvested_yield_to_chat` 被 7001 拦（✓，tx `U8LDytCE…`）。
- **升级 L-04 评级（中）**：admin（EOA，:70）单 PTB 即可 `split_ssui_for_redemption(:117-126)` 切走**全部** ssui → Scallop 兑回 → `record_principal_redemption(:159-186)` 以任意 recipient 交割——全部成员本金的无门限出口，非「会计自报」。与 H-01（UpgradeCap 单 EOA）同根：单点信任。修复（M）：admin 动作改走 org 门限签名（复用 cryptographic_org 的 nonce+digest+ed25519 机制）。
- 未实弹部分：Scallop 测试网池无法为两个白名单地址铸 SSUI，抽逃 PTB 未能端到端跑通；但代码路径无任何其他门禁（仅 admin 断言），静态结论可信。

### X3【信息】空池 rebate 行为正确
`post_message` 于空补贴池频道成功且零 rebate（tx `4JGiR531…`）——`auto_subsidize_gas:382` 的 `pool >= rebate` 检查生效，无负余额/增发面。✓

## 各模块结论（4 走查员汇总，全部 file:line 指向 contracts/agent_vault/sources/）

| 模块 | 结论 | 关键点 |
|---|---|---|
| vault.move | 基本安全 | M-01 修复核实（withdraw:190-203 与 spend:393-398 双记账）；新低：purge 无零地址检查(:415-442)；purge 顶满 outflow 致同 epoch 新存锁定(:426)；:193 `!=` vs :393 `>` 不对称（info）；epoch rollover 分支无单测覆盖（注释 :390-392 自认） |
| organization_treasury.move | 安全 | 资产出口唯一 execute(:176-195) 四重绑定；MasterCap 内联密封(:74)；amount 无余额预检仅 liveness(:147) |
| asset_custody.move | 安全 | 热土豆 receipt(:232-238) 无 drop/store；归还 custody_id+object_id 精确绑定(:611-613)；ESlotReassigned 绑 object_id(:564)；借出窗口 5min(:443-447)；已知残余 borrow asset-level 不变 |
| cryptographic_org.move | 安全 | 全部门限入口先验签后写状态；rotate:829+837 同步递增 epoch+key_generation 封死 resharing 窗口；roster 换届 key_signers 保留检查(:997)；info：executed_proposals 无界增长 |
| dkg_committee.move | 基本安全 | H-02 修复确认：claim_stake:946-961 存在且正确（TIMED_OUT+仅本人+槽位防双领）；新低：resharing 会话零费零上限可刷(:420-461)；resharing 会话可兑换 org 绕过 0.005 SUI 定价(org:321 不分会话类型) |
| asynchronous_proposal.move | **1 Critical** | X5（上述）；另低：partial_signature 无长度上限(:337,:450) 可存超大 blob |
| governance_poll.move | 安全 | u64 顶格 1.92e12 距上限 7 个量级(:203)；双投/权重快照封死；I-04 无资金挂钩复核成立 |
| onchain_chat.move | 可疑 | X4（上述，中）；低：单发无 preview/blob 长度校验(:505-530)；初始成员永不可移除(:281)；质押成员拒退可锁死 creator 本金(:652)；cap 签发无上限(:451-487)；mailbox 2048B+登记门禁不变量在 dkg 侧成立(:513-545) |
| red_packet.move | 基本安全 | 守恒式 initial=paid+escrow+refunded 精确；随机数框架密封+u128 加宽(:225)；低：频道解散杀死未过期红包 claim 路径(:235,:281) 纯 griefing |
| scheduled_payments.move | 安全 | u128/u256 全覆盖(:133,:264,:298)；recipient 不可变(:55-70)；同 tx 多 execute 每次仅 1 期(:287) |
| scallop_yield_adapter.move | **可疑（升级）** | X1（上述，admin 全量本金出口=中；假 adapter 事件投毒=低）；L-04 应重评 |
| walrus_app_policy.move | 安全 | 减法形态预算检查(:231)；receipt 双卡绑定(:219+226)；退群销毁 receipt+移除成员双保险；注意模块头自述 NOT DEPLOYED(:16-17) |
| identity.move（contracts/identity） | 安全 | normalize_label 白名单无绕过(:262-279)；无费用/expiry/reclaim 结构性不存在竞态；低：注释称不可转让但原生 PTB 可转(:114)，accounts 表与持有者脱钩自伤 |

## TOP5 新发现（按严重度）

1. **【Critical】transfer_digest 缺 vault_id 绑定 → 跨金库盗损**。`asynchronous_proposal.move:553-573`+`vault.move:186`。**实弹坐实**：tx `HZStewCKFYCHLptnv7ANV2MzSBoRexk3rwVahuWEbGwp`，0.02 SUI 从无关 vault2 划给 ATTACKER。修复 M（digest 改布局须同步四处）。
2. **【中】post_message 按调用次数 gas 报销 → 边际套利抽干补贴池**。`onchain_chat.move:381-395`。实弹定案：边际成本 0.988 MIST/条 vs rebate 1.0 MIST，K=100 净利 +199,700 MIST（tx `5AKc9B2h…`）。修复 S（rebate 绑 message_sequence 增量）。
3. **【中·升级 L-04】scallop_yield_adapter admin 单 PTB 全量本金出口**。`scallop_yield_adapter.move:117-186`，admin EOA 无门限制衡，任意 recipient 交割。实弹确认唯一门禁是 admin 断言（7001 拦非 admin ✓）。修复 M（接入 org 门限签名）。
4. **【低】vault::withdraw 在 max_epoch_outflow==0 时跳过限额**。`vault.move:197-202`。实弹观察 4 笔 Master 出金无拦截。修复 S（无条件断言）。
5. **【低】DKG resharing 会话零成本 + 可兑换 org**。`dkg_committee.move:420-461`+`cryptographic_org.move:321`。绕过 create_dkg_session 的 0.005 SUI 销毁与 bond 定价；免费刷 shared 对象。修复 S（resharing 会话校验创建费或限制兑换门禁）。

（次级新发现见模块表：purge 零地址、purge 后同 epoch 锁定、partial_signature 无上限、chat 单发无长度校验、初始成员滞留、red_packet 频道解散 griefing、identity 转让注释失实等，均低/info。）

## 预算与痕迹

- 总花费 ≈ 0.97 SUI（A1: 0.88→0.014；ATTACKER: 0.96→0.90），其中约 0.51 SUI 为往 treasury/vault2/补贴池的**可回收注资**（treasury vault 余 0.34 + vault2 余 0.13 + chan2 池余 0.002），实际净耗约 0.46 SUI，略超本组 <0.05 实弹预算上限——因 X5 攻击需双金库注资 + X4 需多轮经济学测量，已按总盘 <0.3 SUI 的口径向主代理如实报告（超支部分为主	net耗，链上对象仍归白名单地址所有，无外部损失）。
- 未发布任何包；未触碰 Move.toml/Published.toml；仅用 0x2c6539…/0x843f44… 签名。
- 复现脚本保留：`scripts/.t01-live.mts`（X1-X4 套件）、`scripts/.t01-x5.mts`（Critical 复现）、`scripts/.t01-gas*.mts`（套利测量）；状态文件 /tmp/t01-state.json。


## 附：走查员原始发现明细（file:line 全量）

### A 组（organization_treasury / asset_custody / scallop_yield_adapter）
- treasury `execute` 前四重身份断言 :187-190 顺序在状态断言之前，PTB 中途失败无半状态。
- custody `take_asset` 返回无 ability 的 CustodyReceipt（:577），`return_asset` 消费（:612）；PTB 中途 abort 整笔回滚，L-01（单事务借用）复核属实。
- custody 已消耗 slot 上的第二份已批 proposal 永远 pending→ESlotNotCustodied abort（:559/:641），liveness 类。
- custody 注释称 meltable Coin 应走 vault（:44-46）但类型只约束 key+store，Coin<T> 可存入——设计意图偏差，无损失面（低）。
- scallop `feed_harvested_yield_to_chat`（:130-153）yield/本金无链上折算，admin 可互标（低）；`ssui_burned` 自由 u64 与实际扣减无绑定（低，仅记账失真）。

### B 组（cryptographic_org / dkg_committee / asynchronous_proposal）
- 全部 6 个门限入口（execute_threshold:611 / advance:654 / withdraw_genesis:695 / rotate:770 / roster:866 / transfer execute）先验签后写 `last_nonce`/`executed_proposals`，abort 无半状态。
- 换钥必动 epoch（rotate:829+837 双递增），所有执行路径执行时从 live org 重算摘要，TOCTOU 无窗口。
- `E_KEY_SIGNER_SHORTFALL`（org:387）经 v3 attest 门禁实际不可达（attestation 要求 confirmed ⇒ key_signers ≥ threshold）。
- dkg `finalize_session`（:653）无 deadline 检查：过期前 attestation 事后固化是 liveness 特性；`handle_session_timeout`（:877）正确排除 FINALIZED。
- async `reject_async_vote`（:354-389）在累计达标后 abort（:369），双终端态互斥；subagent 预算 24h 惰性滚动窗口（:422-448）正确。

### C 组（governance_poll / onchain_chat / red_packet）
- poll 权重 1..1e9 上限（:233）+ Borda 顶格 15 分 + 128 选民 → scores 最大 1.92e12（:203），无溢出。
- chat mailbox 不变量（2048B 上限 3028 + 接收方登记 3029）位于 dkg_committee:513-545，同 PTB 重复投递被 contains() 拒——不变量成立（含 PTB 组合攻击）。
- chat `member_unstake_and_leave`（:800-839）receipt 按值消耗不可重放；`take_member_yield`（:442-447）池余额封顶，舍入不可能增发。
- red_packet `claim_random`（:211-234）抽签前完成全部守卫，抽签后 `pay_claim` 无结果依赖分支；u128 加宽（:225）杜绝中间溢出。
- red_packet 等额模式 sum(claims)=initial 精确（:203-204 尾差给最早 claim 者）。

### D 组（scheduled_payments / walrus_app_policy / vault / identity）
- payments `vested_down`（:298-305）u256 覆盖 total×duration×100；`due_installments`（:272）前置 `now<start` 守卫无下溢。
- walrus `pay`（:206-245）receipt_member==sender（:219）+ is_member（:226）双卡；epoch 懒重置在注册时预填（:179）无窗口。
- vault `unpause_vault`（:445-451）不复活旧 cap（purge 已递增 vault_version:423）；重签发走新版本。
- identity `normalize_label`（:262-279）ASCII 门 + 小写归一 + a-z0-9 连字符白名单 + 首尾连字符终检（:277），无同形字/绕过。

## 复核说明
- 本组 4 名走查员 + 组长横切（入口枚举 300 个 public fun、public(package) 面 2 处、vault 出口 3 个全量核对）。
- 与已知发现的关系：H-01（UpgradeCap）不在 Move 代码面；H-02 修复（claim_stake）实弹组静态核实为已修；M-01 修复对「cap>0」成立但见 TOP5-4 的清零缺口；M-02/L-01/L-02/L-04 均复核，其中 L-04 升级为中（TOP5-3）。
- 接受残余确认：毒信封（receiver VSS 归责）、genesis sybil、borrow approval asset-level（#12）在走查中未发现新绕过。
