# T08 · 二次开发团队评估报告：三条二开路线的「改哪、多难、哪里会碰壁」

评估基线：main 仓（Euraxluo/multisig），contracts/agent_vault 血统 13 `0xcdc87b8ef5b071a293966f4329f1e9b4a443f49f1cf599cc188009cf7524ab44`（testnet，尚不含审计修复修复版；血统 14 待发布）。所有 file:line 均为仓库实读。工作量口径：S=1-2 人日、M=3-7 人日、L=8-20 人日（含测试与前端联调，不含包发布协调）。

---

## 路线① 给 vault 加新 Coin 类型支持

### 1.1 链上现状：vault 本身已经是泛型的，泛型「够」但只够到 vault 一层

- `contracts/agent_vault/sources/vault.move:34` — `public struct AgentVault<phantom T> has key`，且**全部**资金路径都已参数化：`initialize_vault<T>`(:145)、`deposit<T>`(:174)、`withdraw<T>`(:179)、`issue_operator_cap<T>`(:218)、`set_outflow_policy<T>`(:241)、`spawn_agent_card<T>`(:258)、`set_agent_budget<T>`(:303)、`pause_agent<T>`(:323)、`resume_agent<T>`(:343)、`spend_x402_budget<T>`(:361)、`emergency_unilateral_purge<T>`(:415)、只读 `vault_balance/vault_version/is_vault_paused<T>`(:461-469)。`T` 是 phantom，balance 走 `Balance<T>`，任何 `Coin` 类型开箱即用。
- `asynchronous_proposal.move:465` 与 `:522` — `execute_transfer_proposal<T>(… vault: &mut AgentVault<T> …)` 也是泛型。所以「一个资产一个金库」的模型在 Move 层已经成立。

### 1.2 真正的碰壁点 1：Proposal 结构体不记资产身份

- `asynchronous_proposal.move:100-109` — `Proposal { … amount: u64, recipient: address, … }`，无 coin type 字段。`organization_treasury.move:5-7` 的模块注释直接承认："SUI is the only admitted asset: the existing Proposal stores an amount but no asset identity."
- 现状的安全性靠**对象绑定**而非类型绑定：`TransferBinding`（`organization_treasury.move:60-65`）把 proposal 钉到 treasury → treasury 内联封存的 `master_cap` 钉到唯一 `AgentVault<SUI>`（`organization_treasury.move:41-46`，`master_cap: MasterCap` 内联无取出口）。即资产身份=「这个 treasury 的 vault 实例」。多资产要走的路就是每个资产建一个 treasury——链上已经可行，**不需要改 Proposal 结构**，只需要让 `organization_treasury` 的入口泛型化。

### 1.3 链上改动清单（路线①的 Move 侧）

| # | 改动 | 位置 | 工作量 |
|---|---|---|---|
| M1 | `organization_treasury::new<SUI>` → `new<T>`（去 `use sui::sui::SUI`，:23/:107） | `organization_treasury.move:107` `let master_cap = vault::initialize_vault<SUI>(ctx)` | S |
| M2 | `execute`/`execute_for_testing` 的 `vault: &mut AgentVault<SUI>` → `<T>`（:181/:226） | 同文件 | S |
| M3 | 错误文案 `EWrongVault`（:44）等含 "SUI vault" 字样的语义修正 | 同文件 | S |
| M4 | `#[test_only]` 入口同步泛型化 + `organization_treasury_tests.move` 补非 SUI 币回归（用测试币） | tests | S |
| — | **不需要改**：vault、asynchronous_proposal、red_packet（已是 `RedPacket<phantom CoinType>`，`red_packet.move:98`，且 :96 明示接受任意 Coin）、scheduled_payments（`Balance<Asset>` :65） | | |

链上小计：**S（约 1 人日）**。血统 14 升级窗口顺路带上即可；UpgradeCap 单 EOA（审计 H-01，runbook 第 12 项 `0x6e73…72f8`）是发布前置而非本路线阻塞。

### 1.4 碰壁点 2：SDK 与 UI 的 SUI 硬编码（真正的工作量大头）

**SDK 层（packages/multisig）——大部分已参数化，默认值是 SUI：**

