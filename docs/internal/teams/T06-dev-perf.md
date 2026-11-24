# T06 开发者·性能与成本组报告（链上 gas / 前端性能 / SDK RPC）

> 复核对象：血统 13 包 `0xcdc87b8ef5b071a293966f4329f1e9b4a443f49f1cf599cc188009cf7524ab44`（testnet）。
> 方法：① `sui move test --statistics`（421/421 全绿，指令 gas 差值 = 用例值 − 49,999,995,000,000 基线）；② `SuiGrpcClient.simulateTransaction` dev-inspect（0 SUI 花费，探测脚本已用毕删除）；③ `.next` 产物直接计量（app-build-manifest.json + chunk 文件字节数）；④ SDK 源码逐调用点计数。
> 本组未发起任何签名交易，链上花费 0 SUI（远低于 0.3 SUI 预算）。

---

## 一、链上 gas：每入口成本实测

### 1.1 dev-inspect 实测表（testnet 真实执行路径，gas price 1000 MIST）

| 入口 | n=3 | n=10 | n=50 | n=100 | 线性拟合（storage MIST） |
|---|---|---|---|---|---|
| `dkg_committee::create_dkg_session` | 0.0082 | 0.0099 | 0.0196 | 0.0333 SUI | `6,467,600 + 243,200·n`（R²=1.000） |
| `vault::initialize_vault<SUI>` | 0.0056 | — | — | — | 常数（storage 4,598,000） |
| `onchain_chat::create_channel_with_stake`(100 SUI) | 0.0098 | 0.0209 | 0.0848 | 0.1646 SUI | `3,974,800 + 1,596,000·n` |
| `cryptographic_org::create_organization_with_chain_id`（PoP 中止路径，只烧前置校验） | 0.0020 | 0.0020 | 0.0020 | 0.0362 | abort 于指令 78（1010 PoP 校验），n≤50 时计算费恒 1,000,000，n=100 跳到 2,630,000 |

`create_dkg_session` 的 computation 在 n≤50 恒为 1,000,000 MIST（≈1M gas units × price 1000），n=100 才涨到 2,540,000 —— 说明 `participants.contains` 线性扫 + `assert_participant_set` 的 O(n²) 去重在 128 人上限内不是计算费大头；**大头是 storage**，且每参与者仅 243,200 MIST（≈0.00024 SUI，一段 32B 地址在 `vector<address>` 里的边际成本）。整体成本结构健康。

### 1.2 move-test 指令差值 Top（--statistics，单位：差值 gas units）

- `governance_poll_tests::maximum_voters_weights_and_options_remain_within_u64` **722,878** —— 最大者也只是 u64 极值压力测试。
- `scheduled_payments_tests::curve_boundaries_and_maximum_intermediates` 407,390
- `red_packet_tests::max_count_greeting_and_duration` 366,155
- `walrus_app_policy_tests::maximum_name_and_app_count` 328,785 / `first_app_above_capacity` 134,706
- `asset_custody_tests::per_type_live_slot_capacity` 174,477 / `distinct_type_capacity` 168,965（两条“到界即拒”用例：**被拒绝的路径也要烧满全表扫描**）
- 全部 421 条中 409 条 < 250 差值单位；真实用户路径（DKG/提案/执行）都在 100–250 区间：`test_fully_async_single_shot_submission` 249、`test_dkg_async_mailbox_and_quorum_finalization_with_offline_member` 186、`valid_threshold_signature_executes_pays_and_advances_nonce` 133。

结论：**没有单笔会炸 gas budget 的入口**；所有循环上界（128 人、MAX_COUNT=128、MAX_AGENTS_PER_VAULT=100、MAX_ROSTER_MEMBERS=128）都在 (red_packet.move:45-47)、(vault.move:26,29,269)、(cryptographic_org.move:42) 明文钉死。

### 1.3 最贵的 3 个操作（按 n=50 用户的真实成本排序）

