# agent_vault 第三方安全审计报告

- 审计对象：`contracts/agent_vault/sources/`（12 模块，7,230 行 Move）
- 审计类型：源码审计（白盒，定向核查 + 抽查），未含形式化验证
- 报告版本：v1.0
- 依据基线：Move 单元测试 418/418 全绿；红队 10 轮、35+ 发现全部闭环（本报告不重复计分，仅在残余风险中复述未闭环项）
- 结论摘要：**有条件通过**，2 项 High（1 项部署面、1 项资金锁定路径）需在 TGE/主网上线前处置，详见 §6

---

## 1. 范围与方法

### 1.1 范围

| 类别 | 内容 |
|---|---|
| 源码 | `vault`、`cryptographic_org`、`dkg_committee`、`asynchronous_proposal`、`organization_treasury`、`asset_custody`、`governance_poll`、`onchain_chat`、`red_packet`、`scheduled_payments`、`scallop_yield_adapter`、`walrus_app_policy` |
| 客户端摘要实现 | `packages/multisig/src/agent-vault/org/digest.ts`、`bcs.ts` |
| 既有材料 | `docs/THIRD_PARTY_AUDIT_SCOPE.md`、`docs/PRELAUNCH_CHECKLIST.md`、`docs/RESHARING_SECURITY.md` |

### 1.2 方法

1. 以 `transfer::public_transfer`、`balance::split`、`withdraw`、`dynamic_field::remove` 为锚点枚举**全部资产出口**，逐个回溯到授权断言，而不是逐行通读。
2. 以域常量（`DOMAIN_*`）为锚点，把 Move 侧 9 个摘要构造函数与 SDK `digest.ts` 的拼接顺序、编码逐字段对照。
3. 对状态机模块（proposal / custody / dkg）核对 `status` 迁移、快照字段与执行期实时字段的一致性（TOCTOU 检查）。
4. 对 hot potato、动态字段键、共享对象身份绑定做人工可满足性分析。
5. 抽查读入规模上界（VecMap / Table / 消息体）以确认无无界存储写入。

### 1.3 明确未覆盖（不在本报告担保范围内）

- **无形式化验证**：未对摘要编码、FROST 聚合验签、状态机做机器证明；本报告结论为人工推理。
- **无第三方审计历史**：本次为首次外部白盒审计；此前仅有内部复核与红队演练，二者不可替代第三方意见。
- **无主网部署验证**：未对主网字节码/ABI/对象布局做比对；`Published.toml` 记录的是测试网 lineage，源码与已部署字节码的一致性未验证。
- 未做链上模糊测试、未做 gas/存储成本分析、未审 `packages/multisig` 其余业务代码、未审前端与密钥管理。
- 未评估密码学原语实现本身（FROST/DKG 正确性依赖客户端库，链上只做 ed25519 验签与小阶点拒绝）。

---

## 2. 资产流图与信任边界

### 2.1 资产流图

```mermaid
flowchart LR
    subgraph P0["持有人 / 成员"]
        M[MasterCap 持有者]
        MEM[组织成员<br/>members+weights]
        AG[Agent 卡<br/>AgentCap]
        SB[Subagent 协签<br/>SubagentCoSignCap]
    end

    subgraph V["agent_vault::vault"]
        BAL[(Balance&lt;T&gt;)]
        POL[max_epoch_outflow<br/>max_agent_budget]
    end

    subgraph GOV["cryptographic_org + async proposal"]
        ORG[Organization<br/>group_pk / epoch / key_generation / nonce]
        PROP[Proposal<br/>accumulated_weight ≥ threshold]
        FROST[FROST 聚合签名<br/>Ed25519 verify]
    end

    subgraph T["organization_treasury"]
        TR[OrganizationTreasury<br/>内联 MasterCap]
        BIND[TransferBinding<br/>treasury_id + proposal_id]
    end

    subgraph C["asset_custody"]
        INV[(dynamic_object_field<br/>按 TypeName+slot 索引)]
        REC[CustodyReceipt<br/>无 abilities]
    end

    subgraph OTH["外围价值流"]
        DKG[DkgSession<br/>bond + genesis stake]
        PAY[scheduled_payments]
        RP[red_packet escrow]
        CHAT[onchain_chat 质押/收益]
        SCA[scallop adapter<br/>admin 中继]
    end

    M -->|withdraw 无额度约束| BAL
    AG -->|spend_x402_budget<br/>日额度+epoch 流出| BAL
    MEM -->|投票/驳回| PROP
    PROP -->|threshold 达成| FROST
    FROST -->|nonce 单调 + 摘要绑定| PROP
    PROP -->|execute_transfer_proposal| BAL
    TR -->|execute: 校验 binding| BIND
    BIND -->|proposal 身份绑定| PROP
    TR -->|内联 MasterCap 调用 withdraw| BAL
    INV -->|take_asset 借出原子窗口| REC
    REC -->|return_asset 同事务| INV
    INV -->|execute_release| RCV[proposal.recipient]
    MEM -->|bond / stake| DKG
    DKG -->|claim_bond 仅本人| MEM
    DKG -->|take_genesis_stakes<br/>public(package) 扫入| ORG
    PAY -->|claim / execute_installment| RCV
    RP -->|claim_equal / claim_random| MEM
    CHAT -->|收益分润 / 退群清算| MEM
    SCA -->|record_principal_redemption<br/>admin 自报 ssui_burned| MEM
```

