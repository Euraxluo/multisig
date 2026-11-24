# agent_vault 第三方安全审计范围

状态：**GAP / UNVERIFIED**。截至本文最后更新，本项目没有独立第三方审计报告。本文件是审计委托材料，不是审计结论，也不把本地测试或内部复核写成第三方意见。

## 1. 审计对象

| 项 | 当前值 | 证据 |
|---|---|---|
| Move 包 | `agent_vault` | `contracts/agent_vault/Move.toml` |
| Move edition | 2024 | `contracts/agent_vault/Move.toml` |
| 依赖 | Sui `8fc60f1fa966e90398c93beb67ad4f42992889c7`（`mainnet-v1.74.1`） | `contracts/agent_vault/Move.toml` 与 `Move.lock`（2026-10-26 只读核对远端 tag 与 lock 一致） |
| Testnet published-at / original-id | `0x73afe159f7b017efdfc7a013a6e444d54317b0147ae7fb182a182c3dc5ba57b5`（fresh lineage，version 1） | `contracts/agent_vault/Published.toml` |
| UpgradeCap | `0xc4b50706bf89d1436006b84c091927095a7e32bb5fa7fed90c15b5eebe700310`，**单址持有、未封印（开发阶段 GAP）** | `Published.toml` → `upgrade-capability` |
| SDK 默认包 ID | 与 published-at 一致（`AGENT_VAULT_PACKAGE_ID`） | `packages/multisig/src/agent-vault/org/constants.ts` |

**血统历史**（审计方按需溯源，旧字节码仍可调用）：

- 最初 lineage root `0x23d1d8a2…`（v1）经 v3 `0x83fb785f…`、v5 `0x0b49cb61…`、v6 `0xbe71f98b…`、v7 `0xca0650d4…`、v8 `0x2bac5eb0…`、v9 `0xebcea19b…`、v10 `0x9d42cc69…` 升级至 v11 `0xd4ce6022…`（首次委员会门限治理升级 tx `2KwtyC7ZgUkaFEM8iXkhVyonAXUYjvCEa7NDPhtyPU31`，FROST 3-of-4 经 `authorize_upgrade` → 原生 Upgrade → `commit_upgrade` 单 PTB）。
- 该 lineage 的 UpgradeCap `0x165bc08f…` 于 2026-10-26 封入共享 `GovernedUpgrader` `0x84899d6b9998f81083ac9720f641ff8261ac5456723aea9b9f58a3bfa67ef40e`（seal tx `EuFw4SYNVHAbFSXBAEKKYJaTLM4bQjfuR7qTQundygEt`，组织 `0x4a2ccdee…`）；因自举分片未持久化，该组织无法再发起门限提案，lineage **冻结于 v11**，仅作历史对象/事件溯源。
- 2026-10-27 起转入 fresh publish 演进（`0x75ae40d8…` 等，含 `red_packet_v2`/`walrus_app_policy_v2`/`governed_upgrade` 模块的中间形态）；当前 `0x73afe159…` lineage 的 12 模块见 §2，**不含** v2 双模块与 `governed_upgrade`（历史对象仍由旧字节码服务，属只读兼容范围）。

审计机构应同时核对源码、编译产物、已部署包和原始类型归属。仅审本地源码不能证明已部署 ABI 与源码一致；仅审 ABI 也不能覆盖源码中的未部署路径。

## 2. 模块范围

当前源码范围包含 `contracts/agent_vault/sources/` 的 12 个模块及其全部生产入口、公开类型、事件、动态字段和升级边界：

- `vault`（文件：`agent_vault.move`）
- `asynchronous_proposal`
- `cryptographic_org`
- `dkg_committee`
- `asset_custody`
- `governance_poll`
- `onchain_chat`
- `organization_treasury`
- `red_packet`
- `scallop_yield_adapter`
- `scheduled_payments`
- `walrus_app_policy`（自报质押/金额入口，需单独审计）

前端仍保留 `red_packet_v2` / `walrus_app_policy_v2` 的接线与环境变量覆盖，但当前包**不含**这两个模块：ABI 探测失败时前端拒绝创建、不回退旧版。审计如需覆盖历史 v2 对象，须另行约定旧包范围。

测试模块用于理解预期行为和复现安全属性，但不能替代生产代码审计。独立包 `contracts/identity` 不在本次 agent_vault 审计范围内（2026-10-29 已独立部署 testnet：package `0xba0780e7…7c9251e`、共享 Names `0x25193e4e…58d8294`、UpgradeCap `0x55f8dcf7…ad59ce` 未封印）；若纳入审计需单独开范围。

## 3. 必审风险

### 3.1 DKG 与门限密钥

