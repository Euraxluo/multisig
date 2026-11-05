# 部署清单（Testnet）

本文只描述**如何部署**，不执行任何部署。所有命令都需先取得明确解禁：部署新包、升级、发交易各自单独解禁，不累积。

状态标签沿用项目约定：**REAL**（已核验）、**UNVERIFIED**（未端到端验证）、**GAP**（配置缺失）、**NOT-DEPLOYED**（代码已写未上链）。

---

## 1. 合约包

### 1.1 当前链上基线（REAL）

| 项 | 值 | 证据 |
|---|---|---|
| 包名 | `agent_vault` | `packages/contracts/agent_vault/Move.toml` |
| 当前版本 | **新 lineage v1** | `Published.toml` → `version = 1`（2026-10-27 fresh publish tx `baM5G46UKidUZv55LpSDGdJrCVt3fwY9S8eVZuKtPBP`；旧 lineage 至 v11 已冻结，见 §2.3） |
| 当前调用目标 | `0xd4ce6022cd96dafc97577ab88b272cdd30f7d29d5a094853041d36b25d831371`（新 lineage v1，2026-10-27 fresh publish tx `baM5G46UKidUZv55LpSDGdJrCVt3fwY9S8eVZuKtPBP`，14 模块） | `Published.toml` → `published-at` |
| Published.toml 记录 original-id | `0x23d1d8a26813531cbf3832f522f9d16c5548fd3c9f9b1c5609bbd6adbe87dfe1`（v1 root，2026-10-26 v8 升级时由 CLI 改写为该正确值；此前误记 v3 升级包 `0x83fb785f…`） | `Published.toml` → `original-id` |
| 升级能力对象 | `0x165bc08fb1e2cc1fb3b92d345d49762269dae5aa5248bc06ae88cdb7730979a1` | `Published.toml` → `upgrade-capability` |
| 历史版本（字节码仍可调用） | v3 `0x83fb785f…`、v6 `0xbe71f98b…`、v7 `0xca0650d4…`（2026-10-22，升级 tx `397b7gbuqhvoDuAo3qCBdWg5CQxiogRj42cKz7DgEqcw`） | `PACKAGE_LINEAGE`（`lib/proposal-chain.ts`）保留其事件溯源 |
| chain-id | `4c78adac`（testnet） | `Published.toml` |
| 工具链 | `sui 1.82.1` | `Published.toml` → `toolchain-version` |
| Move edition | 2024 | `Move.toml` |

**三条不可混淆的 ID 规则**（本项目已实证，违反会静默读不到数据）：

1. **调用/读取目标**用最新包 `published-at`。兼容升级会铸造**新包对象**，旧包**不会**转发到新增函数——用 `0xaca8c6cc…` 调 `dkg_revision` 会返回 `Could not resolve function`。
2. **对象类型、事件类型、动态字段 NAME 类型**永远用**定义该类型的包**拼写。升级不改变类型拼写。`DkgSession` 的 `definingId` 始终是 `0x23d1d8a2…`。
3. 因此前端涉及四个不同常量，见 `lib/proposal-chain.ts` 与 `lib/dkg-type-origin.ts`：
   - `PROPOSAL_PACKAGE_ID` = 最新包（调用目标）
   - `PROTOCOL_MODULE_ORIGIN` = `0xaca8c6cc…`（v4 引入模块的类型定义处）
   - `PROPOSAL_TYPE_ORIGIN` = `0x23d1d8a2…`（最初类型定义处）
   - `DKG_TYPE_ORIGIN` = `0x23d1d8a2…`（`lib/dkg-type-origin.ts`，用于动态字段 name 类型）

### 1.2 已发布模块与本地源码

当前 testnet v7 包含以下 12 个模块（文件名 `agent_vault.move` 内的模块名是 `vault`）：