- `agent-vault/vault_client.ts:51` — `defaultCoinType = config?.defaultCoinType ?? '0x2::sui::SUI'`；所有 build* 方法均接受 `coinType?` 覆盖（:80,:99,:111,:125,:142,:154,:166,:179,:191,:807,:896,:938,:958）。SDK 主链路 OK。
- 例外（写死 SUI，改不了参数）：
  - `agent-vault/chat/builders.ts:96` — 群聊天收币按 `&mut Coin<SUI>`（链上 `onchain_chat.move` 全模块 `Balance<SUI>/Coin<SUI>` 硬编码，:61-77,:220,:233,:260,:324,:331,:708,:760,:771,:804）。
  - `agent-vault/app-policy/builders.ts:88` — pay 只收 `Coin<SUI>`（链上 `walrus_app_policy.move:211`）。
  - `agent-vault/scallop/*` — SSUI witness 对应 `Scallop MarketCoin<SUI>`（`scallop_yield_adapter.move:18,:27`），换资产=换协议适配器，不是参数问题。
  - `agent-vault/org/reader.ts:87` / `finance/reader.ts` — Organization 的 `genesis_stake: Balance<SUI>` BCS 布局（`cryptographic_org.move:85`）直接裸 u64 解码，与多资产无关但与链改动联动。
  - `dkg/ai_sentinel.ts:1` — 仅用 `MIST_PER_SUI` 换算经济参数，属 gas 计价，换链无关。
- **gas 与计价的本质约束**：Sui 的 gas 只能是 SUI。所有「手续费/保证金/质押」路径（`dkg_committee.move:358,:476,:596` creation_fee/bond；`onchain_chat` 质押池；`cryptographic_org.move:85` genesis_stake）**必须保持 SUI**，多资产只应发生在「资产保管/支付」层。这条边界今天没有注释或类型区分，二开者最容易在这里犯错。

**前端层（lib/ + components/）——硬编码清单：**

| 位置 | 问题 | 工作量 |
|---|---|---|
| `lib/agent-vault-chain.ts:24,:172,:300,:399,:441` | `SUI_TYPE` 作默认 coinType 贯穿 readVault/createAgentVaultWriters | S |
| `components/agent-vault-actions-dialog.tsx:149` | 初始化金库 metadata 写死 `coinType: "0x2::sui::SUI"`，且无资产选择 UI | M（需加资产选择器） |
| `components/create-transaction-dialog.tsx:126` | **过滤器硬门槛**：`vault.coinType === "0x2::sui::SUI"` 才能作为转账金库——多资产最直接的拦路虎 | S |
| `components/group-details-view.tsx:190` | 群余额只汇总 SUI vaults（`normalizeStructTag(row.coinType) === …`） | S |
| `components/group-details-view.tsx:570,:577,:588` | 红包 create/claim/refund 全部写死 `coinType: "0x2::sui::SUI"` | S（链上已泛型） |
| `components/group-treasury.tsx:20-21` | 显示层 `coinType.endsWith("::sui::SUI") ? 9 位小数 : 最小单位`——非 SUI 资产直接显示裸最小单位 | M |
| `lib/payment-assets.ts:29-37` | 资产注册表只有 SUI/USDC(测试网)/USDT(env)，`decimals` 写死 | M |
| `lib/wallet-data.ts:55,:65` | SUI 特判 decimals 9 + 排序置顶 | S |
| `lib/token-weight.ts:45` | decimals 取值 `wanted === SUI_TYPE ? 9 : getCoinMetadata`——正确做法（on-chain CoinMetadata）已有，只是未推广 | S |
| `components/create-bill-dialog.tsx:111` | 账单 coinType 写死 SUI | S |
| `components/payment-scheduler-dialog.tsx:45` / `stream-payment-dialog.tsx:43` | 下拉默认值硬编码 SUI（但已接 `usePaymentAssets` 动态资产列表，`lib/use-payment-assets.ts:40` 按 wallet 实际余额过滤 decimals≠null 资产） | S |
| `components/recurring-payments.tsx:66` | SUI 特判 symbol/decimals | S |

前端小计：**M（约 4-6 人日）**。模式已经存在（payment-scheduler/stream-dialog 的 `usePaymentAssets` + `getCoinMetadata` decimals 动态化），只是没铺满。

### 1.5 路线①结论

