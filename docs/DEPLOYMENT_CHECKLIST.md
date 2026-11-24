# 部署清单（Testnet）

本文只描述**如何部署**，不执行任何部署。所有命令都需先取得明确解禁：部署新包、升级、发交易各自单独解禁，不累积。

状态标签沿用项目约定：**REAL**（已核验）、**UNVERIFIED**（未端到端验证）、**GAP**（配置缺失）、**NOT-DEPLOYED**（代码已写未上链）。

---

## 1. 合约包

### 1.1 当前链上基线（REAL，源：`contracts/agent_vault/Published.toml` 与 SDK 常量）

| 项 | 值 | 证据 |
|---|---|---|
| 包名 | `agent_vault` | `contracts/agent_vault/Move.toml` |
| published-at / original-id | `0x73afe159f7b017efdfc7a013a6e444d54317b0147ae7fb182a182c3dc5ba57b5`（fresh lineage，version = 1） | `Published.toml` |
| 升级能力对象 | `0xc4b50706bf89d1436006b84c091927095a7e32bb5fa7fed90c15b5eebe700310`（未封印，单址持有，GAP，见 §2.3） | `Published.toml` → `upgrade-capability` |
| chain-id | `4c78adac`（testnet） | `Published.toml` |
| 工具链 | `sui 1.82.1` | `Published.toml` → `toolchain-version` |
| Move edition | 2024 | `Move.toml` |
| SDK 默认包 ID | `AGENT_VAULT_PACKAGE_ID` 与 published-at 一致 | `packages/multisig/src/agent-vault/org/constants.ts` |

血统历史：最初的 `0x23d1d8a2…` lineage 升级至 v11 后冻结（其 UpgradeCap 已于 2026-10-26 封入 `GovernedUpgrader`，seal tx `EuFw4SYNVHAbFSXBAEKKYJaTLM4bQjfuR7qTQundygEt`，但自举 FROST 分片仅存进程内存，该 lineage 无法再操作）；此后经历多次 fresh publish（2026-10-27 `0x75ae40d8…` 等），当前为 `0x73afe159…`。各历史快照与升级交易见 `PRELAUNCH_CHECKLIST.md` 附录与 git 历史。

**三条不可混淆的 ID 规则**（Sui 机制，本项目已实证，违反会静默读不到数据）：

1. **调用/读取目标**用最新包 `published-at`。兼容升级会铸造**新包对象**，旧包**不会**转发到新增函数——用旧包 ID 调新函数会返回 `Could not resolve function`。
2. **对象类型、事件类型、动态字段 NAME 类型**永远用**定义该类型的包**拼写。升级不改变类型拼写。
3. 混合血统时期前端因此持有四个不同常量（调用目标、模块 origin、类型 origin、动态字段 origin）。当前 fresh lineage 三者同为 `0x73afe159…`，前端统一由 `AGENT_VAULT_PACKAGE_ID` 派生（`lib/proposal-chain.ts`、`lib/dkg-type-origin.ts`）；若未来走兼容升级路线，需重新拆分常量。

### 1.2 已发布模块与本地源码

本地 `sources/` 共 12 个模块（`agent_vault.move` 内的模块名是 `vault`）：

```
agent_vault.move (module: vault)   asynchronous_proposal.move    cryptographic_org.move
dkg_committee.move                 governance_poll.move          onchain_chat.move
organization_treasury.move         red_packet.move               scallop_yield_adapter.move
scheduled_payments.move            vault.move                    walrus_app_policy.move
```

发布后可用只读命令核对模块映射：`sui client object <published-at> --json` 的 `content.Package.module_map`。这只证明模块存在，不证明本地源码等同于部署字节码或真实钱包生命周期通过。

**NOT-DEPLOYED 说明**：`contracts/identity`（独立包，48/48 Move 测试通过）**从未部署**。前端 `NEXT_PUBLIC_IDENTITY_PACKAGE_ID` / `NEXT_PUBLIC_IDENTITY_NAMES_ID` 留空时，身份相关功能保持禁用；原生 SuiNS 不依赖它，仍可用。

### 1.3 构建与测试门禁

