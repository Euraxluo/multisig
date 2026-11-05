# 上线前检查表

每一项 REAL 能力对应一条**可复现**的验证命令或真实 digest。没有证据的一律标 UNVERIFIED / GAP / NOT-DEPLOYED，不得写成已完成。

最近本地门禁核验时间：2026-10-27；本轮完成第二次 fresh publish（只保留最好版本）：链上基线切至**新 lineage v1** `0x75ae40d8d59865774e5584a57dd297587c68507e14979849a3c00fa1d6234fc2`（tx `CbRWAnUsdKq3XGBM1mRjnDp4z568k3b8ADamfdGfD6Tk`，**12 模块**：删 v1 红包/政策双模块与 3013 死桩、未用 1004 常量，Move 273/273；同日早些的 14 模块版 `0x334899da…` 作废；旧 lineage 冻结于 v11，见 `THIRD_PARTY_AUDIT_SCOPE.md`）。

---

## A. 构建与测试门禁

| # | 项 | 命令 | 期望 | 当前 | 级别 |
|---|---|---|---|---|---|
| A1 | TypeScript | `cd multisig && pnpm exec tsc --noEmit` | 0 错误 | 0 错误 | REAL |
| A2 | 前端离线测试 | `pnpm exec tsx --test lib/*.test.ts lib/crypto/*.test.ts` | 全过 | **696/696** | REAL |
| A3 | Move 测试 | `cd /Users/echo/project/sui_project_a/packages/contracts/agent_vault && sui move test` | 全过 | **287/287** | REAL |
| A4 | Move lint | `sui move lint --warnings-are-errors` | 无告警 | 0 告警 | REAL |
| A5 | 生产构建 | `pnpm build` | 成功 | ✓ Compiled successfully | REAL |
| A6 | ESLint | `pnpm exec eslint .` | 0 error | **0 error / 28 warning** | REAL |

> A6 是独立的可见代码规范门禁；当前 `pnpm build` 也会执行 lint 与类型检查，但 A5 的构建成功仍不替代 A6 的独立报告。
>
> A6 现状（2026-10-23）：`eslint.config.mjs` 用 `FlatCompat` 桥接 `next/core-web-vitals` + `next/typescript`（ESLint 9 flat config；`eslint-config-next` 仍只发 eslintrc 预设）。`pnpm exec eslint . --quiet` 退出码 0。
>
> 2026-10-24 完整复跑共 28 条 warning，其中 27 条是 `*.test.ts` 中的 `@typescript-eslint/no-explicit-any`，另 1 条是 `dkg-ceremony-dialog.tsx` 的可变 ref cleanup 提示。测试要构造 gRPC 客户端与钱包的局部替身，结构化精确的假实现会把每个测试绑死在 SDK 的完整类型面上。
>
> 本轮处理过 `react-hooks/exhaustive-deps` 的 30 条告警：7 条真实依赖问题已补齐或删除；其余生成计数器的 cleanup 递增是异步失效机制，已改为 effect 生命周期内的失效闭包。2026-10-24 全库复跑仍有 DKG 对话框 1 条该规则 warning，本轮名册恢复文件为 0 条。
>
> 另有 3 处 `@next/next/no-img-element`，已就地加 `eslint-disable-next-line` 并写明理由——头像/钱包图标的宿主在运行时才确定，无法进入 `images.remotePatterns` 的构建期白名单，URL 已由 `safeAvatar` 限制为 https。加了 disable 后它们不再计入 warning。
>
> 本项不是"配置了 lint 就算完"：清理过程中堵掉的是真实缺陷，不是抑制告警。见下。

### A6 清理中修复的真实缺陷（类型收紧作为缺陷探测器）

每一处都是把 `any` 换成真实类型后，编译器暴露出原本会在运行时发生的错误：

| 位置 | 缺陷 | 后果 |
|---|---|---|
| `components/bill-details-dialog.tsx:94` | `bill.creatorName[0]` 未判空 | 创建者无名称时渲染崩溃 |
| `components/bill-details-dialog.tsx:108`、`components/walrus-app-sandbox-dialog.tsx:34` | `new Date(undefined)` | 显示 "Invalid Date" |
| `components/create-bill-dialog.tsx`、`components/create-group-dialog.tsx` | "搜索联系人"菜单没有输入框，`searchTerm` 恒为空 | 搜索功能完全失效 |
| `components/quick-templates.tsx` | `useTemplate` 在 `onClick` 回调里调用 | 违反 `rules-of-hooks` |
| `lib/sui-wallet-signer.ts:200` | 只检查 `sui:signTransaction` 特性对象存在，未检查方法可调用 | 钱包声明空特性对象时，调用落到 `undefined` |
| `lib/sui-wallet-signer.ts:223` | `modern`/`legacy` 的方法都不可调用时，仍直接调用 `legacy.…` | **在已写入待确认交易锁之后抛错，被 `uncertain()` 包装成「交易状态尚未确认」**——一次纯粹的能力缺失被误报成未确认交易，用户被要求去链上查一笔从未发出的交易，且锁会阻止重新发起 |
| `lib/sui-wallet-signer.ts:52` | `findMatchingWallet` 返回 `any` | 钱包账户缺失字段在签名时才暴露 |
| `lib/governance.ts:24` | `readGovernanceValue` 返回 `any` | 旧版本写入的行未经收窄直接进入渲染 |
| `lib/governance.ts:9` | `GovernanceVote` 带 `[key: string]: any` | 所有字段访问绕过检查 |
| `lib/pending-transactions.ts:46` | `parseReceipt` 用 `any` 解析浏览器存储 | 畸形回执的字段检查写在 `any` 上，编译器无法保证覆盖完整 |
| `lib/onchain-store.ts:112` | `proposalProjection` 入参 `Record<string, any>` | 未收窄的 JSON 字段进入显示投影 |
| `lib/dev-keystore.ts:67` | `getActiveDevKeypair(): any` | 调用方可触碰当前方案不存在的方法 |

`lib/sui-wallet-signer.ts:223` 那条最危险：它不崩溃，而是把"钱包不支持"包装成"交易状态未确认"。这违反红线 7（数据缺失与读取失败不能互相冒充），并留下一条解锁前无法重试的死锁。

---

## B. 浏览器回归（两种分辨率都必须跑）