- 会话创建、参与者集合、权重与 threshold 的绑定。
- Feldman/VSS 承诺、分片投递、确认、密态信箱公钥登记和动态字段类型归属。
- `attest_group_key`、`finalize_session` 的成员资格、重复申报、阈值、群公钥一致性和重放防护。
- 组织地址是否只由链上最终群公钥决定，以及任意调用方是否能选择、替换或绕过群公钥。
- mainnet 域隔离不新增合约入口：会话固化后由链下 PTB 编排读取 `final_public_key`/已确认名册，调用**既有** `create_organization_with_chain_id` 传目标链标识。审计需评估该链下编排的名册一致性核验。
- 公开事件、共享对象和动态字段是否泄漏私钥分片或可重构材料。
- 任何失败路径是否会留下不可终止、不可恢复或部分提交的会话。

### 3.2 资产与托管

- `vault` 的存入、提取、额度、暂停、epoch、AgentCap/OperatorCap/MasterCap 绑定和紧急清算。
- `asset_custody` 的托管存入、按类型+槽位索引、单事务原子借用（hot potato receipt）、审批与执行释放。
- `organization_treasury` 的组织、Vault、提案、TransferBinding 四者绑定，以及执行、退款和重复执行。
- `scheduled_payments` 的预存、补资、逐期执行、暂停、终止、退款和时间边界。
- `red_packet` 的资产守恒、成员资格、重复领取、随机分配、到期退款。
- `scallop_yield_adapter` 的本金、收益、兑换、残余和管理员权限。
- 所有 Coin 类型、金额单位、余额变化、事件计数和实际对象余额的守恒关系。

### 3.3 组织治理与权限

- 组织名册更新、权重、threshold、成员增删、最后权限、重共享和旧权限残留。
- 提案创建、批准、拒绝、执行、过期和重复执行。
- `governance_poll` 的选民快照、投票权重、模式、截止时间、重复投票和结果重建。
- `onchain_chat` 的频道成员、质押收据、消息发送、批量发送、代发 Cap、限额、撤销、退款与收益债务记账（按质押加权的 `YieldAccumulatorKey`/`MemberYieldKey` 动态字段；`remove_zero_stake_member` 允许创作者移除零质押频道中丢凭证的成员）。
- `walrus_app_policy` 的 registry 绑定、PolicyAdminCap、跨 registry 越权、预算、熔断、策略更新及历史入口。
- sender、对象所有权、capability 类型和跨模块调用是否被错误地当作权限。

### 3.4 升级与依赖

- 当前包与既有已发布类型、函数签名、struct 布局和 abilities 的兼容性（fresh publish 后为独立类型域）。
- `init` 不会在升级时重新运行；升级后的激活、迁移和版本检查是否可用。
- 新旧包同时访问旧共享对象时的行为。
- 已部署 ABI、原始类型包 ID、事件类型和动态字段 NAME 类型是否与前端/SDK 一致。
- UpgradeCap 托管双态：旧 lineage cap 已封入 `GovernedUpgrader`（wrapper 内联包裹后 cap 独立对象不可寻址、`commit_upgrade` 无门禁回收、`governed_transfer_cap` 唯一放行、分片丢失即不可操作——历史事实）；**现行 cap 为单址持有、未封印（GAP）**，封印方案见 `BOOTSTRAP_PRODUCTION_RUNBOOK.md`。
- Sui framework 依赖的版本和已部署字节码/ABI 复核。

### 3.5 边界与组合

- 任意公开函数的直接调用、同一 PTB 组合、第三方代提交、重放、过期、错误对象、错误类型参数和错误 Coin。
- 动态字段数量、事件扫描假设、向量长度、字符串长度、金额、deadline、epoch 和分页相关的有界性。
- 失败交易是否不产生部分资产移动、权限变化、事件谎报或不可恢复锁。
- 事件字段是否足以从链上重建最终状态；事件是否被错误地当成权限或唯一事实来源。

## 4. 审计机构应交付

1. 按严重级别分组的完整发现清单，至少包含：文件/模块/函数、触发前置条件、最小复现、影响、修复建议和是否可在同一 PTB 触发。
2. 对每个 Critical/High 发现提供可重复的 Move test、交易构造或脚本复现，不接受只有截图或口头描述。
3. 源码与已部署字节码/ABI 的差异报告。
4. UpgradeCap、Publisher、共享对象和关键 capability 的权限与生命周期审查。
5. 修复复审报告，逐条标明 fixed / accepted risk / unresolved。
6. 明确审计边界：未审模块、未部署包、未验证的真实钱包流程、跨设备传输层和外部 relayer 不得被默认为已审计。
7. 最终签署日期、审计 commit 或源码归档标识、工具版本和测试命令。

## 5. 交给审计机构的证据包

```bash
cd contracts/agent_vault
sui move build
sui move test
sui move lint --warnings-are-errors
sui client object 0x73afe159f7b017efdfc7a013a6e444d54317b0147ae7fb182a182c3dc5ba57b5 --json
sui client object 0xc4b50706bf89d1436006b84c091927095a7e32bb5fa7fed90c15b5eebe700310 --json
# 历史血统取证（可选）
sui client object 0x84899d6b9998f81083ac9720f641ff8261ac5456723aea9b9f58a3bfa67ef40e --json
sui client tx-block EuFw4SYNVHAbFSXBAEKKYJaTLM4bQjfuR7qTQundygEt --json
sui client tx-block 2KwtyC7ZgUkaFEM8iXkhVyonAXUYjvCEa7NDPhtyPU31 --json
```