- **泛型够吗**：vault/red_packet/scheduled_payments/proposal-execute 四层链上已经泛型，够；**不够的是** organization_treasury 的 SUI 固化（1.2/1.3，S 级修复）和 chat/app-policy/scallop 三个业务模块的 SUI 固化（后两者语义上就该是 SUI 专属，chat 若要多资产是 L 级重构）。
- **UI 硬编码点**：2 处真门槛（create-transaction-dialog:126 的过滤、agent-vault-actions-dialog:149 的初始化），其余是显示/默认值问题。
- 总工作量：**链上 S + SDK S + 前端 M ≈ 6-8 人日**；顺手项（血统 14 升级时同步）。碰壁预警：① gas 计价层（bond/fee/stake）必须留在 SUI，别泛型化；② `Proposal.amount` 无资产字段，靠 vault 对象隔离，UI 端务必展示「proposal → treasury → vault」链路而非把 proposal 当全局资产语义。

---

## 路线② 把组织迁移到别的链

### 2.1 Sui 强耦合清单（迁移时必须重写/替换）

| 耦合面 | 证据 | 替代难度 |
|---|---|---|
| **对象模型与权限**：UID/ID、shared object、key-only cap（无 store 防转让） | `vault.move:34`（shared + phantom）、`vault.move:74-79`（OperatorCap 无 store）、`organization_treasury.move:41-46`（内联封存 MasterCap，"not independently addressable"） | L——非对象链（以太坊系）要用合约存储+modifier 重造 cap 语义；有对象模型的链（Aptos/Sui 系）迁移成本骤降 |
| **动态字段做会话/信箱存储** | `dkg_committee.move` 47 处 dynamic_field/Table（bond/stake 槽 :221/:227，attestation 槽 :177，mailbox `encrypted_mailboxes: Table<MailboxKey, vector<u8>>` :205） | L——等价物是合约内 mapping，但「字段即对象可独立寻址/转移」的读模型没了，索引器要重写 |
| **PTB 原子组合**：创建+share+绑定一 PTB 完成 | `organization_treasury.move:84-99` 注释明确 "Call share with the returned value in this PTB"、`:139-145` execute 前 4 个 assert 的对象同时引用；`vault.move:160` share_object | L——多笔交易拆分会引入中间状态窗口（cap 悬空、binding 未关联），需要额外的两阶段提交设计 |
| **原生 ed25519 验签**（fastcrypto，gas 便宜） | `cryptographic_org.move:191,:637,:674,:719,:808,:823,:930`；`asynchronous_proposal.move:499`；`dkg_committee.move:717` 共 9 处 | 视目标链：有预编译（ed25519）则 S；无则 Move/Solidity 层实现 ed25519 verify 是 L+ 且常被审计否决 |
| **事件 + 原生 sender 语义** | 12 模块 70 处 `event::emit`；`cryptographic_org.move:177` `ctx.sender()`、`dkg_committee.move:700` 同 | M——EVM 有 msg.sender + event；Solana 有 instruction 数据；但「事件即索引事实源」的前端逻辑（lib/online-indexer.ts 等 18 个 SuiGrpcClient 模块）要重写 |
| **TxContext.epoch() 做日切/限额** | `vault.move:192-196,:361-390`（epoch_outflow、spent_in_current_epoch 按 epoch 滚动） | M——换成时间窗（Clock→block.timestamp），但 epoch=普适周期、日切=24h 的语义差异要重写测试 |
| **Clock/Random 原生对象** | `red_packet.move:38,:230`（`random::new_generator`，红包拆分）、`governance_poll/asynchronous_proposal` 的 `clock: &Clock` | M——有等价物，但 Random 在 EVM 无安全等价（VRF/chainlink） |
| **32 字节地址空间** | `dkg/mailbox.ts:48-55` `addressBytes` 假定 32 字节；`cryptographic_org.move:159` pk 32 字节断言 | M/M+——EVM 20 字节地址进 digest 前要 pad32 并全链路统一，漏一处就是摘要不匹配 |
| **Sui 专属黑名单补丁** | `dkg_committee.move:55-70` 小阶公钥编码拉黑（因 ed25519_verify 接受 identity pk，"rt-lit-ed25519-verify 实测链上接受"）——这是在补偿**Sui 原生 verify 不做子群检查**的缺口 | 目标链若有严格的验证库（如 noble 全量校验）可删；否则照抄 |
| **域常量里的 "SUI_" 前缀与 chain_id** | `cryptographic_org.move:38` `DEFAULT_CHAIN_ID = b"sui-testnet:"`；digest 域 `SUI_ORG_*`（`org/constants.ts:36-44`）、`SUI_DKG_*`（`dkg_committee.move:104`）、`SUI_FROST_BINDING_V1`（`threshold_signer.ts:14`）、`SUI_DKG_MAILBOX_V1`（`mailbox.ts:44`） | S——纯字符串，但**改一个字节所有历史摘要/签名作废**，须换域版本号（V3/V2→+1）并保留旧域辨认（项目已有先例：V1 保留辨认、新签走 V2，`cryptographic_org.move:61-63`） |
| **SDK 的 @mysten/sui 依赖面** | `packages/multisig/src`：Transaction/TransactionArgument（builder 30+ 文件）、bcs、normalizeStructTag/normalizeSuiAddress、SuiGrpcClient、MIST_PER_SUI | L——BCS 在多数链有移植但布局是自定义 struct（`lib/proposal-chain.ts:15-22` OrganizationContent 手工 BCS 布局），类型 origin 校验（`lib/group-vaults.ts:154-196` getPackage ABI 校验）整层是 Sui 包模型专属 |

