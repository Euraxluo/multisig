# agent_vault 第三方安全审计范围

状态：**GAP / UNVERIFIED**。截至 2026-10-26，本项目没有独立第三方审计报告。本文件是审计委托材料，不是审计结论，也不把本地测试或内部复核写成第三方意见。

## 1. 审计对象

| 项 | 当前值 | 证据 |
|---|---|---|
| Move 包 | `agent_vault` | `packages/contracts/agent_vault/Move.toml` |
| Move edition | 2024 | `packages/contracts/agent_vault/Move.toml:3` |
| 依赖 | Sui `8fc60f1fa966e90398c93beb67ad4f42992889c7`（`mainnet-v1.74.1`） | `packages/contracts/agent_vault/Move.toml` 与 `Move.lock`；2026-10-26 只读核对远端 tag 与既有 lock 一致 |
| Testnet published-at（现行 lineage） | `0x75ae40d8d59865774e5584a57dd297587c68507e14979849a3c00fa1d6234fc2`（fresh publish，v1） | `packages/contracts/agent_vault/Published.toml:7`；2026-10-27 tx `CbRWAnUsdKq3XGBM1mRjnDp4z568k3b8ADamfdGfD6Tk` 全新发布 **12 模块**（storage 426,436,000 + computation 3,960,000 MIST；同日决策「只保留最好的版本」：删除 `red_packet`/`walrus_app_policy` v1 双模块、`finalize_session`/`_v2` 3013 死桩、未用 `E_MEMBERS_WEIGHTS_MISMATCH`；前一日 14 模块版 `0x334899da81e20d80ad24891f041a21394fc0647eabd5b40b320f0aa4bf5bf2dc` 同日作废）。上一 lineage 终点为 v11 `0xd4ce6022cd96dafc97577ab88b272cdd30f7d29d5a094853041d36b25d831371`，由首次委员会门限治理升级 tx `2KwtyC7ZgUkaFEM8iXkhVyonAXUYjvCEa7NDPhtyPU31` 发布（FROST 3-of-4 经 `authorize_upgrade` → 原生 Upgrade → `commit_upgrade` 单 PTB；`UpgradeAuthorized.digest` 与 CLI 构建产物一致），因自举分片未持久化而**冻结**，仅作历史对象/事件溯源 |
| Original package ID | **现行 lineage**：`0x75ae40d8d59865774e5584a57dd297587c68507e14979849a3c00fa1d6234fc2`（2026-10-27 fresh publish，version 1 起步）；同日作废：`0x334899da81e20d80ad24891f041a21394fc0647eabd5b40b320f0aa4bf5bf2dc`（14 模块版） | `packages/contracts/agent_vault/Published.toml:8`。**旧 lineage**：root `0x23d1d8a2…`（v1）至 v11 `0xd4ce6022cd96dafc97577ab88b272cdd30f7d29d5a094853041d36b25d831371` 已冻结；历史升级包 v3 `0x83fb785f…`、v5 `0x0b49cb61…`、v6 `0xbe71f98b…`、v7 `0xca0650d4…`、v8 `0x2bac5eb0…`、v9 `0xebcea19b…`（GovernedUpgrader 类型的定义包）、v10 `0x9d42cc69…`，其字节码仍可被调用，见 3.4 |
| Published version | `1`（现行新 lineage） | `packages/contracts/agent_vault/Published.toml:9`；链上核验新 UpgradeCap `0x3ccbf816cc2779cae5d422c500050d8be9c1c7fcc770b7d1db067a659cf2e973`：`package: 0x75ae40d8…`、`version: 1`、policy `0.0`（compatible）、owner `AddressOwner: 0x8ac06d3d…`。旧 lineage 终点 v11（经共享 wrapper `0x84899d6b…` 读内联 cap：version 11） |
| UpgradeCap | **现行**：`0xa1c3a64693161a0aa2e774b85898f8724687858fae1f146e4cfb3ef795761d90`（新 lineage v1）；**旧（冻结）**：`0x165bc08f…`（v1–v11） | `packages/contracts/agent_vault/Published.toml:12` |
| Current UpgradeCap custody | **现行新 cap `0xa1c3a64693161a0aa2e774b85898f8724687858fae1f146e4cfb3ef795761d90`：单址 `0x8ac06d3d…`（开发阶段 GAP，未封印）**；旧 cap `0x165bc08f…` 永久封存于共享 `GovernedUpgrader` `0x84899d6b9998f81083ac9720f641ff8261ac5456723aea9b9f58a3bfa67ef40e`（组织 `0x4a2ccdee…`，FROST 3-of-4，threshold_weight=3，分片未持久化故不可再操作） | 新 cap：`sui client object 0xa1c3a64693…`（2026-10-27）。旧 cap：seal tx `EuFw4SYNVHAbFSXBAEKKYJaTLM4bQjfuR7qTQundygEt` 后独立读取 404（wrapped 语义），经 wrapper 核验 |