### 2.2 信任边界图

```mermaid
flowchart TB
    subgraph TB1["边界 1：链下 ↔ 链上（摘要拼接）"]
        SDK["SDK digest.ts<br/>chain_id/org/epoch/nonce/…"]
        MV["Move 摘要构造函数<br/>bcs::to_bytes 拼接"]
        SDK <-->|必须逐字节一致| MV
    end

    subgraph TB2["边界 2：成员多数 ↔ FROST 密钥持有者"]
        VOTE["异步投票<br/>链上实时名册权重"]
        KEY["FROST 签名者集合<br/>key_signers / key_threshold"]
        VOTE -->|只决定门限是否达标| EXEC
        KEY -->|唯一签名授权来源| EXEC[execute_transfer_proposal]
    end

    subgraph TB3["边界 3：组织治理 ↔ 金库根权限"]
        TRU["OrganizationTreasury<br/>MasterCap 不可独立寻址"]
        RAW["裸 AgentVault<br/>MasterCap 由 EOA 持有"]
        TRU -->|只能经 execute + FROST| VAULT[(vault 余额)]
        RAW -->|MasterCap 即根权限| VAULT
    end

    subgraph TB4["边界 4：链上 ↔ 链下隐私/中继"]
        MAIL["DKG mailbox 密文 2048B 上限"]
        STAKE["attest 签名 = Round-1 公布钥真签名"]
        CHAIN[("链上只存密文，<br/>无解密/无发送方签名归责")]
        MAIL --- CHAIN
        STAKE --- CHAIN
    end

    subgraph TB5["边界 5：部署面"]
        CAP["UpgradeCap 托管方式<br/>（源码范围外）"]
        OPS["运维密钥 / RPC / 前端"]
    end
```

**边界判定**：TB1、TB2、TB3 是本次审计确认的**有效**安全边界；TB4 的发送方归责明确缺失（见 §5）；TB5 是当前**最薄弱**的一环（见 H-01）。

---

## 3. 摘要域分离逐字节布局

以下 4 个摘要为资产授权的直接依据，全部采用 `SHA-256`，域字符串以原始 ASCII 字节前置、无长度前缀；`bcs(ID)` 在 Sui 中等价于 32 字节地址。

### 3.1 国库转账 `SUI_ORG_TREASURY_TRANSFER_V2:`（`asynchronous_proposal.move:545-568` ↔ `digest.ts:164-189`）

| # | 字段 | Move 序列化 | SDK 序列化 | 字节数（testnet） |
|---|---|---|---|---|
| 1 | domain | `b"SUI_ORG_TREASURY_TRANSFER_V2:"` | `utf8(...)` | 29 |
| 2 | chain_id | `*chain_id`（原始字节） | `chainBytes()` | 12（`sui-testnet:`） |
| 3 | org_id | `bcs::to_bytes(&ID)` | `requireAddress` | 32 |
| 4 | epoch | `bcs(u64)` | `u64le` | 8 |
| 5 | nonce | `bcs(u64)` | `u64le` | 8 |
| 6 | proposal_id | `bcs(&ID)` | `requireAddress` | 32 |
| 7 | recipient | `bcs(&address)` | `requireAddress` | 32 |
| 8 | amount | `bcs(u64)` | `u64le` | 8 |
| 9 | key_generation | `bcs(u64)` | `u64le` | 8 |
| | **合计** | | | **169** |