### 2.2 可移植清单（近乎零改动带走）

- **FROST1 全套**（`packages/multisig/src/dkg/`）：`threshold_signer.ts`（RFC 9591 §4.4 逐参与者绑定因子 :14-25,:224-235）、`vss.ts`（Feldman 承诺）、`resharing.ts`（GJKR，DealerHonestyProof :49-66）、`fully_async_dkg.ts`——外部依赖仅 `@noble/curves`、`@noble/hashes`，无 @mysten 导入（dkg/ 目录只有 mailbox.ts 用 `fromHex/toHex` 纯函数 :4）。**这是整个系统里迁移成本最低、价值最高的资产**。
- **摘要域设计与 key_generation 绑定**：V2 摘要布局 `H(domain ‖ chain_id ‖ org_id ‖ epoch ‖ nonce ‖ payload ‖ action_type)`（`cryptographic_org.move:535+` ↔ `org/digest.ts:30-45` 逐字节一致）；treasury transfer 摘要尾绑 `bcs(key_generation)`（内存 #180 不变量）。纯 sha256+手工序列化（`org/bcs.ts`），任何链可复刻。
- **ECIES 信箱**（`dkg/mailbox.ts`）：x25519+HKDF+AES-GCM，AAD V2 绑 domain/session/sender/recipient（:42-45,:146,:200）。唯一 Sui 假设是 32 字节地址（:48-55），换链改 `addressBytes` 一处。
- **错误码注册表**（org 1001-1012 / vault 2012+ / dkg 3001-3028 / proposal 4010-4018）与 `#[error(code)]` 文案：设计可搬，载体随链。
- **准入经济学参数**（creation_fee 0.005 SUI、bond 地板 0.05 SUI、`bond_bounds()/creation_fee_mist()` `dkg_committee.move:1001-1011`）：逻辑可搬，数值随目标链 gas 经济重定。

### 2.3 迁移路线的两条现实路径与碰壁点

- **路径 A（同 Move 生态，如 Aptos）：约 M-L。** Move 源码 70% 可平移（7289 行里 sui::object/transfer/balance 语义在 Aptos 有对应），主要工作是把 cap 模型换成 resource account signer 模型、dynamic_field→table、PTB 拆分。碰壁点：Aptos 无 shared object 的同版本并发语义，DkgSession 共享竞态行为会变，须重跑全部对抗测试（10 轮红队 35+ 闭环不作数）。
- **路径 B（EVM 系）：L+ 且不建议。** 三个结构性死结：① 原生 ed25519_verify 无预编译（除非目标链有，如部分 L2）；② key-only cap 的「非 owner 不可引用他人对象」防重放模型没有等价物，要用存储槽+nonce 重造；③ PTB 原子性消失后 `organization_treasury.move:44-99` 的创建流要两阶段化，而审计注释明确依赖单 PTB（"No init is needed, including when this additive module arrives by upgrade"）。
- **SDK 切分建议**：`packages/multisig/src/dkg/`（纯密码学，已可跨链）与 `agent-vault/`（Sui 绑定）今天已经在目录级分开（见 2.1/2.2），这是迁移唯一的好消息；坏消息是 `agent-vault/org/digest.ts` ↔ Move 的「逐字节一致」契约（文件头注释）意味着**任何一侧改序列化都要四处同步**（SDK digest.ts + reader + 常量表 + 测试 fixture，内存 #180 已载明）。