```bash
UI_BASE_URL=http://127.0.0.1:3005 UI_VIEWPORT_WIDTH=390 \
PLAYWRIGHT_MODULE=/Users/echo/project/research-network/agent_research_asset_protocol_workflow/node_modules/playwright/index.mjs \
node scripts/ui-regression.mjs
# 再把 UI_VIEWPORT_WIDTH 改为 1280 重跑
```

| # | 项 | 期望 | 当前 | 级别 |
|---|---|---|---|---|
| B1 | 390px 场景 | 16/16，pageerror 为空，无横向溢出 | **16/16** | REAL |
| B2 | 1280px 场景 | 16/16，pageerror 为空，无横向溢出 | **16/16** | REAL |

覆盖的 16 个场景：`profile-navigation`、`wallet-discovery`、`payment-tools-and-group-history`、`ssm-channel-states-configuration-gap`、`ssm-keeps-every-registered-group-reachable`、`invoice-drafts-reopen-and-delete`、`agent-vault-no-account-and-legacy-history`、`group-ai-tab-reads-chain-delegations`、`group-roster-change-requires-committee-shares`、`notification-unread-badge`、`shared-person-never-fabricates-a-profile`、`shared-group-read-only`、`shared-treasury-read-only`、`group-discovery-membership-scan`、`theme-switch-applies-and-persists`、`walrus-policy-read-only-and-administration-status`。

---

## C. 链上能力逐项核验

本地 FROST 恢复与 nonce 验收另见 `docs/FROST_LOCAL_ACCEPTANCE.md`：真实 Chromium IndexedDB 9/9；传输集成 23 项使用真实密码学与加密信封、内存 I/O。名册提交/回执模块 88 项测试使用真实临时 Sui personal signatures，聚焦门禁 107/107，覆盖严格新请求认证、原 request/result/有序 action 的公开来源绑定、两个 pending 入口拒绝错配、旧无绑定回执保锁、原 digest 恢复与 post-state/CAS 后解锁。独立原回执入口覆盖重开后已生效/过期请求、旧版已推进 epoch 后 acknowledge 失败重试，无需重新签名或提交；普通签名仍严格拒绝过期。来源 metadata 是本机记录，不能替代链上内容证明或扩大群签名认证域；真实钱包恢复仍 UNVERIFIED。应用名册场景已增加两类原回执按钮的可达与拒绝验证、同地址 provider 切换重新发现和换账户清空列表。此前错误变量 `VIEWPORT_WIDTH` 的输出不能证明 1280px，本轮以 `UI_VIEWPORT_WIDTH` 重新分别验证，脚本输出也记录实际 viewport。

| # | 能力 | 验证方式 | 期望 | 级别 |
|---|---|---|---|---|
| C1 | 包已部署为新 lineage v1 | `sui client object 0x75ae40d8d5…` | 对象存在，`owner: Immutable`，12 个模块（fresh publish tx `CbRWAnUsdKq3XGBM1mRjnDp4z568k3b8ADamfdGfD6Tk`，2026-10-27；UpgradeCap `0x3ccbf816…2e973` 未封印；旧 lineage 冻结于 v11） | REAL |
| C2 | 新函数只在最新包解析 | `sui client call --dry-run` 探测 `0xd4ce6022cd…` | `remove_zero_stake_member`（v8）+ `governance_poll::new_manual`/`organization_treasury::new`/`red_packet_v2::create`/`scheduled_payments::create_recurring`/`walrus_app_policy_v2::initialize_registry_v2` 全部解析成功（未知函数名对照报 `Could not resolve`） | REAL（2026-10-26 v8 升级后已验） |
| C3 | 组织发现（事件反查） | 前端连接真实账户，看群组列表 | 扫描 `OrganizationCreatedEvent`，按成员资格过滤 | REAL |
| C4 | 事件类型拼写不变 | 用 `PROPOSAL_TYPE_ORIGIN` 查询 `OrganizationCreatedEvent` | 非 0；用新包前缀查询为 0 | REAL |
| C5 | DKG 信箱密封 | `scripts/dkg-mailbox-e2e.ts`（**发真实交易，需单独解禁**） | `recipient recovered the share: true` | REAL（已跑通） |
| C6 | DKG 终局 → 建组织 → 门限签名 | `scripts/dkg-mailbox-e2e.ts`（3 个真实 keystore 钱包，真实 testnet 交易） | finalize `6WDXaFzAjTBcd9sWcrdTpiwJ6YtjSPZsmgz4BQAmTbd9`，状态 3，`group_pk=d5fa424b…` 与 Σ C₀ 逐字节相等，建组织 `DbCdSLr2…` → `0xf38e9daf…`，**且用 t 份分片做的门限签名对着该链上公钥验签通过** | **REAL**（2026-10-22） |
| C10 | **DAO 群公钥持有 SUI 资产** | `scripts/dao-live-transfer.ts` | DAO 地址收到 0.05 SUI 并保持余额 | **REAL** |
| C11 | **成员增删后地址不变、仍可签名转账** | 同上 | 本地重共享后派生地址不变，门限签名转出 0.01 SUI 成功；链上组织名册换届仍为 UNVERIFIED（见 C7） | **LOCAL（离线多项式重共享）/ UNVERIFIED（链上换届）** |
| C7 | 名册换届（门限签名） | 前端「成员」页编辑名册 → 预演 → 提交 | 本地聚合 FROST 签名后提交 `update_organization_roster` | UNVERIFIED（需真实钱包逐笔验） |
| C8 | Walrus 策略授权 | 浏览器场景 `walrus-policy-read-only-and-administration-status` | 显示「旧版策略仅供读取 · V2 交易已接线」；V2 面板含用户签名的初始化/登记/付款/暂停入口（无自动提交），testnet registry 对象尚未初始化 | REAL（页面边界）/ GAP（旧字节码仍可调用；V2 链上生命周期未验证） |
| C9 | 真实钱包签名生命周期 | 浏览器扩展钱包逐笔签名 | 每笔有 digest 且链上可查 | **UNVERIFIED**（P0-3，需单独解禁） |

**C1–C2 实测证据（2026-10-26，v8 升级后，只读）**