1. **`onchain_chat::create_channel_with_stake` n=50：0.0848 SUI（n=100 → 0.1646）**。每成员 1,596,000 MIST —— 是 DKG 路径每成员（243,200）的 **6.55 倍**。原因：`create_channel_internal`（onchain_chat.move:251-324）把每个成员写成 **`Table<address,bool>` 动态字段**（每个 DF 是独立子对象），而 DKG 只把地址写进共享对象内联的 `vector<address>`。
2. **`dkg_committee::create_dkg_session` n=100：0.0333 SUI** + 全流程每人再花 submit_commitment（3 个 dynamic field：BondSlot/StakeSlot/AttestationKeySlot + commitments 表项，估 0.7–1.1 M MIST/人）+ n−1 笔 `deposit_mailbox_share`（估 0.4–0.6 M MIST/对）。
3. **`vault::initialize_vault` 0.0056 SUI + `spawn_agent_card` 到 100 卡**：AgentRecord 内联 `VecMap`（vault.move:44），单对象膨胀而非子对象增殖，读取一次 `getObject` 即全量 —— 设计正确，但每次 `set_agent_budget`/`pause` 都重写整个 vault 对象，100 卡时对象约 100×96B≈10KB，每次管理操作 rewrite ≈ 10KB×2000 MIST/KB ≈ 20 M MIST refund-able 存储费。

### 1.4 create_dkg_session 全流程总成本 vs Safe

**本 DAO n 人全流程（单人视角，n=门槛 t=⌈0.6n⌉）**：
- 创建会话 0.0082 SUI（n=3）+ 创建费销毁 0.005 SUI（dkg_committee.move:104 `SESSION_CREATION_FEE_MIST`，转 @0x0）+ bond 0.05 SUI（可退，claim_bond 全额）+ submit_commitment ≈0.001 + (n−1)×deposit_mailbox_share ≈0.0005×(n−1) + confirm ≈0.001 + attest+finalize ≈0.001 + `create_organization_from_session`（members_weight Table n 项 + executed_proposals 空表 + 组织对象，估 0.008–0.015 SUI）。
- **n=3 实付（扣回可退 bond）≈ 0.017–0.025 SUI/人**；n=50 约 0.05–0.08 SUI/人。
- 对比 Safe 单例部署（`GnosisSafe::setup`，mainnet 常态 **0.25–0.4 ETH**，自 EOA 部署非 factory 时更高；factory+proxy 常态 ~0.05–0.15 ETH）：SUI 价格维度不可直接比，但结构性结论成立：**本项目是"每会话一次性创建费 0.005 SUI + 可退 bond"的准入经济模型（dkg_committee.move:101-107），无持续租金；Safe 是一次性部署费**。本项目额外优势：threshold-attestation 共识本身不额外发交易（attest 融合在 confirm 后一次 `attest_group_key`）。

### 1.5 优化点（链上）

| # | 优化点 | 位置 | 预期收益 | 改动量 |
|---|---|---|---|---|
| G1 | `onchain_chat` 成员集合 `Table<address,bool>` → `VecMap<address,bool>`（≤128 人上限已存在，线性扫可接受）或 `vector<address>` + 链上不去重（UI 已去重） | onchain_chat.move:251-268 | n=50 建群 storage 从 0.0848 → ≈0.02 SUI（**−76%**）；但**破坏性布局变更**，需新字段+迁移 | **L** |
| G2 | `submit_commitment` 的 BondSlot/StakeSlot 合并为一个 `ParticipantEscrowSlot { bond, stake }` 单 DF | dkg_committee.move:494-501 | 每人省 1 个 DF ≈ 0.2 M MIST × n 人；n=50 全组省 ≈0.01 SUI | **M**（布局兼容性：新增槽位类型，旧槽位读取兼容） |
| G3 | `attestation_count_for` 每次 finalize 全量扫 participants × dynamic_field::exists（dkg_committee.move:737-758）→ 会话上加 `attestations_for_key: Table<vector<u8>, u64>` 计数器，attest 时增减 | dkg_committee.move:684-737 | finalize 从 O(n) 次 DF 读降为 O(1)；computation 省不多（读不是写）但共享对象争用下降 | **M** |
| G4 | 存储退款审计：`claim_bond`/`claim_stake` 移除 DF 有 rebate；确认 `GenesisStakeSweptEvent` 路径（take_genesis_stakes remove 所有 StakeSlot）确实拿到 rebate —— 已经 remove，**无需改**，仅建议在文档标注预期退款额 | dkg_committee.move:968-994 | 文档级，0 代码 | **S** |
| G5 | `Organization.members_weight` Table → 内联 `vector<(address,u64)>`（roster ≤128，读取端 readWeightTable 的分页/listDynamicFields 全部消失） | cryptographic_org.move:397-403,423-430 | 建组织 storage −n×DF；**读取端每次省 1+⌈n/50⌉×2 次 RPC**（见三节 R2）；布局破坏性 | **L** |

---

## 二、前端：next build 产物分析

### 2.1 首屏 JS 体积（实测 `.next/app-build-manifest.json` + chunk 字节）