```
agent_vault.move (module: vault)   asynchronous_proposal.move    cryptographic_org.move
dkg_committee.move                 governance_poll.move          onchain_chat.move
organization_treasury.move         red_packet.move               red_packet_v2.move
scallop_yield_adapter.move         scheduled_payments.move       walrus_app_policy.move
```

2026-10-26 通过 `sui client object <当前版本> --json` 只读核对：v7 的 `content.Package.module_map` 含上述 12 个模块，包 digest 为 `7NrgaektvbVoeUZa9EP4b4fwEeHpTXMtBcEmgZxjtKf3`。这仅证明模块存在，不证明当前本地源码等同于部署字节码或真实钱包生命周期通过。

本地 `sources/` 另含第 13 个模块 `walrus_app_policy_v2.move`；它在 v7 的模块映射之外（v7 时期 NOT-DEPLOYED），**2026-10-26 已随 v8 发布**（见 §1.1 v8 基线）。身份包仍独立于这些模块。

**NOT-DEPLOYED 说明**：`contracts/identity`（独立包，48/48 Move 测试通过）**从未部署**。前端 `NEXT_PUBLIC_IDENTITY_PACKAGE_ID` / `NEXT_PUBLIC_IDENTITY_NAMES_ID` 留空时，身份相关功能保持禁用；原生 SuiNS 不依赖它，仍可用。

### 1.3 构建与测试门禁

```bash
cd /Users/echo/project/sui_project_a/packages/contracts/agent_vault
sui move build
sui move test                 # 既有本地记录 287/287（含未部署 Walrus V2）；发布前重新运行
sui move test --lint
```

**部署前必须全绿。** 任一项失败即停止。

Sui framework 的 manifest 与锁文件均固定到 `8fc60f1fa966e90398c93beb67ad4f42992889c7`；2026-10-26 只读 `git ls-remote` 确认它与 `mainnet-v1.74.1` tag 及既有 `Move.lock` 一致。本次固定 manifest 引用未更换依赖源码。既有 `.gitignore` 原先排除该锁文件，现已为 agent_vault 增加例外；本轮仅让生成锁文件可审阅，未暂存或提交。发布证据归档必须同时包含 manifest 与锁文件；升级依赖须另外复核，不能删除锁文件后依赖可移动 tag 复现审计输入。

---

## 2. 部署顺序

### 2.1 首次发布（当前已完成，此处仅作文档）

```bash
# 1. 确认链与环境
sui client active-env          # 必须是 testnet
sui client active-address

# 2. 构建 + 全量测试
sui move build && sui move test

# 3. 发布（消耗一次解禁）
sui client publish --gas-budget 500000000

# 4. 记录三样东西，写回 Published.toml
#    - published-at（新包 ID）
#    - original-id（首次发布即与 published-at 相同）
#    - upgrade-capability（UpgradeCap 对象 ID）
```

**当前核验（REAL，2026-10-26，只读）**：UpgradeCap `0x165bc08f…` 已封入共享 `GovernedUpgrader` `0x84899d6b9998f81083ac9720f641ff8261ac5456723aea9b9f58a3bfa67ef40e`（seal tx `EuFw4SYNVHAbFSXBAEKKYJaTLM4bQjfuR7qTQundygEt`），独立对象读取 404（wrapped 语义）；经 wrapper 读取内联 cap 为 `package: 0xd4ce6022…`、`version: 11`、policy `0.0`（compatible），治理组织 `0x4a2ccdee1445322cb03c04c00823937580362aaddc6f439268f8fc69a0dd8736`（FROST 3-of-4，threshold_weight=3，`last_nonce: 1` 已被治理升级燃烧）。单地址托管 GAP 已关闭，但存在 §2.3 所述操作能力限制。

### 2.2 兼容升级（v6/v7/v8 已按此路径完成）