```
$ sui client object 0x2bac5eb016e47c6808e7b781f3e8f9e70ac6978b09989e0558d5822f8061a174
objectId: 0x2bac5eb016e47c6808e7b781f3e8f9e70ac6978b09989e0558d5822f8061a174
version:  8
objType:  package
owner:    Immutable
prevTx:   D2rwcf7YFuHXu2oHgzJC3Z6Lq2MNQm6LCmAAqAWzz5tB
modules:  13 (asynchronous_proposal, cryptographic_org, dkg_committee, governance_poll,
              onchain_chat, organization_treasury, red_packet, red_packet_v2,
              scallop_yield_adapter, scheduled_payments, vault, walrus_app_policy,
              walrus_app_policy_v2)
digest:   4byP8N1LfSYHSj43UotJRX2xNWZYn3p3nofw5rVkezsa

$ sui client call --dry-run --package 0x2bac5eb0… --module onchain_chat --function remove_zero_stake_member
Expected 2 args, found 0            # 入口存在且解析
$ sui client call --dry-run --package 0x2bac5eb0… --module onchain_chat --function nonexistent_function_xyz
Could not resolve function nonexistent_function_xyz in module onchain_chat
```

（v7 及更早版本的对应记录：v7 `0xca0650d4…` 升级 tx `397b7gbu…`，digest `7NrgaektvbVoeUZa9EP4b4fwEeHpTXMtBcEmgZxjtKf3`，12 模块。）

**C10–C11 实测证据（2026-10-22，真实 testnet 转账）**

```
$ pnpm exec tsx scripts/dao-live-transfer.ts

group pk: c808e17507601653d4e76cfbff6a49eb87be7a4f1716c2518c8583edf98840e1
DAO address: 0xf818d60beb52c48636bfe1a5b9f9ecdd7a395f87ebf7d6402f049f93c104e5b1
fund tx: AfyutjVN8TSWjUZ4JgQJDwmmuYcxY5dErspLivr1ucJq
DAO balance after funding: 50000000 MIST

after remove, DAO address: 0xf818d60b…（未变）
after add,    DAO address: 0xf818d60b…（未变）
DAO balance after roster changes: 50000000 MIST

transfer digest: 5JVvB5CEvH9EUZwNcFjH3oKKtAmwdqUG31gKLujXyUzS
transfer success: true
DAO balance after transfer: 38011901 MIST
```

链上复核：

```
$ sui client tx-block 5JVvB5CEvH9EUZwNcFjH3oKKtAmwdqUG31gKLujXyUzS --json
digest:  5JVvB5CEvH9EUZwNcFjH3oKKtAmwdqUG31gKLujXyUzS
status:  success
sender:  0xed5573c14292270a7328ce86e036106ebecbe56ef0e6775fa335a037b8e25f4b   ← 由群公钥派生的 DAO 地址
balance: 0x8ac06d3d… +10000000    （收款方）
balance: 0xed5573c1… -11988099    （DAO，含 gas）
```

（该次转账的群公钥为 `3ccb5afe…`/地址 `0xed5573…`；脚本每次运行生成新的测试密钥，上表两次运行都在 testnet 留下真实交易。）

**关键技术点**：Sui 签的是 `blake2b(messageWithIntent("TransactionData", bytes), 32)`，不是 intent 包装后的字节。
签未哈希的 intent 能通过裸 `ed25519.verify`，却被全节点以 `Invalid user signature` 拒绝——这一点已用
`lib/dao-key-lifecycle.test.ts` 的专门用例锁死。

**D10 实测证据**：

```
$ sui client object 0x165bc08fb1e2cc1fb3b92d345d49762269dae5aa5248bc06ae88cdb7730979a1
objType: 0x2::package::UpgradeCap
owner:   {"AddressOwner": "0x8ac06d3d4328aff5bef88990741c1f620a96d5fc579bf2e459467763bd605788"}
```

已封入组织门限 `GovernedUpgrader`（2026-10-26 seal `EuFw4SYNVH…`），D10 的「单地址」风险关闭；但自举分片未持久化、托管不可再操作（lineage 冻结 v11），可恢复托管仍需另做——D10 改标 **PARTIAL**。

---

## D. 明确不能上线声称的内容

以下项**当前不能**对用户或对外材料呈现为"已完成"。逐条列出，防止误标：

| # | 项 | 真实状态 | 用户可见处的正确措辞 |
|---|---|---|---|
| D1 | 分布式 DKG 建组织 | 链上 `attest_group_key` / `finalize_session_v3` 路径已有 3 个 testnet keystore 账户的真实流程证据；浏览器多设备钱包生命周期、恢复与跨设备协调仍未完成。名册换届已有手动 JSON 与私信 transport UI，但 identity 私信承载未部署，真实多设备 FROST E2E 仍未验证 | 「部分完成，未完成真实多设备验收」；不得写「浏览器分布式 DKG 已完成」 |
| D2 | 群聊端到端加密（SSM） | 依赖外部 relayer；参考实现只存内存 | 「未配置 relayer」或「relayer 仅内存」，不得写「消息持久化」 |
| D3 | 加密私信 | ECDH P-256 + HKDF + AES-GCM，**未经审计** | 「未经过独立审计」，不得写「安全加密通信」 |
| D4 | 身份合约 | `contracts/identity` **从未部署** | 「未部署」；留空即禁用，不得假装可用 |
| D5 | 价格展示 | 需要 `NEXT_PUBLIC_PRICE_FEED=on`，第三方估值 | 「第三方估值，非赎回价」 |
| D6 | 通知 | 仅从本机已同步的提案派生 | 「无推送订阅；仅显示本机已同步内容」 |
| D7 | 自动扣款 | `scheduled_payments` 无外部自动扣款/后台调度 | 「需手动签名触发」，不得写「自动续费」 |
| D8 | 红包 V2 | 默认跟随提案包（testnet v7 已含模块）；可用 `NEXT_PUBLIC_RED_PACKET_V2_PACKAGE_ID` 覆盖，使用前核验 live ABI 与频道类型归属；真实钱包生命周期仍 UNVERIFIED | 「ABI 不可用时拒绝创建」，**不回落旧版创建**；模块存在不得标作钱包验收完成 |
| D9 | 共享链接写操作 | 默认只读 | 写操作必须由用户显式执行 |
| D10 | UpgradeCap 托管 | 单一地址持有 | 「未转多签」 |

---

## E. 数据与错误状态区分