```bash
cd contracts/agent_vault
sui move build
sui move test                 # 2026-11-24 实测 424/424；发布前重新运行
sui move lint --warnings-are-errors
```

**部署前必须全绿。** 任一项失败即停止。

Sui framework 的 manifest 与锁文件均固定到 `8fc60f1fa966e90398c93beb67ad4f42992889c7`（2026-10-26 只读 `git ls-remote` 确认与 `mainnet-v1.74.1` tag 及 `Move.lock` 一致）。`.gitignore` 已为 agent_vault 的 `Move.lock` 增加例外，锁文件可审阅、可随授权提交归档；发布证据归档必须同时包含 manifest 与锁文件，升级依赖须另行复核，不得删除锁文件后依赖可移动 tag 复现审计输入。

---

## 2. 部署顺序

### 2.1 首次发布（当前 lineage 已完成，此处仅作文档）

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

发布后的 UpgradeCap 处置是部署面的关键风险：当前 lineage 的 cap（`0xc4b50706…`）为单址持有、未封印（GAP，对应 `SECURITY_REVIEW.md` H-01）；上一 lineage 的 cap 曾封入组织门限 `GovernedUpgrader` 后因自举分片不落盘而永久失去操作能力。处置方案见 §2.3。

### 2.2 兼容升级

> **升级门禁与模块边界**：只允许兼容变更——新增函数、新增模块、放宽泛型约束；禁止改已有 public 函数签名、改已发布 struct/enum 布局与 abilities。每次升级须逐一核对 `module_map` 只含预期变更。

```bash
# 1. 构建与测试
sui move build && sui move test

# 2. 升级（消耗一次解禁）
sui client upgrade --gas-budget 500000000 --upgrade-capability <UPGRADE_CAP_ID>

# 3. Published.toml 由 CLI 自动更新 version 与 published-at
# 4. 更新前端 NEXT_PUBLIC_PROPOSAL_PACKAGE_ID 为新 published-at
```

**升级后必做的三步验证**：

```bash
# a. 新函数只在最新包上可解析
sui client call --package <新包ID> --module dkg_committee --function dkg_revision --gas-budget 10000000
# 期望：能解析并返回 revision；用旧包 ID 调同一函数应报 Could not resolve function

# b. 旧对象仍可读（类型拼写不变）
#    用前端只读探测或 sui client object <旧对象ID>，确认 type 前缀仍是类型定义包 ID

# c. 事件仍按类型定义包 ID 拼写
#    查询事件时必须用类型 origin，用升级后的新包前缀查询返回 0
```

### 2.3 UpgradeCap 托管（材料，不执行）

**当前状态**：现行 lineage 的 UpgradeCap（`0xc4b50706…`）为单址持有、未封印——这是主网上线前必须关闭的部署面风险（`SECURITY_REVIEW.md` H-01、`PRELAUNCH_CHECKLIST.md` §G）。

目标策略：把 UpgradeCap 作为一次性治理根权限交给**独立的 Sui MultiSig 地址**（建议 3-of-5、五个独立签名者、权重各 1）或封入组织门限 `GovernedUpgrader`。前一 lineage 的教训：`GovernedUpgrader` 封印成功（seal tx `EuFw4SYNVHAbFSXBAEKKYJaTLM4bQjfuR7qTQundygEt`），但自举仪式的 FROST 分片仅存进程内存（安全约束：DKG 私分片不落盘），进程结束即失——该组织无法再发起门限提案，lineage 冻结在 v11。**选 `GovernedUpgrader` 路线必须先解决分片持久化（加密设备分片库），否则等于永久放弃升级能力。**

MultiSig 路线的准备与执行：

```bash
# 只读复算候选多签地址（公钥须来自经确认的生产签名者，不是开发 keystore）
sui keytool list --json
sui keytool multi-sig-address \
  --threshold 3 --weights 1 1 1 1 1 \
  --pks <PK_1_BASE64> <PK_2_BASE64> <PK_3_BASE64> <PK_4_BASE64> <PK_5_BASE64>
```

得到**用户确认的目标多签地址**后，实际转移命令是一次性动作，必须另行解禁：