审计机构应同时核对源码、编译产物、已部署 v7 包和原始类型归属。仅审本地源码不能证明已部署 ABI 与源码一致；仅审 ABI 也不能覆盖源码中的未部署路径。

## 2. 模块范围

本次源码范围包含 `packages/contracts/agent_vault/sources/` 的 12 个模块及其全部生产入口（v1 `red_packet`/`walrus_app_policy` 已删除，v2 为唯一版本；旧包上二者的历史对象仍由旧字节码服务，属只读兼容范围）、公开类型、事件、动态字段和升级边界。2026-10-27 的 fresh publish（现行包 `0x75ae40d8…`，tx `CbRWAnUsdKq3XGBM1mRjnDp4z568k3b8ADamfdGfD6Tk`）发布 12 个模块（含 `governed_upgrade`）；其源码等于 v11 源码减去两个已回退的审计面积增补、再减去 v1 红包/政策双模块与 3013/1004 死代码（见 §6 测试计数条目）；只读 dry-run 已确认新入口在 v8 解析（`remove_zero_stake_member`、`governance_poll::new_manual`、`organization_treasury::new`、`red_packet_v2::create`、`scheduled_payments::create_recurring`、`walrus_app_policy_v2::initialize_registry_v2` 均解析，未知函数名对照失败）：

- `vault`（文件：`agent_vault.move`）
- `asynchronous_proposal`
- `cryptographic_org`
- `dkg_committee`
- `governance_poll`
- `governed_upgrade`（自举托管：把本包自身 `UpgradeCap` 封入组织门限治理的共享 wrapper；`authorize_upgrade` 绑定 wrapper id + 32 字节编译 digest，`commit_upgrade` 无门禁回收原生回执，`governed_transfer_cap` 为唯一放行路径。**2026-10-26 已随 v11 生效并完成首次治理升级实测**：seal tx `EuFw4SYN…`、治理升级 tx `2KwtyC7Z…`、组织 `0x4a2ccdee…`）
- `onchain_chat`
- `organization_treasury`
- `red_packet`
- `red_packet_v2`
- `scallop_yield_adapter`
- `scheduled_payments`
- `walrus_app_policy`（legacy，旧自报质押/金额入口仍需单独审计）
- `walrus_app_policy_v2`（独立 registry/policy、真实收据/SUI 付款；**2026-10-26 已随 v8 部署**，历史调用入口仍指向旧包。前端已完整接线：`lib/walrus-app-policy-v2.ts` 对 testnet v8 做过真实 ABI 探测（五入口全部解析）、registry 快照读取、离线 PTB 构造器、创建对象解析（AdminCapV2 归属校验）、付款人自有 `MemberStakeReceipt` 列表与登记前频道对象预检（对象类型/持有人/ID 对账，逐项校验不跳过）；`components/walrus-policy-registry.tsx` 的 `WalrusPolicyV2Registry` 提供用户签名的初始化/登记/付款/暂停入口——登记按钮在频道经共享 ChatChannel 预检前不解锁；付款表单按快照提供已登记应用下拉（已暂停禁选）、凭证选择器自动填入频道并把与策略权威频道不符的凭证禁选，频道不匹配/质押不足/金额超单笔上限均有前置警示；链上仍独立复核，无自动提交。testnet 的 registry 对象尚未初始化，真实钱包签名的 V2 链上生命周期仍为 **UNVERIFIED**）

测试模块用于理解预期行为和复现安全属性，但不能替代生产代码审计。独立包 `contracts/identity` 不在本次 agent_vault 审计范围内；**2026-10-29 已独立部署 testnet**（package `0xba0780e7…7c9251e`、共享 Names `0x25193e4e…58d8294`、UpgradeCap `0x55f8dcf7…ad59ce` 未封印，演化同样走 fresh publish）——若纳入审计需单独开范围。

## 3. 必审风险

### 3.1 DKG 与门限密钥