| # | 规则 | 验证点 | 级别 |
|---|---|---|---|
| E1 | 空列表 ≠ 加载失败 | 群组列表、活动、消息均有独立的「加载中 / 为空 / 失败」三态 | REAL |
| E2 | 读取失败必须可见 | 关键路径失败有 `role="alert"` 提示，不静默吞掉 | REAL |
| E3 | 超时不吞成"未注册" | `lib/suins.ts` 超时按失败上报；`lib/dkg-mailbox.ts` 只把 `Function not found` 判为旧包 | REAL（有测试） |
| E4 | 交易超时不诱重复发送 | `lib/sui-wallet-signer.ts` 超时走 `uncertain()`，保留摘要、拒绝重签 | REAL（有测试） |
| E5 | 分页游标不前进显式报错 | 各 `listEvents`/`listOwnedObjects` 循环有游标去重 | REAL |

---

## F. 可访问性与隐私

| # | 项 | 验证方式 | 当前 | 级别 |
|---|---|---|---|---|
| F1 | 步骤条键盘可达 | 四个创建向导的步骤条为 `<button>`，带 `aria-current`、`aria-label`、`focus-visible` | 已改 | REAL |
| F2 | 无无标签图标按钮 | 脚本扫描 `components/**/*.tsx` | 0 个 | REAL |
| F3 | 对话框都有可访问名称 | 扫描 `DialogContent` 是否都有 `DialogTitle` | 0 个缺失 | REAL |
| F4 | 对比度 | `lib/contrast.test.ts`（38 项）从 `app/globals.css` 实读令牌计算 WCAG 比率 | 全部达标，见下 | REAL |
| F5 | 数据去向说明 | 浏览器 `profile-navigation` 场景断言该面板存在 | 通过 | REAL |

### F4 细目（2026-10-22 实测，非估算）

`lib/contrast.test.ts` 直接读 `app/globals.css` 的 HSL 令牌计算比值，因此改令牌会立刻失败；
已用变异测试确认守卫有效（把 `--destructive` 改回旧值 → 4 项失败并报 `1.98:1`；
把遮罩系数改为 0 → 12 个渐变端点全部失败）。

本轮修掉的实测缺陷：

| 位置 | 原值 | 现值 | 依据 |
|---|---|---|---|
| 暗色 `--destructive` | `0 62.8% 30.6%`（1.98:1） | `0 62.8% 70%` | 85 处 `text-destructive` 错误提示在暗色下几乎不可读 |
| 暗色 `--destructive-foreground` | `0 0% 98%` | `0 0% 10%` | 配深色文字 6.49:1；浅色主题同步改实色 5.62:1 |
| 浅色 `--destructive` | `0 84.2% 60.2%`（3.76:1） | `0 84.2% 44%` | 错误文字白底 5.62:1，`/10` 底 4.73:1 |
| `--input`（浅/暗） | `89.8%` / `14.9%`（1.26:1、1.31:1） | `58%` / `42%` | 输入框与 outline 按钮的边界属 WCAG 1.4.11 的 3:1 |
| 浅色 `--muted-foreground` | `45.1%`（在 `--muted` 上 4.35:1） | `44%` | `bg-muted` + `text-muted-foreground` 同元素 42 处，需 4.5:1 |
| 群/账单/提案/投票头部渐变 | 白字最低 1.67:1（`amber-400`） | 加 `bg-black/45` 遮罩，最低 5.10:1 | 渐变调色板含 `cyan-400`/`amber-400` 等浅端；遮罩铺在上层，标题改 `relative` |
| 投票头部截止行 | `text-white/80`（遮罩后 3.91:1） | `text-white` | 遮罩后透明度叠加仍不足 |
| `payment-dialog` 说明文字 | `text-white/80`（3.97:1） | `text-white` | 该渐变两端够深，无需遮罩 |
| 交易详情「已执行」徽章 | `bg-emerald-500/30 + text-emerald-100`（3.90:1） | `bg-emerald-700 text-white`（5.48:1） | 浅底浅字 |
| 交易详情「已拒绝」徽章 | `bg-destructive/40 + destructive-foreground` | 实色 `bg-destructive` | 40% 透明会把深色主题底色提亮，与浅色文字冲突 |

实测确认（非推断）：对话框中遮罩为 `rgba(0,0,0,0.45)`、`inset 0`，标题为纯白，
标题中心点 `elementFromPoint` 命中 `H2` 而非遮罩；最浅的 `from-orange-500 to-amber-400`
强制施加到头部后截图仍清晰可读。两种主题下 390px 与 1280px 各 16/16 回归通过。

仍未量化：`rgba` 混色与渐变中段的实际像素值由浏览器渲染决定，测试按令牌与遮罩系数
的解析值计算，未对截图做逐像素采样。此边界不改变结论（最浅端点已按最坏情况计算）。

---


### C6 的取证与一次真实错误（2026-10-22）

三轮跑出三种结果，只有第三轮成立，前两轮是我自己的脚本缺陷：

| 轮次 | 链上 `group_pk` | 问题 |
|---|---|---|
| 1、2 | `78366db6…` = 3001·G | `reduce` 少了初始值，dealer 0 的 C₀ 被累加 **两次**；链上固化了一把谁都没分享过的密钥 |
| 3 | `d5fa424b…` = 2001·G（1000+1001） | 正确 |

前两轮的组织 `0x83cfb389…`、`0xc9e7dadd…` 仍留在测试网上，`group_pk` 都是那把被重复计数的密钥。
它们**不应被当作可用的 DAO**：其离散对数可由测试夹具直接算出，没有任何门限意义。
已用 `lib/crypto/group-key-sum.test.ts`（4 项）把该错误钉死，含一条直接复现
「用首元素作种子 → 群公钥不等于 Σ a_{i,0}·G」的用例。

第三轮的完整证据链（全部发真实交易）：

```
commit[0..1]                                  → true（64 字节，链上承诺 == 本地计算）
share f_0(2) verifies against C_0              → true
recipient recovered the share                  → true
confirm[0..1]                                  → true（2/2）
unconfirmed attestation rejected with 3011     → true
attest[0..1]                                   → true（计数 2）
finalize with unattested key rejected w/ 3012  → true
finalize                                       → true  6WDXaFzA…
status after finalize                          → 3
on-chain final key == recomputed Σ C₀          → true
create organization                            → true  DbCdSLr2…  → 0xf38e9daf…
t-of-n signature verifies against on-chain key → true
```

最后一行是这轮唯一新增、也是最关键的一行：分片真的能重构出链上那把密钥。
缺了它，「DKG 成功」只证明状态机推进，不证明密钥可被门限控制。