关键结论：`key_generation` 进入摘要，`rotate_group_key`（`cryptographic_org.move:837`）递增该值后，旧分片既签不出新摘要，旧摘要也因 nonce/代际不匹配无法重放，resharing 窗口被关闭。

### 3.2 门限提案 `SUI_ORG_THRESHOLD_PROPOSAL_V2:`（`cryptographic_org.move:532-553` ↔ `digest.ts:30-54`）

| # | 字段 | 编码 | 字节数 |
|---|---|---|---|
| 1 | domain | raw ASCII | 30 |
| 2 | chain_id | raw | 12（可变） |
| 3 | org_id | BCS ID | 32 |
| 4 | epoch_version | BCS u64 | 8 |
| 5 | nonce | BCS u64 | 8 |
| 6 | payload | **raw bytes，无长度前缀** | 可变 |
| 7 | action_type | BCS u8 | 1 |
| | **合计** | | **91 + len(payload)** |

关键结论：`action_type` 进摘要，签名即"动作类别"授权；payload 无长度前缀，但因后续仅 1 字节动作域且域串隔离，不存在结构性歧义（跨域碰撞被 domain 前缀排除）。

### 3.3 纪元推进审批 `SUI_ORG_EPOCH_ADVANCE_V2:`（`cryptographic_org.move:555-580` ↔ `digest.ts:57-81`）

| # | 字段 | 编码 | 字节数 |
|---|---|---|---|
| 1 | domain | raw ASCII | 25 |
| 2 | chain_id | raw | 12 |
| 3 | org_id | BCS ID | 32 |
| 4 | epoch_version | BCS u64 | 8 |
| 5 | nonce | BCS u64 | 8 |
| 6 | new_epoch_version | BCS u64 | 8 |
| 7 | key_generation | BCS u64 | 8 |
| | **合计** | | **101** |

### 3.4 密钥轮换 `SUI_ORG_KEY_ROTATION_V3:`（`cryptographic_org.move:510-530` ↔ `digest.ts:84-112`）

| # | 字段 | 编码 | 字节数 |
|---|---|---|---|
| 1 | domain | raw ASCII | 24 |
| 2 | chain_id | raw | 12 |
| 3 | org_id | BCS ID | 32 |
| 4 | epoch_version | BCS u64 | 8 |
| 5 | nonce | BCS u64 | 8 |
| 6 | new_group_pk | raw 32B（Move 侧未校验长度；SDK 侧 `requireDigest32`） | 32 |
| 7 | new_signers | BCS `vector<address>`：uleb 长度 + 32B×n | 1 + 32n |
| 8 | key_threshold | BCS u64 | 8 |
| | **合计** | | **125 + 32n**（n < 128） |

附录（同法核对，均一致）：`POP_V2` 77+40n、`POP_V1` 92、`ROSTER_V1` 141+40n、`GENESIS_WITHDRAW_V1` 133、`DKG_ATTEST_V1` 82（不含 chain_id，靠 session_id 唯一性隔离）。

### 3.5 核查结论（对应任务问题 6）

**SDK 与 Move 侧 4 个摘要逐字节一致，未发现编码歧义或字段顺序漂移。** 9 个摘要全部对齐。三点保留意见：

- `bcs(ID)` 依赖 Sui `ID` 结构体单字段 `bytes: address` 的透明 BCS 编码，这一点在框架升级中若改变会静默破坏兼容性；
- SDK 侧 `bcsVectorAddress` 要求调用方传入完整 32 字节 hex 且不做短地址补齐（`bcs.ts:82-89`），属于"安全失败"（抛错而非错签），可接受；
- 现有 SDK 测试（`redesign.test.ts:41-75`）用同一套 helper 构造期望值，属**自洽性测试**，无法发现两侧共享的同一误解。建议增加由 Move 侧 `vector<u8>` 常量或链上事件产出的 golden vector（见 L-03）。

---

## 4. 发现清单

分档统计：Critical 0 / High 2 / Medium 2 / Low 4 / Info 4。