```bash
sui client transfer \
  --object-id <UPGRADE_CAP_ID> \
  --to <CONFIRMED_MULTISIG_ADDRESS> \
  --gas-budget <BUDGET>
```

执行前检查：active-env 必须为 `testnet`（主网发布时为主网）；当前 owner 必须能签名；目标地址必须由独立公钥和已确认阈值复算；执行后用 `sui client object <UPGRADE_CAP_ID> --json` 核对 `owner.AddressOwner` 已变为目标多签地址。该转移不可自动回滚；恢复路径是由多签持有人重新发起一笔达到阈值的转回交易。

主网化的完整顺序（含托管缺口逐条关闭）见 `BOOTSTRAP_PRODUCTION_RUNBOOK.md`。

### 2.4 回滚路径

**兼容升级无法回滚**。Sui 的 UpgradeCap 只能前进，不能指向旧版本。因此：

- 回滚 = **发布一个把行为改回去的新版本**（version N+1），不是撤销。
- **共享对象的状态布局不可回滚**。若新版本写入了新字段（通过 dynamic field），旧逻辑不会读它，数据仍在链上。
- **升级前必须做的准备**：记录当前 `published-at` 与 `version`；导出一份当前前端 `.env` 的包 ID 配置；在 testnet 上先用一次性包演练同一份 diff。
- 若升级后发现问题，**先把前端 `NEXT_PUBLIC_PROPOSAL_PACKAGE_ID` 指回旧包**（旧包仍在链上，原函数仍可调），再准备修复版。这只对"新增函数有问题"有效；已通过新函数写入的状态无法被旧逻辑正确处理。

---

## 3. 环境变量

### 3.1 核心与认证变量

| 变量 | 作用 | 缺失时行为 |
|---|---|---|
| `NEXT_PUBLIC_PROPOSAL_PACKAGE_ID` | 调用目标包（升级后需更新） | 留空回退到 SDK 内置当前包 ID（`AGENT_VAULT_PACKAGE_ID`）；自定义部署/主网发布需显式提供 |
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
| `NEXT_PUBLIC_AGENT_VAULT_PACKAGE_ID` | 留空跟随 SDK 内置当前包 ID |
| `NEXT_PUBLIC_WALRUS_APP_POLICY_PACKAGE_ID` | 跟随提案包 |
| `NEXT_PUBLIC_WALRUS_APP_REGISTRY_ID` | Walrus 策略注册表无链上发现事件，需手动填入已创建注册表对象 ID |
| `NEXT_PUBLIC_GOVERNANCE_PACKAGE_ID` | 跟随 `NEXT_PUBLIC_PROPOSAL_PACKAGE_ID`（提案包已含该模块） |
| `NEXT_PUBLIC_SCHEDULED_PAYMENTS_PACKAGE_ID` | 跟随提案包；**不代表有后台自动扣款** |
| `NEXT_PUBLIC_RED_PACKET_V2_PACKAGE_ID` | 跟随提案包；使用前核验 live ABI 与 canonical ChatChannel origin，失败时拒绝且不回退旧版创建 |
| `NEXT_PUBLIC_ORGANIZATION_TREASURY_PACKAGE_ID` | 跟随提案包，使用前核验 live ABI 与类型归属 |
| `NEXT_PUBLIC_USDT_COIN_TYPE` | 发票/收款选择器隐藏 USDT |
| `NEXT_PUBLIC_PRICE_FEED` | 价格展示关闭 |
| `NEXT_PUBLIC_SSM_RELAYER_URL` | 加密群聊保持"未配置 relayer"，输入框禁用 |

### 3.3 网页 Keystore 已移除

`/api/dev/keystore` 在所有环境返回 410，不读取本机密钥；旧 `ENABLE_DEV_KEYSTORE` / `NEXT_PUBLIC_ENABLE_DEV_KEYSTORE` 标志不再生效。网页启动和身份变更会删除旧版本存下的 `sui_dev_accounts` 与 `sui_active_dev_privkey`，保留账户公开信息及待恢复回执。旧 Keystore 身份只能查询原回执，不能新签名；请通过扩展钱包、Passkey 或 Google zkLogin 连接账户。CLI 密钥保持在网页进程之外。