### 2.4 工作量汇总

- 路径 A（Move 系换链）：**L（10-20 人日）**，其中链上 M、SDK/索引层 M、对抗性重测 M。
- 路径 B（EVM）：**L+（20+ 人日）且密码学验证层要重做安全评审**。
- 碰壁点预警：① `DEFAULT_CHAIN_ID` 硬编码进组织对象且不可变（`cryptographic_org.move:78` chain_id 存于 struct，改域=新组织重建+resharing 重跑）；② genesis_stake 90 天硬锁（`cryptographic_org.move:688-695` 时间戳逻辑）跨链桥接期的双链一致性没有设计；③ 前端 18 个 SuiGrpcClient lib 模块（`lib/*-chain.ts` 系）是隐藏的最大工作量。

---

## 路线③ 把 FROST 换成 Schnorr MuSig2 或 BLS

### 3.1 接口边界在哪

**边界不在 SDK 内部，而在「签名字节 → 链上验签」这条线上。** 系统里 9 个链上验签点全部调用 `sui::ed25519::ed25519_verify(签名, group_pk, digest)`：

- `cryptographic_org.move:191`（创建 PoP）、`:637`（execute_threshold_proposal）、`:674`（advance_epoch）、`:719`（genesis_withdraw）、`:808`（轮换 PoP）、`:823`（rotate_group_key）、`:930`（roster_update）
- `asynchronous_proposal.move:499`（transfer 执行门）
- `dkg_committee.move:717`（participant attestation，64 字节断言 :715、32 字节 pk 断言 :692、小阶拉黑 :696）

链上对签名方案的全部隐含假设：**签名 64 字节、公钥 32 字节（`cryptographic_org.move:159` `group_pk.length()==32`；`dkg_committee.move:692`）、验证算法是 ed25519 单签验证（即「聚合签名在数学上必须长得像普通 Ed25519 签名」）、且库不做子群检查需编码拉黑补偿（:55-70）**。

SDK 侧边界类：`ThresholdSignerNode`（`threshold_signer.ts:192`，generateNonceCommitment/computeSignatureShare 两阶段）、`DKGParticipant`/`FullyAsyncParticipant`（DKG 侧）、`ResharingNode`/`GennaroResharingParticipant`（`resharing.ts:237,:398`）、digest 层（与方案无关，digest 只管「签什么」）。前端消费点：`lib/crypto/threshold_signer.ts:19`（旧版复刻）、`lib/frost-exchange.ts:30-32`（从 multisig/dkg 导入类型）、`lib/committee-session.ts`（浏览器内存分片托管）。

### 3.2 选项 A：MuSig2（Schnorr over secp256k1）——**链上走不通，这是硬墙**

- sui-framework 的密码学原语集（实测依赖目录 `contracts/agent_vault/build/agent_vault/bytecode_modules/dependencies/Sui/`）：ed25519、ecdsa_k1、ecdsa_r1、bls12381、groth16、ecvrf、ristretto255、group_ops、hash、hmac、poseidon、vdf、rangeproofs。**没有 BIP340 Schnorr，也没有通用的「EC 点乘+标量运算」native 可用于自实现**——`group_ops.move` 只有 bls12-381 域（`bls12381.move:80-106` 的 scalar/g1/g2/gt ops）。
- 在 Move 里纯软件实现 secp256k1 点运算+双 SHA256 验证：gas 成本比 native 高 2-3 个数量级，且 Move 无可寻址大整数库，等于把审计面整个重开。结论：**MuSig2 路线在当前 Sui 框架版本上不可行**，除非 Sui framework 未来加入 schnorr 原语。
- 附带说明：MuSig2 是 n-of-n，不是 threshold-t-of-n；要保留 t-of-n 语义还得叠 FROST 风格的 L3 结构，进一步失去意义。