| 页面 | JS 总量（含共享） | 页面独有 | 首要大块 |
|---|---|---|---|
| `/`（首页） | **3563 KB / 20 chunks**（layout∪page 并集） | 13 chunks | 380-*.js **921 KB**（@mysten/sui SDK + curves）、584-*.js **574 KB**（group-details 视图 + 全量 i18n 字典 en+zh）、900-*.js **436 KB**（radix 组件族）、page 自身 **319 KB**、975-*.js 198 KB |
| `/groups/[id]` | 3111 KB | 17 chunks | 同 380/584/192/900 + dkg-ceremony-dialog 静态内联 |
| `/walrus` | 2023 KB | — | 380+192+584 |
| `/trust` | 830 KB | — | 192+156+e84615ed |
| `/auth/callback` | 1734 KB | — | — |

`/` 首屏 3.5 MB JS 在 3G/弱网下（1 Mbps）≈ 28 s 纯下载，LCP 会被打穿。gzip 后约 1.0–1.1 MB（按 3:1 估），仍然偏重。

### 2.2 体积构成定位

- **380-*.js 921 KB**：`@mysten/sui`（dist 5.5 MB 源）+ `@noble/curves`（1.7 MB 源）+ `@noble/hashes` + multisig SDK 的 BCS/签名栈。指纹：`ed25519`×11、`ristretto`×3、`Transaction`×157。
- **584-*.js 574 KB**：**不是 Walrus SDK**（`lib/walrus-client.ts` 是纯 fetch 的 210 行，walrus-client.ts:35,133）。实为 group-details-view(2014 行)+red-packet/payment/dialog 组件群 + `lib/i18n/dictionaries.ts` **静态 import 全部 14 个域字典**（dictionaries.ts:2-15，共 511 KB 源码、en+zh 双语全部打进首屏；192-*.js 里 CJK 字符实测 ≈113 KB UTF-8）。
- **900-*.js 436 KB**：全量 radix-ui 组件（package.json 里 33 个 `@radix-ui/react-*` 依赖，多数 "latest"）。
- **framer-motion 7.4 MB / lucide-react 33 MB 源**（pnpm store 实测）按需 tree-shake 后残留有限，但 `app/page.tsx:9` 的 `AnimatePresence` 与 dashboard 每卡片 motion 都在首页路径上。

### 2.3 dkg-ceremony-dialog 能否懒加载

**能，且收益极大**。`components/group-details-view.tsx:56` 静态 `import { DkgCeremonyDialog }`，对话框组件本体 1336 行 + `@mysten/seal` + ECIES/WebCrypto 封装 + `lib/dao-key-lifecycle`/`dkg-mailbox`/`frost-session` 全链。仅 `groups/[id]` 页用到；但因为它静态内联进 group-details-view，把 `/` 也拖进了 584 chunk 的一部分（首页经 GroupDetailsDialog→group-details-view 路径）。

### 2.4 前端优化点