---

## 4. 初始化顺序

链上对象之间有依赖，顺序错了会得到"对象存在但不可用"的状态：

```
1. Publisher / UpgradeCap  custody        （一次性，转多签或封印门限托管）
        ↓
2. 组织（Organization）
   · 路径 A：DKG 会话 → attest_group_key（达到成员门限）→ finalize_session → create_organization_from_session
   · 路径 B：create_organization_entry（单机，无 DKG 保证）
        ↓
3. 组织金库（organization_treasury）+ 资金金库绑定
        ↓
4. 频道（ChatChannel）——必须保留协议规范 origin
        ↓
5. 应用策略注册表（walrus_app_policy）——不发发现事件，registry 对象 ID 需手工填入前端
        ↓
6. 定期支付 / 红包 / 治理投票（依赖组织与金库）
```

**关键约束**：

- 步骤 2 的路径 A 的链上部分（成员申报 → 固化 → 建组织）已有 testnet keystore 证据（`PRELAUNCH_CHECKLIST.md` C6）；浏览器多设备钱包生命周期仍为 UNVERIFIED。FROST 私信承载已下沉至 SDK `multisig/bridge`（`createPrivateMessaging` + `createFrostDmTransport`，前端 `lib/` 为薄壳）并有离线双节点 E2E，名册 UI 以手动公开 JSON 与 identity 私信 transport 两种入口完成请求/两轮交换/聚合；identity 合约从未上链，真实跨设备传输仍为 GAP / UNVERIFIED。
- 步骤 3 的 treasury 绑定是**不可变**的：绑定错了只能换新金库，不能改绑。
- 步骤 5 的 registry 无发现事件，**必须人工传递对象 ID**。

---

## 5. 前端构建与部署

```bash
pnpm install
pnpm exec tsc --noEmit                        # 期望 0 错误
pnpm exec tsx --test lib/*.test.ts lib/crypto/*.test.ts   # 2026-11-23 实测 727/727
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
PLAYWRIGHT_MODULE=<path-to-playwright>/node_modules/playwright/index.mjs \
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
| 3 | 对象类型未变形 | `sui client object <组织对象ID> --json` | `type` 前缀为类型定义包 ID |
| 4 | 事件可查 | 用类型 origin 前缀查 `OrganizationCreatedEvent` | 非 0 条 |
| 5 | 新包查事件为 0 | 用非类型定义包前缀查同一事件 | **0 条**（这是正确行为，不是 bug） |
| 6 | Walrus 策略面板边界 | 前端 `walrus-policy-read-only-and-administration-status` 场景 | 旧版策略仅供读取；V2 入口为用户签名交易（无自动提交） |
| 7 | DKG 信箱密封 | `scripts/dkg-mailbox-e2e.ts`（**发真实交易，需单独解禁**） | `recipient recovered the share: true` |
| 8 | 前端回归 | §5 两条命令 | 16/16 × 2 |

---

## 7. 明确不在本清单内的事

以下事项**没有**被本清单覆盖，不能被当作已完成：

- **真实钱包签名生命周期验收**：仍需在真实浏览器扩展钱包下逐笔验证（UNVERIFIED）。
- **DKG 终局建组织**：链上申报 → `finalize_session` → `create_organization_from_session` 已有 UI 接线与历史 testnet keystore 证据；浏览器多设备钱包验收仍为 UNVERIFIED。名册 FROST 另有手动 JSON 与 identity 私信入口，本地恢复与双标签页 nonce 已验收，identity 包从未上链，真实跨设备传输仍为 GAP / UNVERIFIED。
- **`contracts/identity` 部署**：从未上链（NOT-DEPLOYED）。
- **合约审计**：无第三方审计（GAP / UNVERIFIED）；委托范围见 `docs/THIRD_PARTY_AUDIT_SCOPE.md`。
- **relayer 持久化**：参考实现只存内存（GAP）。
- **UpgradeCap 托管**：现行 cap 为单址持有、未封印（GAP，见 §2.3）；主网化前置条件详见 `BOOTSTRAP_PRODUCTION_RUNBOOK.md`。
