# T02 红队·密码学组报告（FROST / DKG / 互操作）

审阅范围：`packages/multisig/src/dkg/{threshold_signer,vss,resharing,ceremony,mailbox,math}.ts`、`lib/frost-exchange.ts`、`lib/crypto/committee-signing.ts`、`lib/frost-session.ts`（对照栈）、`packages/multisig/src/agent-vault/org/{digest,bcs,constants}.ts` ↔ `contracts/agent_vault/sources/{cryptographic_org,asynchronous_proposal,dkg_committee}.move`、`packages/multisig/src/namespace/identity.ts` ↔ `contracts/identity/sources/identity.move`。noble curves 版本 2.4.0（`node_modules/@noble/curves/package.json`）。

---

## 一、FROST 审（threshold_signer.ts / frost-exchange.ts / committee-signing.ts）

### F-01【高·潜伏】被宣布删除的"单 nonce 无绑定"旧签名器仍完整存留在 lib/crypto/threshold_signer.ts

`lib/frost-exchange.ts:12-17` 头注释明确写道：旧单 nonce 方案（R = Σ r_i·G、无承诺绑定）已删除，因为"last signer could craft commitments that cancel the honest nonces"（Drijvers 类抵消攻击）。但该实现一字未删地留在 `lib/crypto/threshold_signer.ts`：

- 单 nonce：`lib/crypto/threshold_signer.ts:36-38`（`generateNonceCommitment` 只生成一个 `ephemeralNonce`，无 hiding/binding 对）；
- 无绑定因子、无 ρ：`:52-76` 直接 `R = Σ R_i`；
- 聚合器**无自验**：`:97-118` `aggregateSignature` 直接拼 `R‖z` 返回，不像 SDK 版那样 `ed25519.verify` 兜底（对比 `packages/multisig/src/dkg/threshold_signer.ts:299-303`）。

全仓 grep 验证：除自身外**零生产引用**（`lib/crypto/resharing.ts` 已改为 re-export shim，`lib/crypto/ceremony.ts` 与 `lib/crypto/vss.ts` 是 SDK 外唯一活副本，见 §三 I-04 关联）。风险不在今天，而在"一次顺手 import 就复活一个已知可被最后一签者伪造的签名器"。同目录 `resharing.ts:1-11` 已树立"唯一实现在 SDK、lib 层只留 shim"的归一原则，`threshold_signer.ts` 是该原则的漏网者。

**修复（S）**：删除 `lib/crypto/threshold_signer.ts`，或改成与 `resharing.ts` 同款的 re-export shim；`lib/crypto/ceremony.ts:1-11` 同步收敛到 `multisig/dkg`（当前仅 `dkg-ceremony-dialog.tsx:27` 一处 import，改一行）。

### F-02【中】双 FROST 栈并存且绑定因子域互不兼容：SDK 自研 `SUI_FROST_BINDING_V1:` vs noble `ed25519_FROST`（RFC 9591 标准域）

生产代码同时运行两套 FROST：

| 栈 | 绑定因子 ρ 布局 | 生产入口 |
|---|---|---|
| SDK 自研 | `SHA512("SUI_FROST_BINDING_V1:" ‖ (idx‖D‖E)升序 ‖ msg ‖ Y ‖ idx_8le)`，`threshold_signer.ts:14,88-126` | `dkg-ceremony-dialog.tsx:938`（reshare 后签 epoch-advance）经 `committee-signing.ts:74-81` |
| noble ed25519_FROST | RFC 9591 H1：`H("FROST-ED25519-SHA512-v1rho" ‖ …)`，`node_modules/@noble/curves/abstract/frost.js:93`、`ed25519.js:183-196` | `group-roster-dialog.tsx:40`（名册轮换）经 `lib/frost-session.ts:277,322` |

两栈对**同一组分片**算出的 ρ 不同 → round-1 承诺/round-2 份额**跨栈不可聚合**。目前靠字段形状差异（`FrostRound1` vs `NonceCommitment`）天然防混淆，且两侧最终都过 `ed25519.verify`（`frost-session.ts:324`、`threshold_signer.ts:299`），错误混栈只会 fail-closed。但隐患是**没有任何文档或类型标记**声明"本会话属于哪个栈"：未来把 reshare 流迁移到 frost-session（或反向）时，两套 nonce 存储（SDK 节点内存烧毁 vs `frost-session-store.ts:66-71` IndexedDB 密封单次消费）与两套 ρ 语义极易被混接。建议在 ADR/RESAHARING_SECURITY.md 显式登记双栈现状与各自归属流，或立迁移项统一到 noble。