- 会话创建、参与者集合、权重与 threshold 的绑定。
- Feldman/VSS 承诺、分片投递、确认、密态信箱公钥登记和动态字段类型归属。
- `attest_group_key`、`finalize_session_v3` 的成员资格、重复申报、阈值、群公钥一致性和重放防护。
- v1/v2 固化入口的兼容行为、拒绝条件和旧会话边界。
- 组织地址是否只由链上最终群公钥决定，以及任意调用方是否能选择、替换或绕过群公钥。
- mainnet 域隔离不新增合约入口：会话固化后由链下 PTB 编排读取 `final_public_key`/已确认名册，调用**既有** `create_organization_with_chain_id` 传目标链标识（2026-10-27 按审计行数决策撤销了曾加的会话路径 chain-id 变体）。审计需评估该链下编排的名册一致性核验。
- 公开事件、共享对象和动态字段是否泄漏私钥分片或可重构材料。
- 任何失败路径是否会留下不可终止、不可恢复或部分提交的会话。

### 3.2 资产与托管

- `vault` 的存入、提取、额度、暂停、epoch、AgentCap/OperatorCap/MasterCap 绑定和紧急清算。
- `organization_treasury` 的组织、Vault、提案、TransferBinding 四者绑定，以及执行、退款和重复执行。
- `scheduled_payments` 的预存、补资、逐期执行、暂停、终止、退款和时间边界。
- `red_packet` 与 `red_packet_v2` 的资产守恒、成员资格、重复领取、随机分配、到期退款和旧入口隔离。
- `scallop_yield_adapter` 的本金、收益、兑换、残余和管理员权限。
- 所有 Coin 类型、金额单位、余额变化、事件计数和实际对象余额的守恒关系。

### 3.3 组织治理与权限

- 组织名册更新、权重、threshold、成员增删、最后权限、重共享和旧权限残留。
- 提案创建、批准、拒绝、执行、过期和重复执行。
- `governance_poll` 的选民快照、投票权重、模式、截止时间、重复投票和结果重建。
- `onchain_chat` 的频道成员、质押收据、消息发送、批量发送、代发 Cap、限额、撤销和退款。v8 起会员分红改为按质押加权的收益债务记账（`YieldAccumulatorKey`/`MemberYieldKey` 动态字段，不改已发布 `ChatChannel` 布局）：晚进群者债务快照等于当前累加器，退群只能拿到入群后分配的份额，快进快出无法收割存量分红池；分母为本金池余额，无质押频道的分红留在池中由解散时创作者回收；新增 `remove_zero_stake_member` 允许创作者移除零质押频道中丢凭证的成员以解除解散阻塞（有质押成员仍只能凭本人收据退出）。旧 v7 字节码的人头均分入口仍可被直接调用，需评估存量频道在两个包间的行为分叉。
- `walrus_app_policy` 的 registry 绑定、PolicyAdminCap、跨 registry 越权、预算、熔断、策略更新及仍可调用的旧入口；新增 `walrus_app_policy_v2` 的 AdminCapV2/registry 绑定、权威频道、MemberStakeReceipt 持有人/成员/质押校验、实际 Coin<SUI> 付款、固定收款人、逐笔/逐 epoch 额度与退出路径。
- sender、对象所有权、capability 类型和跨模块调用是否被错误地当作权限。

### 3.4 升级与依赖

- v7 与既有已发布类型、函数签名、struct 布局和 abilities 的兼容性。
- `init` 不会在升级时重新运行；升级后的激活、迁移和版本检查是否可用。
- 新旧包同时访问旧共享对象时的行为。
- 已部署 ABI、原始类型包 ID、事件类型和动态字段 NAME 类型是否与前端/SDK 一致。
- UpgradeCap 单地址托管已由 `governed_upgrade` 封入组织门限 wrapper（见 §2），但审计仍需复核：wrapper 内联包裹后 cap 独立对象不可寻址（wrapped 语义）、`commit_upgrade` 的无门禁回收边界、`governed_transfer_cap` 的唯一放行路径、以及组织群密钥分片丢失时托管是否变为不可操作（本项目现状见 §6 托管条目）。
- Sui framework 依赖的版本和已部署字节码/ABI 复核。

### 3.5 边界与组合

- 任意公开函数的直接调用、同一 PTB 组合、第三方代提交、重放、过期、错误对象、错误类型参数和错误 Coin。
- 动态字段数量、事件扫描假设、向量长度、字符串长度、金额、deadline、epoch 和分页相关的有界性。
- 失败交易是否不产生部分资产移动、权限变化、事件谎报或不可恢复锁。
- 事件字段是否足以从链上重建最终状态；事件是否被错误地当成权限或唯一事实来源。

## 4. 审计机构应交付