---

## G. 上线判定

只有同时满足以下条件才能说 **production ready**：

- [x] A1–A6 全绿（A6 已于 2026-10-23 配置并跑通，0 error）
- [x] B1、B2 各 16/16 且 pageerror 为空（2026-10-26 生产构建产物复跑通过）
- [ ] C7 名册换届真实跨设备签名与提交验收（手动 JSON 与私信 Round 1/2 transport 已接线；request/transcript 仍需公开 JSON 创建或导入。本地恢复与 nonce 消费已有浏览器证据，identity 未部署，真实多设备/钱包 E2E 仍为 GAP / UNVERIFIED）
- [ ] C9 真实钱包逐笔签名验收通过（需解禁）
- [ ] D1–D10 全部在用户可见处正确标注，无一处被当成已完成
- [ ] UpgradeCap 已转多签或冷钱包
- [ ] 部署、升级、回滚路径演练过一次（需解禁）
- [ ] 合约第三方审计完成（当前为 GAP / UNVERIFIED）

**当前不满足**：C7（名册换届真实多设备/钱包提交生命周期；identity 私信承载未部署）、C9、D10、审计、UpgradeCap 多签。因此**现阶段不能对外称 production ready**。C6 的 DKG 终局链上状态机已有 testnet keystore 证据，浏览器多设备 DKG 生命周期仍需单独验收。2026-10-24 的本地 FROST 恢复、双标签页 nonce 和传输集成证据详见 `docs/FROST_LOCAL_ACCEPTANCE.md`；它们不替代线上验收。第三方审计范围材料见 `docs/THIRD_PARTY_AUDIT_SCOPE.md`，状态仍为 **GAP / UNVERIFIED**。


## 追加：A6 exhaustive-deps 清理（2026-10-23）

本轮逐文件处理 ESLint 的 30 条 `react-hooks/exhaustive-deps` 告警：

- 7 条真实依赖问题已修复：补齐 `initialRecipient`、账户对象和活动范围依赖；删除 `useMemo` 中未使用的 `open`；将 recurring payment 的 `scope` 稳定为 `useCallback`。
- 其余告警来自异步请求的 generation/epoch/guard 计数器。cleanup 中的递增是失效旧请求的实际机制；把 `.current` 快照到局部变量会让递增失效，因此改为 effect 生命周期内的 `invalidate` 闭包，保持行为并让规则不再误报。

2026-10-24 复跑证据：`pnpm exec eslint .` → **0 error / 28 warning**，其中 `react-hooks/exhaustive-deps` 为 DKG 对话框 **1 条**；`pnpm exec tsc --noEmit` → **0 错误**。

---

## 追加：第二轮独立审查（2026-10-22）

两个后台代理分别审查 RPC 错误处理与 UI 真实性问题，共报 22 条。逐条回到源码核对，**全部成立**，已修复：

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 1 | `group-details-dialog.tsx` | `discoverChannels` 的 `truncated` 未消费，扫描到上限仍断言「尚未配置链上频道」并引导创建第二个频道（会再锁一份抵押） | 消费 `truncated`，标「未能确认（扫描不完整）」，「仍要创建新频道」并说明风险 |
| 2 | `dashboard.tsx` | 红色失败告警下方紧接着断言「本机与链上都没有找到」 | 失败时改为「无法确认你的群组」 |
| 3 | `agent-vault-chain.ts` | 扣费事件扫描分页停滞静默返回部分列表 | 改为抛错；页上限置 `spentEventsTruncated` |
| 4 | `agent-vault-chain.ts` | 扣费读取失败把已核验的卡降级为 unverified 并给出错误理由 | 拨出独立 try，记 `spentEventsError`，状态不变 |
| 5 | `agent-vault-chain.ts` | epoch 读失败仍断言「本纪元额度已用尽」 | `epochKnown=false` + 明确说明不能据此断定 |
| 6 | `group-discovery.ts` | 本次读取失败的组织仍保留 `chain-confirmed` 徽标 | 读失败即撤销徽标 |
| 7 | `suins.ts` | 反查失败映射成「没有名称」，违反文件自身契约 | 失败抛出，UI 显示「未能反查，不代表没有名称」 |
| 8 | `identity-panel.tsx` | 加载失败时三个空态仍显示「暂无关注/粉丝/待提取」 | 按 `detailsError` 区分 |
| 9 | `dkg-mailbox.ts` | 动态字段类型用调用目标包推导，下次升级后静默 notFound → 跳过份额投递 | 新增 `DKG_ENCRYPTION_KEY_TYPE_ORIGIN` 显式传入 |
| 10 | `agent-vault-chain.ts` | 本机索引损坏静默隐藏已转出的副卡 | `readAgentCapIndex` 返回错误并上报 |
| 11 | `sui-wallet-signer.ts` | passkey 校验 catch-all 把任何原因写成签名失败 | 保留 `cause` 与原因文本 |
| 12 | `group-chat.ts` | 文档说存储错误会传播，唯一调用方 `catch {}` | 显示存储读取失败 |
| 13 | `transactions.tsx` | Completed 标签页信任本机 `status`，无链上门禁（Pending 页有） | 补 `chainSyncedAt` 门禁与金额/时间待核验 |
| 14 | `transaction-details-dialog.tsx` | 任意 `executionDigest` 渲染成绿色「执行凭证」，含旧版伪造的 `0xexec_…` | 要求「Sui 摘要形状 + 已同步」双条件 |
| 15 | `transaction-details-dialog.tsx` | `requiredApprovals=0` 渲染 `NaN%` 与非法宽度 | 未同步或门限为 0 显示 `—` |
| 16 | `dkg-ceremony-dialog.tsx` | 「组织已成功部署在链上」仅凭本机记录 | 挂载时真实 `getObject` 决定 |
| 17 | `bill-details-dialog.tsx` / `requests.tsx` | 账单结算状态无来源标注 | 标「本机记录」，可核验付款附摘要链接 |
| 18 | `votes.tsx` / `governance.ts` | 「已执行」徽标未过 `synced`（其它数字都过了） | 补门禁 |
| 19 | `create-transaction-dialog.tsx` | 预览承诺定时/条件执行，提交路径却拒绝；两个 Expiration 输入无 `value/onChange` | 预览改为「尚无合约支持，提交会被拒绝」；输入接真实 `executeDate` |
| 20 | `direct-messages-dialog.tsx` | 粉丝读取失败静默变空列表 | 显示读取失败 |
| 21 | `group-details-dialog.tsx` | 门限回退到本机值却紧邻「已核验托管余额」 | 无链上读取时标「未核验」 |
| 22 | `red-packet-dialog.tsx` / `unified-chat-message.tsx` | 未读取状态填 0/「已领完」；任意 `.wma` 标成固定投票标题 | 区分未读取；附件只标格式 |