### Critical

无。本次未发现可直接窃取资金、绕过 FROST 门限或凭空铸币的路径。

### High

#### H-01 升级权限仍由单地址 EOA 持有，治理封印未生效（部署面）

- 位置：`docs/THIRD_PARTY_AUDIT_SCOPE.md` §1（现行 lineage UpgradeCap `0xa1c3a646…`，owner `AddressOwner: 0x8ac06d3d…`，policy `0.0`）；12 个源码模块中**不含** `governed_upgrade`。
- 攻击场景：该 EOA 私钥泄露或被钓鱼 → 攻击者以 compatible policy 发布任意逻辑的升级包，替换 `organization_treasury::execute` 的绑定校验或 `vault::withdraw` 的 `MasterCap` 断言，一次性转走全部受治理金库与托管资产。链上所有既有对象仍归新字节码解释，FROST 门限、epoch、nonce 全部失效。
- 影响：全协议资金与治理完整性，且不可回滚（升级后旧逻辑不可恢复）。
- 修复建议：主网发布后立即把 UpgradeCap 封入 `governed_upgrade` 共享 wrapper，由组织 FROST 门限（建议 threshold_weight ≥ key_threshold 且 ≥ 2/3）审批升级；将 policy 从 `compatible` 收紧并公开 `UpgradeAuthorized` 事件监控；上线前在 PRELAUNCH_CHECKLIST 增加"cap owner 非单地址"硬门禁。
- 备注：属部署/运维缺陷而非源码缺陷，但对"能否上主网"是一票否决项。

#### H-02 DKG 超时会话中的创世质押超额部分永久锁定

- 位置：`dkg_committee.move:484-490`（缴款拆分：bond 进 `ParticipantBondSlot`，**余额全部**进 `ParticipantStakeSlot`，无上限校验）、`:942-965`（`take_genesis_stakes` 断言 `STATUS_FINALIZED`）、`:909-930`（`claim_bond` 只退 `ParticipantBondSlot`，要求终态 FINALIZED 或 TIMED_OUT）。
- 攻击场景（非恶意，但可被诱导）：
  1. 参与者按 `create_dkg_session` 的 `payment` 语义缴入超过 `session_bond_mist` 的金额（函数注释仅说明"bond 部分强制托管，余额记为创世质押"，未提示余额不可退）；
  2. 会话因成员离线/网络问题 `handle_session_timeout` 进入 `TIMED_OUT`；
  3. 此时 `claim_bond` 只退回 bond；`take_genesis_stakes` 因要求 `FINALIZED` 不可调用；`ParticipantStakeSlot` 无任何其他 `dynamic_field::remove` 路径（全仓 grep 仅 `:490` 写入、`:951` 读取删除）。
  4. 结果：超额部分永久冻结在 `DkgSession` 共享对象内。
- 影响：用户资金永久损失；金额无上界（缴多少锁多少）。终态不可达 FINALIZED 的比率在早期网络并不低。
- 修复建议：三选一——(a) `handle_session_timeout` 后开放 `claim_stake`，把 `ParticipantStakeSlot` 原路退回；(b) 对 `payment.value() - bond_mist` 设上限（如 ≤ 2×bond）并在 SDK 层默认精确付款；(c) 超时终态下允许 `take_genesis_stakes` 退还给各 participant（Pull 模型），与 `claim_bond` 保持"纯退款、无罚没"的一致性。

### Medium

#### M-01 `max_epoch_outflow` 只覆盖 Agent 路径，不覆盖 Master 出口，与文档"金库总支出的硬上限"表述不符

- 位置：`vault.move:209-211`（注释称"限制单个 epoch 内金库总支出的硬上限"）、`:331-374`（`spend_x402_budget` 是**唯一**记账 `epoch_outflow` 的入口）、`:171-186`（`withdraw` 无任何额度/暂停校验）、`:385-407`（`emergency_unilateral_purge` 全额扫出，同样不记账）。
- 攻击场景：
  1. 若运维将 `MasterCap` 放入热钱包/自动化服务（文档场景中的"agent 金库"常如此），攻击者取得 MasterCap 后可无限额、无日切地 `withdraw`，`max_epoch_outflow` 不产生任何限制；
  2. 审计方按字段名/注释预期"金库级流出上限"能约束所有出金，实际只能约束 Agent 卡路径，形成防护预期偏差；
  3. `organization_treasury` 场景下 MasterCap 被封死，风险不成立——但两种 vault 用法共用同一模块与同一份文档。