**修复（M）**：短期 S（文档+类型品牌）；长期 L（统一到 noble ed25519_FROST，SDK 自研栈退役）。

### F-03【低-中】SDK 节点 nonce 生命周期：重复生成静默覆盖 + 仅内存烧毁，round-1 已上链后刷新页面即整轮报废

- `threshold_signer.ts:211-221`：`generateNonceCommitment()` 无"未消费不得重生成"守卫——重复调用直接覆盖 `hidingNonce/bindingNonce`，先前已发布的承诺成为孤儿。聚合时会自验失败（`:299`），安全上 fail-closed，但属于静默状态破坏。
- 烧毁仅置零内存字段（`:259-260`）：round-1 承诺已通过 `submit_commitment` 冻结上链（`dkg_committee.move:484-498`），页面刷新后 nonce 永久丢失，本轮签名只能整体重来（新承诺集 → 新会话轮）。对照 noble 栈已解决的同类问题：`frost-session.ts:172-185` 把 nonce 密封进 device-vault 持久化，`frost-session-store.ts:66-71` consume-once 原子消费、`:72-77` 支持同 transcript 幂等重放。
- 另外：SDK 提供的逐份额验证 `verifyShare`（`threshold_signer.ts:165-190`）在两条生产聚合路径（`committee-signing.ts:81`、`frost-exchange.ts:191`）均未被调用，聚合失败时无法自动定位作恶份额，归责全靠人工重跑。

**修复（S/M）**：generateNonceCommitment 加未消费守卫；reshare 流复用 frost-session-store 式持久化或至少 UI 层警告；聚合 catch 里对每份额跑 verifyShare 输出 blame 列表。

---

## 二、DKG 审（vss.ts / resharing.ts / ceremony.ts）

### D-01【中】Gennaro finalizeNewShare 的 PoK 校验循环遍历 proofs 而非 commitments——缺席证明的 dealer 静默跳过诚实性校验

`resharing.ts:503` 注释宣称"严格校验所有 Dealer 的 PoK……无任何静默回退"，但 `:504` 的循环是 `for (const [senderId, proof] of options.dealerHonestyProofs.entries())`：**`peerCommitments` 里存在、而 proofs 映射缺项的 dealer 完全绕过** `verifyDealerHonestyProof`。它仍会过同态校验 `:542`（对任意自洽的多项式都通过），最终只被 `:568` 的群公钥总校验兜住。安全性由 Σ C_{i,0} = Y 兜底没有丢，但：(a) 与注释承诺矛盾；(b) 丢失逐 dealer 归责——一个毒常数 dealer 夹在诚实 dealer 之间时，只能知道"有人毒了"，不知道是谁。正确写法是以 `peerCommitments` 为循环源、缺 proof 即 throw（与 `:509` 缺 commitments 即 throw 对称）。

**修复（S）**：`resharing.ts:504` 循环源换成 `peerCommitments.entries()`，proof 缺失抛 `DealerHonestyError`。

### D-02【中】防"虚构身份"的 expectedVerificationShareY 比对在生产路径是死代码

`resharing.ts:176-181`：`verifyDealerHonestyProof` 的 Y_i 比对（防 dealer 虚构前任验证份额）是可选参数；`:519` 透传 `options.expectedVerificationShares?.get(senderId)`。生产唯一调用点 `dkg-ceremony-dialog.tsx:925-931` 构造的 options 只含 `dealerHonestyProofs / oldActiveIndices / context`——**从不传 expectedVerificationShares**。于是恶意 dealer 可以对任意自选的 Y'_i 自证"诚实"（C_0 = λ·Y'_i + PoK 全成立），伪造的是与历史名册无关的身份。最终同样被群公钥总校验兜住（不损失资产安全），但"证明各 Dealer 的常数承诺严格来自原私钥分片"这半句承诺（`:110-111`）在链上无锚、在客户端无比对，等于每个 dealer 的"身份"只靠 self-claim。修复需把前任 epoch 的验证份额 Y_i = s_i·G 持久化（reshare 前由各成员本地计算并互签存证，或链上名册字段）。