**一条建议经实测被推翻**：审查建议把 `EncryptionKeySlot` 的类型源改为 `DKG_TYPE_ORIGIN`。实测该动态字段的真实类型是 `0x0b49cb61…::dkg_committee::EncryptionKeySlot`（v5），不是 `0x23d1d8a2…`。照建议替换会当场让所有信箱公钥读取返回 notFound。已改为新增独立常量。

**门禁（本轮结束）**：`tsc --noEmit` 0 错误；离线测试 **492/492**；`✓ Compiled successfully`；浏览器回归 390px **16/16**、1280px **16/16**，pageerror 为空、无横向溢出。


---

## ⛔ 上线阻断项：`finalize_session` 允许任意人指定群公钥（2026-10-22，CRITICAL，v6 已修复）

独立密码学审查发现，并用真实代码在本地复现确认。**这不是前端缺陷，是已部署合约的缺陷。**

### 事实

`packages/contracts/agent_vault/sources/dkg_committee.move:332-348`（v1）：

```move
public fun finalize_session(session, group_public_key, _ctx) {
    assert!(session.status == STATUS_ROUND_2_MAILBOX, ...);
    assert!(session.confirmations_count >= session.threshold, ...);
    assert!(vector::length(&group_public_key) == 32, ...);
    session.final_public_key = group_public_key;   // 调用方给定，无任何验证
```

无 sender 检查、无签名。任何人可把已达门限的会话固化到自己生成的密钥上。

`finalize_session_v2`（`:351-378`）**并未修好**：它对 `group_public_key` 本身验证签名——

```move
let is_valid = ed25519::ed25519_verify(&frost_signature, &group_public_key, &msg);
```

这是循环论证：只证明「调用方持有它所选密钥的私钥」，不证明「已确认的门限成员为该密钥持有分片」。`lib/dkg-finalize-circularity.test.ts` 用真实消息布局复现了这条伪造：

```
attacker pk   : 652a007484ba43b6e5704e606e18e4329ecd9b63a2a7dec9b5d93fceccf0b85d
signature len : 64
contract check: PASSES — attacker-chosen key accepted
vs honest key : rejected (expected)
```

放大路径：`cryptographic_org.move:164-193` 的 `create_organization_from_session` 无 sender 检查，直接采用 `final_public_key` 作为 `org.group_pk`。攻击者成为控制共享 `Organization` 的密钥的唯一持有者。

### 可达性（实测）

- `finalize_session` 与 `finalize_session_v2` 均存在于已部署 v5 包 `0x0b49cb61…`
- 存在一笔成功的 testnet 交易走了 v1 入口：`DLy7jedM7sE6ZpaYLTUP42Lap2KQ6N83cHGukwtvzVmE`，`status: success`

### 修复状态：已修复并部署（v6，2026-10-22）

用户当次解禁部署后，已完成修复、重新发布并升级：

| 项 | 值 |
| --- | --- |
| 新包（调用目标） | `0xbe71f98ba28561c54060f234a4b79bb2f3873d2d65abc1819b7cb5af5c9010ad` |
| 版本 | 6 |
| 升级交易 | `DnTQHB3NWKWmBBi746UZr6aADMBnALqdUeKNVP7JrC17` |
| 类型源（不变） | `0x23d1d8a2…` / `0x0b49cb61…`（v6 未重定义这些结构体） |
| 新增类型源 | `GroupKeyAttestationSlot` 首次定义于 v6：`0xbe71f98b…` |

**原计划的修法（用链上承诺重算 `Σ C_0`）经源码核实不可行**：`sui::ed25519` 只暴露
`ed25519_verify`，没有曲线点运算；`sui::hash` 只有 sha2/sha3，没有 blake2b；
`sui::address` 无法从 ed25519 公钥推导。链上无法重算群公钥，也无法把 ed25519
公钥绑定到 Sui 地址。因此改为**成员申报**：

1. `finalize_session`（v1）与 `finalize_session_v2`（v2）保留签名（兼容升级不允许改
   已发布函数签名），函数体改为 `abort E_LEGACY_FINALIZE_DISABLED`（3013）。
2. 新增 `attest_group_key(session, clock, group_pk, ctx)`：仅已确认参与者可调用，
   把「本机从链上承诺重算出的群公钥」写入自己的动态字段 `GroupKeyAttestationSlot`；
   重复调用覆盖旧值。
3. 新增 `finalize_session_v3(session, group_pk, ctx)`：要求 **`threshold` 个已确认
   参与者申报了同一个群公钥**，否则 abort 3012。伪造需要控制达到门限的已确认地址
   ——与 DKG 本身的信任假设一致，不再是「任意路人一键劫持」。
4. 只读视图：`attestations_for(session, group_pk)`、`attested_key_of(session, participant)`。

`create_organization_from_session` 的第 3 条建议（链上校验 `final_public_key ==
Σ commitments[0]`）无法实现，原因同上；等价保证由 v3 的门限申报提供。

验证证据：

```
$ sui move build                                        # 通过
$ sui move lint --warnings-are-errors                   # 通过
$ sui move test                                         # 252 passed / 0 failed
$ sui client object 0xbe71f98b…                         # version 6, owner Immutable
$ getMoveFunction(0xbe71f98b…::dkg_committee::*)        # v1/v2/v3 + attest_* 全部存在
```

新增测试 `agent_vault::dkg_committee_attestation_tests`（11 项）pin 住：无申报不能固化、
未确认成员不能申报、非参与者不能申报、过期不能申报、跨密钥申报不累加、重复申报覆盖、
两个旧入口 abort 3013。

**残留限制**：v6 之前已固化的会话无法追溯修复，其 `final_public_key` 仍可能是第三方
选定值。客户端在「已固化」分支会重算并比对，不一致时明确报警。

### v6 审查与回归修复（同日）