> **⚠️ 升级门禁与模块边界**：本地 `sources/` 的 13 个模块已随 **v8（2026-10-26，tx `D2rwcf7YFuHXu2oHgzJC3Z6Lq2MNQm6LCmAAqAWzz5tB`）全部发布**，含 `walrus_app_policy_v2.move`（绑定真实付款的收据校验入口）；dry-run 与实际升级的 `objectChanges.published` 模块清单一致（13 个模块）。v8 同时落地 `onchain_chat` 收益债务记账（动态字段，未改 `ChatChannel` 已发布布局）与 `remove_zero_stake_member`。后续升级仍须逐一核对 module_map 只含预期变更。

```bash
# 1. 只允许兼容变更：新增函数、新增模块、放宽泛型约束。
#    禁止：改已有 public 函数签名、改已发布 struct/enum 布局与 abilities。
sui move build && sui move test

# 2. 升级前先在本地核对发布策略
sui client upgrade --help

# 3. 升级（消耗一次解禁）
sui client upgrade --gas-budget 500000000 --upgrade-capability 0x165bc08f…

# 4. Published.toml 由 CLI 自动更新 version 与 published-at
# 5. 更新前端 NEXT_PUBLIC_PROPOSAL_PACKAGE_ID 为新 published-at
```

**升级后必做的三步验证**（v5、v6 升级时逐条做过）：

```bash
# a. 新函数只在最新包上可解析
sui client call --package <新包ID> --module dkg_committee --function dkg_revision --gas-budget 10000000
# 期望：能解析并返回 revision；用旧包 ID 调同一函数应报 Could not resolve function

# b. 旧对象仍可读（类型拼写不变）
#    用前端只读探测或 sui client object <旧对象ID>，确认 type 前缀仍是原始包 ID

# c. 事件仍按原始包 ID 拼写
#    查询事件时必须用 PROPOSAL_TYPE_ORIGIN，用新包前缀查询返回 0
```

### 2.3 UpgradeCap 托管材料（仅材料，不执行）

目标策略：把 UpgradeCap 作为一次性治理根权限交给**独立的 Sui MultiSig 地址**，建议 3-of-5、五个独立签名者、权重各 1。当前工作区已有五个本地 keystore 公钥，可用以下只读命令复算候选地址；这些本地账户只是候选配置，未经用户确认不得视为生产托管成员：

```bash
sui keytool list --json
sui keytool multi-sig-address \
  --threshold 3 --weights 1 1 1 1 1 \
  --pks <PK_1_BASE64> <PK_2_BASE64> <PK_3_BASE64> <PK_4_BASE64> <PK_5_BASE64>
```

本次只读复算（REAL）得到候选地址：`0x67255000e6f9873fb595cfaaa39d5b5165682b04f6aa102d96860cb065daaf4a`。该地址尚未被用户确认，也没有持有 UpgradeCap；不能把候选地址写成已完成托管。

得到**用户确认的目标多签地址**后，实际转移命令是一次性动作，必须另行解禁：

```bash
sui client transfer \
  --object-id 0x165bc08fb1e2cc1fb3b92d345d49762269dae5aa5248bc06ae88cdb7730979a1 \
  --to <CONFIRMED_MULTISIG_ADDRESS> \
  --gas-budget <BUDGET>
```

执行前检查：active-env 必须为 `testnet`；当前 owner 必须能签名；目标地址必须由独立公钥和已确认阈值复算；执行后用 `sui client object <UPGRADE_CAP_ID> --json` 核对 `owner.AddressOwner` 已变为目标多签地址。该转移不可由当前材料自动回滚；恢复路径是由多签持有人重新发起一笔转回交易，仍需达到阈值。