审计方还应使用与 `Published.toml` 一致的 testnet 网络和工具链，并把实际命令输出、包 digest、ABI 快照和审计输入归档。不得把私钥、助记词、session secret、prover secret 或 API key 放入证据包。

## 6. 当前内部证据与限制

- 前端离线测试：**REAL，727/727**（2026-11-23，`pnpm exec tsx --test lib/*.test.ts lib/crypto/*.test.ts`），其中名册提交/回执来源与认证/重开恢复 88 项，聚焦门禁 107/107；真实 Chromium IndexedDB 本地验收 **9/9**，包括刷新恢复、双标签页 nonce 原子消费（密封盒路径）、缓存分片重用、存储失败，以及页面重建后过期原回执恢复（该项 execute/resume/live read 为本地注入）。复现与证据边界见 `docs/FROST_LOCAL_ACCEPTANCE.md`，这些结果不代表真实网络传输或扩展钱包 E2E。生产构建已验证：`Content-Security-Policy`（`default-src 'self'`、`object-src 'none'`、`frame-ancestors 'none'`，script/style 因无 nonce 管线保留 `'unsafe-inline'`）、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY` 在页面、API 路由与 404 路径均生效；UI 回归 390px 与 1280px 各 16/16。金库/Agent 创建流要求 MasterCap/AgentCap 的链上 owner 与发起账户/目标地址一致（`expectedOwner`），回执在创建对象解析与校验成功前保持 pending 锁（`deferAcknowledgement`），解析失败时用户经由待恢复入口看到原 digest 而非裸错误。
- Move 全包测试：**424/424**（2026-11-24 实测，当前 12 模块源码）。审计机构应在其环境重新运行并记录输出。
- TypeScript、ESLint、生产构建和浏览器回归均有记录，但这些只覆盖前端工程门禁，不构成 Move 安全审计。
- DKG 信箱密封、终局状态机和 DAO 门限转账已有项目级测试/探测记录；审计方仍需独立复核，不得直接继承结论。
- FROST 前端/SDK 密钥边界：FROST hiding/binding nonce 在写入 IndexedDB 前经 `lib/crypto/device-vault.ts` 以**不可导出** AES-256-GCM 设备密钥密封（AAD 绑定 nonce 记录 id），磁盘对象库只存密文；DKG 设备分片（`lib/committee-share-store.ts` 四个对象库）接入同一密封层，同步冲突比较改用与分片绑定的 SHA-256 tag；zkLogin 临时签名私钥写入 sessionStorage 前同样密封（AAD 绑定临时公钥），签名意图锁用 `navigator.locks` 跨标签页互斥。该边界防磁盘/配置文件拷贝与密文外带，不防已在页面内运行的同源脚本——后者需 `encrypted-keystore.ts` 口令信封或 SIP-9 passkey。2026-11-23 起，FROST 私信承载（协议轮次、私信信封、事件投影与传输）已下沉至 SDK `packages/multisig/src/bridge`，前端 `lib/` 仅保留 IndexedDB/钱包/env 注入薄壳；离线双节点 E2E 在 CI 中验证 request→round1→transcript→round2→aggregate。identity 合约为 testnet 单独部署（不在本审计范围），真实多设备传输/钱包 E2E 与线上事件索引验收仍为 **GAP / UNVERIFIED**。这些产品接线缺口不能被用来降低链上 DKG 算法的独立审计结论。
- UpgradeCap 托管：旧 lineage cap 已封入组织门限 `GovernedUpgrader`（2026-10-26，seal tx `EuFw4SYN…`，治理升级 tx `2KwtyC7Z…` 完成唯一一次 v10→v11 门限升级）；但自举 FROST 分片按安全约束仅存进程内存、未持久化，该组织无法再发起任何门限提案，旧 lineage 冻结在 v11。可操作的委员会托管需在封印前接入加密设备分片库或改用新包发布。**现行 lineage 的 cap 为单址开发阶段托管（GAP）**。
- 现有 `computeProposalDigest` 不包含应用层 `actionType`；FROST proposal action 虽将其纳入请求上下文，但若链上按该字段分派操作，不能把现有 group signature 说成已认证 action type。

## 7. 上线门槛

在以下条件全部满足前，项目只能对外标为未审计或审计进行中：

- 独立机构签发最终报告。
- Critical/High findings 已修复并完成复审，或由明确责任人书面接受风险。
- 源码、已部署 ABI、测试输出和审计 commit 完成归档。
- 现行 UpgradeCap 以可恢复分片方案完成门限托管封印（`docs/BOOTSTRAP_PRODUCTION_RUNBOOK.md`）。
- 真实钱包生命周期和部署/升级/回滚演练另行完成；它们不是审计报告的自动替代物。

当前结论：**GAP / UNVERIFIED；没有第三方审计，不能声称密码学或合约已审计，也不能称 production ready。**