**修复（M）**：reshare 上下文生成时采集并广播 Y_i 集，`finalizeNewShare` 强制传入并比对。

### D-03【低】legacy ResharingNode.finalizeResharing 允许"只给 newCommitteeShares、不给期望公钥"的静默毒化路径

`resharing.ts:341-349`：只传 `newCommitteeShares` 时 `computedGroupPublicKey` 直接取自重算值，`:351-357` 的与 `originalGroupPublicKey` 的一致性校验**仅在两者都提供时**运行——只给 shares 的调用方接受任意毒化结果不报错。对照 Gennaro 路径 round-9 已把 `originalGroupPublicKey` 改为必传硬校验（`:497-501`）。当前唯一使用方是演示 CLI `packages/multisig/bin/dkg-cli.ts:116-148`，但该类经 `dkg/index.ts` 公开导出。次要关联：`vss.ts:43-49,63-78` 把零系数编码为恒等元并在验证时跳过，全零多项式的"空 dealer"能无告警通过 VSS（不破坏门限代数，但淹没 dealer 活性诊断）。

**修复（S）**：`finalizeResharing` 同步去可选化（对齐 Gennaro 路径），或从 index.ts 导出面移除；vss 对全零承诺集给出告警事件。

---

## 三、互操作审（SDK digest.ts ↔ Move 全量对拍，含 identity 包）

### 对拍结论：9/9 摘要域今日逐字节一致（零漂移）

逐域核对（TS 构造点 ↔ Move 构造点，字段序/编码全对）：

| 域 | TS | Move | 备注 |
|---|---|---|---|
| SUI_ORG_THRESHOLD_PROPOSAL_V2: | org/digest.ts:40 | cryptographic_org.move:18,544 | action_type u8 尾字节 ✓ |
| SUI_ORG_EPOCH_ADVANCE_V2: | digest.ts:68 | move:22,555-577 | 尾绑 key_generation ✓ |
| SUI_ORG_KEY_ROTATION_V3: | digest.ts:95 | move:23,506-530 | new_signers bcs vector ✓ |
| SUI_ORG_ROSTER_V1: | digest.ts:209 | move:24,583-609 | members+weights 双 vector ✓ |
| SUI_ORG_POP_V2: | digest.ts:130 | move:27,466-486 | threshold_weight+key_threshold ✓ |
| SUI_ORG_POP_V1: | digest.ts:150 | move:30,489-503 | 轮换 PoP 仍 V1 ✓ |
| SUI_ORG_TREASURY_TRANSFER_V2: | digest.ts:177 | asynchronous_proposal.move:57,553-572 | 尾绑 key_generation ✓ |
| SUI_ORG_GENESIS_WITHDRAW_V1: | digest.ts:237 | cryptographic_org.move:31,740-757 | ✓ |
| SUI_DKG_ATTEST_V1: | digest.ts:263 | dkg_committee.move:104,711-717 | sid 为 ID 原始 32B ✓ |

编码基元对拍：`u64le`（org/bcs.ts:49-58）↔ `bcs::to_bytes(&u64)` 8 字节小端 ✓；`bcsVectorAddress`（bcs.ts:82-89，uleb 计数+32B）↔ `bcs::to_bytes(vector<address>)` ✓；`bcsVectorU64` ✓；地址/ID 一律 32 原始字节，`requireAddress`（digest.ts:8-12）严格 32B ✓。identity 包镜像：`IDENTITY_LIMITS`（namespace/identity.ts:18-27）↔ identity.move:11-19（3/32/64/512/1000/17/4112/12 全一致）；65 字节 P-256 临时公钥与 12B nonce 校验（identity.ts:395-396）↔ identity.move:216-218,281 ✓；`MAX_MAILBOX_PAYLOAD_BYTES=2048`（org/constants.ts:81）↔ dkg_committee.move:91 ✓。

### I-01【高杠杆·流程缺口】一致性完全靠人肉，CI 无跨实现 golden vector