- 影响：MasterCap 泄露时损失不设上限；监控/风控模型若按 `epoch_outflow` 做告警会漏报 100% 的 Master 流出。
- 修复建议：把 `withdraw`/`emergency_unilateral_purge` 也纳入同一套 `epoch_outflow` 记账（purge 可豁免但必须发事件并把 `epoch_outflow` 置为 `max` 以便监控）；或在文档与 `set_outflow_policy` 注释中明确"该上限仅约束 Agent 卡"，并增加独立的 `MasterWithdrawnEvent` 监控口径。
- 结论文本（对应任务问题 1）：**不覆盖**。`spend_x402_budget` 的 outflow 上限未覆盖所有出金入口；`transfer::public_transfer` 在 12 模块中共 20 处，其中 5 处直接或间接从 `AgentVault.balance` 拆分（`vault.move:184`、`:373`、`:401`，`asynchronous_proposal.move:507`、`:537` 经 `vault::withdraw`），仅 `:373` 一条路径记账。

#### M-02 Subagent 可单方面占用主账号投票席位且不可撤销

- 位置：`asynchronous_proposal.move:395-459`（`submit_async_vote_by_subagent` 以 `master` 为键写入 `proposal.voters`）、`:445`（`assert!(!proposal.voters.contains(master), E_ALREADY_VOTED)`）、`:302-310`（`revoke_subagent_cosign_cap` 只置 `is_revoked`，不回溯已投的票）。
- 攻击场景：主账号签发了一张权重为 w 的协签卡给自动化代理。代理被入侵后，对一个攻击者构造的恶意转账提案投下赞成票（金额在 `max_budget_per_tx` 内），随后主账号即使立刻吊销 Cap，该票已永久计入 `accumulated_weight`，主账号**无法改投或撤票**（`voters` 已含 master）。若被入侵的代理卡权重足以单独达到门限，提案可直接执行。
- 影响：治理完整性——主账号对自身席位的最终控制权被削弱；吊销不具回溯性。
- 修复建议：(a) 允许 `master` 在提案未执行前覆盖/撤销 subagent 投出的票（以 `voters` 中记录 `cast_by_subagent: bool` 区分，仅允许 master 本人重写）；(b) 或把 subagent 投票改为"待主账号确认"的两段式；(c) 至少把 `max_budget_per_tx` 与提案 `amount` 的额度消耗改为"仅对执行成功的提案计费"，避免代理用额度消耗做 DoS（当前每投一票即消耗额度，见 `:453-455`）。
- 备注：不构成越权（权重 ≤ 主账号名册权重，`:240` 已断言），属授权粒度不足。

### Low

#### L-01 托管"借出"实为单事务原子借用，无法支持跨交易借贷

- 位置：`asset_custody.move:229-238`（`CustodyReceipt` **无任何 abilities**）、`:541-599`（`take_asset` 返回 `(Asset, CustodyReceipt)`）、`:606-622`（`return_asset` 消费 receipt）。
- 分析（对应任务问题 3）：hot potato 语义正确。receipt 无 `drop`/`store`/`key`/`copy`，因此：
  - 无法存入对象、无法转给他人、无法跨交易携带；
  - 若 PTB 结束仍持有 receipt，VM 报"unused value without drop"并**整体 abort**；
  - 若 PTB 中途 abort，Sui 事务原子回滚，资产与槽位恢复原状。
  **结论：不存在"资产永久锁定"路径。**
- 影响（功能性而非安全性）：所谓 `KIND_BORROW` 只能做同事务内的临时取出（如把 `UpgradeCap` 拿去做一次授权后即刻归还），不能做真实世界的长周期抵押/借贷。若未来升级给 receipt 增加 `store`，将立刻退化为"可携出托管"，必须视为破坏性变更。
- 修复建议：在 `CustodyReceipt` 定义处加显式不可变注释与 CI 断言（禁止为 receipt 增加 abilities）；文档把 `BORROW` 更名或注明"atomic borrow"。