1. 按严重级别分组的完整发现清单，至少包含：文件/模块/函数、触发前置条件、最小复现、影响、修复建议和是否可在同一 PTB 触发。
2. 对每个 Critical/High 发现提供可重复的 Move test、交易构造或脚本复现，不接受只有截图或口头描述。
3. 源码与 v7 已部署字节码/ABI 的差异报告。
4. UpgradeCap、Publisher、共享对象和关键 capability 的权限与生命周期审查。
5. 修复复审报告，逐条标明 fixed / accepted risk / unresolved。
6. 明确审计边界：未审模块、未部署包、未验证的真实钱包流程、跨设备传输层和外部 relayer 不得被默认为已审计。
7. 最终签署日期、审计 commit 或源码归档标识、工具版本和测试命令。

## 5. 交给审计机构的证据包

```bash
cd /Users/echo/project/sui_project_a/packages/contracts/agent_vault
sui move build
sui move test
sui move test --lint
sui client object 0x75ae40d8d59865774e5584a57dd297587c68507e14979849a3c00fa1d6234fc2 --json
sui client object 0xa1c3a64693161a0aa2e774b85898f8724687858fae1f146e4cfb3ef795761d90 --json
sui client tx-block baM5G46UKidUZv55LpSDGdJrCVt3fwY9S8eVZuKtPBP --json
sui client object 0x84899d6b9998f81083ac9720f641ff8261ac5456723aea9b9f58a3bfa67ef40e --json
sui client tx-block EuFw4SYNVHAbFSXBAEKKYJaTLM4bQjfuR7qTQundygEt --json
sui client tx-block 2KwtyC7ZgUkaFEM8iXkhVyonAXUYjvCEa7NDPhtyPU31 --json
```

审计方还应使用与 `Published.toml` 一致的 testnet 网络和工具链，并把实际命令输出、包 digest、ABI 快照和审计输入归档。不得把私钥、助记词、session secret、prover secret 或 API key 放入证据包。

## 6. 当前内部证据与限制