| # | 优化点 | 位置 | 预期收益 | 改动量 |
|---|---|---|---|---|
| F1 | `DkgCeremonyDialog` 改 `next/dynamic(() => import(...), { ssr:false })`，只在用户点"发起仪式"时加载 | group-details-view.tsx:56,1956 | `/groups/[id]` 首屏 −250~400 KB（seal+ECIES+dkg 链）；ceremony 是低频操作 | **S** |
| F2 | i18n 字典按 locale 拆分：`dictionaries.ts` 改为 `import("./dictionaries/…")` 动态加载当前 locale（或至少 en/zh 两个 entry chunk 分离） | lib/i18n/dictionaries.ts:2-15,41-53 | 首屏 −180~250 KB（另一半语言不加载）；192+584 两 chunk 都瘦 | **S** |
| F3 | 首页 tab（payments/dashboard/agent/profile 5 个 tab）改 `next/dynamic` 每 tab 独立 chunk；PendingWork 默认 tab 常驻 | app/page.tsx:6-11 | `/` 首屏 −600~900 KB（584+900 大部分延迟） | **M** |
| F4 | radix 组件按需收敛：33 个依赖里实际常用的 <12（dialog/button/card/…），未用的从 package.json 删除避免 barrel 引入；配 `optimizePackageImports` | package.json:31-63, next.config.mjs | 900-*.js 436→≈250 KB | **M** |
| F5 | `@mysten/sui` 深导入审计：所有 `from "@mysten/sui"`（31 个文件）确认无 barrel 根导入；zklogin/GraphQL 子路径不进首页 chunk | 见 grep 列表（components/*.tsx 31 文件） | 380-*.js 921→≈700 KB | **S**（审计+改 import 路径） |
| F6 | Walrus 相关（group-files/walrus-blob-dialog/`/walrus` 页）从首页路径剥离（profile 只留 Link，不 import 组件） | components/profile.tsx:256-258 | 首页不再因 Link 而拉入 walrus 组件树 | **S** |
| F7 | `next build --profile` + `ANALYZE=true` 常态化：目前仓库无 bundle-analyzer 配置，加 `@next/bundle-analyzer` wrapper | next.config.mjs | 流程性（无直接 KB） | **S** |

---

## 三、SDK / 后端：热路径 RPC 调用数

### 3.1 readSession（DKG 会话读取）—— 每次恰好 1 次 RPC

`readDkgSession`（packages/multisig/src/agent-vault/committee/reader.ts:72-106）：单次 `getObject(sessionId, include content)` + 本地 BCS 解析（DkgSessionBcs 19-32），把 3 个 Table 只取句柄+size。**已是最优**。热路径问题不在 readSession 本身，而在它上面的**组合层**：

| 热路径 | 逐调用点计数（n=参与人数，v=投票人数） | 位置 |
|---|---|---|
| `readQualifiedDealers` | **1 + n**（readSession + 串行 for 循环每参与者 1 次 `getDynamicField`） | lib/dkg-local-session.ts:10-16（`await` 在 for 循环内，**串行**） |
| `handleConfirmWithShares` | 1(session) + n(dealers) + 1(own commitment) + (n−1)(mailboxShare) + 1(encryptionKey) + 1(confirmation) ≈ **2n+3**；n=10 → 23 次串行 RPC | components/dkg-ceremony-dialog.tsx:514-605（for 内 await，555-584 行） |
| `handleStartDkg` Phase2 预检 | 1 + 1 + (n−1) 次 `readMailboxShare` **串行** | dkg-ceremony-dialog.tsx:354-361 |
| `handleFinalize`（FINALIZED 分支） | 1 + n 次 `readGroupKeyAttestation`，这里**已用 `Promise.all`**（741 行）✅ | dkg-ceremony-dialog.tsx:738-743 |
| `readProposalSnapshot` | 2(getObject) + members 表 (1+⌈n/50⌉ listDynamicFields + ⌈n/50⌉ getObjects) + votes 表同构 + 1(getMoveFunction，模块级 memo✅) + 1(RejectedWeightKey) + **v 次 RejectingVoterKey 串行 for-await** | lib/proposal-chain.ts:107-132（119-121 行 Promise.all 内嵌 per-voter await，实际串行） |
| `refreshProposal`（每 4 s 轮询 × 每个已存提案） | = readProposalSnapshot + verifyTreasuryProposal | lib/onchain-store.ts:449-458；轮询源 lib/online-indexer.ts:113-126（`startOnlineIndexer(4000)`） |
| `discoverGroupsCached` | ≤12 页 listEvents + ⌈m/4⌉ 批 × 2 RPC/组织（batch=4 ✅，60 s TTL 缓存 ✅） | lib/group-discovery.ts:169-214,226-244 |

**n=5 群、v=5 投票：一次 refreshProposal ≈ 14 次 RPC；每 4 s 轮询 × 3 个提案 = 42 次/4s ≈ 10 RPC/s 持续打到 fullnode。** n=128 时单次 145 RPC。这既是延迟问题（串行 for-await 每跳 100–300 ms，n=10 确认流程 23 跳 ≈ 2–7 s 纯网络等待），也是公共 RPC 配额问题。

### 3.2 SDK 优化点

| # | 优化点 | 位置 | 预期收益 | 改动量 |
|---|---|---|---|---|
| R1 | `readQualifiedDealers` for-await → `Promise.all(participants.map(readCommitment))`；`handleConfirmWithShares` 的 dealer 循环（读 mailbox share 可并发，解密验签本地） | lib/dkg-local-session.ts:10-16；dkg-ceremony-dialog.tsx:555-584 | n=10 确认流程 23 跳 → 5 跳左右，**−2~5 s** 用户可感知 | **S** |
| R2 | `readProposalSnapshot` 的 RejectingVoterKey v 次读 → 一次 `listDynamicFields(proposal.id)` 反向枚举（或合约侧加 `rejecting_count` u64 + 事件已够 UI 用） | lib/proposal-chain.ts:118-121 | v=30 时 −29 RPC/snapshot；轮询态每 4 s 省 ~90 请求 | **S**（SDK）/ **M**（合约加字段） |
| R3 | 轮询退避：`startOnlineIndexer` 固定 4 s → 页面不可见时 `document.hidden` 停表（visibilitychange），标签页隐藏即 0 RPC；或 4s→15s 指数退避 | lib/online-indexer.ts:113-126 | 后台标签页 RPC −100%（多标签用户常开 3–5 页） | **S** |
| R4 | `readWeightTable` 双请求模式（listDynamicFields 拿 fieldId + getObjects 拿内容）→ 若 gRPC 支持 `include: { content }` 于 listDynamicFields 返回（新版支持 dynamicFields[].value），合并为单请求/页 | lib/proposal-chain.ts:47-74 | 每页省 1 请求；n=50 群每次 snapshot 省 2 请求 | **S** |
| R5 | G5 落地时（members 内联 vector）SDK 侧 `readWeightTable` 整体删除，org 单次 getObject 即含全 roster | — | 每次 snapshot 固定 −(2+2⌈n/50⌉) RPC | （依赖 G5，**L**） |

---

## 四、TOP10 排序（收益 ÷ 改动量加权）

| 排名 | 项 | 维度 | 预期收益 | 改动量 |
|---|---|---|---|---|
| 1 | **R1 DKG 读取并发化**（readQualifiedDealers/confirm 循环 Promise.all） | 延迟 | n=10 仪式 −2~5 s/人；改动 ~20 行 | **S** |
| 2 | **F2 i18n 字典按 locale 动态加载** | 首屏 | −180~250 KB（−5~8%） | **S** |
| 3 | **R3 轮询 hidden-tab 停表/退避** | RPC 配额 | 后台标签 −100% 请求 | **S** |
| 4 | **F1 DkgCeremonyDialog 懒加载**（next/dynamic） | 首屏 | `/groups/[id]` −250~400 KB | **S** |
| 5 | **R2 RejectingVoterKey 批量化** | RPC | v=30 时 −29 请求/snapshot | **S** |
| 6 | **F3 首页 5 tab 动态分包** | 首屏 | `/` −600~900 KB（合计可达 −40%） | **M** |
| 7 | **F4 radix 依赖收敛 + optimizePackageImports** | 首屏 | 900-chunk −40% | **M** |
| 8 | **G2 Bond/Stake 合并单槽** | gas | 每参与者 −0.2 M MIST，n=50 全组 −0.01 SUI | **M** |
| 9 | **F5 @mysten/sui 深导入审计** | 首屏 | 380-chunk −200 KB | **S** |
| 10 | **G1/G5 chat 成员表 VecMap 化 + org roster 内联**（两个破坏性布局变更，合并排期到血统 14 升级窗口） | gas+RPC | 建群 −76% storage；snapshot −4 RPC | **L** |

---

## 五、佐证清单（file:line / 实测命令）

- dev-inspect 数值：`SuiGrpcClient.simulateTransaction`（baseUrl `https://fullnode.testnet.sui.io:443`，`gasPaymentMocked:true`），n∈{3,5,10,20,50,100} 全表见 §1.1；storage 拟合残差为 0（精确线性）。
- move-test 差值：`sui move test --statistics`（contracts/agent_vault，421/421 OK，wall 4.34 s），基线 49,999,995,000,000。
- 准入经济常量：dkg_committee.move:101-107（MIN_BOND 0.05 / MAX_BOND 0.5 / 创建费 0.005 / 时长 [10min,7d]）。
- 事件/大小上界：MAX_MAILBOX_PAYLOAD_BYTES=2048（dkg_committee.move:96-97，3028）、MAX_GREETING=256/MAX_COUNT=128（red_packet.move:45-47）、MAX_TITLE=256（asynchronous_proposal.move:63）、MAX_PREVIEW=4096（onchain_chat.move:44）。
- 首屏计量：`.next/app-build-manifest.json` pages 表 × chunk 文件 size（2026-11-14 现场 build 产物，.next/static 共 4.2 MB）。
- RPC 计数公式的每处 await：proposal-chain.ts:47-74,107-132；dkg-local-session.ts:10-16；dkg-ceremony-dialog.tsx:354-361,555-584,738-743；online-indexer.ts:113-126；group-discovery.ts:169-214。
- Safe 对比：GnosisSafe 部署成本为公开常识区间（0.05–0.4 ETH 视 factory 与网络），未在本报告内做链上实测 —— 标注为 [INFERENCE]。

（报告完，T06）