**回归（本轮引入，已修）**：`components/dkg-ceremony-dialog.tsx` 在删除单标签页假 DKG 时，
把基线的「固化后创建组织」一并删掉了，`onConvertedSuccess` 变成从未调用的 prop，
`buildCreateOrganizationFromSessionPTB` 零调用，导致固化完成的会话没有任何可达路径变成 DAO。
基线 `git show HEAD:components/dkg-ceremony-dialog.tsx:321` 确实调用了它。
已补回：`finalize_session_v3` 成功后立即 `create_organization_from_session`，门限取
`session.threshold`（而非调用方可选值），组织对象用 `findCreatedProtocolObject` 按类型唯一确认，
再 `persistGroupOrganization` 落盘并回调 `onConvertedSuccess`。三个失败点分开报告：
固化交易失败 / 固化成功但建组织失败（明确写「固化不可撤销，请重新打开对话框再建组织」）/
建组织成功但本机关联失败（给出 orgId 与 digest，提示手动核对）。不会把「已固化」误报成「固化失败」。

**UI liveness（本轮引入，已修）**：截止时间后第 5 个按钮也被禁用，但合约的
`finalize_session_v3` 不读 `Clock`、没有 deadline 检查——成员在截止前申报，之后任何人仍可固化。
禁用该按钮会让已达申报门限的会话永远无法落地。已取消该按钮的时间门禁，并把两条互相矛盾的
截止提示合并为一条。

**独立审查结论（逐条回源码核对）**：

| 审查项 | 核对结果 |
| --- | --- |
| 非门限者能否钉任意 key | 否。写 `final_public_key` 的只有 `finalize_session_v3:458`；v1/v2 函数体只有 abort |
| 计数能否被重复地址抬高 | **能，前提是列表含重复地址**（v6 及更早）。`attestation_count_for:505` 遍历参与者**下标**，同一地址占两个下标记两票 → **多计**。v7 用 `assert_participant_set:173` 在创建时拒绝重复，实证见下节 |
| 动态字段名冲突 | 否。名字是 hash(type, value)，不同 struct 不可能撞 |
| legacy abort 是否有旁路 | 否。函数体仅一条 abort，无 friend/entry 包装 |
| t 个恶意成员抢在截止前 attest 恶意 key | **成立，但不构成提权**：t 个成员本就持有门限签名能力，能签任意消息；把组织密钥换成自己的不给他们新能力，只是让诚实成员无法再建组织。真正的 liveness 风险，已知并记录 |
| `create_dkg_session` 允许重复/零地址 | 成立，**基线即存在**，v6 未改。但审查给的方向**错了**：实测是**多计**不是少计（见下节实证），构成单成员绕过门限申报的提权。已修并**部署于 v7**（3014），链上复现见下节 |
| `create_organization_from_session` 接受任意 `threshold_weight` | 成立，**基线即存在**。客户端已固定传入 `session.threshold`；合约侧源码已加下限（1009），随 v7 部署 |

### v7 修复（源码已改、测试已过、**已于 2026-10-22 部署**）

链上复现（同一笔模拟，v7 与 v6 对照，`create_dkg_session` 参数完全一致，
参与者列表 `[A, A]`、threshold 2）：

```
v7  0xca0650d4…::dkg_committee::create_dkg_session  -> MoveAbort 3014
      in assert_participant_set (instruction 35)
v7  0xca0650d4…  参与者 [A, sender]                 -> Transaction（成功）
v6  0xbe71f98b…  参与者 [A, A]                      -> Transaction（成功，即漏洞）
```

对照组说明：v7 拒绝的是**重复地址**而非本次调用本身，因为把列表换成两个不同地址后
同一调用成功。v6 接受同样的重复列表，直接证明该提权在 v6 上真实存在。
`dkg_revision()` 链上返回值：v7 = **4**，v6 = 3（`simulateTransaction` 读返回值）。

| 项 | 改动 | 证据 |
| --- | --- | --- |
| 参与者重复/零地址 | `assert_participant_set`，`create_dkg_session` 与 `create_resharing_session` 都调用，错误码 3014 | `sui move test` 含 3 项 |
| 组织名册重复/零地址 | `assert_valid_roster`，`create_organization_with_chain_id` 调用 | `cryptographic_org_roster_tests` 4 项 |
| 治理门限下限 | `create_organization_from_session` 要求 `threshold_weight >= dkg threshold`（1009） | `dkg_committee_tests` 已适配 |
| DKG 修订号 | 3 → 4（`dkg_committee.move:68`），测试断言同步为 4 | `sui move test` OK 252/252 |

**重复地址是真提权，不是仅「会话卡死」**——此前审查判断为「重复项只会少计」，
**实测相反**。用临时禁用守卫的构建实测：
`create_dkg_session(2, vector[ALICE, ALICE])` + ALICE 单次 `attest_group_key`
→ `attestations_for(KEY_A)` 返回 **2**。原因是 `attestation_count_for` 遍历的是
**参与者列表下标**，每个下标都去读同一个 `GroupKeyAttestationSlot{ALICE}`，
所以同一槽位被重复计入；而 `confirmations` 按地址建键，只记 1 次。
后果：**一个真实成员即可满足门限为 2 的申报门槛**并固化任意密钥。
该实证测试在观察后已删除，防回归由 `create_rejects_a_duplicated_participant` 承担。

前端同时加了防御：遇到 v6 会话含重复地址时明确拒绝并说明「此会话永远无法固化」，
不会一边申报一边无限重试。

**只读实测（真实会话 `0x4da8b14f…`，status=2，3 名参与者）**：

```
commitment a: 64        # 承诺可读，长度正确
confirmation a: true    # 确认状态可读
mailbox a->b: 137       # 密封分片可读（类型源 0x23d1d8a2…）
attestation a: null     # 新槽位为空 → 「尚未申报」，不是空密钥
attestation c: null
```

**动态字段派生实证**：用 `deriveDynamicFieldID` 对已知存在的 `EncryptionKeySlot` 反推 field id，
在链上真实命中（3/3 `PRESENT`），证明申报槽位的寻址算法正确，而不是「找不到就当没有」的自证。
另对真实会话 dry-run `attestations_for`：`execution status: success`，O(n) 动态字段循环可执行。