**当前状态：已封入组织门限托管（2026-10-26）**。seal tx `EuFw4SYNVHAbFSXBAEKKYJaTLM4bQjfuR7qTQundygEt` 以 `governed_upgrade::receive_cap`+`share` 把 cap 封入 `0x84899d6b9998f81083ac9720f641ff8261ac5456723aea9b9f58a3bfa67ef40e`；治理升级 tx `2KwtyC7ZgUkaFEM8iXkhVyonAXUYjvCEa7NDPhtyPU31` 完成首次 v10→v11 门限升级。上方「转 Sui MultiSig 地址」的旧方案已被该路径取代且**不再可行**（cap 已包裹，`sui client transfer` 不可用）。

  **操作能力限制**：自举仪式的 FROST 分片仅存进程内存（安全约束：DKG 私分片不落盘），进程结束即失；该组织无法再发起门限提案，后续升级与 `governed_transfer_cap` 均不可用——此包 lineage 冻结在 v11。后续合约演进需发布新包（新 original-id）或事先接入加密设备分片库再做托管。

---

### 2.4 回滚路径

**兼容升级无法回滚**。Sui 的 UpgradeCap 只能前进，不能指向旧版本。因此：

- 回滚 = **发布一个把行为改回去的新版本**（version N+1），不是撤销。
- **共享对象的状态布局不可回滚**。若新版本写入了新字段（通过 dynamic field），旧逻辑不会读它，数据仍在链上。
- **升级前必须做的准备**：
  1. 记录当前 `published-at` 与 `version`（本文 §1.1 即是）。
  2. 导出一份当前前端 `.env` 的包 ID 配置。
  3. 在 testnet 上先用一次性包演练同一份 diff。
- 若升级后发现问题，**先把前端 `NEXT_PUBLIC_PROPOSAL_PACKAGE_ID` 指回旧包**（旧包仍在链上，原函数仍可调），再准备修复版。这只对"新增函数有问题"有效；已通过新函数写入的状态无法被旧逻辑正确处理。

---

## 3. 环境变量

### 3.1 核心与认证变量

| 变量 | 作用 | 缺失时行为 |
|---|---|---|
| `NEXT_PUBLIC_PROPOSAL_PACKAGE_ID` | 调用目标包（升级后需更新） | 留空回退到内置 testnet v7 ID（`lib/proposal-chain.ts`）；自定义部署/主网发布需显式提供 |
| `ZKLOGIN_ORIGIN` | 精确 origin，无尾斜杠 | zkLogin 不可用 |
| `ZKLOGIN_GOOGLE_CLIENT_ID` | Google OAuth 客户端 | zkLogin 不可用 |
| `ZKLOGIN_SESSION_SECRET` | `openssl rand -hex 32` | zkLogin 不可用 |
| `ZKLOGIN_SALT_URL` | HTTPS salt 服务 | zkLogin 不可用 |
| `ZKLOGIN_PROVER_URL` | HTTPS prover | zkLogin 不可用 |

**ZKLOGIN_* 是服务端变量，绝不能用 `NEXT_PUBLIC_` 前缀**——否则会打进浏览器包。

### 3.2 可选与模块覆盖（默认关闭即为"未配置"，不是"损坏"）

| 变量 | 缺失时行为 |
|---|---|
| `NEXT_PUBLIC_IDENTITY_PACKAGE_ID` / `_NAMES_ID` | 身份功能禁用；SuiNS 仍可用 |
| `NEXT_PUBLIC_AGENT_VAULT_PACKAGE_ID` | 留空跟随默认 testnet v11（`0xd4ce6022…`） |
| `NEXT_PUBLIC_WALRUS_APP_POLICY_PACKAGE_ID` | 跟随提案包（默认新包） |
| `NEXT_PUBLIC_WALRUS_APP_REGISTRY_ID` | Walrus 策略注册表无链上发现事件，需手动填入已创建注册表对象 ID |
| `NEXT_PUBLIC_GOVERNANCE_PACKAGE_ID` | 跟随 `NEXT_PUBLIC_PROPOSAL_PACKAGE_ID`（默认新包，已含该模块） |
| `NEXT_PUBLIC_SCHEDULED_PAYMENTS_PACKAGE_ID` | 跟随提案包（默认新包）；**不代表有后台自动扣款** |
| `NEXT_PUBLIC_RED_PACKET_V2_PACKAGE_ID` | 跟随提案包（默认新包）；使用前核验 live ABI 与 canonical ChatChannel origin，失败时拒绝且不回退旧版创建 |
| `NEXT_PUBLIC_ORGANIZATION_TREASURY_PACKAGE_ID` | 跟随提案包（默认新包），使用前核验 live ABI 与类型归属 |
| `NEXT_PUBLIC_USDT_COIN_TYPE` | 发票/收款选择器隐藏 USDT |
| `NEXT_PUBLIC_PRICE_FEED` | 价格展示关闭 |
| `NEXT_PUBLIC_SSM_RELAYER_URL` | 加密群聊保持"未配置 relayer"，输入框禁用 |