#### L-02 DKG 申报可被反复改写，finalize 存在低成本持久化 griefing

- 位置：`dkg_committee.move:681-720`（`attest_group_key` 允许在 `ROUND_2_MAILBOX` 内任意覆盖自己的申报）、`:647-670`（`finalize_session` 要求 `attestation_count_for(session, final_pk) >= threshold`）、`:868-893`（超时清退）。
- 攻击场景：恶意成员在诚实成员完成申报、即将有人调用 `finalize_session` 时，把自己的申报翻转到另一个 32 字节值，使诚实密钥的申报数降到 threshold-1，迫使 finalize abort；重复成本仅为 gas，最长可拖到 deadline，之后会话只能 `TIMED_OUT`（叠加 H-02 即造成资金损失）。
- 影响：可用性；不能伪造密钥（申报需 Round-1 公布钥的真签名，`:700-714`，且小阶点被拒 `assert_not_small_order_pk`）。
- 修复建议：允许"锁定申报"（一旦 finalize 门限满足的密钥可被任一中立者 `freeze_key(group_pk)`，冻结后不可再改）；或 finalize 允许附带"最近 N 个区块内的申报快照"以消除竞态；最低成本方案是把该 griefing 的经济成本纳入 bond 罚没（当前 bond 在超时下全额退还，`claim_bond` 无罚没）。

#### L-03 摘要测试为自洽性测试，缺少跨语言 golden vector

- 位置：`packages/multisig/src/agent-vault/org/redesign.test.ts:41-75` 等。
- 分析：期望值由同一组 `txt/u64/sha256` helper 现拼，若 Move 侧与 SDK 侧对同一字段存在**相同误解**（如 `bcs(ID)` 的编码假设），测试无法发现。已人工核对 9 个摘要一致，但该保证不可持续。
- 修复建议：以 Move 测试中的 `vector<u8>` 常量（或链上 `ProposalCreated`/`TransferCreated` 事件里的真实摘要）作为 golden vector 固化到 SDK 测试；CI 中同时跑 Move 测试与 SDK 测试，任何一侧改动即失败。

#### L-04 Scallop 适配器的会计字段由 admin 自报，存在账实漂移

- 位置：`scallop_yield_adapter.move:156-190`（`record_principal_redemption(adapter, sui_returned, ssui_burned, recipient)` 中 `ssui_burned` 未与任何 sSUI 余额对账；`total_staked_sui_principal` 按传入 coin 面值递减）。
- 分析：本金交付是真实的（`transfer::public_transfer(sui_returned, recipient)`，事实源为 `coin.value()`，已修复旧版裸 u64 问题），但 `ssui_burned` 与 `total_staked_sui_principal` 纯记账。admin 可写出与真实赎回不一致的账面数字，导致 `total_harvested_yield_sui` / 本金基准线失真，进而影响收益分配口径。
- 影响：会计完整性，无直接资金窃取（收益分配走 `onchain_chat::distribute_staking_yield`，其金额来自真实 coin）。
- 修复建议：要求调用方同时传入并销毁 sSUI `Coin`（或 `Balance`），用其面值作为 `ssui_burned`；或把 adapter 改为实际托管 sSUI 对象，使账实同源。

### Info

#### I-01 默认构造函数写入 testnet 域串

- `cryptographic_org.move:38`（`DEFAULT_CHAIN_ID = b"sui-testnet:"`）、`:276-287`（默认 `create_organization` 使用该值）。
- 主网组织若误用默认入口，摘要的 chain 段将写死 "sui-testnet:"。这**不构成跨链重放**（摘要同时绑定 org_id，且对象只存在于单链），但会造成主网/测试网签名工具链混用时的排障困难与审计混淆。建议主网 SDK 强制显式传 `chain_id`，并把默认入口标记为 testnet-only。

#### I-02 `#[test_only]` 绕过入口需在发布构建中确认剥离

- 例：`asynchronous_proposal.move:519`、`cryptographic_org.move:1204`、`organization_treasury.move:246`、`asset_custody.move:818` 等 `*_for_testing`。
- 抽查确认全部带 `#[test_only]`，正常发布构建不导出。建议 CI 增加"发布字节码符号表不含 `for_testing`"的断言，防止误用 `sui move build --test` 产物发布。

#### I-03 存储上界已被约束