- 前端离线测试：**REAL，726/726**（2026-10-26，含设备密钥库/密封回回归、创建流 owner 断言/延迟回执确认、V2 ABI 门禁/PTB 构造/registry 读取/创建对象解析/自有质押凭证列表/频道预检 10 项；门禁命令为仓库根目录裸 `node --import tsx --test`——本仓库全部 `.test.ts` 均未提交，显式传文件参数会禁用递归发现）；其中名册提交/回执来源与认证/重开恢复 88 项，聚焦门禁 107/107；真实 Chromium IndexedDB 本地验收 **9/9**（2026-10-26 密封改造后复跑通过），包括刷新恢复、双标签页 nonce 原子消费（密封盒路径）、缓存分片重用、存储失败，以及页面重建后过期原回执恢复（该项 execute/resume/live read 为本地注入）。独立原回执 UI 入口与旧版签名前恢复已接线，普通签名 TTL 不放宽。key-preserving roster update 的 request/result/有序 action 绑定、原 digest 恢复、设备 epoch CAS 与解锁顺序由离线提交模块测试覆盖，回执 metadata 仅是本机归因记录，不是链上内容证明。复现与证据边界见 `docs/FROST_LOCAL_ACCEPTANCE.md`，这些结果不代表真实网络传输或扩展钱包 E2E。生产构建已验证（2026-10-26 `pnpm build` + 3005 端口实测）：`Content-Security-Policy`（`default-src 'self'`、`object-src 'none'`、`frame-ancestors 'none'`，script/style 因无 nonce 管线保留 `'unsafe-inline'`）、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY` 在页面、API 路由与 404 路径均生效；同构建 UI 回归 390px 与 1280px 各 16/16。金库/Agent 创建流现已要求 MasterCap/AgentCap 的链上 owner 与发起账户/目标地址一致（`lib/agent-vault-chain.ts` `expectedOwner`），且回执在创建对象解析与校验成功前保持 pending 锁（`lib/agent-vault-transactions.ts` `deferAcknowledgement`），解析失败时用户经由待恢复入口看到原 digest 而非裸错误。
- Move 全包测试：**现行新包（2026-10-27 fresh publish）的发布门禁为 303/303**。曾加入的 `first_governed_upgrade_version` 版本标记与会话路径 chain-id 变体（含 `E_INVALID_CHAIN_ID` 与 2 项测试，使计数一度为 306）已按「审计按行计费、编排走 PTB」的决策回退出源码：v11（冻结旧 lineage）发布时门禁为 304/304 且含该标记，新旧包源码差异即此两项。审计机构应在其环境重新运行并记录输出。
- TypeScript、ESLint、生产构建和浏览器回归均有记录，但这些只覆盖前端工程门禁，不构成 Move 安全审计。
- DKG 信箱密封、v6/v7 终局状态机和 DAO 门限转账已有项目级测试/探测记录；审计方仍需独立复核，不得直接继承结论。
- 旧 `lib/frost-exchange.ts` 仍是协议库与测试；新增 `lib/frost-session.ts`、`lib/frost-session-store.ts` 与 `lib/frost-private-transport.ts` 已提供带上下文校验、IndexedDB nonce 消费和私信 API 的代码边界。2026-10-26 起，FROST hiding/binding nonce 在写入 IndexedDB 前经 `lib/crypto/device-vault.ts` 以**不可导出** AES-256-GCM 设备密钥密封，AAD 绑定 nonce 记录 id（keyPackageId:contextHash:index），磁盘对象库只存密文；密封/开封发生在调用方边界，nonce 燃烧事务仍为同步原子提交，旧明文记录仅保留读取兼容。同日，DKG 设备分片（`lib/committee-share-store.ts` 的 pending/bound/dealer/legacy 四个对象库）也接入同一密封层：写入前密封、读取时开封，同步冲突比较改用与分片绑定的 SHA-256 tag（该 tag 不泄漏可用信息——验证分片本就可由公开承诺多项式导出），绑定/换届的 CAS 事务保持原同步语义，绑定路径在跨 id 迁移时于事务外重新密封。该边界防磁盘/配置文件拷贝与密文外带，不防已在页面内运行的同源脚本——后者需 `encrypted-keystore.ts` 口令信封或 SIP-9 passkey。同日，zkLogin 临时签名私钥在写入 sessionStorage 前也经同一设备密钥库密封（AAD 绑定该次登录的临时公钥，`lib/zklogin.ts`），签名意图锁改为 `navigator.locks` Web Locks 跨标签页互斥、无该 API 时回退本标签内存锁（`lib/sui-wallet-signer.ts`）。名册换届 UI 已接入手动公开 JSON 与 `frost-private-transport.ts` 私信两种 FROST 请求/两轮交换/聚合并提交前刷新门禁（`components/group-roster-dialog.tsx`、`lib/group-roster-transactions.ts`）；私信记录按已认证发送身份、当前 request、transcript 和固定 signer index 逐条验证，identity 私信承载仍未部署。名册 FROST 的真实多设备传输/钱包 E2E 仍为 **GAP / UNVERIFIED**；DKG v7 终局使用成员申报路径，其浏览器多设备验收另列。这些产品接线缺口不能被用来降低链上 DKG 算法的独立审计结论。
- UpgradeCap 托管：**已由组织门限治理接管（2026-10-26）**。seal tx `EuFw4SYN…` 把 cap 封入共享 `GovernedUpgrader` `0x84899d6b…`（组织 `0x4a2ccdee…`，FROST 3-of-4、threshold_weight=3、成员权重 1）；首次治理升级 tx `2KwtyC7Z…` 以门限签名完成 v10→v11（`ProposalExecutedEvent` nonce=1、`UpgradeAuthorized.digest` 与 CLI 构建产物逐字节一致、cap version=11）。
  **操作能力限制（重要）**：本次自举仪式的 FROST 分片按安全约束仅存进程内存、未持久化，进程结束即不可再生成该群签名；因此该组织无法再发起任何门限提案，此包 lineage 的后续升级与 `governed_transfer_cap` 均不可用（cap 永久封存于 wrapper，包冻结在 v11）。这不是链上缺陷，而是「不持久化分片」约束的必然结果；可操作的委员会托管需在封印前接入加密设备分片库（前端 `committee-share-store` 路径）或改用新包发布。
- 现有 `computeProposalDigest` 不包含应用层 `actionType`；FROST proposal action 虽将其纳入请求上下文，但若链上按该字段分派操作，不能把现有 group signature 说成已认证 action type。

## 7. 上线门槛

在以下条件全部满足前，项目只能对外标为未审计或审计进行中：

- 独立机构签发最终报告。
- Critical/High findings 已修复并完成复审，或由明确责任人书面接受风险。
- 源码、v7 已部署 ABI、测试输出和审计 commit 完成归档。
- UpgradeCap 双态：旧 lineage cap 已封入组织门限 wrapper（链上可核）但分片未持久化、不可再操作（历史事实）；**现行新包 cap 为单址开发阶段托管（GAP）**——生产上线前须按 `sui_project_a/docs/BOOTSTRAP_PRODUCTION_RUNBOOK.md` 以可恢复分片方案完成封印演练。
- 真实钱包生命周期和部署/升级/回滚演练另行完成；它们不是审计报告的自动替代物。

当前结论：**GAP / UNVERIFIED；没有第三方审计，不能声称密码学或合约已审计，也不能称 production ready。**