### 3.3 网页 Keystore 已移除

`/api/dev/keystore` 在所有环境返回 410，不读取本机密钥；旧 `ENABLE_DEV_KEYSTORE` / `NEXT_PUBLIC_ENABLE_DEV_KEYSTORE` 标志不再生效。网页启动和身份变更会删除旧版本存下的 `sui_dev_accounts` 与 `sui_active_dev_privkey`，保留账户公开信息及待恢复回执。旧 Keystore 身份只能查询原回执，不能新签名；请通过扩展钱包、Passkey 或 Google zkLogin 连接账户。CLI 密钥保持在网页进程之外。

---

## 4. 初始化顺序

链上对象之间有依赖，顺序错了会得到"对象存在但不可用"的状态：

```
1. Publisher / UpgradeCap  custody        （一次性，转多签或冷钱包）
        ↓
2. 组织（Organization）
   · 路径 A：DKG 会话 → attest_group_key（达到成员门限）→ finalize_session_v3 → create_organization_from_session
   · 路径 B：create_organization_entry（单机，无 DKG 保证）
        ↓
3. 组织金库（organization_treasury）+ 资金金库绑定
        ↓
4. 频道（ChatChannel）——必须保留协议规范 origin
        ↓
5. 旧版应用策略注册表（walrus_app_policy::create_registry）仅供读取
   · 不发发现事件，registry 对象 ID 需手工填入前端
   · 旧版自报质押/计费入口仍可被旧字节码调用；walrus_app_policy_v2 已随 v8 部署（真实 SUI 付款），前端面板含用户签名的初始化/登记/付款/暂停入口；testnet registry 对象尚未初始化，真实钱包链上生命周期 UNVERIFIED
        ↓
6. 定期支付 / 红包 / 治理投票（依赖组织与金库）
```

**关键约束**：

- 步骤 2 的路径 A 目前**未端到端打通**（UNVERIFIED）：v7 的 `attest_group_key` / `finalize_session_v3` 通过链上成员分别申报并固定群公钥，不是 FROST 私信签名路径；本地 DKG 终局 UI 已按链上状态接入，但真实多设备钱包生命周期仍需单独验收。FROST session/store/private-transport API 已存在，名册 UI 已接入手动公开 JSON 与 identity 私信 transport 两种请求/两轮交换/聚合入口；identity 私信承载尚未部署，名册操作的真实多设备签名交换仍是 GAP / UNVERIFIED。
- 步骤 3 的 treasury 绑定是**不可变**的：绑定错了只能换新金库，不能改绑。
- 步骤 5 的 registry 无发现事件，**必须人工传递对象 ID**。

---

## 5. 前端构建与部署

```bash
cd /Users/echo/project/project/sui_project_c/multisig
pnpm install
pnpm exec tsc --noEmit                        # 期望 0 错误
pnpm exec tsx --test lib/*.test.ts lib/crypto/*.test.ts   # 当前 696/696
pnpm build                                    # 生产构建
```

**已知构建陷阱**：`pnpm build` 会覆盖 `.next` 并打挂正在运行的 dev server。构建后必须：

```bash
pkill -f "next dev.*3005"
rm -rf .next
pnpm dev --port 3005
```

**上线前门禁**（两项都要跑，分辨率不同暴露不同问题）：