- DKG mailbox：`dkg_committee.move:86-91`（`MAX_MAILBOX_PAYLOAD_BYTES = 2048`，`E_PAYLOAD_TOO_LARGE = 3028`）、`:529-534`（接收方必须已登记 `EncryptionKeySlot`，`E_RECIPIENT_KEY_MISSING = 3029`）；
- 聊天：`onchain_chat.move:44-45`（preview 4096B、blob id 128B）、`:604-617`（批量 32 条先全量校验后写入）；
- 金库：`vault.move:28-31`（100 agent、service hash 256B）。
- 结论：未发现无界动态字段写入；所有持久化输入均有显式上限。

#### I-04 `governance_poll` 计分仅作参考，不授权资金动作

- `governance_poll.move:195-206`（`scores` 为纯视图，重复投票由 `:172` 的 `is_empty` 断言拒绝，截止前严格 `:`）。
- 结论：符合"咨询性投票"定位，不产生资产权限；若未来把 poll 结果接入门限执行，需重新审计（当前无此接线）。

---

## 5. 关键问题逐条结论

| # | 核查问题 | 结论 | 依据 |
|---|---|---|---|
| 1 | `spend_x402_budget` 的 outflow 上限是否覆盖所有出金入口 | **否**。仅 Agent 路径记账；`vault::withdraw`、`emergency_unilateral_purge`、treasury 的 `execute`（经 withdraw）均不记账。 | M-01；`vault.move:171-186/331-374/385-407` |
| 2 | `asynchronous_proposal` 的 voter 去重与 epoch 快照是否有 TOCTOU | **无 TOCTOU**。create 时快照 `epoch`/`threshold_weight`；vote 与 execute 均断言 `proposal.epoch == org.epoch_version()`（`:325`、`:363`、`:409`、`:479`），名册只能在 epoch 递增时变化，故投票期权重集合冻结。去重键为地址（subagent 以 `master` 为键），审批/驳回共用同一 `voters` 表，无法重复决策。 | `:168-312`、`:334`、`:368`、`:445` |
| 3 | `asset_custody` 热土豆 receipt 在 PTB 中途 abort 时资产是否永久锁定 | **否**。receipt 无 abilities，不可 drop/store/transfer；未消费即事务 abort 并原子回滚；消费即归还同一 custody/type/slot/object_id（`:612-621`）。限制是借用不能跨交易（L-01）。 | `asset_custody.move:229-238/541-622` |
| 4 | DKG bond 是否可被会话参与者在 finalize 前抢占 | **不可**。`claim_bond` 的键包含 `participant`，只允许 `ctx.sender()` 取自己的槽，且要求 `status ∈ {FINALIZED, TIMED_OUT}`；`take_genesis_stakes` 为 `public(package)` 且只扫 `ParticipantStakeSlot`、不碰 bond，并要求 `FINALIZED`。**未发现抢占路径**；但超时下 stake 无退款（H-02）。 | `dkg_committee.move:909-930/942-965` |
| 5 | `organization_treasury::TransferBinding` 是否可能绑到不同 org 的 proposal | **不可**。`create_transfer` 先断言 `self.org_id == org.id` 再经该 org 创建提案；`execute` 同时断言 treasury/org/vault/binding/proposal 五元身份（`:144-146`、`:187-196`），提案内 `org_id`/`epoch` 由 `execute_transfer_proposal` 再校验（`:471-480`）。`TransferBinding` 字段创建后不可变，且共享对象无 setter。 | `organization_treasury.move:143-196` |
| 6 | SDK `digest.ts` 与 Move 4 个摘要是否字节一致 | **一致**（另核 5 个共 9 个全部一致）。逐字段布局见 §3。保留意见：`bcs(ID)` 透明编码假设、缺跨语言 golden vector（L-03）。 | §3；`digest.ts:30-232` |

---

## 6. 残余风险

以下为已知且经评审接受的风险，本次审计确认其描述与代码现状相符；严重度为本报告评估。