### 3.3 选项 B：BLS threshold（bls12-381）——链上可行，工作量 L，有两个隐藏大坑

- 链上原语存在且是 native：`bls12381_min_sig_verify` / `bls12381_min_pk_verify`（framework 源码 `crypto/bls12381.move:15,:27`）。BLS 门限签名（门限 BDK/DKG）聚合出的签名直接可被 native 验证，**验签 gas 甚至比 ed25519 更省**。
- 坑 1（公钥长度全面破裂）：min_pk 的 G2 公钥是 96 字节、min_sig 的 G1 公钥 48 字节。`cryptographic_org.move:159` 的 32 字节断言、`organization_treasury` 创建流、`dkg_committee.move:692`、`lib/group-vaults.ts:118` 的 Organization BCS 布局（`group_pk:vector<u8>` 虽是 vector，但 SDK/UI 到处假定 32）、`digest.ts` 的 `requireDigest32/requireAddress` 32 字节守卫——全部要改。公钥长度无法平滑兼容，**新 pk 长度=新 Organization 对象**，旧组织迁移必须走一次「BLS 侧 DKG + 新 org + 资产搬家」，等于全量仪式重跑。
- 坑 2（DKG 数学整个换域）：现有 DKG/GJKR 全部建立在 ed25519 群上（`vss.ts:3` `Point = ed25519.Point.BASE`，标量域 L）。BLS 门限需要 bls12-381 标量域（同阶但承诺点在 G1/G2）——`@noble/bls12-381` 可用，但 `threshold_signer.ts` 的 FROST1 双 nonce 协议、`resharing.ts` 的 DealerHonestyProof（ed25519 点算术）**全部重写**，且 BLS 门限方案（如 GJM/JouxE-Palmer）与 FROST 的 nonce 承诺轮次结构不同， Ceremony UI（`dkg-ceremony-dialog.tsx` 的 Round1/Round2 状态机 :275-:861）跟着重排。
- attestation 通道同样受累：`dkg_committee.move:717` 用 `ed25519_verify` 验证参与者会话密钥对 `H(SUI_DKG_ATTEST_V1‖sid‖groupPk)` 的签名——BLS 化后这个通道可继续用 ed25519（身份认证与群签名解耦，天然隔离），这是唯一不用改的部分。

### 3.4 选项 C（报告补充）：留在 Ed25519，但把「可换签名方案」做成接口——推荐先做

- 9 个验签点的调用形状完全一致（`verify(sig, pk, digest)`），唯一阻碍是没有 scheme 分派。最小改造：`Organization` 增加 `sig_scheme: u8` 字段（0=ed25519-FROST1），所有验签点先 `assert!(org.sig_scheme == SCHEME_ED25519, E_SCHEME_MISMATCH)`；未来任何方案迁移=新 scheme 枚举+新验签分支，旧组织永远安全。工作量：**S（1-2 人日，血统 14 顺路）**。
- 碰壁点：`sig_scheme` 进不进摘要？**必须进**（否则换 scheme 后旧签名在新 scheme 组织上重放）——即 digest V3 再加一个尾字节，四处同步成本再付一次（SDK `digest.ts` + `reader.ts` + 常量表 + fixture，先例见 #14 V2 加 action_type 的完整流程，`cryptographic_org.move:60-62`）。

### 3.5 工作量汇总

| 选项 | 链上 | SDK | 前端/仪式 | 总计 |
|---|---|---|---|---|
| C：scheme 字段+摘要 V3 | S | S | S | **S（1-2 人日）** |
| B：BLS 门限全量迁移 | M（新验签点+长度放宽） | L（DKG/签名/resharing 全重写） | M（ceremony UI+组织重建） | **L（10-20 人日）+ 全量安全重审** |
| A：MuSig2 | **不可行**（框架无 Schnorr 原语） | — | — | 阻塞于 Sui framework |

---

## 「如果要成为可二开平台，今天缺的 3 个抽象」

### 抽象 1：资产描述符注册表（Asset Descriptor）——S 级