```bash
UI_BASE_URL=http://127.0.0.1:3005 UI_VIEWPORT_WIDTH=390 \
PLAYWRIGHT_MODULE=/Users/echo/project/research-network/agent_research_asset_protocol_workflow/node_modules/playwright/index.mjs \
node scripts/ui-regression.mjs

# 再把 UI_VIEWPORT_WIDTH 改成 1280 跑一遍
```

期望：各 **16/16**，`pageerror` 为空，无横向溢出。

---

## 6. 部署后验证（每项都要有 digest 或命令输出）

| # | 验证项 | 命令 / 方法 | 期望 |
|---|---|---|---|
| 1 | 包可解析 | `sui client call --package <新包> --module dkg_committee --function dkg_revision` | 返回 revision |
| 2 | 旧包不解析新函数 | 同上，用旧包 ID | `Could not resolve function` |
| 3 | 对象类型未变形 | `sui client object <组织对象ID> --json` | `type` 前缀为原始包 ID |
| 4 | 事件可查 | 用 `PROPOSAL_TYPE_ORIGIN` 前缀查 `OrganizationCreatedEvent` | 非 0 条 |
| 5 | 新包查事件为 0 | 用新包前缀查同一事件 | **0 条**（这是正确行为，不是 bug） |
| 6 | Legacy Walrus 策略仅供读取 + V2 交易入口 | 前端 `walrus-policy-read-only-and-administration-status` 场景 | 显示“旧版策略仅供读取 · V2 交易已接线”；V2 初始化/登记/付款/暂停为用户签名入口（无自动提交），testnet registry 对象尚未初始化（UNVERIFIED） |
| 7 | DKG 信箱密封 | `scripts/dkg-mailbox-e2e.ts`（**发真实交易，需单独解禁**） | `recipient recovered the share: true` |
| 8 | 前端回归 | §5 两条命令 | 16/16 × 2 |

---

## 7. 明确不在本清单内的事

以下事项**没有**被本清单覆盖，不能被当作已完成：

- **真实钱包签名生命周期验收**：仍需在真实浏览器扩展钱包下逐笔验证（P0-3，UNVERIFIED）。
- **DKG 终局建组织**：v7 的成员申报 → `finalize_session_v3` → `create_organization_from_session` 已有 UI 接线与历史 testnet keystore 证据；浏览器多设备钱包验收仍为 UNVERIFIED。名册 FROST 另有手动 JSON 与 identity 私信入口，本地恢复与双标签页 nonce 已验收，identity 包从未上链，真实跨设备传输仍为 GAP / UNVERIFIED。
- **`contracts/identity` 部署**：从未上链（NOT-DEPLOYED）。
- **合约审计**：无第三方审计（GAP / UNVERIFIED）；委托范围见 `docs/THIRD_PARTY_AUDIT_SCOPE.md`。
- **relayer 持久化**：参考实现只存内存（GAP）。
- **ESLint**：已于 2026-10-23 配置并跑通（`pnpm exec eslint . --quiet` 退出码 0）；完整运行 0 error / 28 warning（2026-10-24：27 条测试替身 `no-explicit-any` + 1 条 DKG 对话框可变 ref cleanup 提示）。`next.config.mjs` 的 `eslint.ignoreDuringBuilds` 与 `typescript.ignoreBuildErrors` 均已删除，`pnpm build` 现在会执行 lint 与类型检查。
- **UpgradeCap 托管**：现行新 cap `0xa1c3a64693161a0aa2e774b85898f8724687858fae1f146e4cfb3ef795761d90` 为单址开发阶段托管（GAP，未封印）；旧 lineage cap 已永久封入 `GovernedUpgrader`（seal `EuFw4SYN…`，2026-10-26）但分片未持久化、不可再操作（冻结于 v11）——可恢复托管方案见 §2.3 与 `sui_project_a/docs/BOOTSTRAP_PRODUCTION_RUNBOOK.md`。