现有防线各自只测一侧：Move 测试用**硬编码签名**走行为回路（agent_vault_tests.move:530-538 的 pk/msg/sig1 常量，:574-618 断言执行序），从不断言摘要 hex；SDK 侧 economics.test.ts:40-63 只对 genesis-withdraw 一个域手算 sha256 自比对，且 `DOMAINS` 注册表（org/constants.ts:36-45）仅 TS 内自洽。任何一侧单方面改字节序/字段序/域字符串，两边测试依然全绿，直到链上 E_INVALID_SIGNATURE。我在本次审查中实测生成的两个种子向量（node 重算，输入见下文提案）：

- `proposal_v2`: chain="sui-testnet:" org=0xaa…aa epoch=1 nonce=1 msg="hello_sui_frost_threshold_action" action=1 → `bf6e1bead9a075a1e2c8537a9ff244a80c65dc04cf1beea10fe228a6a0bb7c7b`
- `dkg_attest_v1`: sid=0xcc…cc gpk=0x8a88e3dd…b40f6f5c（Move 测试同款 pk）→ `ae323761aa0fd6f4a3f9b8f1547949d5f54c3159035ec7e49442d6e805d4e048`

### I-02【低】公开 getter `domain_threshold_approval()` 返回已废弃域 SUI_ORG_APPROVAL_V1:

cryptographic_org.move:19 定义、:1108-1110 公开返回**已废弃**的 V1 审批域（真值是 :22 的 EPOCH_ADVANCE_V2，:555-561 注释明说 V1 仅留作历史辨认）。全仓无 SDK 调用方，但任何第三方集成者按 getter 名取域签名，链上必拒。同理建议连同检查 `domain_pop`/`domain_pop_v2` 两个 PoP 域 getter 的命名区分度（move:1122-1128，轮换用 V1、创建用 V2，注释已说明但 getter 名不带版本号）。

**修复（S）**：删除 getter 或改名 `domain_threshold_approval_v1_deprecated()`。

### I-03【中】chainId 的 string|Uint8Array 双态是隐性脚枪；常量镜像表无漂移检测

- digest.ts:19-21 `chainBytes`：字符串按 utf8 原文入摘要。若调用方误传 hex 字符串（"0x7470…"）会按 ASCII 入哈希而非解码字节。现行接线正确：frost-session.ts:64 强制 `chainIdHex` 且 `unhex()`（:72 还校验偶长度小写 hex），org reader 传原始字节——但 API 面本身两种形态都收，且无任何文档钉死"字符串必须是与 DEFAULT_CHAIN_ID（move:38 "sui-testnet:"）同族的 ASCII 标识"。
- identity 限制表、2048B 信箱上限、DOMAINS 注册表均为**手工镜像且无测试对拍 Move 源**（economics.test.ts:54-63 只测 TS 侧）。Move 侧一旦 bump（如 MAX_MAILBOX_PAYLOAD_BYTES 调 4096），SDK 预校验先放行/先拒绝都产生难排查的 3028 或本地误拒。

**修复（S）**：digest.ts 入口把 chainId 收敛为 `Uint8Array`（或 `hex|ChainLabel` 判别联合），常量漂移由下节 CI 方案一并覆盖。

### I-04【低】frost-exchange.ts 声称 "The message the contract verifies" 但无任何合约消费 SESSION_CERT_V1

frost-exchange.ts:54-62 定义 `SESSION_CERT_V1:` 并注释"contract verifies"；全 contracts/ grep **零命中**。且该模块生产已死（仅 `lib/frost-exchange.test.ts`、`lib/dao-key-lifecycle.test.ts` 两个测试引用）。与 F-01 同属"文档性漂移 + 死生产面"：误导后续审计与开发。

**修复（S）**：修正注释为离线协调消息，或将模块并入 frost-session 体系后删除。

---

## 四、跨实现 golden-vector 固化提案（可直接执行）

**目标**：9 个摘要域 × 固定输入 → 单一 JSON 真值文件，SDK vitest 与 sui move test 双侧消费 + CI 再生 diff，任何单侧布局改动立即爆红。