现状：coin 的 symbol/decimals 判断散落在 6 个文件 11 处（`lib/wallet-data.ts:55`、`lib/token-weight.ts:45`、`components/group-treasury.tsx:20`、`lib/payment-assets.ts:29-37`、`components/recurring-payments.tsx:66`、`create-transaction-dialog.tsx:126`……），每加一种资产要在每个 if 分支补特判，漏一处就是显示 0 小数或过滤器吞掉合法金库。且正确模式已经存在但没推广：`lib/token-weight.ts:45` 对非 SUI 用 `getCoinMetadata` 动态取 decimals、`lib/use-payment-assets.ts:40` 按钱包实际余额列资产。
缺的是：一个统一的 `AssetDescriptor { coinType, symbol, decimals, gasPricing: boolean, custodyPath: "vault" | "custody" | "chat-stake" }` 注册表 + 「gas 层资产必须是 SUI」的显式类型区分（对应 1.4 的本质约束）。落地后路线①的前端工作量从 M 降到 S。工作量：**S**。

### 抽象 2：签名方案接口（ThresholdScheme）——S/M 级

现状：FROST1 的两阶段协议（`generateNonceCommitment`/`computeSignatureShare`）直接以具体类暴露，`lib/frost-exchange.ts:30-32` 与 `lib/crypto/threshold_signer.ts:19` 各自 import 具体实现；链上 9 个验签点无 scheme 概念（3.1）。任何方案迁移都是「换类+改 9 处链上调用+改 BCS 布局」三线并进的爆破作业。
缺的是：`interface ThresholdScheme { schemeId: u8; publicKeyLength: number; signatureLength: number; digestDomainVersion: string; sign(participants): Uint8Array; }` SDK 侧接口 + 链上 `sig_scheme: u8` 字段 + 摘要绑定 scheme（3.4 选项 C）。这是路线③选项 B 的前置工程，不做它，BLS 迁移永远是一次性爆破；做了它，未来任何方案（含 Sui framework 若新增 Schnorr）都变成增量分支。工作量：**S/M**。

### 抽象 3：链适配层（ChainAdapter）——M 级

现状：`packages/multisig/src/dkg/`（纯密码学）与 `agent-vault/`（Sui 绑定）目录上分开，但 `agent-vault` 内部 builder（`Transaction` + moveCall 目标字符串）与 reader（`SuiGrpcClient` + 手工 BCS，`lib/proposal-chain.ts:15-22`）没有接口边界；lib/ 的 18 个 `*-chain.ts` 模块直接 `new SuiGrpcClient`（如 `lib/proposal-chain.ts:8-9`）。域常量 `SUI_ORG_*` 前缀与 `chain_id="sui-testnet:"`（`cryptographic_org.move:38`）埋在摘要第一字节，换链即全部历史签名作废（2.3 碰壁点①）。
缺的是：`ChainAdapter { buildTx(call): TxEnvelope; readObject(id, BcsShape): T; queryEvents(filter): Event[]; addressSpec: 32 | 20; nativeVerify: { schemeId: 0, fn: "ed25519" } … }` 一层接口 + 把「域前缀」从 `SUI_` 改为按 `chain_id` 参数化（域里已有 chain_id 字段的 digest 天然隔离，无需改前缀；真正要动的是 FROST binding 域 `SUI_FROST_BINDING_V1` 与 mailbox AAD 域这类无 chain_id 的常量，加 chainId 入参即可）。工作量：**M**（接口抽取本身机械，成本在让 18 个 lib 模块与 30+ builder 走接口而不破坏现有四道门禁：Move 全绿 + tsc + next build + Vercel Ready）。

### 三个抽象的优先级建议

抽象 2（签名方案接口）> 抽象 1（资产注册表）> 抽象 3（链适配层）。理由：抽象 2 是唯一「不做就永远只能爆破迁移」的安全级接口，且 S/M 成本最低；抽象 1 直接解锁路线①的产品价值；抽象 3 服务于最不确定的路线②（EVM 路径本身存疑），可以等路径 A 确定后再抽。

---

## 附：核验方式

本报告全部结论出自仓库实读（rg/grep/sed 定位，非推测）：链上 9 个验签点逐一列出并核对行号；sui-framework 原语集经 `contracts/agent_vault/build/.../dependencies/Sui/` 依赖字节码目录与 `~/.move/git/.../sui-framework/sources/crypto/` 源码双向确认（bls12381 native 存在、schnorr 缺席）。未做任何链上交易（本路线为代码评估，无需 dev-inspect）。