这条探测同时证明了新增读取函数的「未申报 → null」语义在真实链上成立，
而不是只在内联桩里成立。注意：用 `.mts` 探针脚本时 `@mysten/sui` 会以 ESM
加载，与项目 CJS 模块形成两个类实例，`instanceof ObjectError` 会假性为
false，从而把「未找到」误报为真实错误；用 `.ts`/应用内路径复核后行为正确。
这是探针方法的陷阱，不是产品缺陷。

### 客户端已做的缓解（不等于修复）

- `components/dkg-ceremony-dialog.tsx` 的 `handleFinalize` 在**已固化**分支也重算 `Σ C_0` 并与 `final_public_key` 比对；不一致时明确报警「此组织的 group_pk 可能由第三方选定，不要在其中托管资产」。
- 移除了原先基于 `sha256(message)` 的签名份额生成——合约验证的是原始消息，预哈希产物永远无法聚合，留着只会让人误以为可用。
- `components/dkg-ceremony-dialog.tsx` 已固化面板与「组织已成功部署在链上」文案改由真实 `getObject` 决定。

v6 起，新建会话的固化结果由门限成员申报决定；v6 之前固化的旧会话仍需按上面的比对结果区别对待。

---

## A6 关闭：ESLint 配置与真实缺陷清理（2026-10-23）

**改动**

- 新增 `eslint.config.mjs`：ESLint 9 flat config，用 `@eslint/eslintrc` 的 `FlatCompat`
  桥接 `next/core-web-vitals` + `next/typescript`（`eslint-config-next` 仍只发 eslintrc 预设）。
- `@typescript-eslint/no-unused-vars` 允许 `^_` 前缀（保留签名用的参数、省略字段用的 rest 解构）。
- `*.test.ts` / `tailwind.config.ts`：`no-require-imports` 关闭（测试必须在模块求值前装好环境变量与 mock，
  提升的 ESM import 表达不了这个顺序），`no-explicit-any` 降为 warning（测试构造 gRPC 客户端与钱包的局部替身）。

**结果**

```
$ pnpm exec eslint . --quiet
$ echo $?
0
```

最新复跑 warning 28 条（历史记录曾为 34 条）：`no-explicit-any` 27（全在测试）+ `react-hooks/exhaustive-deps` 1（`dkg-ceremony-dialog.tsx` 的可变 ref cleanup 提示）。测试替身不涉及生产代码。另有 3 处 `no-img-element` 已就地 disable 并写明理由，不再计入。

**清理过程中修复的真实缺陷**（完整表格见 §A6，每一条都是把 `any` 换成真实类型后编译器暴露出来的）：

- `components/bill-details-dialog.tsx:94`：`bill.creatorName[0]` 无名称时崩溃。
- `components/bill-details-dialog.tsx:108`、`components/walrus-app-sandbox-dialog.tsx:34`：`new Date(undefined)` 渲染 "Invalid Date"。
- `components/create-bill-dialog.tsx`、`components/create-group-dialog.tsx`：「搜索联系人」菜单没有输入框，`searchTerm` 恒空，功能实际不存在。已补真实输入框（保留入口，不删功能）。
- `components/quick-templates.tsx`：`useTemplate` 在 `onClick` 内调用，违反 `rules-of-hooks`。
- `lib/sui-wallet-signer.ts:223`：钱包两种执行特性都不可调用时，旧代码仍调用 `legacy.…`，抛错被 `uncertain()` 包装成
  「交易状态尚未确认」——一次能力缺失被误报成未确认交易，且待确认锁阻止重新发起。**违反红线 7。**
- `lib/sui-wallet-signer.ts:200`：`signFeature` 存在但不含可调用方法时调用落到 `undefined`。
- `lib/governance.ts`：`GovernanceVote` 与 `readGovernanceValue` 的 `any` 改为显式字段 + `unknown` 索引签名；
  由此暴露 `proposalVoteSnapshot` 等三条路径下 `creator` 确实可能缺席，消费方已改为可选访问。
- `lib/pending-transactions.ts:46`：`parseReceipt` 的字段校验写在 `any` 上。改为 `unknown` 逐字段收窄；
  `persistent` 是本地缓存标志而非身份字段，采取归一化（缺省视为 `true`）而不是拒绝——拒绝会让旧版本写下的未确认交易无法恢复。
- `lib/onchain-store.ts:112`：`proposalProjection` 入参改 `Record<string, unknown>`；
  `treasuryId`/`treasuryBindingId` 的畸形值**故意保留**（注释已说明：收窄成 `undefined` 会把「存在但非法」变成「不存在」，
  正是现有防护要阻止的回落路径）。
- `lib/dev-keystore.ts:67`：返回类型 `any` → SDK `Keypair`。
- `lib/wallet-discovery.ts`：`features: Record<string, any>` → `SuiWalletFeatures`（SDK 各特性声明的交叉 + 索引签名），
  `WalletAccount` 改用 SDK 类型；`supportsSuiWallet` 的「特性名 ↔ 方法名」配对改为数据表，编译器可校验。
- `lib/sui-stack-messaging.ts`：同上，`WalletSigner` 的 `signAndExecuteTransaction` 覆盖改用
  `Parameters<Signer["signAndExecuteTransaction"]>` 派生（SDK 未导出 `SignAndExecuteOptions`）。

**门禁（本轮结束）**

```
$ pnpm exec tsc --noEmit          → 0 错误
$ pnpm exec eslint . --quiet      → 0 error（退出码 0）
$ pnpm exec tsx --test lib/*.test.ts lib/crypto/*.test.ts
ℹ tests 577 / pass 577 / fail 0
$ pnpm build
✓ Compiled successfully；Route / 465 kB，First Load JS 1.1 MB
$ node scripts/ui-regression.mjs  （390px 与 1280px 各一次）
16/16 passed，pageerror 为空，无横向溢出
```

**仍缺**：UpgradeCap 单地址持有；第三方审计；旧 `lib/frost-exchange.ts` 仅保留 FROST 协议与聚合逻辑，不负责传输；新的 `lib/frost-private-transport.ts` 已由名册 UI 调用，并通过 `private-messages.ts` 接到 identity `send_message` 交易与 `MessageSent` 事件读取，但 identity 包/Names 尚未部署，真实独立设备、网络、钱包和线上回执 E2E 仍为 **GAP / UNVERIFIED**（产品功能 GAP，不能用于降低 DKG 正确性结论）。最新复跑的 28 条 ESLint warning（27 测试 any + 1 ref cleanup）不阻塞 A6。均未 commit、未 push。