1. **生成器**（M 的工作量大头）：新建 `scripts/golden-vectors-gen.mjs`，复用 `scripts/rt9-fixtures-v2.mjs` 的无依赖 node 脚本模式。单一 spec 表驱动：每域一条 `{ domain, build: (spec) => {输入字段}, moveArgs: [...] }`，9 域各固定一组确定性输入（沿用本报告两个种子向量 + economics.test.ts:35-39 的 ORG/SESSION/RECIPIENT 常量风格），输出：
   - `packages/multisig/src/agent-vault/org/__fixtures__/digest-vectors.json`：`[{ fn: "computeProposalDigest", args: {...十进制字符串/十六进制}, expected: "bf6e1bea…" }, …]`（u64 一律 decimal-string、字节一律 0x-hex，避免 JS number 精度歧义）；
   - `contracts/agent_vault/tests/digest_vectors.move`（test_only 模块，嵌入同表输入与 expected 的 `vector<u8>` 字面量——仓库已有先例：agent_vault_tests.move:530-538 的字节数组嵌入风格）。
2. **SDK 消费**：新建 `org/digest.vectors.test.ts`，表驱动逐条 `expect(hex(computeXxx(args))).toBe(expected)`；顺手把 economics.test.ts:40-63 的手算用例改为引用同一 JSON（消灭第二份手写真值）。
3. **Move 消费**：`agent_vault_tests.move` 增一个测试函数，循环调 `compute_proposal_digest / compute_threshold_approval_digest / compute_key_rotation_digest / compute_roster_update_digest / compute_create_pop_digest / compute_rotate_pop_digest / compute_genesis_withdraw_digest`（cryptographic_org.move:466-609,740-757）、`transfer_digest`（asynchronous_proposal.move:553-572，经公开入口构造 Proposal 后走 execute 路径或新增 test_only 直调）、attest 摘要（dkg_committee.move:711-717 逻辑，用 `x"` 字面量对拍），逐条 `assert!(==expected)`。
4. **CI 门禁**：发布四道门禁（Move 全绿 + SDK tsc + next build + Vercel）之外加一步 `node scripts/golden-vectors-gen.mjs && git diff --exit-code -- packages/multisig/src/agent-vault/org/__fixtures__ contracts/agent_vault/tests/digest_vectors.move`——生成器是唯一真值源，任一侧手改域串/字段序而不更新 spec 表，再生 diff 即失败。
5. **FROST 跨栈钉子**（可选加项，S）：`threshold_signer.frost1.test.ts` 增一条固定分片+固定 nonce 的确定性向量（注入 `randomScalar` 不可行则加 deterministic-nonce 构造入口），断言 SDK 栈与 noble `ed25519_FROST` 各自产出的签名都过 `ed25519.verify`——钉住"两栈虽不互聚合、但都产出链上可验签名"的下界。

**工作量**：生成器+spec 表 M（约 1 人日）；双侧消费测试 S（半天）；CI 步骤 S（1 小时）。总计 M。

---

## 附：本组结论速览

| 编号 | 级别 | 一句话 | 修复 |
|---|---|---|---|
| F-01 | 高（潜伏） | 可被抵消攻击的旧单 nonce 签名器仍是活文件 | S 删/shim 化 |
| F-02 | 中 | 双 FROST 栈 ρ 域不兼容、无栈标记 | S 文档 / L 统一 |
| F-03 | 低-中 | nonce 重复生成无守卫、仅内存烧毁、verifyShare 无人调用 | S/M |
| D-01 | 中 | PoK 循环遍历 proofs 非 commitments，缺席者静默跳过 | S |
| D-02 | 中 | expectedVerificationShareY 生产路径从不传，防虚构身份死代码 | M |
| D-03 | 低 | legacy ResharingNode 单传 shares 不对拍公钥；空 dealer 无告警 | S |
| I-01 | 流程高杠杆 | 9/9 域今日一致但 CI 无 golden vector（两个种子向量已产出） | M |
| I-02 | 低 | 公开 getter 返回废弃域 APPROVAL_V1 | S |
| I-03 | 中 | chainId 双态 API + 三组常量镜像无漂移检测 | S |
| I-04 | 低 | SESSION_CERT_V1 注释谎称合约校验；模块生产已死 | S |