| 编号 | 风险 | 现状与缓解 | 残余严重度 |
|---|---|---|---|
| R-01 | **创世 Sybil**：链上无法区分"一人多钱包" | 已经济定价：`0.005 SUI` 创建费直接转 `@0x0` 销毁（`dkg_committee.move:365-368`，先验额再整体销毁）；bond `0.05–0.5 SUI`（`bond_bounds`）；创世质押 90 天硬锁（`cryptographic_org.move:88`、`:695-735`）。攻击成本随女巫数量线性增长。 | 低（经济可承受时仍可刷量，属治理权重问题而非资金安全问题） |
| R-02 | **结构合法的毒信封**：内容为密文，链上无法判定 | 已缓解：2048B 上限（3028）+ 接收方必须已登记加密公钥（3029），可投递但无法污染他人份额；接收端 VSS 校验 + UI "broken 列表"归责。发送方签名归责明确缺失（`dkg_committee.move:520` 的 TODO）。 | 中低（可造成个别会话失败，叠加 H-02 时转化为资金锁定） |
| R-03 | **借出审批是资产级而非动作级** | `action_digest` 32B 承诺已进提案与事件（`asset_custody.move:161`、`:414-417`），但"PTB 实际动作 == action_digest"的相等性校验在 UI/链下。链上只保证借出的是**哪个对象**、必须同事务归还。 | 低（资产不会离开托管；偏离的是审批语义） |
| R-04 | 超时会话的创世质押无退款路径 | 见 H-02，**未闭环**。 | 高（金额无上界） |
| R-05 | 升级权限单点 | 见 H-01，**未闭环**（部署面）。 | 高 |
| R-06 | 门限不可达导致资金搁浅 | 设计上明确无个人找回权限（`organization_treasury.move:15-17` 注释承认）；`rotate_group_key` 需旧钥门限签名，无法自救。属"去中心化代价"。 | 中（需在用户协议与 UI 明示） |
| R-07 | 链下聚合器信任 `partial_signatures` | 表内部分签名不在链上验证，链上只验最终聚合签名 over `group_pk`。任何链下服务不得把该表当作"已签名集合"。 | 低（已由最终验签兜底） |

红队历史（10 轮、35+ 发现）已全部闭环的修复，本次抽查未见回归：轮次修复痕迹仍保留在代码中（如 `#12` borrow 窗口 `asset_custody.move:548-554`、`:79`；`#14` action_type 进摘要；`#20` 超时清退；`#21/#22` scallop 事实源与频道绑定；Round-9 `key_generation`；Round-10 mailbox 3028/3029）。

---

## 7. 结论：能否上主网

**结论：当前源码质量达到"可上主网候选"水平，但不满足无条件放行。** 核心资金路径（加权提案 + FROST over V2 摘要 + 单调 nonce + key_generation 换代封窗 + treasury 身份五元绑定）经人工核查成立，未发现可直接绕过的授权缺口；摘要跨语言一致性成立；418/418 Move 测试与 10 轮红队闭环提供了较强的回归保障。

**放行条件（全部满足方可上线）：**

1. **H-01 闭环**：主网 UpgradeCap 封入 `governed_upgrade`（或等价门限托管），owner 不再为单地址；升级 policy 与监控事件就位。
2. **H-02 闭环**：超时会话的 `ParticipantStakeSlot` 具备退款路径，或对超额缴款设硬上限并在 SDK 强制精确付款；两者择一并补测试。
3. **M-01 口径修正**：要么把 Master 出口纳入 `epoch_outflow` 记账，要么修改字段/文档语义并增加独立监控；不得让运维按"金库级硬上限"部署。
4. **M-02 处置**：至少提供 master 覆盖 subagent 票的路径，或在 UI/文档中明示"协签卡等于一次性不可撤回的投票授权"。
5. **部署面**：完成源码 ↔ 主网字节码的 ABI/模块清单比对；确认发布构建已剥离 `#[test_only]` 入口；`chain_id` 在主网显式传入。
6. **外部依赖**：FROST/DKG 客户端库需独立审计或至少提供第三方测试向量；`total_staked_sui_principal` 类账实漂移需在运营流程中定期对账。

**不建议在以下情形上线**：UpgradeCap 仍由单一 EOA 持有；或 DKG 作为创世准入的主要路径而 H-02 未修复（超时即永久锁仓会在早期网络高频发生）。

---

*本报告仅为第三方白盒审计意见，不构成投资建议或对未审计代码/部署环境的担保。审计基于当前工作区源码快照；任何后续变更需重新评估受影响条目。*
